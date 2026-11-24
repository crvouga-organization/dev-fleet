"""Opt-in real Ubuntu/systemd test in a disposable QEMU guest, not live acceptance.
Build test tooling with the adjacent Dockerfile. Run with /dev/kvm, repository
mounted read-only at /workspace and an empty temporary directory at /artifacts.
No host networking, host root mount, Docker socket or production secrets allowed.
"""
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import time
import tomllib
import urllib.request

ROOT = Path('/artifacts')
BOOTSTRAP = Path('/bootstrap/revision').exists()
# The desktop session needs a desktop installed in the guest: several GiB and
# a graphical login on QEMU's virtual display. Opt in with FLEET_TEST_DESKTOP=1.
DESKTOP = os.environ.get('FLEET_TEST_DESKTOP') == '1'
HOME = '/home/fleettest'
SERVER = 't3code-headless.service'
APP = 't3code-desktop.service'
IMAGE_SHA = '5645d0318ad21f643ebb1ac4567514620e9893380b07b0201fda163baa5b7eb5'
# Package installs from snapshot.ubuntu.com can take over ten minutes when the
# snapshot service is slow; the job's own timeout still bounds the whole run.
COMMAND_TIMEOUT = 1500
# The exposure policy this guest declares (worker_exposure, as fleet-sync
# passes it from exposure in fleet.json): one port held to the tailnet, as for
# a remote desktop that cannot bind one address, and one opened to everyone,
# which is the control that shows a connection from outside arrives at all.
TAILNET_ONLY_PORT = 3389
PUBLIC_PORT = 3390
# Declared to the check only, never to the play: no loaded rule holds it.
UNSYNCED_PORT = 3391
EXPOSURE = {'tailnetOnlyPorts': [{'protocol': 'tcp', 'port': TAILNET_ONLY_PORT}], 'publicPorts': [{'protocol': 'tcp', 'port': PUBLIC_PORT}]}
BANNER = 'fleet-exposure-fixture'


def run(args, **kwargs):
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=COMMAND_TIMEOUT, **kwargs)
    except subprocess.TimeoutExpired as expired:
        # What the command printed before it was cut off is the evidence.
        partial = ''.join(part.decode(errors='replace') if isinstance(part, bytes) else part or '' for part in (expired.stdout, expired.stderr))
        (ROOT / 'last-failure.log').write_text(partial)
        raise RuntimeError(f'Disposable VM command did not end within {COMMAND_TIMEOUT} seconds; inspect private artifact last-failure.log') from None
    if result.returncode:
        (ROOT / 'last-failure.log').write_text(result.stdout + result.stderr)
        raise RuntimeError('Disposable VM command failed; inspect private artifact last-failure.log')
    return result


AGENTS = 'app-t3code-agents'
THREAD = AGENTS + '-fixture'
QUIET = 'devfleet-quiet.service'
BUSY = 'devfleet-pressure-fixture.service'


def check_slice_policy(ssh):
    limit = json.loads(Path('/workspace/ansible/ubuntu/policy.json').read_text())['resourceSafety']['agentSlice']['oomPressurePercent']
    for name in [AGENTS, THREAD]:
        unit = name + '.slice'
        run(ssh + [f'systemctl --user start {unit}'])
        # systemd exposes the percentage as a fraction of UINT32_MAX on D-Bus.
        value = run(ssh + [f'systemctl --user show {unit} -p ManagedOOMMemoryPressureLimit --value']).stdout.strip()
        percent = float(value[:-1]) if value.endswith('%') else int(value) * 100 / (2**32 - 1)
        assert abs(percent - limit) < 0.1, (unit, percent, limit)
        assert run(ssh + [f'systemctl --user show {unit} -p ManagedOOMMemoryPressure --value']).stdout.strip() == 'kill'

    for mode in ('--pipe --wait', '--scope'):
        actual = run(ssh + [f'systemd-run --user --quiet {mode} cat /proc/self/cgroup']).stdout.strip()
        assert f'/{AGENTS}.slice/run-' in actual, actual


def pressure_sample(ssh):
    start = time.monotonic()
    command = f"""set -e
{answers(SERVER)}
systemctl --user is-active --quiet {QUIET}
cg=/sys/fs/cgroup$(systemctl --user show {THREAD}.slice -p ControlGroup --value)
for dir in "$cg" "$(dirname "$cg")"; do
  cat "$dir/memory.pressure" "$dir/memory.swap.current"
  grep -E '^(pgscan|pgsteal) ' "$dir/memory.stat"
done
grep -E '^pswp(in|out) ' /proc/vmstat"""
    result = subprocess.run(ssh + [command], check=True, capture_output=True, text=True, timeout=5)
    print(json.dumps(dict(ssh_ms=round(1000 * (time.monotonic() - start)),
                          quiet='active', samples=result.stdout.splitlines())), flush=True)


def test_agent_pressure(ssh):
    """Exercise reclaim inside a small test cgroup in the disposable guest."""
    run(ssh + ["""test "$(swapon --show=NAME,PRIO --noheadings | sort -k2,2nr | head -1 | awk '{print $1}')" = /dev/zram0"""])
    # Keep the fixture small enough that even without oomd its hard cap bounds
    # the damage. File-backed pages drive reclaim on repeated scans.
    script = """import mmap, sys, tempfile, time
from pathlib import Path
controlled = len(sys.argv) > 1
group = Path('/sys/fs/cgroup' + Path('/proc/self/cgroup').read_text().strip().split('::',1)[1])
def stalled():
    line = (group / 'memory.pressure').read_text().splitlines()[-1]
    return int(line.split('total=')[1]) / 1000000
end = time.monotonic() + 65
with tempfile.TemporaryFile() as f:
    f.truncate(160 * 1024 * 1024)
    with mmap.mmap(f.fileno(), 0) as pages:
        while not controlled or time.monotonic() < end:
            for start in range(0, len(pages), 1024 * 1024):
                before = time.monotonic()
                baseline = stalled() if controlled else 0
                for i in range(start, start + 1024 * 1024, 4096):
                    pages[i] = (pages[i] + 1) % 256
                if controlled:
                    # Pace the fixture at 52% full PSI, between the historical
                    # and candidate limits. The saturating run never sleeps.
                    time.sleep(max(0, (stalled() - baseline) / 0.52 - (time.monotonic() - before)))
"""
    subprocess.run(ssh + ['cat > pressure-fixture.py'], input=script.encode(),
                   capture_output=True, check=True)
    check_slice_policy(ssh)
    archive = subprocess.run(['tar', '-C', '/workspace', '-cf', '-', 'cliproxy/tests', 'cliproxy/scripts', 'cliproxy/models.json'],
                             capture_output=True, check=True)
    subprocess.run(ssh + ['tar -xf -'], input=archive.stdout, check=True)
    run(ssh + [f'systemd-run --user --unit={QUIET} --slice={THREAD}.slice sleep 240'])
    unit = BUSY
    launch = (f'systemd-run --user --unit={unit} --slice={THREAD}.slice '
              '--property=MemoryHigh=24M --property=MemoryMax=256M --property=RuntimeMaxSec=150 ')
    try:
        # Run a real repository test while a bounded reclaim burst shares its session.
        # --pipe forwards the session's output, the evidence when it fails.
        evidence = ROOT / 'pressure-trial.log'
        with evidence.open('wb') as log:
            trial = subprocess.Popen(ssh + [launch + """--pipe --wait --collect /bin/sh -ec 'python3 pressure-fixture.py paced & pid=$!; python3 -m unittest discover -s cliproxy/tests -p test_model_protocol.py; wait "$pid"'"""],
                                     stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT)
            while trial.poll() is None:
                pressure_sample(ssh)
                time.sleep(2)
        if trial.returncode:
            (ROOT / 'last-failure.log').write_bytes(evidence.read_bytes())
            raise RuntimeError('A test session under paced pressure failed; inspect private artifact last-failure.log')
        start = run(ssh + ['date +%s']).stdout.strip()
        run(ssh + [launch + 'python3 pressure-fixture.py'])
        # One thrashing session measures about 52-56% full PSI, below the
        # 60% oomd limit: oomd is a last resort here. What must hold under
        # sustained overload is that SSH answers, the quiet session lives and
        # the hard cap contains the runaway session.
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            pressure_sample(ssh)
            time.sleep(2)
        run(ssh + [f'systemctl --user is-active --quiet {unit}'])
        peak = int(run(ssh + [f'cat /sys/fs/cgroup$(systemctl --user show {unit} -p ControlGroup --value)/memory.peak']).stdout)
        assert peak <= 256 * 1024 * 1024, peak
        journal = run(ssh + [f'sudo journalctl -u systemd-oomd --since=@{start} --no-pager -o cat'])
        assert not any('Killed' in line for line in journal.stdout.splitlines()), journal.stdout
        print('SSH and the quiet session stayed live while the hard cap contained a thrashing session', flush=True)
    finally:
        subprocess.run(ssh + [f'systemctl --user stop {unit} {QUIET}'], capture_output=True, timeout=10)


def test_io_guard(ssh):
    """Give one disposable block device slow writes while SSH and another session stay live."""
    quiet = 't3code-quiet.scope'
    writer = 't3code-writer.scope'
    scope = ['systemd-run', '--user', '--scope', f'--slice={THREAD}.slice']
    # Never delay the guest's system disk. The mapper addresses only a new loop file.
    run(ssh + ["""set -eu
sudo modprobe dm-delay || sudo apt-get install -y linux-modules-extra-$(uname -r)
truncate -s 64M io-fixture.img
loop=$(sudo losetup --find --show io-fixture.img)
echo "$loop" > io-fixture.loop
echo "0 $(sudo blockdev --getsz "$loop") delay $loop 0 0 $loop 0 80" | sudo dmsetup create fleet-io-fixture
sudo chown "$(id -u)" /dev/mapper/fleet-io-fixture"""])
    def start(name, command):
        return subprocess.Popen(ssh + [' '.join([*scope, '--unit=' + name, command])],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    quiet_process = start(quiet, """python3 -c 'import time; pages=bytearray(96*1024*1024); time.sleep(240)'""")
    try:
        wait_for(ssh, f'systemctl --user is-active --quiet {quiet}', 15, 'quiet session did not start')
        started = run(ssh + ['date +%s']).stdout.strip()
        # Synchronous, unbuffered writes to the scratch device. Each write takes
        # at least 80 ms, so the 32-block burst ends well inside the grace period.
        write = 'dd if=/dev/zero of=/dev/mapper/fleet-io-fixture bs=4096 oflag=direct status=none'
        burst = start(writer, write + ' count=32')
        assert burst.wait(timeout=30) == 0, 'short write burst was interrupted'
        busy = start(writer, write + ' count=2000')
        deadline = time.monotonic() + 140
        while time.monotonic() < deadline:
            before = time.monotonic()
            sample = subprocess.run(ssh + [f'''set -e
systemctl --user is-active --quiet {quiet}
{answers(SERVER)}
cat /proc/pressure/io
# What the guard reads: its state, the writer's stalls and bytes, the root's bytes.
systemctl is-active personal-fleet-pressure-guard || true
cg=/sys/fs/cgroup$(systemctl --user show {writer} -p ControlGroup --value)
tail -1 "$cg/io.pressure" 2>/dev/null || true
sed 's/^/writer /' "$cg/io.stat" 2>/dev/null || true
dev=$(lsblk -dno MAJ:MIN /dev/mapper/fleet-io-fixture | tr -d ' ')
grep "^$dev " /sys/fs/cgroup/io.stat | sed 's/^/root /' || true
sudo journalctl -u personal-fleet-pressure-guard --since=@{started} -o cat | grep -v '^{{' | tail -3 || true
sudo journalctl -u personal-fleet-pressure-guard --since=@{started} -o cat | grep '^{{' || true'''],
                                    capture_output=True, text=True, timeout=5, check=True)
            print(json.dumps(dict(io_fixture=sample.stdout.splitlines(),
                                  ssh_ms=round(1000*(time.monotonic()-before)))), flush=True)
            decisions = [json.loads(line) for line in sample.stdout.splitlines() if line.startswith('{')]
            if decisions:
                assert all(d['reason'] == 'io' and d['scope'] == writer for d in decisions), decisions
                assert busy.wait(timeout=10) != 0
                return
            time.sleep(2)
        raise RuntimeError('guard did not attribute sustained stalls to the writer')
    finally:
        run(ssh + [f'systemctl --user stop {writer} {quiet} || true; sudo dmsetup remove fleet-io-fixture && sudo losetup -d "$(cat io-fixture.loop)"'])
        quiet_process.wait(timeout=10)


def main():
    ROOT.mkdir(exist_ok=True)
    image = ROOT / 'ubuntu.img'
    if not image.exists():
        with urllib.request.urlopen('https://cloud-images.ubuntu.com/releases/resolute/release-20261016/ubuntu-26.04-server-cloudimg-amd64.img', timeout=60) as response, image.open('wb') as target:
            while chunk := response.read(1024 * 1024):
                target.write(chunk)
    assert hashlib.file_digest(image.open('rb'), 'sha256').hexdigest() == IMAGE_SHA
    print('verified Ubuntu cloud image', flush=True)
    if not (ROOT / 'client').exists():
        run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(ROOT / 'client')])
    if not (ROOT / 'host').exists():
        run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(ROOT / 'host')])
    private = '\n'.join('    ' + line for line in (ROOT / 'host').read_text().splitlines())
    public = (ROOT / 'host.pub').read_text().strip()
    (ROOT / 'known_hosts').write_text('[127.0.0.1]:2222 ' + public + '\n')
    (ROOT / 'user-data').write_text(f'''#cloud-config
users:
  - name: fleettest
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    ssh_authorized_keys:
      - {(ROOT / 'client.pub').read_text().strip()}
ssh_keys:
  ed25519_private: |
{private}
  ed25519_public: {public}
{"" if BOOTSTRAP else "packages: [ansible-core]"}
''')
    (ROOT / 'meta-data').write_text('instance-id: disposable-fleet-test\nlocal-hostname: disposable-fleet-test\n')
    run(['cloud-localds', str(ROOT / 'seed.img'), str(ROOT / 'user-data'), str(ROOT / 'meta-data')])
    if not (ROOT / 'guest.qcow2').exists():
        run(['qemu-img', 'create', '-f', 'qcow2', '-F', 'qcow2', '-b', str(image), str(ROOT / 'guest.qcow2'), '64G' if BOOTSTRAP else '24G'])
    ssh = ['ssh', '-i', str(ROOT / 'client'), '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes', '-o', f'UserKnownHostsFile={ROOT}/known_hosts', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=3', '-p', '2222', 'fleettest@127.0.0.1']
    log = (ROOT / 'serial.log').open('w')
    vm = subprocess.Popen(['qemu-system-x86_64', '-enable-kvm', '-cpu', 'host', '-smp', '2', '-m', '4096', '-display', 'none', '-serial', 'stdio', '-drive', f'file={ROOT}/guest.qcow2,if=virtio', '-drive', f'file={ROOT}/seed.img,format=raw,if=virtio', '-netdev', 'user,id=net0,hostfwd=tcp:127.0.0.1:2222-:22' + ''.join(f',hostfwd=tcp:127.0.0.1:{port}-:{port}' for port in (TAILNET_ONLY_PORT, PUBLIC_PORT)), '-device', 'virtio-net-pci,netdev=net0'], stdout=log, stderr=log)
    try:
        for _ in range(120):
            attempt = subprocess.run(ssh + ['true'], capture_output=True, timeout=5)
            if attempt.returncode == 0:
                break
            time.sleep(2)
        if BOOTSTRAP:
            # The bootstrap starts as soon as SSH answers, as a pipeline would:
            # it waits for the machine's own first boot (cloud-init) itself.
            print('fresh verified SSH; first boot may still be running', flush=True)
            # The official cloud image includes Git. Remove it only in this
            # disposable fixture to exercise the minimal-target boundary,
            # waiting for any package work first boot is still doing.
            run(ssh + ['sudo apt-get -o DPkg::Lock::Timeout=900 remove --yes git'])
            run(ssh + ['! command -v node && ! command -v bun && ! command -v mise && ! command -v git'])
            print('fresh target has no Node, Bun, mise or Git; invoking production SSH bootstrap', flush=True)
            run(ssh + ['mkdir -p work && printf preserved > work/uncommitted'])
            result = subprocess.run(['/verification/bootstrap', str(ROOT), '/bootstrap'], capture_output=True, text=True, timeout=5500)
            (ROOT / 'bootstrap-result.json').write_text(result.stdout)
            assert result.returncode == 0, 'production bootstrap did not reach node convergence; inspect redacted bootstrap-result.json'
            evidence = 'sha256sum work/uncommitted /etc/ssh/ssh_host_ed25519_key.pub; stat -c %Y /etc/systemd/logind.conf.d/60-personal-fleet.conf /etc/ssh/sshd_config.d/60-personal-fleet.conf'
            before = run(ssh + [evidence]).stdout
            repeated = subprocess.run(['/verification/bootstrap', str(ROOT), '/bootstrap'], capture_output=True, text=True, timeout=5500)
            (ROOT / 'bootstrap-repeat-result.json').write_text(repeated.stdout)
            assert repeated.returncode == 0, 'repeated bootstrap did not pass the baseline'
            assert run(ssh + [evidence]).stdout == before, 'repeat changed work, SSH identity or unchanged managed files'
            print('production remote bootstrap and repeat passed the baseline; live auth remains unverified', flush=True)
            return
        # The baseline-only run applies Ansible directly, which first boot
        # installs (packages above): it waits for first boot itself.
        run(ssh + ['cloud-init status --wait --long'])
        print('fresh verified SSH and cloud-init complete', flush=True)
        verification = Path('/verification/verify')
        assert verification.exists(), 'Compile the tracked runtime-check.ts fixture and mount /verification first'
        subprocess.run(ssh + ['cat > verify && chmod 700 verify'], input=verification.read_bytes(), capture_output=True, check=True, timeout=60)
        run(ssh + ['mkdir -p baseline && mkdir -p work && printf preserved > work/uncommitted'])
        archive = subprocess.run(['tar', '-C', '/workspace/ansible/ubuntu', '-cf', '-', '.'], capture_output=True, check=True).stdout
        subprocess.run(ssh + ['tar -C baseline -xf -'], input=archive, capture_output=True, check=True)
        command = "cd baseline && ansible-playbook baseline.yml --extra-vars '" + json.dumps({'development_user': 'fleettest', 'development_uid': 1000, 'development_home': HOME, 'tailscale_address': '100.64.0.2', 'ssh_port': 22, 'worker_exposure': EXPOSURE}) + "'"
        first = run(ssh + [command])
        (ROOT / 'first-apply.log').write_text(first.stdout + first.stderr)
        second = run(ssh + [command])
        (ROOT / 'repeat-apply.log').write_text(second.stdout + second.stderr)
        assert 'changed=0' in second.stdout, 'repeat run changed configuration'
        test_drift(ssh, command)
        run(ssh + ['test "$(cat work/uncommitted)" = preserved && sudo visudo -c && test "$(systemctl is-enabled sleep.target)" = masked'])
        # No tailnet here and the session arrives from outside it: the firewall
        # loads, but keeps SSH open rather than lock the test out.
        run(ssh + ['sudo sshd -T | grep -qx "passwordauthentication no" && sudo sshd -T | grep -qx "permitrootlogin no" && sudo nft list table inet personal_fleet | grep -q "policy drop" && sudo nft list table inet personal_fleet | grep -q public-ssh'])
        assert holds_tailnet_only(ssh), 'the firewall the play loaded holds no tailnet-only rule for the declared port'
        t3 = test_headless(ssh)
        test_agent_pressure(ssh)
        test_agent(ssh)
        reboot(ssh)
        check_slice_policy(ssh)
        test_io_guard(ssh)
        run(ssh + ['test "$(systemctl is-enabled sleep.target)" = masked && test "$(cat work/uncommitted)" = preserved && sudo nft list table inet personal_fleet | grep -q "policy drop"'])
        # No play ran since the reboot: personal-fleet-firewall.service loaded it.
        run(ssh + ['systemctl is-active --quiet personal-fleet-firewall.service'])
        assert holds_tailnet_only(ssh), 'the firewall loaded at boot holds no tailnet-only rule for the declared port'
        if t3:
            after_headless_reboot(ssh, t3)
        test_exposure(ssh)
        if t3 and DESKTOP:
            test_desktop(ssh, t3)
        verification = Path('/verification/verify')
        if verification.exists():
            subprocess.run(ssh + ['cat > verify && chmod 700 verify'], input=verification.read_bytes(), capture_output=True, check=True, timeout=60)
            evidence = run(ssh + ['./verify'])
            (ROOT / 'boot-policy-evidence.json').write_text(evidence.stdout)
            print('production boot-policy observer passed after VM reboot', flush=True)
        run(ssh + ['systemctl is-active beszel-agent.service && test \"$(sudo cat /var/lib/beszel-agent/fixture-preserved)\" = preserved'])
        print(json.dumps({'passed': ['Ubuntu baseline apply', 'repeat no-op', 'sudoers validation', 'sleep target masked', 'reboot and fresh SSH', 'uncommitted file preserved', 'sleep/SSH drift repair and injected capacity gate', 'native Beszel agent no-op/crash/reboot with intentionally unreachable fixture hub', 'keys-only sshd without root login, and the fleet firewall loaded at apply and boot with SSH kept open while no tailnet session proves the manager path', 'tailnet-only port: its rule loaded at apply and at boot, worker:exposure passing for a listener on every address and failing for a declared port without a loaded rule, and the port closed on the guest network interface while a public port answers'] + (['headless T3 server: install, no-op, killed process restarted, stopped server started by the recovery timer, started at boot with nobody logged in, managed update policy'] if t3 else []) + (['desktop T3 app: switch from headless keeping ~/.t3, auto-login after reboot, serving on loopback only, stopped app started by the recovery timer'] if t3 and DESKTOP else []), 'unverified': ['Tailscale', 'closing public SSH over a tailnet session', 'paired T3', 'Beszel agent/private metrics', 'full remote bootstrap'] + ([] if DESKTOP else ['desktop session (FLEET_TEST_DESKTOP=1)'])}), flush=True)
    finally:
        # Preserve failure evidence on disk before terminating the disposable VM.
        # This is fixture cleanup, not a claimed power-loss acceptance test.
        try:
            subprocess.run(ssh + ['sync'], capture_output=True, timeout=15)
        except subprocess.TimeoutExpired:
            pass
        vm.terminate()
        try:
            vm.wait(timeout=15)
        except subprocess.TimeoutExpired:
            vm.kill()
            vm.wait()
        log.close()


def pins():
    """The T3 release mise.toml pins, with its digests: never written here."""
    with open('/workspace/mise.toml', 'rb') as source:
        variables = tomllib.load(source)['vars']
    return variables['t3_version'], variables['t3_linux_x64_sha256'], variables['t3_desktop_amd64_sha256']


def download(url, target, digest):
    if not target.exists():
        with urllib.request.urlopen(url, timeout=120) as response, target.open('wb') as out:
            while chunk := response.read(1024 * 1024):
                out.write(chunk)
    assert hashlib.file_digest(target.open('rb'), 'sha256').hexdigest() == digest, f'{target.name} does not match its pin'


def variables(**extra):
    return json.dumps({'development_user': 'fleettest', 'development_uid': 1000, 'development_home': HOME, 'development_source': f'{HOME}/source', **extra})


def play(ssh, playbook, **extra):
    return run(ssh + [f"cd baseline && ansible-playbook {playbook} --extra-vars '{variables(**extra)}'"])


def user(ssh, command):
    return run(ssh + [f'XDG_RUNTIME_DIR=/run/user/1000 {command}'])


def main_pid(ssh, unit):
    return user(ssh, f'systemctl --user show {unit} -p MainPID --value').stdout.strip()


def wait_for(ssh, command, seconds, message):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if subprocess.run(ssh + [command], capture_output=True, timeout=20).returncode == 0:
            return time.monotonic() - (deadline - seconds)
        time.sleep(5)
    raise AssertionError(message)


def answers(unit):
    return f'XDG_RUNTIME_DIR=/run/user/1000 systemctl --user is-active --quiet {unit} && curl --fail --silent --max-time 10 http://127.0.0.1:3773/.well-known/t3/environment | grep -q environmentId'


def reboot(ssh):
    boot = run(ssh + ['cat /proc/sys/kernel/random/boot_id']).stdout
    subprocess.run(ssh + ['sudo reboot'], capture_output=True, timeout=10)
    time.sleep(3)
    for _ in range(120):
        result = subprocess.run(ssh + ['cat /proc/sys/kernel/random/boot_id'], capture_output=True, text=True, timeout=5)
        if result.returncode == 0 and result.stdout != boot:
            break
        time.sleep(2)
    assert result.returncode == 0 and result.stdout != boot, 'reboot reconnect failed'


def test_headless(ssh):
    """A headless worker on a stock server image: the pinned T3 server as a
    lingering user service (t3-headless.yml), recovered by the timer."""
    version, server_sha, _ = pins()
    name = f't3-{version}-linux-x64'
    archive = ROOT / f'{name}.tar.gz'
    download(f'https://github.com/pingdotgg/t3code/releases/download/v{version}/{name}.tar.gz', archive, server_sha)
    tools = f'{HOME}/.local/share/personal/tools'
    subprocess.run(ssh + [f'mkdir -p {tools} && cat > {tools}/{name}.tar.gz'], input=archive.read_bytes(), capture_output=True, check=True, timeout=300)
    run(ssh + [f'tar -xzf {tools}/{name}.tar.gz -C {tools} && {tools}/{name}/t3 --version'])
    server = f'{tools}/{name}/t3'
    # The plays read the revision's scripts from development_source.
    run(ssh + ['mkdir -p source/ansible && ln -sfn ~/baseline source/ansible/ubuntu'])
    run(ssh + ['! command -v gdm3 && ! test -e /etc/gdm3/custom.conf'])
    play(ssh, 't3-policy.yml', t3_executable=server)
    first = play(ssh, 't3-headless.yml', t3_server_path=server)
    (ROOT / 't3-headless-first.log').write_text(first.stdout + first.stderr)
    wait_for(ssh, answers(SERVER), 60, 'the headless T3 server did not answer its local API')
    run(ssh + ['printf preserved > ~/.t3/fleet-test-preserved'])
    pid = main_pid(ssh, SERVER)
    repeat = play(ssh, 't3-headless.yml', t3_server_path=server)
    (ROOT / 't3-headless-repeat.log').write_text(repeat.stdout + repeat.stderr)
    assert 'changed=0' in repeat.stdout, 'a second t3-headless.yml run changed the worker'
    assert main_pid(ssh, SERVER) == pid, 'the T3 server restarted on a no-change run'
    play(ssh, 'recovery.yml', t3_unit=SERVER)
    user(ssh, 'systemctl --user is-active personal-worker-recovery.timer')
    # A killed process is restarted by its own unit (Restart=always) ...
    user(ssh, f'systemctl --user kill -s SIGKILL {SERVER}')
    wait_for(ssh, answers(SERVER), 60, 'the killed T3 server was not restarted')
    assert main_pid(ssh, SERVER) != pid, 'the killed T3 server process was not replaced'
    # ... and a stopped one by the recovery timer: every minute, the
    # documented bound, plus one run of the health script.
    user(ssh, f'systemctl --user stop {SERVER}')
    took = wait_for(ssh, answers(SERVER), 150, 'the recovery timer did not start the stopped T3 server')
    print(f'headless T3 server: no-op, killed process restarted, stopped server started by the timer in {took:.0f} s', flush=True)
    return {'server': server, 'version': version}


def after_headless_reboot(ssh, t3):
    """After a reboot nobody has logged in to: the server started with the
    user manager, before the SSH session that checks it."""
    wait_for(ssh, answers(SERVER), 120, 'the headless T3 server did not start after a reboot')
    started = int(user(ssh, f'systemctl --user show {SERVER} -p ActiveEnterTimestampMonotonic --value').stdout.strip())
    session = int(run(ssh + ['loginctl show-session "$XDG_SESSION_ID" -p TimestampMonotonic --value']).stdout.strip())
    assert 0 < started < session, 'the T3 server was not started before anyone logged in'
    run(ssh + ['test "$(loginctl show-user fleettest -p Linger --value)" = yes && test "$(cat ~/.t3/fleet-test-preserved)" = preserved'])
    for _ in range(30):
        policy = run(ssh + [f'{t3["server"]} policy show']).stdout
        if 'loaded this policy.' in policy:
            break
        time.sleep(1)
    (ROOT / 't3-policy-check.log').write_text(policy)
    assert 'loaded this policy.' in policy, 'running T3 did not load managed update policy'
    print('headless T3 server started at boot with nobody logged in and loaded the managed policy', flush=True)


def test_desktop(ssh, t3):
    """Opt-in: the same worker switched to the desktop session keeps ~/.t3,
    runs the desktop app in the auto-login session after a reboot, and the
    recovery timer starts a stopped app."""
    version, _, desktop_sha = pins()
    name = f'T3-Code-{version}-amd64.deb'
    package = ROOT / name
    download(f'https://github.com/pingdotgg/t3code/releases/download/v{version}/{name}', package, desktop_sha)
    run(ssh + ['sudo DEBIAN_FRONTEND=noninteractive apt-get install --yes ubuntu-desktop-minimal'])
    applied = play(ssh, 't3-desktop.yml', t3_desktop_url=f'https://github.com/pingdotgg/t3code/releases/download/v{version}/{name}', t3_desktop_name=name, t3_desktop_sha256=desktop_sha)
    (ROOT / 't3-desktop-first.log').write_text(applied.stdout + applied.stderr)
    run(ssh + [f'! test -e ~/.config/systemd/user/{SERVER} && test "$(cat ~/.t3/fleet-test-preserved)" = preserved'])
    # The app serves on loopback only whatever its desktop settings say.
    run(ssh + ['mkdir -p ~/.t3/userdata && echo \'{"serverExposureMode": "network-accessible"}\' > ~/.t3/userdata/desktop-settings.json'])
    reboot(ssh)
    wait_for(ssh, answers(APP), 300, 'the desktop app did not start in the auto-login session after a reboot')
    run(ssh + ['test "$(ss -H -l -n -t "sport = :3773" | awk \'{print $4}\' | sort -u)" = 127.0.0.1:3773'])
    # As fleet-sync does: recovery only once the app runs, which a desktop
    # worker does only after the reboot into its graphical session.
    play(ssh, 'recovery.yml')
    group = user(ssh, f'systemctl --user show {APP} -p ControlGroup --value').stdout.strip()
    renderers = '/sys/fs/cgroup' + group + '/renderers'
    wait_for(ssh, f'grep -q "[0-9]" {renderers}/cgroup.procs', 150,
             'desktop recovery did not place renderers in their own cgroup')
    policy = json.loads(Path('/workspace/ansible/ubuntu/policy.json').read_text())
    ceiling = policy['resourceSafety']['rendererMaxMiB'] * 1024**2
    run(ssh + [f'test "$(cat {renderers}/memory.max)" = {ceiling}'])
    # The recovery check may see the app stopping and start it again, which
    # cancels the stop job: that is the recovery this measures.
    user(ssh, f'systemctl --user stop {APP} 2>&1 | grep -v "^Job for {APP} canceled" || true')
    took = wait_for(ssh, answers(APP), 150, 'the recovery timer did not start the stopped desktop app')
    run(ssh + ['test "$(cat ~/.t3/fleet-test-preserved)" = preserved'])
    print(f'desktop T3 app: switched from headless keeping ~/.t3, auto-login after reboot, stopped app started by the timer in {took:.0f} s', flush=True)


def holds_tailnet_only(ssh):
    """Whether the loaded table drops the declared port in its input chain
    under the tailnet-only mark, read from the kernel and not from the file."""
    table = json.loads(run(ssh + ['sudo nft -j list table inet personal_fleet']).stdout)['nftables']
    for rule in (item['rule'] for item in table if 'rule' in item):
        if rule.get('comment') != 'tailnet-only' or rule.get('chain') != 'input':
            continue
        matches = [part['match'] for part in rule['expr'] if 'match' in part]
        if len(matches) == 1 and matches[0]['left'] == {'payload': {'protocol': 'tcp', 'field': 'dport'}} and matches[0]['right'] == TAILNET_ONLY_PORT and any('drop' in part for part in rule['expr']):
            return True
    return False


def listen(ssh, unit, ports):
    """A fixture service that listens on every IPv4 address, as a service
    that cannot bind one address does, and greets whoever reaches it."""
    script = f"""import selectors, socket, sys
waiting = selectors.DefaultSelector()
for port in sys.argv[1:]:
    listener = socket.socket()
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(('0.0.0.0', int(port)))
    listener.listen()
    waiting.register(listener, selectors.EVENT_READ)
while True:
    for key, _ in waiting.select():
        connection, _ = key.fileobj.accept()
        connection.sendall(b'{BANNER}\\n')
        connection.close()
"""
    subprocess.run(ssh + ['cat > exposure-fixture.py'], input=script.encode(), capture_output=True, check=True, timeout=60)
    user(ssh, f'systemd-run --user --unit={unit} /usr/bin/python3 -I -B {HOME}/exposure-fixture.py ' + ' '.join(str(port) for port in ports))
    for port in ports:
        wait_for(ssh, f'ss -H -l -n -t "sport = :{port}" | grep -q "0.0.0.0:{port}"', 30, f'the fixture did not listen on port {port}')


def exposure(ssh, **declared):
    """worker:exposure, the production check, run in the guest under a policy."""
    return json.loads(run(ssh + ['./verify exposure'], input=json.dumps({**EXPOSURE, **declared})).stdout)['check']


def greeted(port):
    """Whether the fixture answers on the guest's network interface: QEMU
    forwards the port from this container, so the connection arrives from
    outside the guest and outside any tailnet. QEMU accepts the connection
    itself, so only the fixture's greeting shows the guest let it in."""
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=10) as connection:
            connection.settimeout(10)
            return connection.recv(64).decode(errors='replace').strip() == BANNER
    except OSError:
        return False


def test_exposure(ssh):
    """A port declared in exposure.tailnetOnlyPorts on a booted machine: the
    production check passes for a listener on every address only because the
    loaded rule holds the port, and the port is closed on the guest's network
    interface. The default policy of the table would close it there alone;
    that the rule also closes it to containers is not shown here."""
    fixture = 'devfleet-exposure-fixture.service'
    unsynced = 'devfleet-exposure-unsynced.service'
    held = f'tcp 0.0.0.0:{TAILNET_ONLY_PORT} ({fixture})'
    listen(ssh, fixture, [TAILNET_ONLY_PORT, PUBLIC_PORT])
    try:
        # This guest has no tailnet, so the play kept SSH open and the check
        # says so. It is the only fault: the listeners are no part of it.
        check = exposure(ssh)
        assert check['status'] == 'fail' and check['summary'] == 'WORKER_PUBLIC_SSH_UNDECLARED', f'worker:exposure under the declared policy: {check["status"]}: {check["summary"]}'
        # With that one fact declared, as break-glass access would be:
        check = exposure(ssh, publicSsh=True)
        assert check['status'] == 'pass' and check['summary'].endswith(f'Its tailnet-only rules hold to loopback and the tailnet: {held}.'), f'worker:exposure did not pass for the listener on the tailnet-only port: {check["status"]}: {check["summary"]}'
        # Without the declaration the same listener is reported ...
        check = exposure(ssh, publicSsh=True, tailnetOnlyPorts=[])
        assert check['status'] == 'warn' and check['summary'] == f'WORKER_LISTENER_UNRESTRICTED {held}', f'worker:exposure for an undeclared listener: {check["status"]}: {check["summary"]}'
        # ... and a declared port passes by its loaded rule, not by being declared.
        listen(ssh, unsynced, [UNSYNCED_PORT])
        try:
            check = exposure(ssh, publicSsh=True, tailnetOnlyPorts=[*EXPOSURE['tailnetOnlyPorts'], {'protocol': 'tcp', 'port': UNSYNCED_PORT}])
            assert check['status'] == 'fail' and check['summary'] == f'WORKER_TAILNET_ONLY_RULE_MISSING tcp 0.0.0.0:{UNSYNCED_PORT} ({unsynced})', f'worker:exposure for a declared port with no loaded rule: {check["status"]}: {check["summary"]}'
        finally:
            subprocess.run(ssh + [f'XDG_RUNTIME_DIR=/run/user/1000 systemctl --user stop {unsynced}'], capture_output=True, timeout=20)
        # Loopback reaches the service; the network interface does not, while
        # the public port beside it, served by the same process, answers.
        run(ssh + [f'test "$(timeout 10 head -n 1 < /dev/tcp/127.0.0.1/{TAILNET_ONLY_PORT})" = {BANNER}'])
        assert greeted(PUBLIC_PORT), 'the public port did not answer on the guest network interface: the control connection failed'
        assert not greeted(TAILNET_ONLY_PORT), 'the tailnet-only port answered on the guest network interface'
    finally:
        subprocess.run(ssh + [f'XDG_RUNTIME_DIR=/run/user/1000 systemctl --user stop {fixture}'], capture_output=True, timeout=20)
    print('tailnet-only port: rule loaded at boot, worker:exposure passes for a listener on every address, closed on the network interface', flush=True)


def test_drift(ssh, command):
    # Disposable guest fault injection only. Repair uses the unchanged tracked
    # baseline, never a production one-off edit.
    run(ssh + ["sudo systemctl unmask sleep.target && printf '# Managed by personal Fleet; injected fixture drift\\nAllowTcpForwarding no\\n' | sudo tee /etc/ssh/sshd_config.d/60-personal-fleet.conf >/dev/null"])
    repaired = run(ssh + [command])
    (ROOT / 'drift-repair.log').write_text(repaired.stdout)
    run(ssh + ['test "$(systemctl is-enabled sleep.target)" = masked && sudo sshd -T | grep -qx "allowtcpforwarding yes"'])
    repeated = run(ssh + [command])
    (ROOT / 'drift-repeat.log').write_text(repeated.stdout + repeated.stderr)
    assert 'changed=0' in repeated.stdout, 'repaired baseline did not converge'
    # Simulate a resource-policy rejection without filling a disk or killing work.
    low_disk = subprocess.run(ssh + [command + ' --extra-vars \'{"worker_minimum_free_disk_mib":1000000000}\''], capture_output=True, text=True, timeout=120)
    (ROOT / 'capacity-refusal.log').write_text(low_disk.stdout + low_disk.stderr)
    assert low_disk.returncode != 0 and 'RESOURCE_CAPACITY_REQUIRED' in low_disk.stdout
    print('source-owned sleep/SSH drift repaired; injected capacity refusal preserved work', flush=True)


def test_agent(ssh):
    # No tailnet/production contact: this explicit fault fixture maps the private
    # hub name to guest loopback with no TLS listener. Service health is NOT
    # authenticated connection or fresh-metrics acceptance.
    run(ssh + ["grep -q 'fixture.fixture.ts.net' /etc/hosts || printf '127.0.0.1 fixture.fixture.ts.net\\n' | sudo tee -a /etc/hosts >/dev/null"])
    variables = json.dumps({'beszel_node': 'fixture-node', 'beszel_hub_url': 'https://fixture.fixture.ts.net:8443', 'beszel_public_key': (ROOT / 'host.pub').read_text().strip(), 'beszel_agent_token': 'disposable-fixture-not-a-live-credential'})
    # The agent play, with the lock and the unit it reads beside it.
    archive = subprocess.run(['tar', '-C', '/workspace/ansible/monitoring', '--exclude=./tests', '-cf', '-', '.'], capture_output=True, check=True).stdout
    subprocess.run(ssh + ['mkdir -p beszel/monitoring && tar -C beszel/monitoring -xf -'], input=archive, capture_output=True, check=True, timeout=60)
    command = 'cd beszel/monitoring && ~/verify agent'
    first = run(ssh + [command], input=variables)
    (ROOT / 'agent-first.log').write_text(first.stdout + first.stderr)
    pid = run(ssh + ['systemctl show beszel-agent.service --property=MainPID --value']).stdout.strip()
    second = run(ssh + [command], input=variables)
    (ROOT / 'agent-repeat.log').write_text(second.stdout + second.stderr)
    assert 'changed=0' in second.stdout
    assert run(ssh + ['systemctl show beszel-agent.service --property=MainPID --value']).stdout.strip() == pid, 'healthy agent restarted'
    # Repair owned, nonsecret configuration without replacing agent identity.
    run(ssh + ["printf 'HUB_URL=https://drift.fixture.ts.net:8443\\nSYSTEM_NAME=drift-node\\n' | sudo tee /etc/personal-beszel/agent.env >/dev/null"])
    repaired = run(ssh + [command], input=variables)
    (ROOT / 'agent-drift-repair.log').write_text(repaired.stdout + repaired.stderr)
    restored = run(ssh + ['sudo cat /etc/personal-beszel/agent.env']).stdout
    assert restored == 'HUB_URL=https://fixture.fixture.ts.net:8443\nSYSTEM_NAME=fixture-node\n', 'owned agent configuration drift was not repaired'
    repeated = run(ssh + [command], input=variables)
    assert 'changed=0' in repeated.stdout, 'agent drift repair did not converge'
    pid = run(ssh + ['systemctl show beszel-agent.service --property=MainPID --value']).stdout.strip()
    run(ssh + ["printf preserved | sudo tee /var/lib/beszel-agent/fixture-preserved >/dev/null && sudo systemctl kill --signal=SIGKILL beszel-agent.service"])
    for _ in range(30):
        current = run(ssh + ['systemctl show beszel-agent.service --property=MainPID --value']).stdout.strip()
        if current != '0' and current != pid:
            break
        time.sleep(1)
    assert current != '0' and current != pid, 'agent did not recover within restart bound'
    print('native agent no-op and bounded crash recovery passed; hub intentionally unreachable', flush=True)


if __name__ == '__main__':
    main()

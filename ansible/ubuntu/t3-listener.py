"""Identify the user unit that owns every T3 listener before desktop recovery."""
from pathlib import Path
import re
import subprocess
import sys

UNIT = 't3code-desktop.service'
DESKTOP = Path('/opt/T3 Code (Nightly)/t3code')
PREVIOUS = Path('/opt/T3 Code (Nightly).previous/t3code')


def property_value(unit, name):
    return subprocess.check_output(
        ['systemctl', '--user', 'show', unit, '-p', name, '--value'], text=True
    ).strip()


def process_owner(pid):
    group = Path('/proc', pid, 'cgroup').read_text().split('0::')[-1].strip()
    units = [part for part in group.split('/') if part.endswith(('.service', '.scope'))]
    unit = units[-1] if units else ''
    if unit == UNIT:
        return 'managed'
    if not re.fullmatch(r'app-com\.t3tools\.T3Code-[A-Za-z0-9_-]+\.scope', unit):
        return 'unknown'
    # Verify the scope in this user manager before addressing it by name.
    if property_value(unit, 'ControlGroup') != group:
        return 'unknown'
    members = (Path('/sys/fs/cgroup' + group) / 'cgroup.procs').read_text().split()
    main = property_value(UNIT, 'MainPID')
    for member in members:
        try:
            executable = Path('/proc', member, 'exe').readlink()
        except FileNotFoundError:
            continue
        if executable in (DESKTOP, PREVIOUS):
            # GNOME can move the managed Electron process into this scope.
            # systemd still supervises the original MainPID.
            return 'managed' if main in members else unit
    return 'unknown'


def listener_owner():
    rows = subprocess.check_output(['ss', '-Hlnpt', 'sport = :3773'], text=True)
    if not rows.strip():
        return 'free'
    owners = set()
    exposed = False
    for row in rows.splitlines():
        pids = re.findall(r'pid=(\d+)', row)
        if not pids:
            return 'unknown'
        owners.update(process_owner(pid) for pid in pids)
        address = row.split()[3].rsplit(':', 1)[0]
        exposed |= address not in ('127.0.0.1', '[::1]')
    if owners == {'managed'} and exposed:
        return 'exposed'
    return owners.pop() if len(owners) == 1 else 'unknown'


if __name__ == '__main__':
    try:
        owner = listener_owner()
    except (OSError, subprocess.SubprocessError, IndexError):
        owner = 'unknown'
    if sys.argv[1:] == ['--free']:
        sys.exit(0 if owner == 'free' else 1)
    print(owner)

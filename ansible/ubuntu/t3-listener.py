"""Identify the user unit that owns every T3 listener before desktop recovery."""
from pathlib import Path
import re
import subprocess
import sys


def scope():
    rows = subprocess.check_output(['ss', '-Hlnpt', 'sport = :3773'], text=True)
    if not rows.strip():
        return 'free'
    owners = set()
    for row in rows.splitlines():
        pids = re.findall(r'pid=(\d+)', row)
        if not pids:
            return 'unknown'
        for pid in pids:
            group = Path('/proc', pid, 'cgroup').read_text().split('0::')[-1].strip()
            units = [part for part in group.split('/') if part.endswith(('.service', '.scope'))]
            unit = units[-1] if units else ''
            if unit == 't3code-desktop.service':
                owners.add('managed' if row.split()[3].rsplit(':', 1)[0] in
                           ('127.0.0.1', '[::1]') else 'exposed')
            elif re.fullmatch(r'app-com\.t3tools\.T3Code-[A-Za-z0-9_-]+\.scope', unit):
                # Verify the session manager resolves this name to this exact
                # group and that the installed desktop is running inside it.
                path = subprocess.check_output(['systemctl', '--user', 'show', unit,
                                                '-p', 'ControlGroup', '--value'], text=True).strip()
                if not path or group != path:
                    return 'unknown'
                members = (Path('/sys/fs/cgroup' + path) / 'cgroup.procs').read_text().split()
                for member in members:
                    try:
                        executable = Path('/proc', member, 'exe').readlink()
                    except FileNotFoundError:
                        continue
                    if executable == Path('/opt/T3 Code (Nightly)/t3code'):
                        break
                else:
                    return 'unknown'
                owners.add(unit)
            else:
                return 'unknown'
    if owners == {'managed', 'exposed'}:
        return 'exposed'
    return owners.pop() if len(owners) == 1 else 'unknown'


if __name__ == '__main__':
    try:
        owner = scope()
    except (OSError, subprocess.SubprocessError):
        owner = 'unknown'
    if sys.argv[1:] == ['--free']:
        sys.exit(0 if owner == 'free' else 1)
    print(owner)

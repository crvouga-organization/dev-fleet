#!/usr/bin/python3
"""Place only Electron renderers in the desktop service's delegated subgroup."""
import argparse
import os
from pathlib import Path
import sys


def assign(unit, proc, high, maximum):
    # DelegateSubgroup=app keeps the unit root free of processes so its memory
    # controller can be enabled. Older running units adopt this at next start.
    app = unit / 'app'
    if not app.is_dir():
        return
    if 'memory' not in (unit / 'cgroup.subtree_control').read_text().split():
        (unit / 'cgroup.subtree_control').write_text('+memory')
    renderers = unit / 'renderers'
    renderers.mkdir(exist_ok=True)
    for name, limit in [('memory.high', high), ('memory.max', maximum)]:
        path = renderers / name
        if path.read_text().strip() != str(limit):
            with open(os.open(path, os.O_WRONLY | os.O_NONBLOCK), 'w') as control:
                control.write(str(limit))
    for pid in (app / 'cgroup.procs').read_text().split():
        try:
            process = proc / pid
            if b'--type=renderer' not in (process / 'cmdline').read_bytes().split(b'\0'):
                continue
            # Confirm membership again after reading the process arguments.
            if (process / 'cgroup').read_text().strip().split('::')[-1] != ('/' + str(app.relative_to('/sys/fs/cgroup'))):
                continue
            (renderers / 'cgroup.procs').write_text(pid)
        except (FileNotFoundError, ProcessLookupError):
            continue


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('group')
    parser.add_argument('high', type=int)
    parser.add_argument('maximum', type=int)
    args = parser.parse_args()
    group = Path(args.group)
    if not group.is_absolute() or '..' in group.parts or group.name != 't3code-desktop.service':
        return 1
    assign(Path('/sys/fs/cgroup') / str(group).lstrip('/'), Path('/proc'),
           args.high * 1024**2, args.maximum * 1024**2)
    return 0


if __name__ == '__main__':
    sys.exit(main())

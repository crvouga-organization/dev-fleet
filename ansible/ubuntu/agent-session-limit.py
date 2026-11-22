#!/usr/bin/python3
"""Hold the kernel's limit on the agent scopes of this user's T3.

T3 starts each agent in a scope of the slice it owns,
app-t3code-agents-<id>.slice, which exists only while an agent runs. systemd
has no property that counts the scopes of a slice, so this writes the
kernel's own: cgroup.max.descendants of that slice. The user manager owns the
slice, so its user writes it and root does not. The slice T3 probes scope
support in and starts terminals in, app-t3code-agents.slice, is left alone.
Stopping puts every slice back to "max".
"""
import argparse
from pathlib import Path
import re
import signal
import time

AGENTS = 'app.slice/app-t3code.slice/app-t3code-agents.slice'
OWNED = 'app-t3code-agents-*.slice'
ATTRIBUTE = 'cgroup.max.descendants'


def manager_root(cgroup, mount):
    """The cgroup of the user manager this process runs under."""
    for line in cgroup.read_text().splitlines():
        match = re.match(r'0::(/.*?user@\d+\.service)(?:/|$)', line)
        if match:
            return mount / match.group(1).lstrip('/')
    raise ValueError('not under a user manager')


def hold(root, value):
    """Writes the limit where it differs; returns the slices written."""
    written = []
    for owned in sorted((root / AGENTS).glob(OWNED)):
        attribute = owned / ATTRIBUTE
        try:
            if attribute.read_text().strip() != value:
                attribute.write_text(value)
                written.append(owned.name)
        except OSError:
            # The slice ended between the listing and the write.
            continue
    return written


class Stop(Exception):
    pass


def stop(*_):
    raise Stop


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--limit', type=int, required=True)
    parser.add_argument('--interval', type=float, required=True)
    parser.add_argument('--cgroup', type=Path, default=Path('/proc/self/cgroup'))
    parser.add_argument('--mount', type=Path, default=Path('/sys/fs/cgroup'))
    parser.add_argument('--once', action='store_true')
    args = parser.parse_args()
    if args.limit < 1:
        parser.error('a limit below 1 would refuse every agent')
    root = manager_root(args.cgroup, args.mount)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        while True:
            for name in hold(root, str(args.limit)):
                print(f'agent_session_limit slice={name} descendants={args.limit}',
                      flush=True)
            if args.once:
                return
            time.sleep(args.interval)
    except Stop:
        hold(root, 'max')


if __name__ == '__main__':
    main()

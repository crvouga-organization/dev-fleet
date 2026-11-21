#!/usr/bin/python3
"""Shed one T3 agent scope after sustained I/O or memory pressure."""
import argparse
import json
from pathlib import Path
import time


def pressure(path):
    for line in path.read_text().splitlines():
        kind, *fields = line.split()
        if kind == 'full':
            return float(dict(field.split('=') for field in fields)['avg10'])
    raise ValueError('full pressure unavailable')


def largest_scope(tree):
    best = None
    largest = 0
    for scope in tree.rglob('t3code-*.scope'):
        try:
            # A scope with delegated descendants is not a leaf.
            if any(child.is_dir() for child in scope.iterdir()):
                continue
            size = int((scope / 'memory.current').read_text())
            size += int((scope / 'memory.swap.current').read_text())
        except (OSError, ValueError):
            continue
        if size > largest:
            largest, best = size, scope
    return best, largest


class Guard:
    def __init__(self):
        self.since = None
        self.next_action = 0

    def sample(self, args, now):
        io = pressure(args.proc / 'pressure/io')
        memory = pressure(args.proc / 'pressure/memory')
        if max(io, memory) < args.threshold:
            self.since = None
            if args.marker and not args.dry_run:
                args.marker.unlink(missing_ok=True)
            return
        if self.since is None:
            self.since = now
        if now - self.since < args.duration:
            return
        if args.marker and not args.dry_run:
            args.marker.touch()
        if now < self.next_action:
            return
        scope, size = largest_scope(args.agent_tree)
        if scope is None:
            return
        if not args.dry_run:
            (scope / 'cgroup.kill').write_text('1')
        self.next_action = now + args.cooldown
        print(json.dumps(dict(event='agent_pressure', scope=scope.name,
                              bytes=size, io=io, memory=memory,
                              dry_run=args.dry_run)), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--proc', type=Path, default=Path('/proc'))
    parser.add_argument('--agent-tree', type=Path, required=True)
    parser.add_argument('--threshold', type=float, required=True)
    parser.add_argument('--duration', type=int, required=True)
    parser.add_argument('--cooldown', type=int, required=True)
    parser.add_argument('--interval', type=int, required=True)
    parser.add_argument('--marker', type=Path)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    guard = Guard()
    while True:
        try:
            guard.sample(args, time.monotonic())
        except (OSError, KeyError, ValueError):
            guard.since = None
            if args.marker and not args.dry_run:
                args.marker.unlink(missing_ok=True)
        time.sleep(args.interval)


if __name__ == '__main__':
    main()

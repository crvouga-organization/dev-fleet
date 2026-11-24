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


def io_bytes(group):
    devices = {}
    for line in (group / 'io.stat').read_text().splitlines():
        if not line.strip():
            continue
        device, *fields = line.split()
        values = dict(field.split('=') for field in fields)
        if 'rbytes' in values and 'wbytes' in values:
            devices[device] = int(values['rbytes']) + int(values['wbytes'])
    return devices


def io_delta(previous, current):
    # A new device or a counter reset cannot establish an interval of activity.
    return {device: count - previous[device] for device, count in current.items()
            if device in previous and count > previous[device]}


class Guard:
    def __init__(self):
        self.since = {}
        self.next_action = 0
        self.previous = {}

    def sample(self, args, now):
        io = pressure(args.proc / 'pressure/io')
        memory = pressure(args.proc / 'pressure/memory')
        active = {}
        counters = {}
        candidates = []

        def sustained(key):
            active[key] = self.since.get(key, now)
            return now - active[key] >= args.duration

        memory_due = memory >= args.threshold and sustained('memory')
        io_due = io >= args.threshold and sustained('io')
        if io >= args.threshold:
            try:
                counters['host'] = io_bytes(args.cgroup_root)
            except (OSError, ValueError, KeyError):
                pass
        host_delta = io_delta(self.previous.get('host', {}), counters.get('host', {}))
        if memory_due or io >= args.threshold:
            for scope in args.agent_tree.rglob('t3code-*.scope'):
                try:
                    if any(child.is_dir() for child in scope.iterdir()):
                        continue
                    size = int((scope / 'memory.current').read_text())
                    size += int((scope / 'memory.swap.current').read_text())
                    if memory_due:
                        candidates.append((size, scope, dict(reason='memory', bytes=size)))
                        continue
                    local = pressure(scope / 'io.pressure')
                    current = io_bytes(scope)
                    counters[scope] = current
                    if local < args.threshold:
                        continue
                    for device, count in io_delta(self.previous.get(scope, {}), current).items():
                        host = host_delta.get(device, 0)
                        # PSI alone would select a reader blocked behind another
                        # writer. Require both local stalls and a majority of the
                        # device's traffic in every interval of the grace period.
                        if 0 < count <= host and 2 * count > host and sustained((scope, device)):
                            evidence = dict(reason='io', device=device, bytes=size, io_bytes=count,
                                            device_bytes=host, scope_psi=local)
                            candidates.append((count, scope, evidence))
                except (OSError, ValueError, KeyError):
                    continue
        self.previous = counters
        self.since = active
        if args.marker and not args.dry_run:
            if memory_due or io_due:
                args.marker.touch()
            else:
                args.marker.unlink(missing_ok=True)
        if not candidates or now < self.next_action:
            return
        _, scope, evidence = max(candidates, key=lambda item: (item[0], item[1]))
        if not args.dry_run:
            (scope / 'cgroup.kill').write_text('1')
        self.next_action = now + args.cooldown
        print(json.dumps(dict(event='agent_pressure', scope=scope.name, io=io,
                              memory=memory, dry_run=args.dry_run, **evidence)), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--proc', type=Path, default=Path('/proc'))
    parser.add_argument('--cgroup-root', type=Path, default=Path('/sys/fs/cgroup'))
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
            guard.since.clear()
            guard.previous.clear()
            if args.marker and not args.dry_run:
                args.marker.unlink(missing_ok=True)
        time.sleep(args.interval)


if __name__ == '__main__':
    main()

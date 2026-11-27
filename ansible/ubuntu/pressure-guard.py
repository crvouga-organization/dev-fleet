#!/usr/bin/python3
"""Shed one T3 agent or transient user job after sustained CPU, I/O or memory pressure."""
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


def cpu_use(group):
    # usage_usec is cumulative. A counter that went backwards is a reset.
    value = int((group / 'cpu.stat').read_text().split('usage_usec ', 1)[1].split()[0])
    return value if value >= 0 else None


def cpu_delta(previous, current):
    return {group: count - previous[group] for group, count in current.items()
            if group in previous and count > previous[group]}


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


def workloads(args):
    yield from args.agent_tree.rglob('t3code-*.scope')
    # The drop-ins place new transient units in the shared slice. Jobs that
    # predate the policy can still be direct children of app.slice.
    for tree in (args.agent_tree, args.app_tree):
        if tree is not None:
            yield from tree.glob('run-*.service')
            yield from tree.glob('run-*.scope')


class Guard:
    def __init__(self):
        self.since = {}
        self.next_action = 0
        self.previous = {}
        self.cpu = {}
        self.sampled_at = None

    def sample(self, args, now):
        io = pressure(args.proc / 'pressure/io')
        memory = pressure(args.proc / 'pressure/memory')
        try:
            cpu = pressure(args.proc / 'pressure/cpu')
        except (OSError, ValueError, KeyError):
            cpu = 0
        elapsed = now - self.sampled_at if self.sampled_at is not None else 0
        self.sampled_at = now
        active = {}
        counters = {}
        cpu_use_now = {}
        candidates = []

        def sustained(key):
            active[key] = self.since.get(key, now)
            return now - active[key] >= args.duration

        memory_due = memory >= args.threshold and sustained('memory')
        io_due = io >= args.threshold and sustained('io')
        cpu_due = cpu >= args.cpu_threshold and sustained('cpu')
        if io >= args.threshold:
            try:
                counters['host'] = io_bytes(args.cgroup_root)
            except (OSError, ValueError, KeyError):
                pass
        host_delta = io_delta(self.previous.get('host', {}), counters.get('host', {}))
        if memory_due or io >= args.threshold or cpu >= args.cpu_threshold:
            for scope in workloads(args):
                try:
                    if any(child.is_dir() for child in scope.iterdir()):
                        continue
                    size = int((scope / 'memory.current').read_text())
                    size += int((scope / 'memory.swap.current').read_text())
                    if memory_due:
                        candidates.append((size, scope, dict(reason='memory', bytes=size)))
                        continue
                    if cpu >= args.cpu_threshold:
                        used = cpu_use(scope)
                        cpu_use_now[scope] = used
                        spent = cpu_delta(self.cpu, {scope: used}).get(scope, 0)
                        # Every interval of the grace period, not the average:
                        # a scope that spiked once is not the one saturating the host.
                        # The streak starts with the host's, so both are due together.
                        if (elapsed > 0
                                and spent >= args.cpu_threshold / 100 * elapsed * 1_000_000
                                and sustained((scope, 'cpu'))
                                and cpu_due):
                            candidates.append((spent, scope, dict(
                                reason='cpu', bytes=size, cpu_usec=spent)))
                    if cpu_due:
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
                        # A cgroup counts a write when it is submitted and the
                        # device when it completes, so a slow writer's count can
                        # run ahead of the device's: that is still a majority.
                        if count > 0 and 2 * count > host and sustained((scope, device)):
                            evidence = dict(reason='io', device=device, bytes=size, io_bytes=count,
                                            device_bytes=host, scope_psi=local)
                            candidates.append((count, scope, evidence))
                except (OSError, ValueError, KeyError):
                    continue
        self.previous = counters
        self.cpu = cpu_use_now
        self.since = active
        if args.marker and not args.dry_run:
            if memory_due or io_due or cpu_due:
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
                              memory=memory, cpu=cpu, dry_run=args.dry_run, **evidence)), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--proc', type=Path, default=Path('/proc'))
    parser.add_argument('--cgroup-root', type=Path, default=Path('/sys/fs/cgroup'))
    parser.add_argument('--agent-tree', type=Path, required=True)
    parser.add_argument('--app-tree', type=Path)
    parser.add_argument('--threshold', type=float, required=True)
    parser.add_argument('--cpu-threshold', type=float, required=True)
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
            guard.cpu.clear()
            guard.sampled_at = None
            if args.marker and not args.dry_run:
                args.marker.unlink(missing_ok=True)
        time.sleep(args.interval)


if __name__ == '__main__':
    main()

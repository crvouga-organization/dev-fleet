import policy from '../../ansible/ubuntu/policy.json';
import { threshold } from '../worker-sizing';
import type { Check, Runner } from '../types';

const AGENT_DROP_IN =
  '/etc/systemd/user/t3code-.scope.d/60-personal-fleet.conf';
const GUARDS = {
  'systemd-oomd.service': 'OOMD_INACTIVE',
  'personal-fleet-pressure-guard.service': 'PRESSURE_GUARD_INACTIVE',
  'personal-fleet-disk-guard.service': 'DISK_GUARD_INACTIVE',
  'personal-fleet-disk-gc.timer': 'DISK_GC_TIMER_MISSING',
};
const MIB = 1024 * 1024;

/** A failure code and remedy, or undefined when the probe passes. */
type Probe = (run: Runner) => Promise<[string, string] | undefined>;

const guardsRunning: Probe = async (run) => {
  for (const [unit, code] of Object.entries(GUARDS)) {
    const active = await run(['systemctl', 'is-active', unit]);
    if (!active.ok || active.stdout.trim() !== 'active')
      return [
        code,
        `${unit} is not running. Reapply fleet-sync; runaway memory or disk use is unguarded until then.`,
      ];
  }
  const timer = await run([
    'systemctl',
    'is-enabled',
    'personal-fleet-disk-gc.timer',
  ]);
  if (!timer.ok || timer.stdout.trim() !== 'enabled')
    return [
      'DISK_GC_TIMER_MISSING',
      'Run fleet-sync for this worker to enable its hourly disk GC timer.',
    ];
  return diskGcRecent(run);
};

async function timerTimestamp(run: Runner, kind: string, field: string) {
  const result = await run([
    'busctl',
    'get-property',
    'org.freedesktop.systemd1',
    '/org/freedesktop/systemd1/unit/personal_2dfleet_2ddisk_2dgc_2etimer',
    'org.freedesktop.systemd1.' + kind,
    field,
  ]);
  return result.ok
    ? Number(/^t (\d+)$/.exec(result.stdout.trim())?.[1]) / 1000000
    : NaN;
}

const diskGcRecent: Probe = async (run) => {
  const last = await timerTimestamp(run, 'Timer', 'LastTriggerUSec');
  const since =
    last === 0
      ? await timerTimestamp(run, 'Unit', 'ActiveEnterTimestamp')
      : last;
  const clock = await run(['date', '+%s']);
  const service = await run([
    'systemctl',
    'show',
    'personal-fleet-disk-gc.service',
    '--property=Result',
    '--value',
  ]);
  const age = Number(clock.stdout.trim()) - since;
  if (
    !clock.ok ||
    !service.ok ||
    service.stdout.trim() !== 'success' ||
    !(age >= 0 && age <= 7200)
  )
    return [
      'DISK_GC_RUN_STALE',
      'Inspect the disk GC service journal and run fleet-sync for this worker.',
    ];
  return undefined;
};

const memoryReserved: Probe = async (run) => {
  const show = (property: string, unit: string) =>
    run(['systemctl', 'show', `--property=${property}`, '--', unit]);
  const user = await show('MemoryMax', 'user.slice');
  const root = await show('ManagedOOMSwap', '-.slice');
  const ok =
    /^MemoryMax=\d+$/m.test(user.stdout) &&
    /^ManagedOOMSwap=kill$/m.test(root.stdout);
  return ok
    ? undefined
    : [
        'MEMORY_RESERVE_MISSING',
        'User workloads are not capped below physical memory, or swap exhaustion is unmanaged. Reapply fleet-sync.',
      ];
};

const agentsBounded: Probe = async (run) =>
  (await run(['test', '-f', AGENT_DROP_IN])).ok
    ? undefined
    : [
        'AGENT_MEMORY_LIMIT_MISSING',
        'T3 agent scopes have no per-agent memory limit. Reapply fleet-sync; new agents pick it up without restarts.',
      ];

const agentSliceBounded: Probe = async (run) => {
  const [slice, memory] = await Promise.all([
    run([
      'systemctl',
      '--user',
      'show',
      'app-t3code-agents.slice',
      '--property=LoadState,MemoryHigh,MemoryMax,MemorySwapMax,TasksMax,CPUWeight,IOWeight',
    ]),
    run(['cat', '/proc/meminfo']),
  ]);
  const fields = Object.fromEntries(
    slice.stdout
      .trim()
      .split('\n')
      .map((line) => line.split('='))
  );
  if (!slice.ok || fields['LoadState'] !== 'loaded')
    return [
      'AGENT_SLICE_MISSING',
      'Run fleet-sync and verify T3 uses app-t3code-agents.slice.',
    ];
  const mib = Math.floor(
    Number(/^MemTotal:\s+(\d+) kB$/m.exec(memory.stdout)?.[1]) / 1024
  );
  const limits = policy.resourceSafety.agentSlice;
  const expected = {
    MemoryHigh: Math.floor((mib * limits.highPercent) / 100) * MIB,
    MemoryMax: Math.floor((mib * limits.maxPercent) / 100) * MIB,
    MemorySwapMax: limits.swapMiB * MIB,
    TasksMax: limits.tasks,
    CPUWeight: limits.weight,
    IOWeight: limits.weight,
  };
  if (
    !memory.ok ||
    !Object.entries(expected).every(
      ([key, value]) => Number(fields[key]) === value
    )
  )
    return [
      'AGENT_LIMIT_OVERRIDDEN',
      'Run fleet-sync to restore the aggregate T3 agent limits, then inspect higher-priority drop-ins if the check still fails.',
    ];
  return undefined;
};

const swapActive: Probe = async (run) => {
  // /proc/swaps, not swapon: /usr/sbin is not on the remote worker PATH.
  const swaps = await run(['cat', '/proc/swaps']);
  const rows = swaps.stdout
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/));
  if (!swaps.ok || !rows.length)
    return [
      'SWAP_MISSING',
      'Reapply fleet-sync with enough free disk for overflow swap.',
    ];
  const zram = policy.resourceSafety.zram;
  const priority = (row: string[]) => Number(row[4]);
  const primary = rows.find((row) => row[0] === '/dev/zram0');
  if (
    !primary ||
    priority(primary) !== zram.priority ||
    rows.some((row) => row !== primary && priority(row) >= zram.priority)
  )
    return [
      'ZRAM_PRIORITY_MISMATCH',
      'Run fleet-sync and inspect dev-zram0.swap and the priority of the disk swap.',
    ];
  const tuning = await run([
    'cat',
    '/proc/sys/vm/swappiness',
    '/proc/sys/vm/page-cluster',
  ]);
  if (
    !tuning.ok ||
    tuning.stdout.trim() !== [zram.swappiness, zram.pageCluster].join('\n')
  )
    return [
      'ZRAM_RECLAIM_MISMATCH',
      'Run fleet-sync to restore the reclaim settings for compressed swap.',
    ];
  return undefined;
};

/** The disk guard's floor scales with the filesystem
 * (`sizing.thresholds.diskGuardFloor`); one of unknown size gets the upper
 * bound. */
const diskAboveFloor =
  (path: string): Probe =>
  async (run) => {
    const df = await run(['df', '--output=avail,size', '-B1', path]);
    const [free, size] = (df.stdout.trim().split('\n').at(-1) ?? '')
      .trim()
      .split(/\s+/)
      .map(Number);
    if (!df.ok || free === undefined || !Number.isSafeInteger(free))
      return ['DISK_FREE_UNREADABLE', `Free space on ${path} is unreadable.`];
    const floor = threshold(
      'diskGuardFloor',
      size !== undefined && Number.isSafeInteger(size)
        ? Math.floor(size / MIB)
        : Number.MAX_SAFE_INTEGER
    );
    if (free >= floor * MIB) return undefined;
    return [
      'DISK_FREE_BELOW_FLOOR',
      `${path} has ${Math.floor(free / MIB)} MiB free, under the ${floor} MiB floor. The disk GC already removed idle build output and caches; remove stale worktrees or data, or run "sudo systemctl start personal-fleet-disk-gc.service" and read its journal.`,
    ];
  };

/** Free space cannot show this: /tmp is RAM-backed with a per-user quota, so a
 * write fails while the filesystem still reports room. Probe a real 1 MiB write.
 */
const tmpWritable: Probe = async (run) =>
  (
    await run([
      'sh',
      '-c',
      'f=$(mktemp /tmp/personal-fleet-probe.XXXXXX) || exit 1; head -c 1048576 /dev/zero >"$f"; s=$?; rm -f -- "$f"; exit "$s"',
    ])
  ).ok
    ? undefined
    : [
        'TMP_QUOTA_EXHAUSTED',
        'This user cannot write to /tmp (full, or its per-user quota is used up), so agents and builds fail. The guard never deletes files; remove stale caches and scratch directories under /tmp.',
      ];

/** Measured memory and disk safety on an Ubuntu worker: the running managers,
 * not the files Ansible wrote. Free space below the guard floor fails because
 * what is left after the disk GC is work a person must decide about.
 */
export async function verifyResourceSafety(
  home: string,
  run: Runner
): Promise<Check[]> {
  const probes = [
    guardsRunning,
    memoryReserved,
    agentsBounded,
    agentSliceBounded,
    swapActive,
    diskAboveFloor('/'),
    diskAboveFloor(home),
    tmpWritable,
  ];
  for (const probe of probes) {
    const failure = await probe(run);
    if (failure)
      return [
        {
          id: 'ubuntu:resource-safety',
          status: 'fail',
          summary: failure[0],
          remedy: { action: failure[1] },
        },
      ];
  }
  return [
    {
      id: 'ubuntu:resource-safety',
      status: 'pass',
      summary:
        'systemd-oomd, the disk guard and the disk GC timer are running, user workloads are capped below physical memory, T3 agents have per-agent limits, swap is active, free disk is above the guard floor and /tmp is writable.',
    },
  ];
}

async function groupProtected(group: string, run: Runner): Promise<boolean> {
  const read = (file: string) =>
    run(['cat', '/sys/fs/cgroup' + group + '/' + file]);
  const [cpu, io, memory] = await Promise.all([
    read('cpu.weight'),
    read('io.weight'),
    read('memory.low'),
  ]);
  return (
    cpu.ok &&
    io.ok &&
    memory.ok &&
    Number(cpu.stdout.trim()) >= 1000 &&
    Number(/^default (\d+)$/m.exec(io.stdout)?.[1]) >= 1000 &&
    Number(memory.stdout.trim()) >= policy.sizing.t3ReservedMiB * MIB
  );
}

/** Measure the listener itself: Electron can leave the service's cgroup. */
export async function t3Protection(port: number, run: Runner): Promise<Check> {
  const listener = await run(['ss', '-Hltnp', 'sport', '=', String(port)]);
  const pid = listener.ok && /\bpid=(\d+)\b/.exec(listener.stdout)?.[1];
  let protectedServer = false;
  if (pid) {
    const membership = await run(['cat', `/proc/${pid}/cgroup`]);
    const group = /^0::(\/[^\n]*)$/m.exec(membership.stdout)?.[1];
    if (membership.ok && group && !group.split('/').includes('..'))
      protectedServer = await groupProtected(group, run);
  }
  return protectedServer
    ? {
        id: 'worker:t3-protection',
        status: 'pass',
        summary: 'The T3 listener has its CPU, I/O and memory reserve.',
      }
    : {
        id: 'worker:t3-protection',
        status: 'fail',
        summary: 'T3_PROTECTION_ESCAPED',
        remedy: {
          action:
            'Run fleet-sync on this worker and check the cgroup of the T3 listener after its next idle restart.',
        },
      };
}

export async function pressureEvents(run: Runner): Promise<Check> {
  const id = 'worker:pressure-events';
  const events = await run([
    'sudo',
    '-n',
    'journalctl',
    '--quiet',
    '--unit=personal-fleet-pressure-guard.service',
    '--since=24 hours ago',
    '--output=cat',
    '--grep="event": "agent_pressure"',
    '--lines=1000',
  ]);
  // journalctl returns 1 when --grep found no entries. Avoid treating an
  // authorization or journal failure as evidence that no agents were stopped.
  if (!events.ok && (events.stderr.trim() || events.reason !== 'exit'))
    return {
      id,
      status: 'warn',
      summary: 'Recent pressure guard activity could not be read.',
    };
  const count = events.stdout
    .split('\n')
    .filter((line) => line.includes('"event": "agent_pressure"')).length;
  return {
    id,
    status: count ? 'warn' : 'pass',
    summary: `The pressure guard stopped ${count} agent scopes in the last 24 hours.`,
  };
}

export async function rendererCheck(run: Runner): Promise<Check> {
  const id = 'worker:t3-renderers';
  const unit = await run([
    'systemctl',
    '--user',
    'show',
    't3code-desktop.service',
    '--property=ControlGroup',
    '--value',
  ]);
  const group = unit.stdout.trim();
  if (
    unit.ok &&
    /^\/(?:[\w@.:-]+\/)*t3code-desktop\.service$/.test(group) &&
    !group.split('/').includes('..')
  ) {
    const read = (name: string) =>
      run(['cat', '/sys/fs/cgroup' + group + '/renderers/' + name]);
    const [current, high, max] = await Promise.all([
      read('memory.current'),
      read('memory.high'),
      read('memory.max'),
    ]);
    if (
      current.ok &&
      high.ok &&
      max.ok &&
      Number(high.stdout) === policy.resourceSafety.rendererHighMiB * MIB &&
      Number(max.stdout) === policy.resourceSafety.rendererMaxMiB * MIB
    ) {
      const used = Number(current.stdout.trim());
      if (Number.isSafeInteger(used) && used >= 0)
        return used <= Number(high.stdout)
          ? {
              id,
              status: 'pass',
              summary: 'Desktop renderer memory is within its budget.',
            }
          : {
              id,
              status: 'warn',
              summary: 'T3_RENDERERS_HIGH',
              remedy: {
                action: 'Reload desktop T3 when no agent turn is running.',
              },
            };
    }
  }
  return {
    id,
    status: 'warn',
    summary: 'T3_RENDERER_LIMIT_UNVERIFIED',
    remedy: {
      action:
        'Apply fleet-sync and check the renderer subgroup after the desktop service next restarts and its recovery timer runs.',
    },
  };
}

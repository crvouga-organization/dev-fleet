import { isIP } from 'node:net';
import policy from '../ansible/ubuntu/policy.json';
import { record } from './config';
import type { PublicPort, WorkerExposure } from './exposure';
import type { Check, Runner, Status } from './types';
import { fleetJson } from './fleet-config';

/** The beszel agent's port: it opens no listener (DISABLE_SSH), so one
 * listening on it is never the fleet's intention. */
export const MONITORING_AGENT_PORT = 45876;
/** The fleet's own services: a listener of theirs beyond loopback and the
 * tailnet always fails, whatever the policy says of other listeners. T3 is
 * the desktop app on a desktop worker and the server on a headless one. */
const FLEET_UNITS = [
  't3code-desktop.service',
  't3code-headless.service',
  'beszel-agent.service',
];
/** The scope the desktop app's main process and its server move into. */
const T3_APP_SCOPE = /^app-com\.t3tools\.T3Code-\d+\.scope$/;
const fleetUnit = (unit: string) =>
  FLEET_UNITS.includes(unit) || T3_APP_SCOPE.test(unit);
/** The scope T3 starts each agent in (`t3code-<agent>-<id>.scope`): what
 * listens there was started by an agent, not by the fleet. */
const AGENT_SCOPE = /^t3code-[\w-]+\.scope$/;
/** The table tasks/firewall.yml loads. */
export const FIREWALL_TABLE = ['inet', 'personal_fleet'];

export interface Listener {
  protocol: 'tcp' | 'udp';
  /** The bound address without its port: `0.0.0.0`, `::`, `127.0.0.1`. */
  address: string;
  /** The interface the socket is bound to (`%lo`), when it is. */
  device?: string;
  port: number;
  pids: number[];
}

/** `0.0.0.0:22`, `[::]:22`, `127.0.0.53%lo:53`, `*:68`: the address, the
 * interface it is bound to and the port. */
function localAddress(
  local: string
): { address: string; device?: string; port: number } | null {
  const colon = local.lastIndexOf(':');
  const port = Number(local.slice(colon + 1));
  if (colon < 1 || !Number.isInteger(port) || port < 1 || port > 65535)
    return null;
  const [bound = '', device] = local.slice(0, colon).split('%');
  const address = bound.replace(/^\[|\]$/g, '');
  return {
    address: address === '*' ? '0.0.0.0' : address,
    ...(device && /^[\w.@*-]{1,32}$/.test(device) ? { device } : {}),
    port,
  };
}

/** Listening TCP and UDP sockets from `ss -H -l -n -t -u -p`. */
export function parseListeners(text: string): Listener[] {
  const listeners: Listener[] = [];
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/);
    const protocol = fields[0];
    if (protocol !== 'tcp' && protocol !== 'udp') continue;
    const local = localAddress(fields[4] ?? '');
    if (!local) continue;
    const pids = [
      ...fields
        .slice(6)
        .join(' ')
        .matchAll(/pid=(\d+)/g),
    ].map((match) => Number(match[1]));
    listeners.push({ protocol, ...local, pids: [...new Set(pids)] });
  }
  return listeners;
}

interface Interface {
  name: string;
  addresses: { address: string; scope: string }[];
}

function parseInterfaces(text: string): Interface[] | null {
  try {
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value)) return null;
    return value.filter(record).map((entry) => ({
      name: typeof entry['ifname'] === 'string' ? entry['ifname'] : '',
      addresses: (Array.isArray(entry['addr_info']) ? entry['addr_info'] : [])
        .filter(record)
        .map((info) => ({
          address: typeof info['local'] === 'string' ? info['local'] : '',
          scope: typeof info['scope'] === 'string' ? info['scope'] : '',
        })),
    }));
  } catch {
    return null;
  }
}

/** `docker0`, `br-*`: an interface pattern of the policy, with `*` at its end. */
function matchesInterface(name: string, patterns: string[]): boolean {
  return patterns.some((pattern) =>
    pattern.endsWith('*')
      ? name.startsWith(pattern.slice(0, -1))
      : name === pattern
  );
}

const exposure = policy.exposure;
const internal = (name: string) =>
  name === 'lo' ||
  name === exposure.tailnetInterface ||
  matchesInterface(name, exposure.containerInterfaces);

export function isLoopback(address: string): boolean {
  return (
    /^127\./.test(address) ||
    address === '::1' ||
    /^::ffff:127\./i.test(address)
  );
}

/** Tailscale's ranges: 100.64.0.0/10 and fd7a:115c:a1e0::/48. */
export function isTailnet(address: string): boolean {
  const v4 = /^(?:::ffff:)?100\.(\d+)\./i.exec(address);
  if (v4) {
    const second = Number(v4[1]);
    return second >= 64 && second <= 127;
  }
  return /^fd7a:115c:a1e0:/i.test(address);
}

/** The addresses this worker has outside loopback, the tailnet and its
 * container bridges: where traffic from outside the tailnet arrives. */
export function outsideAddresses(interfaces: Interface[]): string[] {
  return interfaces
    .filter((entry) => !internal(entry.name))
    .flatMap((entry) => entry.addresses)
    .filter(
      (entry) =>
        entry.scope === 'global' &&
        isIP(entry.address) !== 0 &&
        !isTailnet(entry.address)
    )
    .map((entry) => entry.address);
}

/** The systemd unit a process runs in, read from its cgroup; never its
 * command line. */
export function unitOf(cgroup: string): string | null {
  const path = /^0::(\S+)$/m.exec(cgroup)?.[1] ?? '';
  const unit = path
    .split('/')
    .reverse()
    .find((part) => /\.(service|scope|socket)$/.test(part));
  if (!unit || !/^[\w@.:-]{1,128}$/.test(unit)) return null;
  return unit === 'init.scope' ? 'systemd' : unit;
}

interface Firewall {
  active: boolean;
  publicSsh: boolean;
  /** The ports a loaded rule closes to everything but loopback and the
   * tailnet. */
  tailnetOnly: PublicPort[];
}

const NO_FIREWALL: Firewall = {
  active: false,
  publicSsh: false,
  tailnetOnly: [],
};

/** The port an expression matches: `tcp dport 3389`, as nft lists it. */
function destinationPort(
  expression: Record<string, unknown>
): PublicPort | null {
  const match = expression['match'];
  if (!record(match) || match['op'] !== '==' || !record(match['left']))
    return null;
  const payload = match['left']['payload'];
  const port = match['right'];
  if (!record(payload) || payload['field'] !== 'dport') return null;
  const protocol = payload['protocol'];
  if (protocol !== 'tcp' && protocol !== 'udp') return null;
  return typeof port === 'number' && Number.isInteger(port)
    ? { protocol, port }
    : null;
}

/** The port a rule of the input chain marked "tailnet-only" drops: `tcp dport
 * 3389 drop`. A rule under that comment which matches anything else, or does
 * not drop, closes nothing this check can name. */
function tailnetOnlyPort(rule: Record<string, unknown>): PublicPort | null {
  if (rule['comment'] !== 'tailnet-only' || rule['chain'] !== 'input')
    return null;
  const expressions = Array.isArray(rule['expr'])
    ? rule['expr'].filter(record)
    : [];
  const [match, verdict] = expressions;
  return expressions.length === 2 && 'drop' in verdict!
    ? destinationPort(match!)
    : null;
}

/** What `nft -j list table inet personal_fleet` says of the rules. */
export function parseFirewall(text: string): Firewall {
  try {
    const value: unknown = JSON.parse(text);
    const items =
      record(value) && Array.isArray(value['nftables'])
        ? value['nftables'].filter(record)
        : [];
    const active = items.some(
      (item) =>
        record(item['chain']) &&
        item['chain']['hook'] === 'input' &&
        item['chain']['policy'] === 'drop'
    );
    const rules = items.map((item) => item['rule']).filter(record);
    const publicSsh = rules.some((rule) => rule['comment'] === 'public-ssh');
    const tailnetOnly = rules
      .map(tailnetOnlyPort)
      .filter((port): port is PublicPort => port !== null);
    return { active, publicSsh, tailnetOnly };
  } catch {
    return NO_FIREWALL;
  }
}

const describe = (listener: Listener, unit: string | null): string => {
  const host = listener.address.includes(':')
    ? `[${listener.address}]`
    : listener.address;
  return `${listener.protocol} ${host}:${listener.port} (${unit ?? 'unknown unit'})`;
};

const allowed = (ports: PublicPort[], listener: Listener) =>
  ports.some(
    (entry) =>
      entry.protocol === listener.protocol && entry.port === listener.port
  );

/** The listeners the declared policy allows on every interface: sshd and
 * tailscaled (the firewall decides who reaches them), the system's own, and
 * the ports the policy opens. */
export function allowList(rules: WorkerExposure): PublicPort[] {
  return [
    { protocol: 'tcp', port: rules.sshPort },
    { protocol: 'udp', port: exposure.tailscalePort },
    ...(exposure.systemListeners as PublicPort[]),
    ...rules.policy.publicPorts,
  ];
}

const UNRESTRICTED = 'WORKER_LISTENER_UNRESTRICTED';
const AGENT_UNRESTRICTED = 'WORKER_AGENT_LISTENER_UNRESTRICTED';
const RULE_MISSING = 'WORKER_TAILNET_ONLY_RULE_MISSING';

const REMEDY: Record<string, string> = {
  WORKER_FIREWALL_INACTIVE:
    'The fleet firewall is not loaded: run homelab converge, which applies ansible/ubuntu/tasks/firewall.yml. Until then every listener below is reachable from every network the worker is on.',
  WORKER_PUBLIC_SSH_UNDECLARED:
    'SSH is still open beyond the tailnet because converge could not prove the manager reaches the worker over the tailnet. Point the SSH alias of this worker at its tailnet name, then run homelab converge; declare exposure.publicSsh only for break-glass access.',
  get WORKER_LISTENER_UNRESTRICTED() {
    return `Bind the named service to 127.0.0.1 or the tailnet address, or declare its port in exposure.publicPorts of ${fleetJson()}. A service that cannot bind one address, such as a remote desktop, is declared in exposure.tailnetOnlyPorts instead, which opens nothing. A fleet service on a public address is a fault of its unit: run homelab converge. The T3 desktop app returns to loopback when it next starts; converge restarts it immediately if needed.`;
  },
  get WORKER_AGENT_LISTENER_UNRESTRICTED() {
    return `A process an agent started (a development server, say) listens on every address. It is no fleet service and converge does not change it; the fleet firewall, once loaded, admits it only over the tailnet. Have the agent bind it to 127.0.0.1 (most development servers take --host 127.0.0.1 or HOST=127.0.0.1) or stop it, or declare its port in exposure.publicPorts of ${fleetJson()}. It ends with the agent session that started it.`;
  },
  get WORKER_TAILNET_ONLY_RULE_MISSING() {
    return `The named service listens on a port declared in exposure.tailnetOnlyPorts of ${fleetJson()}, but the loaded fleet firewall holds no tailnet-only rule for that port: run homelab converge, which writes the rule and loads it (ansible/ubuntu/tasks/firewall.yml).`;
  },
  WORKER_EXPOSURE_UNOBSERVED:
    'The listening sockets or the firewall could not be read with sudo -n; check worker:sudo, then rerun homelab check --workers.',
};

function result(status: Status, codes: string[], summary: string): Check {
  return {
    id: 'worker:exposure',
    status,
    summary,
    ...(status === 'pass' || status === 'not-applicable'
      ? {}
      : {
          remedy: {
            action: codes.map((code) => REMEDY[code]).join(' '),
          },
        }),
  };
}

/** What was read on the worker. */
interface Observed {
  interfaces: Interface[];
  listeners: Listener[];
  firewall: Firewall;
  /** The ports the kernel hands out to outgoing connections. */
  ephemeral: [number, number];
}

/** Linux's default ip_local_port_range, used when the worker's cannot be
 * read. */
const EPHEMERAL: [number, number] = [32768, 60999];

function portRange(text: string): [number, number] | null {
  const [low, high] = text.trim().split(/\s+/).map(Number);
  return Number.isInteger(low) && Number.isInteger(high) && low! <= high!
    ? [low!, high!]
    : null;
}

/** What the worker shows, or the check itself when exposure is not
 * applicable or could not be read. */
async function observe(run: Runner): Promise<Observed | Check> {
  const container = await run(['systemd-detect-virt', '--container']);
  if (container.ok)
    return result(
      'not-applicable',
      [],
      'This worker runs in a container: its network and firewall belong to its host.'
    );
  const addresses = await run(['ip', '-j', 'address', 'show']);
  const interfaces = addresses.ok ? parseInterfaces(addresses.stdout) : null;
  if (interfaces === null)
    return result(
      'fail',
      ['WORKER_EXPOSURE_UNOBSERVED'],
      'WORKER_EXPOSURE_UNOBSERVED (addresses)'
    );
  if (outsideAddresses(interfaces).length === 0)
    return result(
      'not-applicable',
      [],
      'This worker has no address outside the tailnet: nothing beyond it can connect.'
    );
  const sockets = await run([
    'sudo',
    '-n',
    'ss',
    '-H',
    '-l',
    '-n',
    '-t',
    '-u',
    '-p',
  ]);
  if (!sockets.ok)
    return result(
      'fail',
      ['WORKER_EXPOSURE_UNOBSERVED'],
      'WORKER_EXPOSURE_UNOBSERVED (sockets)'
    );
  const table = await run([
    'sudo',
    '-n',
    'nft',
    '-j',
    'list',
    'table',
    ...FIREWALL_TABLE,
  ]);
  const range = await run(['cat', '/proc/sys/net/ipv4/ip_local_port_range']);
  return {
    interfaces,
    listeners: parseListeners(sockets.stdout),
    firewall: table.ok ? parseFirewall(table.stdout) : NO_FIREWALL,
    ephemeral: (range.ok && portRange(range.stdout)) || EPHEMERAL,
  };
}

/** The listeners beyond loopback, the tailnet and the container bridges.
 * `ss -l -u` lists every unconnected UDP socket, and a client's on a port the
 * kernel handed out (a QUIC tunnel, a DNS lookup) is one: it is not a
 * listener. The fleet firewall, which this check requires, admits only the
 * replies it asked for. */
function exposedListeners(observed: Observed): Listener[] {
  const [low, high] = observed.ephemeral;
  const client = (listener: Listener) =>
    listener.protocol === 'udp' &&
    listener.port >= low &&
    listener.port <= high;
  const bridged = new Set(
    observed.interfaces
      .filter((entry) => internal(entry.name))
      .flatMap((entry) => entry.addresses.map((info) => info.address))
  );
  return observed.listeners.filter(
    (listener) =>
      !(listener.device && internal(listener.device)) &&
      !isLoopback(listener.address) &&
      !isTailnet(listener.address) &&
      !bridged.has(listener.address) &&
      !client(listener)
  );
}

type Kind = 'fleet' | 'agent' | 'other' | 'held' | 'missing';

/** The exposed listeners outside the allow-list, by who owns them: a fleet
 * service, a process an agent started, or anything else. Each names its port
 * and unit. One on a port the policy holds to the tailnet is sorted instead
 * by whether the loaded firewall has the rule that does (`held`) or not
 * (`missing`), whoever started it; but a fleet service is never held: it
 * binds loopback or the tailnet itself. */
async function unrestricted(
  rules: WorkerExposure,
  observed: Observed,
  run: Runner
): Promise<Record<Kind, string[]>> {
  const exposed = exposedListeners(observed);
  const units = new Map<number, string | null>();
  for (const pid of new Set(exposed.flatMap((listener) => listener.pids))) {
    const cgroup = await run(['cat', `/proc/${pid}/cgroup`]);
    units.set(pid, cgroup.ok ? unitOf(cgroup.stdout) : null);
  }
  const permitted = allowList(rules);
  const fleetPorts = [rules.t3Port, MONITORING_AGENT_PORT];
  const found: Record<Kind, Set<string>> = {
    fleet: new Set(),
    agent: new Set(),
    other: new Set(),
    held: new Set(),
    missing: new Set(),
  };
  const tailnetOnly = (listener: Listener): Kind | null =>
    !allowed(rules.policy.tailnetOnlyPorts, listener)
      ? null
      : allowed(observed.firewall.tailnetOnly, listener)
        ? 'held'
        : 'missing';
  for (const listener of exposed) {
    if (allowed(permitted, listener)) continue;
    const unit =
      listener.pids.map((pid) => units.get(pid)).find(Boolean) ?? null;
    const owner: Kind =
      fleetPorts.includes(listener.port) || (unit !== null && fleetUnit(unit))
        ? 'fleet'
        : (tailnetOnly(listener) ??
          (unit !== null && AGENT_SCOPE.test(unit) ? 'agent' : 'other'));
    found[owner].add(describe(listener, unit));
  }
  return {
    fleet: [...found.fleet],
    agent: [...found.agent],
    other: [...found.other],
    held: [...found.held],
    missing: [...found.missing],
  };
}

/** The firewall's own fault, when it has one. */
function firewallFault(rules: WorkerExposure, firewall: Firewall): string[] {
  if (!firewall.active) return ['WORKER_FIREWALL_INACTIVE'];
  if (firewall.publicSsh && !rules.policy.publicSsh)
    return ['WORKER_PUBLIC_SSH_UNDECLARED'];
  return [];
}

const listed = (listeners: string[], code = UNRESTRICTED): string[] =>
  listeners.length ? [`${code} ${listeners.join(', ')}`] : [];

/** worker:exposure: nothing listens beyond loopback and the tailnet but what
 * the declared policy allows, and the firewall that closes the rest is
 * loaded. A listener on a declared tailnet-only port is allowed only while
 * the loaded rules hold that port to the tailnet. Not applicable without an
 * address outside the tailnet. Reports a port and the unit that owns it,
 * never a process's arguments. What an agent
 * started is reported under its own code, by `otherListeners` like any
 * listener that is not the fleet's, and never as a fleet service.
 */
export async function exposureCheck(
  rules: WorkerExposure,
  run: Runner
): Promise<Check> {
  const observed = await observe(run);
  if ('id' in observed) return observed;
  const { fleet, agent, other, held, missing } = await unrestricted(
    rules,
    observed,
    run
  );
  const strict = rules.policy.otherListeners === 'fail';
  const agents = listed(agent, AGENT_UNRESTRICTED);
  const failures = [
    ...firewallFault(rules, observed.firewall),
    ...listed(strict ? [...fleet, ...other] : fleet),
    ...(strict ? agents : []),
    ...listed(missing, RULE_MISSING),
  ];
  const problems = strict
    ? failures
    : [...failures, ...listed(other), ...agents];
  if (problems.length)
    return result(
      failures.length ? 'fail' : 'warn',
      [...new Set(problems.map((problem) => problem.split(' ')[0]!))],
      problems.join('; ')
    );
  const summary = rules.policy.publicSsh
    ? 'Only loopback, the tailnet and the declared allow-list listen beyond this worker, and the fleet firewall is loaded; SSH stays open beyond the tailnet by the declared break-glass opt-in.'
    : 'Only loopback, the tailnet and the declared allow-list listen beyond this worker, and the fleet firewall admits inbound traffic only over the tailnet.';
  return result(
    'pass',
    [],
    held.length
      ? `${summary} Its tailnet-only rules hold to loopback and the tailnet: ${held.join(', ')}.`
      : summary
  );
}

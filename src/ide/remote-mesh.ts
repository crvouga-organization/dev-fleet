import { sshArgs, shellQuote } from '../ssh';
import type { Check, CommandResult, FleetNode, Runner } from '../types';
import type { MachineDefinition, ManagerDefinition } from '../definition';

/** One remote IDE the manager drives on every worker, and that every machine
 * drives on every other machine. Orca (onorca.dev) and Paradev (paradev.dev,
 * formerly Superset) are both this shape: a desktop app a person installs,
 * a CLI that answers `--json`, and a host on every other machine.
 *
 * Orca has no command that adds an SSH target. The desktop registers one
 * under Settings → SSH, and `orca host list` is what a script can read
 * (https://www.onorca.dev/docs/cli/reference). Paradev sets a machine up
 * over SSH with `paradev hosts add`, which installs its CLI, signs the host
 * in with a new key sent on ssh stdin, and repairs a later run
 * (https://docs.paradev.com/cli/cli-reference).
 */

/** What distinguishes one such IDE. The words are the product's. */
export interface RemoteIdeSpec {
  /** The name `ides` enables it by. */
  readonly id: 'orca' | 'paradev';
  /** The product, as a person knows it. */
  readonly product: string;
  /** Where its docs live. */
  readonly docs: string;
  /** The command on PATH. */
  readonly command: string;
  /** Tried when `command` is not installed, as on a Linux worker. */
  readonly fallback?: string;
  /** What a passing app check says. */
  readonly answers: string;
}

const JSON_FLAG = '--json';

export const ORCA: RemoteIdeSpec = {
  id: 'orca',
  product: 'Orca',
  docs: 'https://www.onorca.dev/docs/ssh',
  command: 'orca',
  /** GNOME owns `/usr/bin/orca` on Linux; the app's CLI there is `orca-ide`. */
  fallback: 'orca-ide',
  answers: 'Orca on the manager answers its CLI.',
};

export const PARADEV: RemoteIdeSpec = {
  id: 'paradev',
  product: 'Paradev',
  docs: 'https://docs.paradev.com/remote-access',
  command: 'paradev',
  answers: 'Paradev on the manager answers its CLI.',
};

/** What one machine of the mesh is addressed as. */
export interface MeshMember {
  /** The node ID, which is the name the host is registered under. */
  id: string;
  /** Set for a worker. Absent, the CLI runs on the manager. */
  node?: FleetNode;
  /** The SSH destination the manager's own configuration resolves. */
  ssh: string;
  /** The SSH destination any other worker dials: `user@tailnet-name`. */
  peer: string;
}

type Answer =
  | { response: Record<string, unknown> }
  | { absent: true }
  | { refused: string };

const CODE = /^[A-Za-z0-9_]{1,64}$/;

/** A status code, and nothing else of what a CLI printed. */
function coded(value: Record<string, unknown>): string | undefined {
  const nested = value['error'];
  const code =
    nested && typeof nested === 'object'
      ? (nested as Record<string, unknown>)['code']
      : value['code'];
  return typeof code === 'string' && CODE.test(code) ? code : undefined;
}

/** One JSON document, kept only when it is a host list or a status object. */
function parsed(text: string, ok: boolean): Answer | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (Array.isArray(value))
    return ok ? { response: { hosts: value } } : undefined;
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const code = coded(record);
  if (code) return { refused: code };
  return ok ? { response: record } : undefined;
}

/** Keeps a status code and drops the rest of what a CLI printed, so a key
 * or a pairing URL never reaches a report. */
export function parseAnswer(result: CommandResult): Answer {
  if (result.reason === 'missing') return { absent: true };
  for (const text of [result.stdout, result.stderr]) {
    const answer = parsed(text, result.ok);
    if (answer) return answer;
  }
  return { refused: result.reason === 'timeout' ? 'TIMEOUT' : 'UNREADABLE' };
}

/** Why the CLI could not be asked, as a warning of the check `id`. */
/** Written out in full: the runbook scanner reads a code from a string. */
const WARNINGS = {
  orca: {
    absent: 'ORCA_NOT_INSTALLED',
    stopped: 'ORCA_NOT_RUNNING',
    refused: 'ORCA_REFUSED',
  },
  paradev: {
    absent: 'PARADEV_NOT_INSTALLED',
    stopped: 'PARADEV_NOT_RUNNING',
    refused: 'PARADEV_REFUSED',
  },
} as const;

function unanswered(
  spec: RemoteIdeSpec,
  id: string,
  where: string,
  answer: Exclude<Answer, { response: unknown }>
): Check {
  const warnings = WARNINGS[spec.id];
  if ('absent' in answer)
    return {
      id,
      status: 'warn',
      summary: warnings.absent,
      remedy: {
        action: `Install ${spec.product} on ${where} (${spec.docs}) and start it once, then run converge.`,
      },
    };
  if (answer.refused === 'UNAVAILABLE' || answer.refused === 'unavailable')
    return {
      id,
      status: 'warn',
      summary: warnings.stopped,
      remedy: {
        action: `Start ${spec.product} on ${where}, then run converge.`,
      },
    };
  return {
    id,
    status: 'warn',
    summary: warnings.refused,
    remedy: {
      action: `${spec.product} on ${where} answered ${answer.refused}. Update the app, start it again, then run converge.`,
    },
  };
}

/** The CLI, on this machine or over SSH on a worker. `--json` is added
 * once, so a caller that already ends with it is left as it is. */
function invoke(
  command: string,
  member: MeshMember | undefined,
  args: readonly string[]
): string[] {
  const line =
    args.at(-1) === JSON_FLAG
      ? [command, ...args]
      : [command, ...args, JSON_FLAG];
  return member?.node
    ? [...sshArgs(member.node), line.map((word) => shellQuote(word)).join(' ')]
    : line;
}

async function ask(
  spec: RemoteIdeSpec,
  run: Runner,
  member: MeshMember | undefined,
  args: readonly string[]
): Promise<Answer> {
  const once = (command: string) =>
    run(invoke(command, member, args), { timeoutMs: 120_000 });
  const first = await once(spec.command);
  const result =
    first.reason === 'missing' && spec.fallback
      ? await once(spec.fallback)
      : first;
  return parseAnswer(result);
}

/** The JSON a CLI prints, or the `result` it wraps that JSON in. */
function body(value: Record<string, unknown>): Record<string, unknown> {
  const result = value['result'];
  return result && typeof result === 'object' && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : value;
}

function rows(value: Record<string, unknown>): Record<string, unknown>[] {
  const hosts = body(value)['hosts'];
  if (!Array.isArray(hosts)) return [];
  return hosts.filter(
    (row): row is Record<string, unknown> =>
      !!row && typeof row === 'object' && !Array.isArray(row)
  );
}

/** The check that says the app on the manager answers. Written out so the
 * check registry sees each ID; a template would not.
 */
function appCheck(spec: RemoteIdeSpec): 'orca:app' | 'paradev:app' {
  if (spec.id === 'orca') {
    const id = 'orca:app';
    return id;
  }
  const id = 'paradev:app';
  return id;
}

/** The app on the manager answers its CLI (`<ide>:app`). */
export async function appAnswers(
  spec: RemoteIdeSpec,
  run: Runner
): Promise<Check> {
  const id = appCheck(spec);
  const answer = await ask(spec, run, undefined, ['status']);
  return 'response' in answer
    ? { id, status: 'pass', summary: spec.answers }
    : unanswered(spec, id, 'the manager', answer);
}

/** The destination `source` dials for `target`. The manager uses its own
 * SSH configuration; a worker dials the tailnet name, which every machine
 * of the fleet can resolve.
 */
export function destination(
  source: MeshMember | undefined,
  target: MeshMember
): string {
  return source ? target.peer : target.ssh;
}

/** The SSH address a worker dials for another machine of the fleet. */
export function peerAddress(machine: {
  network?: { tailscaleName: string; user: string } | undefined;
}): string {
  const network = machine.network;
  if (!network) return '';
  return `${network.user}@${network.tailscaleName}`;
}

function hostListed(
  listed: Record<string, unknown>[],
  target: MeshMember,
  address: string
): boolean {
  return listed.some((row) => {
    const name = typeof row['name'] === 'string' ? row['name'] : '';
    const selector = typeof row['selector'] === 'string' ? row['selector'] : '';
    const alias = typeof row['alias'] === 'string' ? row['alias'] : '';
    return (
      name === target.id ||
      name === address ||
      alias === address ||
      selector === address ||
      selector.endsWith(address)
    );
  });
}

function warn(id: string, summary: string, action: string): Check {
  return { id, status: 'warn', summary, remedy: { action } };
}

/** Orca: measure `host list`. A missing SSH target is added in Settings,
 * which has no unattended command. */
async function orcaHost(
  run: Runner,
  source: MeshMember | undefined,
  target: MeshMember,
  apply: boolean
): Promise<Check> {
  const id = 'orca:host';
  const where = source?.id ?? 'the manager';
  const listed = await ask(ORCA, run, source, ['host', 'list']);
  if (!('response' in listed)) return unanswered(ORCA, id, where, listed);
  const hosts = rows(listed.response);
  if (!Array.isArray(body(listed.response)['hosts']))
    return unanswered(ORCA, id, where, { refused: 'UNREADABLE' });
  const address = destination(source, target);
  if (hostListed(hosts, target, address))
    return {
      id,
      status: 'pass',
      summary: `Orca on ${where} holds ${target.id} as a remote host.`,
    };
  if (!apply)
    return {
      id,
      status: 'skip',
      summary: `Planned: add ${target.id} as an Orca SSH host of ${where}.`,
    };
  return warn(
    id,
    'ORCA_SSH_TARGET_MISSING',
    `In Orca on ${where}, open Settings → SSH and add ${address} for ${target.id} (https://www.onorca.dev/docs/ssh), then run converge. Orca has no command that adds an SSH target.`
  );
}

const SECRET = /sk_[A-Za-z0-9_-]{8,}|api[_-]?key/i;

/** Drops a line of Paradev output that carries a key. The code never logs
 * it; this is what a report is allowed to keep of a refusal. */
export function redact(text: string): string {
  return SECRET.test(text) ? '' : text;
}

/** Paradev signs the manager in, starts its host, then `hosts add` on
 * every other machine. `hosts add` prints a new API key on ssh stdin and
 * can echo it, so a refusal keeps only its code. */
async function paradevSignedIn(
  run: Runner,
  member: MeshMember | undefined
): Promise<Check | undefined> {
  const id = 'paradev:app';
  const where = member?.id ?? 'the manager';
  const who = await ask(PARADEV, run, member, ['auth', 'whoami']);
  if ('response' in who) return undefined;
  if ('absent' in who) return unanswered(PARADEV, id, where, who);
  return warn(
    id,
    'PARADEV_NOT_SIGNED_IN',
    `Sign in to Paradev on ${where} with \`paradev auth login\`, or set SUPERSET_API_KEY for that account (https://docs.paradev.com/remote-access), then run converge.`
  );
}

async function paradevRunning(
  run: Runner,
  member: MeshMember | undefined,
  apply: boolean
): Promise<Check> {
  const id = 'paradev:service';
  const where = member?.id ?? 'the manager';
  const status = await ask(PARADEV, run, member, ['status']);
  if (!('response' in status)) return unanswered(PARADEV, id, where, status);
  if (status.response['running'] === true)
    return {
      id,
      status: 'pass',
      summary: `Paradev on ${where} is running.`,
    };
  if (!apply)
    return {
      id,
      status: 'skip',
      summary: `Planned: start Paradev on ${where}.`,
    };
  const started = await ask(PARADEV, run, member, [
    'start',
    '--daemon',
    '--auto-update',
  ]);
  if (!('response' in started)) return unanswered(PARADEV, id, where, started);
  return {
    id,
    status: 'pass',
    summary: `Paradev on ${where} is running.`,
  };
}

function held(where: string, target: string): Check {
  return {
    id: 'paradev:host',
    status: 'pass',
    summary: `Paradev on ${where} holds ${target} as a remote host.`,
  };
}

/** What the host list already says, before anything is added. */
function listedHost(
  hosts: Record<string, unknown>[],
  where: string,
  target: MeshMember,
  address: string
): Check | undefined {
  const known = hosts.find(
    (row) => row['name'] === target.id || row['name'] === address
  );
  if (!known) return undefined;
  if (known['online'] === 'no')
    return warn(
      'paradev:host',
      'PARADEV_HOST_OFFLINE',
      `Paradev on ${where} lists ${target.id} and it is offline. Start Paradev there, then run converge.`
    );
  return held(where, target.id);
}

async function paradevHost(
  run: Runner,
  source: MeshMember | undefined,
  target: MeshMember,
  apply: boolean
): Promise<Check> {
  const id = 'paradev:host';
  const where = source?.id ?? 'the manager';
  const listed = await ask(PARADEV, run, source, ['hosts', 'list']);
  if (!('response' in listed)) return unanswered(PARADEV, id, where, listed);
  if (!Array.isArray(body(listed.response)['hosts']))
    return unanswered(PARADEV, id, where, { refused: 'UNREADABLE' });
  const address = destination(source, target);
  const already = listedHost(rows(listed.response), where, target, address);
  if (already) return already;
  if (!apply)
    return {
      id,
      status: 'skip',
      summary: `Planned: register ${target.id} as a Paradev host of ${where}.`,
    };
  const added = await ask(PARADEV, run, source, [
    'hosts',
    'add',
    address,
    '--name',
    target.id,
    '--yes',
  ]);
  if ('response' in added) return held(where, target.id);
  const check = unanswered(PARADEV, id, where, added);
  return {
    ...check,
    remedy: {
      action:
        `${check.remedy?.action ?? ''} On Linux, lingering keeps the host after logout: loginctl enable-linger.`.trim(),
    },
  };
}

/** Removes the Paradev host `target` was added as. A missing host is
 * already done. The host stays listed offline until deleted in Settings.
 */
export async function removeParadevHost(
  run: Runner,
  target: string
): Promise<Check> {
  const id = 'paradev:host';
  const removed = await ask(PARADEV, run, undefined, [
    'hosts',
    'remove',
    target,
    '--yes',
  ]);
  if (
    'response' in removed ||
    ('refused' in removed && removed.refused === 'not-found')
  )
    return {
      id,
      status: 'pass',
      summary: `Paradev on the manager no longer runs ${target} as a host. Delete it in Settings → Hosts if it is still listed.`,
    };
  return unanswered(PARADEV, id, 'the manager', removed);
}

export interface MeshRun {
  spec: RemoteIdeSpec;
  manager: MeshMember;
  workers: readonly MeshMember[];
  run: Runner;
  apply: boolean;
}

/** One machine's registrations: every other worker, and the manager when
 * this machine is itself a worker. Paradev skips a worker whose CLI is absent.
 */
async function registrations(
  mesh: MeshRun,
  source: MeshMember | undefined
): Promise<Check[]> {
  if (mesh.spec.id === 'paradev' && source) {
    const present = await ask(PARADEV, mesh.run, source, ['status']);
    if (!('response' in present))
      return [unanswered(PARADEV, 'paradev:service', source.id, present)];
  }
  const host = mesh.spec.id === 'orca' ? orcaHost : paradevHost;
  const checks: Check[] = [];
  for (const target of mesh.workers) {
    if (source && target.id === source.id) continue;
    checks.push(await host(mesh.run, source, target, mesh.apply));
  }
  if (source)
    checks.push(await host(mesh.run, source, mesh.manager, mesh.apply));
  return checks;
}

/** Paradev on the manager: signed in, then running. A warning replaces the
 * app check and stops the mesh, because nothing can be added without it.
 */
async function paradevManager(
  mesh: MeshRun,
  checks: Check[]
): Promise<boolean> {
  const signedIn = await paradevSignedIn(mesh.run, undefined);
  if (signedIn) {
    checks[0] = signedIn;
    return false;
  }
  checks.push(await paradevRunning(mesh.run, undefined, mesh.apply));
  return true;
}

/** Every machine registers every other machine. One `<ide>:host` check per
 * registration, plus `<ide>:app` on the manager. Paradev also reports
 * `<ide>:service` where it starts the host.
 */
export async function meshOf(mesh: MeshRun): Promise<Check[]> {
  const { spec, run } = mesh;
  const checks: Check[] = [await appAnswers(spec, run)];
  if (checks[0]?.summary.endsWith('_NOT_INSTALLED')) return checks;
  const stopped = checks[0]?.summary.endsWith('_NOT_RUNNING');
  if (
    spec.id === 'paradev' &&
    !stopped &&
    !(await paradevManager(mesh, checks))
  )
    return checks;
  for (const source of [undefined, ...mesh.workers]) {
    if (stopped && !source) continue;
    checks.push(...(await registrations(mesh, source)));
  }
  return checks;
}

/** The machines the mesh registers. A worker the roster does not list yet
 * is not registered. `declared` is the fleet's worker record, which carries
 * the tailnet name a peer dials.
 */
export function meshMembers(
  manager: ManagerDefinition,
  workers: readonly MachineDefinition[],
  nodes: readonly FleetNode[]
): { manager: MeshMember; workers: MeshMember[] } {
  return {
    manager: {
      id: manager.id,
      ssh: manager.id,
      peer: peerAddress(manager),
    },
    workers: nodes.flatMap((node) => {
      const declared = workers.find((worker) => worker.id === node.id);
      if (!declared?.network) return [];
      return [
        {
          id: node.id,
          node,
          ssh: node.ssh,
          peer: peerAddress(declared),
        },
      ];
    }),
  };
}

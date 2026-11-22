import { spawn } from 'node:child_process';
import type { FleetDefinition } from '../definition';
import {
  encodeSelection,
  SELECTED_BY_ENV,
  type RevisionSelection,
} from '../revision-selection';
import { shellQuote, sshArgs } from '../ssh';
import type { FleetNode } from '../types';
import type { CommandOutcome } from './contracts';
import type { FleetSyncOptions } from './fleet-sync';

/** Set on the manager side of a hand-off (and in tests): never hand off again. */
export const NO_FORWARD_ENV = 'PERSONAL_FLEET_NO_FORWARD';

/** Streams the remote command: progress on stderr, the report on stdout. */
export type ForwardSpawn = (
  command: string[]
) => Promise<{ exitCode: number; stdout: string }>;

export function forwardingDisabled(): boolean {
  return Boolean(process.env[NO_FORWARD_ENV]);
}

/** Whether a request's revision has to be on the default branch of the
 * source repository: always, unless --allow-unmerged says otherwise or the
 * request converges nothing (the schedule's status, or taking it away).
 */
export function asksAncestry(options: FleetSyncOptions): boolean {
  return (
    !options.allowUnmerged &&
    !['status', 'pause', 'disable'].includes(options.schedule ?? '')
  );
}

/** What the guard below exits with; nothing else on the manager uses them. */
const GUARD_EXIT = { unmerged: 65, unverified: 66 } as const;

/** Run on the manager before a handed-off revision's own run script, which
 * installs that revision's toolchain there: the manager's own copy of the
 * source repository says whether its default branch holds the revision. A
 * revision already known to be on it needs no network; anything else is
 * fetched first. `$1` is the revision.
 */
export const ANCESTRY_GUARD = [
  'source="$HOME/.local/share/personal/fleet/manager/source"',
  'held() { git -C "$source" merge-base --is-ancestor "$1" refs/remotes/origin/HEAD 2>/dev/null; }',
  'held "$1" && exit 0',
  `git -C "$source" fetch --quiet --no-tags origin >/dev/null 2>&1 || exit ${GUARD_EXIT.unverified}`,
  `git -C "$source" rev-parse --verify --quiet 'refs/remotes/origin/HEAD^{commit}' >/dev/null 2>&1 || exit ${GUARD_EXIT.unverified}`,
  `held "$1" || exit ${GUARD_EXIT.unmerged}`,
].join('\n');

/** fleet-sync only ever runs on the manager. Started on a worker, it hands the
 * same request to the manager over host-key-verified SSH (no agent forwarding,
 * no credentials copied) and reports the manager's result unchanged.
 */
export async function forwardToManager(
  definition: FleetDefinition,
  options: FleetSyncOptions,
  revision: string | undefined,
  remote: {
    spawn?: ForwardSpawn | undefined;
    script?: string | null;
    /** What selected the revision on the machine that hands the run off. */
    selection?: RevisionSelection;
  } = {}
): Promise<CommandOutcome> {
  // A test must inject the spawn: it can never reach the real manager.
  if (!remote.spawn && process.env['NODE_ENV'] === 'test')
    throw new Error('FLEET_FORWARD_IN_TEST');
  const spawnRemote = remote.spawn ?? spawnInherited;
  const { manager } = definition;
  process.stderr.write(
    `fleet-sync runs on the manager; handing off to ${manager.id} over SSH…\n`
  );
  const result = await spawnRemote(
    managerCommand(definition, options, revision, remote)
  );
  const stdout = result.stdout.trim();
  if (options.json) {
    try {
      return { exitCode: result.exitCode, data: JSON.parse(stdout) as unknown };
    } catch {
      /* Fall through to the structured failure below. */
    }
  }
  const failure = handOffFailure(result.exitCode, definition, revision);
  if (failure && !stdout) return failure;
  return {
    exitCode: result.exitCode,
    data: { version: 1, forwardedTo: manager.id, exitCode: result.exitCode },
    text: stdout,
  };
}

/** Why a hand-off that printed nothing ended as it did, when that is known:
 * the manager's guard stopped it, or the manager could not be reached.
 */
function handOffFailure(
  exitCode: number,
  definition: FleetDefinition,
  revision: string | undefined
): CommandOutcome | null {
  const { manager } = definition;
  const { repository } = definition.source;
  const failed = (code: string, error: string, more: object = {}) => ({
    exitCode: 1,
    data: { version: 1, ok: false, code, error, ...more },
  });
  if (exitCode === GUARD_EXIT.unmerged)
    return failed(
      'FLEET_REVISION_UNMERGED',
      `The revision is not on the default branch of ${repository}, so the manager changed nothing. Merge it first, or pass --allow-unmerged to converge the fleet to an unmerged revision on purpose: every machine, the manager included, then gets that revision's toolchain and policy.`,
      { revision: revision ?? null }
    );
  if (exitCode === GUARD_EXIT.unverified)
    return failed(
      'FLEET_REVISION_UNVERIFIED',
      `The manager changed nothing: it has no copy of ${repository} yet, or could not fetch it, so it is not known whether its default branch holds the revision. Run fleet-sync once on the manager itself, and check its network and Git access; --allow-unmerged converges without asking.`,
      { revision: revision ?? null }
    );
  if (exitCode === 255)
    return failed(
      'FLEET_MANAGER_UNREACHABLE',
      `Could not reach the manager (${manager.id}) over SSH. Wake it, check Tailscale and SSH (Remote Login), or run fleet-sync on the manager directly.`
    );
  return null;
}

/** With the revision's tracked `fleet-manager-run.sh`, the manager runs
 * fleet-sync from a clean checkout of that exact revision; otherwise (no
 * revision, or an older one without the script) its installed launcher.
 * Either way the manager is first asked whether the default branch holds the
 * revision, and is told what selected it. An accounts-only request names no
 * revision, so it is the installed launcher's and nothing is asked.
 */
export function managerCommand(
  definition: FleetDefinition,
  options: FleetSyncOptions,
  selected: string | undefined,
  remote: {
    /** The revision's own run script, when it has one. */
    script?: string | null;
    /** What selected the revision on the machine that hands the run off. */
    selection?: RevisionSelection | undefined;
  } = {}
): string[] {
  const { script: runScript = null, selection } = remote;
  const revision = pinned(options, selected);
  const { manager } = definition;
  const target: FleetNode = {
    id: manager.id,
    ssh: `${manager.network.user}@${manager.network.tailscaleName}`,
    workspace: '~',
    required: [],
  };
  const args =
    runScript && revision
      ? [
          'sh',
          '-c',
          runScript,
          'fleet-manager-run',
          revision,
          ...forwardedFlags(options, undefined),
        ]
      : [
          'devfleet',
          'fleet-sync',
          ...forwardedFlags(options, revision),
          // With no revision to say it about, the manager is told directly.
          ...(!revision && options.allowUnmerged ? ['--allow-unmerged'] : []),
        ];
  const color = process.stdout.isTTY && !process.env['NO_COLOR'];
  // A login shell gives the manager's normal PATH (mise, Docker, Tailscale).
  const { told, guard } = revision
    ? aboutRevision(options, revision, selection)
    : { told: '', guard: '' };
  const script = `export ${NO_FORWARD_ENV}=1${color ? ' FORCE_COLOR=1' : ''}${told}; ${guard}exec ${args.map(shellQuote).join(' ')}`;
  return [...sshArgs(target), `exec /bin/zsh -lc ${shellQuote(script)}`];
}

/** What a hand-off that names a revision adds to the manager's command: what
 * selected the revision, exported for the run there, and the guard that runs
 * before it.
 */
function aboutRevision(
  options: FleetSyncOptions,
  revision: string,
  selection: RevisionSelection | undefined
): { told: string; guard: string } {
  const quoted = (words: string[]) => words.map(shellQuote).join(' ');
  return {
    told: selection
      ? ` ${SELECTED_BY_ENV}=${shellQuote(encodeSelection(revision, selection))}`
      : '',
    guard: asksAncestry(options)
      ? `${quoted(['sh', '-c', ANCESTRY_GUARD, 'fleet-revision-guard', revision])} || exit $?; `
      : '',
  };
}

/** How one option of a request reaches the manager: the flag that carries
 * it, or why no flag does.
 */
export type HandOff = string | { elsewhere: string };

const elsewhere = (why: string): HandOff => ({ elsewhere: why });
const INTERNAL = elsewhere(
  'No command line sets it: the run on the manager works it out itself.'
);

/** Every option of a request and how the hand-off carries it, in the order
 * the flags are written. An option added to fleet-sync does not compile
 * until it is listed here: none is dropped without a reason.
 */
export const HAND_OFF: {
  readonly [Option in keyof Required<FleetSyncOptions>]: HandOff;
} = {
  revision: elsewhere(
    'The hand-off names the revision the worker selected, which is not always the one typed.'
  ),
  node: '--node',
  canary: '--canary',
  schedule: '--schedule',
  only: '--only',
  all: '--all',
  vaultPasswordLogin: '--vault-password-login',
  restartBusy: '--restart-busy',
  dryRun: '--dry-run',
  apply: '--apply',
  yes: '--yes',
  json: '--json',
  nonInteractive: '--non-interactive',
  maintenanceReboot: '--maintenance-reboot',
  force: '--force',
  takeOver: '--take-over',
  rollback: elsewhere(
    'Refused on a worker: only the fleet state on the manager knows the revision applied before.'
  ),
  allowUnmerged: elsewhere(
    'The run on the manager may be older than the flag: it is told what selected the revision instead.'
  ),
  rolledOut: INTERNAL,
  interactiveAuthorization: INTERNAL,
  expectedPlanFingerprint: INTERNAL,
  enrollment: INTERNAL,
  readyBefore: INTERNAL,
  selection: INTERNAL,
  replaces: INTERNAL,
};

/** The revision a hand-off pins the manager's run to. An accounts-only
 * request pins none: it moves no machine to a revision, so the manager's
 * installed launcher runs it, as when it is started on the manager.
 */
function pinned(
  options: FleetSyncOptions,
  revision: string | undefined
): string | undefined {
  return options.only ? undefined : revision;
}

/** The flags of a request, for the run of the revision's own code. That code
 * may be older than a flag, so --allow-unmerged is not among them: the run
 * that hands the request on answers for it, and says so in what it tells the
 * next (SELECTED_BY_ENV).
 */
export function forwardedFlags(
  options: FleetSyncOptions,
  revision: string | undefined
): string[] {
  const named = pinned(options, revision);
  const flags = named ? ['--revision', named] : [];
  for (const [option, flag] of Object.entries(HAND_OFF)) {
    if (typeof flag !== 'string') continue;
    const value: unknown = options[option as keyof FleetSyncOptions];
    if (value === true) flags.push(flag);
    else if (typeof value === 'string' && value) flags.push(flag, value);
    else if (Array.isArray(value))
      for (const entry of value) flags.push(flag, String(entry));
  }
  return flags;
}

function spawnInherited(
  command: string[]
): Promise<{ exitCode: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(command[0]!, command.slice(1), {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.on('error', () => resolve({ exitCode: 255, stdout: '' }));
    child.on('close', (code) => resolve({ exitCode: code ?? 1, stdout }));
  });
}

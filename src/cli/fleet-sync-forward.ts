import { spawn } from 'node:child_process';
import type { FleetDefinition } from '../definition';
import { sourceMismatchRemedy } from '../machine/source';
import {
  encodeSelection,
  SELECTED_BY_ENV,
  type RevisionSelection,
} from '../revision-selection';
import { shellQuote, sshArgs } from '../ssh';
import type { FleetNode } from '../types';
import type { CommandOutcome } from './contracts';
import type { FleetSyncOptions } from './fleet-sync';
import { ALLOW_MISE_DOWNGRADE_ENV, miseGuard } from './fleet-sync-mise';

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

/** Whether a request's revision may not replace a newer mise with the older
 * one it pins: always, unless --allow-mise-downgrade says otherwise or the
 * request is about the schedule, whose own runs are asked when they start.
 */
export function asksMise(options: FleetSyncOptions): boolean {
  return !options.allowMiseDowngrade && !options.schedule;
}

/** What the guards below exit with; nothing else on the manager uses them. */
const GUARD_EXIT = {
  unmerged: 65,
  unverified: 66,
  miseDowngrade: 67,
  miseUnmeasured: 68,
  sourceMismatch: 69,
} as const;

/** Run on the manager first, before every other guard and the revision's
 * own run script, all of which read the manager's own copy of the source
 * repository: a copy whose origin is another repository (made before the
 * fleet's source moved) can never hold the revision, so it is replaced with
 * a clone of the declared one, made beside it so that a failed clone leaves
 * it as it was. A manager with no copy is left to the guards after this.
 * `$1` is the revision, `$2` the declared repository.
 */
export const SOURCE_GUARD = [
  'source="$HOME/.local/share/personal/fleet/manager/source"',
  'origin=$(git -C "$source" remote get-url origin 2>/dev/null) || exit 0',
  '[ "$origin" != "$2" ] || exit 0',
  'rm -rf -- "$source.new"',
  `git clone --quiet --no-checkout --origin origin "$2" "$source.new" >/dev/null 2>&1 || { rm -rf -- "$source.new"; exit ${GUARD_EXIT.sourceMismatch}; }`,
  `rm -rf -- "$source" && mv -- "$source.new" "$source" || exit ${GUARD_EXIT.sourceMismatch}`,
].join('\n');

/** Run on the manager after the ancestry guard and before a handed-off
 * revision's own run script: a revision whose bootstrap is from before the
 * rule that keeps a newer mise may not replace the mise of the manager, or
 * of a worker the request converges, with the older one it pins. The
 * manager's own mise is compared here; the workers are measured by the
 * manager's installed devfleet, and a hand-off it cannot answer for is
 * refused.
 */
export const MISE_GUARD = miseGuard({
  downgrade: GUARD_EXIT.miseDowngrade,
  unmeasured: GUARD_EXIT.miseUnmeasured,
});

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
  if (exitCode === GUARD_EXIT.sourceMismatch)
    return failed('FLEET_SOURCE_MISMATCH', sourceMismatchRemedy(repository), {
      revision: revision ?? null,
    });
  if (exitCode === GUARD_EXIT.unverified)
    return failed(
      'FLEET_REVISION_UNVERIFIED',
      `The manager changed nothing: it has no copy of ${repository} yet, or could not fetch it, so it is not known whether its default branch holds the revision. Run fleet-sync once on the manager itself, and check its network and Git access; --allow-unmerged converges without asking.`,
      { revision: revision ?? null }
    );
  if (exitCode === GUARD_EXIT.miseDowngrade)
    return failed(
      'FLEET_MISE_DOWNGRADE',
      `The manager changed nothing: the revision pins an older mise than the manager runs, and its toolchain bootstrap is from before the rule that keeps a newer mise, so it would replace it. Every checkout on the manager whose mise.toml asks for a newer mise would then stop working. Converge to a revision whose bootstrap keeps a newer mise (any release since that rule), or pass --allow-mise-downgrade to install the older mise on purpose.`,
      { revision: revision ?? null }
    );
  if (exitCode === GUARD_EXIT.miseUnmeasured)
    return failed(
      'FLEET_MISE_UNMEASURED',
      `The manager changed nothing: the revision's toolchain bootstrap is from before the rule that keeps a newer mise, so it would replace a newer one, and the devfleet installed on the manager could not say which mise the workers run (it is from before that question, or the manager has none on its PATH). Run devfleet fleet-sync on the manager itself once, with a current release, so that it can answer; or converge to a revision whose bootstrap keeps a newer mise (any release since that rule); or pass --allow-mise-downgrade to install the older mise on purpose.`,
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
 * revision and whether it would replace the mise of the manager or of a
 * worker the request converges with an older one, and is told what selected
 * it. An accounts-only request names no
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
          ...(!revision && options.allowMiseDowngrade
            ? ['--allow-mise-downgrade']
            : []),
        ];
  const color = process.stdout.isTTY && !process.env['NO_COLOR'];
  // A login shell gives the manager's normal PATH (mise, Docker, Tailscale).
  const { told, guard } = revision
    ? aboutRevision(options, revision, selection, definition.source.repository)
    : { told: '', guard: '' };
  const script = `export ${NO_FORWARD_ENV}=1${color ? ' FORCE_COLOR=1' : ''}${told}; ${guard}exec ${args.map(shellQuote).join(' ')}`;
  return [...sshArgs(target), `exec /bin/zsh -lc ${shellQuote(script)}`];
}

/** What a hand-off that names a revision adds to the manager's command: what
 * selected the revision and whether mise may be downgraded for it, exported
 * for the run there, and the guards that run before it.
 */
function aboutRevision(
  options: FleetSyncOptions,
  revision: string,
  selection: RevisionSelection | undefined,
  repository: string
): { told: string; guard: string } {
  const guard = (script: string, name: string, more: string[] = []) =>
    `${['sh', '-c', script, name, revision, ...more].map(shellQuote).join(' ')} || exit $?; `;
  // What the manager's installed devfleet needs to answer for the same
  // machines, in the form the request asked for.
  const selected = [
    ...(options.node ?? []).flatMap((node) => ['--node', node]),
    ...(options.json ? ['--json'] : []),
  ];
  return {
    told:
      (selection
        ? ` ${SELECTED_BY_ENV}=${shellQuote(encodeSelection(revision, selection))}`
        : '') +
      (options.allowMiseDowngrade
        ? ` ${ALLOW_MISE_DOWNGRADE_ENV}=${revision}`
        : ''),
    guard:
      guard(SOURCE_GUARD, 'fleet-source-guard', [repository]) +
      (asksAncestry(options)
        ? guard(ANCESTRY_GUARD, 'fleet-revision-guard')
        : '') +
      (asksMise(options)
        ? guard(MISE_GUARD, 'fleet-mise-guard', selected)
        : ''),
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
  allowMiseDowngrade: elsewhere(
    'The run on the manager may be older than the flag: it is told in the environment that mise may be downgraded for the revision.'
  ),
  measureMise: elsewhere(
    "Refused on a worker: the hand-off asks the manager's installed devfleet that question by itself, before the revision's run script."
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
 * may be older than a flag, so --allow-unmerged and --allow-mise-downgrade
 * are not among them: the run that hands the request on answers for them,
 * and says so in what it tells the next (SELECTED_BY_ENV,
 * ALLOW_MISE_DOWNGRADE_ENV).
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

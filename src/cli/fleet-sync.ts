import { withMachineLock } from '../machine/lock';
import type { ManagerReport } from '../manager-sync';
import { localCheckoutRevision } from '../machine/local-source';
import {
  definitionSource,
  editedCopyRemedy,
  editedInstalledCopy,
  fleet as canonicalDefinition,
  reloadFleet,
} from '../fleet-config';
import { managerFailure } from '../manager-failure';
import { managerText, stdoutColor } from './fleet-sync-output';
import { managerSchedule, type ScheduleAction } from './fleet-sync-schedule';
import { enrollManager, type EnrollmentResult } from './fleet-sync-enrollment';
import { authorizeManager } from './fleet-sync-vault';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { existsSync, renameSync } from 'node:fs';
import {
  isRevision,
  ensurePrivateRoot,
  type Enrollment,
} from '../machine/state';
import { loadEnrollment } from '../state/enrollment';
import { legacyHome, stateRoot } from '../state/paths';
import { stateDefinition } from '../state/operator';
import {
  appendRun,
  summarizeRun,
  type SyncRun,
  type Trigger,
} from '../state/history';
import {
  DIVERGED_REMEDY,
  mutateState,
  refresh,
  leaseConflict,
  leaseHeldMessage,
  stateContext,
  type Standing,
} from '../state/sync';
import { runRecord } from './fleet-sync-state';
import { planSources, planText, syncPlan } from './fleet-sync-plan';
import { runCommand } from '../runner';
import type { Runner } from '../types';
import type { Settings } from './settings';
import type { CommandOutcome } from './contracts';
import { FleetUsageError } from '../errors';
import { FleetLockError } from '../machine/lock-error';
import { selected } from './fleet-sync-remote';
import { managerIdentity } from './fleet-sync-manager';
import { inRunCheckout, managerRunScript, rehome } from './fleet-sync-checkout';
import { syncAccounts } from './fleet-sync-accounts';
import { packageInfo } from '../package-info';
import {
  asksAncestry,
  asksMise,
  forwardingDisabled,
  forwardToManager,
  type ForwardSpawn,
} from './fleet-sync-forward';
import { defaultBranchHolds, prepareSource } from '../machine/source';
import {
  allowsMiseDowngrade,
  miseDowngrade,
  miseDowngradeRemedy,
  workersToConverge,
} from './fleet-sync-mise';
import {
  decodeSelection,
  SELECTED_BY_ENV,
  selectionText,
  type RevisionSelection,
  type Selector,
} from '../revision-selection';
import { hostId } from '../topology';

export interface FleetSyncOptions {
  revision?: string;
  /** Converge to the revision applied before the current one. */
  rollback?: boolean;
  /** Converge to a revision that is not on the default branch of the source
   * repository. Without it such a revision is refused before anything
   * changes.
   */
  allowUnmerged?: boolean;
  /** Let the revision's bootstrap replace a newer mise with the older one
   * the revision pins. Without it a revision whose bootstrap would do that
   * unasked is refused before anything changes, and one whose bootstrap
   * keeps a newer mise keeps it.
   */
  allowMiseDowngrade?: boolean;
  dryRun?: boolean;
  apply?: boolean;
  yes?: boolean;
  json?: boolean;
  nonInteractive?: boolean;
  node?: string[];
  /** The worker to prove a revision new to the fleet on first, when it is
   * reachable; overrides `canary` in fleet.json.
   */
  canary?: string;
  /** Opt-in: a worker without a token of its own may be logged in with the
   * fleet's shared Vault user, typed on its own terminal.
   */
  vaultPasswordLogin?: boolean;
  all?: boolean;
  schedule?: ScheduleAction;
  /** `accounts`: only the account-derived configuration, on every node. */
  only?: string;
  /** Internal: this revision already converged the whole fleet, so no canary
   * has to prove it first and every worker converges at once.
   */
  rolledOut?: boolean;
  /** Internal: set for interactive terminal runs (sudo enrollment prompts). */
  interactiveAuthorization?: boolean;
  expectedPlanFingerprint?: string;
  /** Take the manager lease from another manager before it expired. */
  takeOver?: boolean;
  /** Restart a worker's T3 for a new release or policy even while agent
   * turns run, which ends them; by default the restart waits for idle.
   */
  restartBusy?: boolean;
  /** Opt-in: reboot each worker whose installed updates wait for a reboot,
   * one at a time, canary first, only while it runs no agent turn, and
   * verify it is ready before the next.
   */
  maintenanceReboot?: boolean;
  /** With --maintenance-reboot: reboot even while agent turns run. */
  force?: boolean;
  /** Internal: what this run's enrollment did, for the report. */
  enrollment?: EnrollmentResult;
  /** Internal: the workers that converged in an earlier run. One that never
   * did may be rebooted once after its first converge.
   */
  readyBefore?: string[];
  /** Internal: what selected the revision, for the report and the history. */
  selection?: RevisionSelection;
  /** Internal: the approved revision this run replaces, when it is another. */
  replaces?: string;
}
export function machineRoot(): string {
  const root = join(homedir(), '.local/share/personal/fleet/manager');
  // One-time move from the pre-topology name; keeps the approved revision.
  const legacy = join(homedir(), '.local/share/personal/fleet/controller');
  if (!existsSync(root) && existsSync(legacy)) renameSync(legacy, root);
  return root;
}

/** Public contract v3: the manager converges itself, then every enrolled worker. */
export async function fleetSync(
  options: FleetSyncOptions,
  settings: Settings,
  run: Runner = runCommand,
  forward?: ForwardSpawn
): Promise<CommandOutcome> {
  validate(options);
  if (!(await onManager(run)))
    return offManager(options, settings, run, forward);
  if (options.schedule === 'status') return scheduleStatus(settings, run);
  if (options.only === 'accounts') return onlyAccounts(options, settings, run);
  const sync = () =>
    managerSync(options, settings, {
      run,
      root: machineRoot(),
      restart: sync,
    });
  if (options.dryRun || options.schedule) return sync();
  const trigger = runTrigger();
  const startedAt = new Date();
  const outcome = await sync();
  await recordRun(
    summarizeRun(
      outcome.data,
      { startedAt, finishedAt: new Date() },
      trigger,
      outcome.exitCode
    ),
    run
  );
  return outcome;
}

/** Runs the manager's schedule starts say so in their environment. */
function runTrigger(env = process.env): Trigger {
  return env['DEVFLEET_TRIGGER'] === 'schedule' ? 'schedule' : 'operator';
}

/** Appends the run to the history in the fleet state and uploads it. A
 * history that cannot be written never changes the run's result.
 */
async function recordRun(entry: SyncRun, run: Runner): Promise<void> {
  try {
    await mutateState(stateContext(run), () => appendRun(entry));
  } catch {
    // Reported by the next fleet-state or fleet-sync run.
  }
}

export interface ManagerSync {
  run: Runner;
  /** This machine's run lock and caches. */
  root: string;
  /** Starts the request over once the fleet state has been replaced. */
  restart: () => Promise<CommandOutcome>;
  /** The home directory that holds this machine's installed copy. */
  home?: string;
}

/** Why the fleet state stops this run before any machine or the state is
 * changed, if it does.
 */
function stateRefusal(
  standing: Standing,
  options: FleetSyncOptions,
  run: Runner,
  revision: string
): CommandOutcome | null {
  if (standing === 'diverged')
    return actionRequired('FLEET_STATE_DIVERGED', DIVERGED_REMEDY, revision);
  // One manager at a time: another one's lease stops this run.
  const held = leaseConflict({
    ...stateContext(run),
    takeOver: options.takeOver === true,
  });
  return held
    ? actionRequired(
        'FLEET_MANAGER_LEASE_HELD',
        leaseHeldMessage(held),
        revision
      )
    : null;
}

/** Why this machine's copy of the configuration stops the run, if it does:
 * a sync installs the copy again, and an edit made to it by hand would be
 * lost. Refused the same way with or without a person, and never asked.
 */
function copyRefusal(
  home: string | undefined,
  revision: string
): CommandOutcome | null {
  const edited = editedInstalledCopy(process.env, home);
  return edited
    ? actionRequired(
        'FLEET_CONFIGURATION_COPY_CHANGED',
        editedCopyRemedy(edited, process.env, home),
        revision
      )
    : null;
}

/** fleet-sync on the machine already known to be the manager. */
export async function managerSync(
  options: FleetSyncOptions,
  settings: Settings,
  { run, root, restart, home }: ManagerSync
): Promise<CommandOutcome> {
  await ensurePrivateRoot(root);
  const state = await loadEnrollment(legacyHome() ? root : null);
  const chosen = await managerRevision(options, state, settings, run);
  if ('exitCode' in chosen) return chosen;
  const { revision, selection } = chosen;
  const unmerged = await unmergedRefusal(options, chosen, root, run);
  if (unmerged) return unmerged;
  const downgrade = await miseRefusal(options, chosen, settings, {
    run,
    root,
    home,
  });
  if (downgrade) return downgrade;
  if (options.schedule)
    return scheduleRequest(options, revision, settings, run);
  const rehomed = await rehome(
    options,
    {
      revision,
      workspace: settings.workspace,
      root,
      selection,
      ...(allowsMiseDowngrade(options, revision)
        ? { allowMiseDowngrade: true }
        : {}),
    },
    run
  );
  if (rehomed === 'unavailable')
    return actionRequired(
      'FLEET_SOURCE_UNAVAILABLE',
      `Revision ${revision} could not be taken from ${canonicalDefinition.source.repository}, so nothing was changed. Check the network and Git access to it, and that the revision is pushed there; fleet-sync never converges from the package or working tree it was started in.`,
      revision
    );
  if (rehomed !== 'here') return rehomed;
  // The bucket is the source of truth: a run, and a preview, starts from its
  // version of the configuration, the roster and the approval, not from a
  // stale local copy. Refreshing never uploads.
  const fresh = await refresh(stateContext(run));
  const refused = stateRefusal(fresh.standing, options, run, revision);
  if (refused) return refused;
  if (fresh.replaced) {
    // Everything read so far came from the stale copy, the manager's own
    // identity included.
    reloadFleet();
    return restart();
  }
  return (
    copyRefusal(home, revision) ??
    previewOrApply(options, settings, state, {
      run,
      root,
      chosen,
      standing: fresh.standing,
    })
  );
}

/** The preview of a run for the chosen revision, or the run itself. */
function previewOrApply(
  options: FleetSyncOptions,
  settings: Settings,
  state: Enrollment | null,
  {
    run,
    root,
    chosen: { revision, selection },
    standing,
  }: { run: Runner; root: string; chosen: Chosen; standing: Standing }
): Promise<CommandOutcome> {
  const request = {
    ...options,
    revision,
    selection,
    ...replaced(state, revision),
  };
  if (options.dryRun)
    return preview(request, settings, {
      run,
      root,
      applied: state?.appliedRevision ?? null,
      standing,
    });
  return authorizeAndApply(root, state, request, {
    settings,
    run,
    revision,
    standing,
  });
}

/** The approved revision a run for another one replaces. */
function replaced(
  state: Enrollment | null,
  revision: string
): { replaces?: string } {
  return state?.approvedRevision && state.approvedRevision !== revision
    ? { replaces: state.approvedRevision }
    : {};
}

/** A run's revision and what selected it. */
interface Chosen {
  revision: string;
  selection: RevisionSelection;
}

/** The revision the manager converges to and what selected it, or why there
 * is none.
 */
async function managerRevision(
  options: FleetSyncOptions,
  state: Enrollment | null,
  settings: Settings,
  run: Runner
): Promise<Chosen | CommandOutcome> {
  const explicit = requestedRevision(options, state);
  if (explicit === null)
    return actionRequired(
      'FLEET_ROLLBACK_UNAVAILABLE',
      'Nothing was changed: the fleet state records no revision applied before the approved one. Install the dev-fleet version to go back to and run fleet-sync.'
    );
  const { revision, by } = await selectedRevision(
    explicit,
    state?.approvedRevision,
    settings,
    run
  );
  if (!isRevision(revision))
    return actionRequired(
      'FLEET_REVISION_REQUIRED',
      'No revision to converge to. Run the published dev-fleet package (it names the commit it was built from), or select a full commit SHA with --revision.'
    );
  return {
    revision,
    selection: selectionOf(options, {
      revision,
      by: options.rollback ? 'rollback' : by,
    }),
  };
}

/** What selected this run's revision. A run started from the fleet-owned
 * checkout, or on the manager after a hand-off, is always given --revision:
 * the run that started it says what selected the revision. So does the
 * schedule, which names the revision it was enabled with.
 */
function selectionOf(
  options: FleetSyncOptions,
  { revision, by }: { revision: string; by: Selector },
  env = process.env
): RevisionSelection {
  const told =
    by === 'revision' ? decodeSelection(env[SELECTED_BY_ENV], revision) : null;
  const scheduled = by === 'revision' && runTrigger(env) === 'schedule';
  return {
    ...(told ?? { by: scheduled ? 'schedule' : by }),
    ...(options.allowUnmerged ? { allowUnmerged: true as const } : {}),
  };
}

/** Why the revision may not become the fleet's, if it may not: without
 * --allow-unmerged it has to be on the default branch of the source
 * repository, as the manager's own copy of that repository says. Asked by
 * the run a person, the schedule or a worker started, before it leaves for
 * the fleet-owned checkout of the revision and before anything changes; the
 * run in that checkout is the revision's own code and is not asked again.
 */
async function unmergedRefusal(
  options: FleetSyncOptions,
  { revision, selection }: Chosen,
  root: string,
  run: Runner
): Promise<CommandOutcome | null> {
  // The run that started this one may have been given --allow-unmerged.
  if (selection.allowUnmerged) return null;
  if (!asksAncestry(options) || inRunCheckout(revision)) return null;
  const ancestry = await defaultBranchHolds(root, revision, run);
  if (ancestry === 'merged') return null;
  const { repository } = canonicalDefinition.source;
  const selected = `selected by ${selectionText(selection)}`;
  return ancestry === 'unmerged'
    ? actionRequired(
        'FLEET_REVISION_UNMERGED',
        `Revision ${revision} (${selected}) is not on the default branch of ${repository}, so nothing was changed. Merge it first, or pass --allow-unmerged to converge the fleet to an unmerged revision on purpose: every machine, the manager included, then gets that revision's toolchain and policy.`,
        revision
      )
    : actionRequired(
        'FLEET_REVISION_UNVERIFIED',
        `Nothing was changed: ${repository} could not be fetched into the manager's own copy of it, so it is not known whether its default branch holds revision ${revision} (${selected}). Check the network and Git access to it, then run fleet-sync again; --allow-unmerged converges without asking.`,
        revision
      );
}

/** Why the revision's own toolchain bootstrap may not run, if it may not: it
 * is from before the rule that keeps a newer mise, and would replace the
 * mise of the manager or of a worker this run converges with the older one
 * the revision pins, which breaks every checkout there whose mise.toml asks
 * for a newer one. Asked like the question above, by the run a person or the
 * schedule started, before it leaves for the fleet-owned checkout: from
 * there on everything is the revision's own code. The pin is read from the
 * revision's own files. --allow-mise-downgrade lets the bootstrap run.
 */
async function miseRefusal(
  options: FleetSyncOptions,
  { revision }: Chosen,
  settings: Settings,
  { run, root, home }: { run: Runner; root: string; home: string | undefined }
): Promise<CommandOutcome | null> {
  if (!asksMise(options) || allowsMiseDowngrade(options, revision)) return null;
  if (inRunCheckout(revision)) return null;
  const source = await prepareSource(root, revision, run, settings.workspace);
  if (!source) return null;
  const found = await miseDowngrade(
    { revision, source },
    {
      manager: canonicalDefinition.manager.id,
      home,
      workers: await workersToConverge(options, settings.config),
    },
    run
  );
  return found
    ? actionRequired(
        'FLEET_MISE_DOWNGRADE',
        miseDowngradeRemedy(revision, found),
        revision
      )
    : null;
}

/** The preview: the read-only report of every machine, and the plan of what
 * a sync would change on them.
 */
async function preview(
  options: FleetSyncOptions & { revision: string },
  settings: Settings,
  context: {
    run: Runner;
    root: string;
    applied: string | null;
    standing: Standing;
  }
): Promise<CommandOutcome> {
  const outcome = await selected(options, settings, context.run);
  const report = outcome.data as { nodes?: { node?: unknown }[] };
  const plan = await syncPlan(
    {
      from: context.applied,
      to: options.revision,
      state: context.standing,
      nodes: (report.nodes ?? [])
        .map((node) => node.node)
        .filter((node): node is string => typeof node === 'string'),
      sources: planSources(settings.workspace, context.root),
      restartBusy: options.restartBusy === true,
      definitions: {
        applied: appliedDefinition(),
        selected: canonicalDefinition,
      },
    },
    context.run
  );
  return {
    ...outcome,
    data: { ...(outcome.data as object), plan },
    text: [outcome.text, planText(plan)].filter(Boolean).join('\n'),
  };
}

/** The fleet configuration the fleet state records as last applied. */
function appliedDefinition(): unknown {
  try {
    const body = stateDefinition(stateRoot());
    return body === null ? null : (JSON.parse(body) as unknown);
  } catch {
    return null;
  }
}

interface ApplyContext {
  settings: Settings;
  run: Runner;
  revision: string;
  /** How the fleet state stood with the bucket when this run started. */
  standing: Standing;
}

/** Applies without a confirmation prompt; --dry-run is the preview. */
async function authorizeAndApply(
  root: string,
  state: Enrollment | null,
  options: FleetSyncOptions,
  context: ApplyContext
): Promise<CommandOutcome> {
  const { settings, run, revision } = context;
  const request = {
    ...options,
    revision,
    apply: true,
    yes: true,
    readyBefore: readyBefore(state),
  };
  const person = interactive(options);
  // A run without a person enrolls a worker only when every fact it needs
  // is verified; it never prompts.
  const enrollment = await enrollManager(settings.config, run, {
    interactive: person,
    joinable: Boolean(canonicalDefinition.tailnet),
  });
  if (!person)
    return applyLocked(root, state, { ...request, enrollment }, context);
  // Needed to hand each node its own Vault token; nodes report any gap.
  await authorizeManager({ interactive: true }, run);
  return applyLocked(
    root,
    state,
    { ...request, enrollment, interactiveAuthorization: true },
    context
  );
}

/** Records the approved revision, converges, records what was applied, then
 * uploads the fleet state: the report says whether the bucket holds it.
 */
function applyLocked(
  root: string,
  state: Enrollment | null,
  request: FleetSyncOptions & { revision: string },
  context: ApplyContext
): Promise<CommandOutcome> {
  const { settings, run, revision } = context;
  const record = runRecord(state, revision, {
    context: { ...stateContext(run), takeOver: request.takeOver === true },
    standing: context.standing,
    ...(definitionSource().kind === 'file'
      ? { definition: JSON.stringify(canonicalDefinition, null, 2) + '\n' }
      : {}),
    scoped: Boolean(request.node?.length),
    ...(request.selection ? { selection: request.selection } : {}),
  });
  return withMachineLock(root, async () => {
    record.approve();
    try {
      return await selected(
        { ...request, rolledOut: state?.appliedRevision === revision },
        settings,
        run,
        (report) => record.settle(report.ok, appliedRevisions(report))
      );
    } finally {
      await record.abandon();
    }
  }).catch((error: unknown) => {
    if (error instanceof FleetLockError)
      return actionRequired(
        'FLEET_MANAGER_LOCKED',
        'Another manager run or interrupted lock exists. Inspect manager and remote processes before removing an abandoned sync.lock; never steal active package-manager locks.'
      );
    throw error;
  });
}
/** Every run (previews and schedules too) happens on the manager: a worker can
 * neither converge the manager's singletons nor observe its T3 links, so a
 * partial run there only produces misleading failures.
 */
async function onManager(run: Runner): Promise<boolean> {
  const { manager } = canonicalDefinition;
  return (await managerIdentity(manager.id, run)).status === 'pass';
}

/** Hands the request to the manager; refuses (without touching any worker)
 * when hand-off is disabled, e.g. on the manager side of a hand-off.
 */
async function offManager(
  options: FleetSyncOptions,
  settings: Settings,
  run: Runner,
  forward: ForwardSpawn | undefined
): Promise<CommandOutcome> {
  const definition = canonicalDefinition;
  // Only the manager's fleet state knows the revision applied before.
  if (options.rollback)
    return actionRequired(
      'FLEET_NOT_MANAGER',
      `fleet-sync --rollback runs only on the manager (${definition.manager.id}); nothing was changed.`
    );
  const { revision, by } = await selectedRevision(
    options.revision,
    undefined,
    settings,
    run
  );
  if (forwardingDisabled())
    return actionRequired(
      'FLEET_NOT_MANAGER',
      `fleet-sync runs only on the manager (${definition.manager.id}), which is always a macOS machine; nothing was changed. Run it there, or from a worker that can SSH to the manager.`,
      revision ?? null
    );
  const runScript = revision
    ? await managerRunScript(settings.workspace, revision, run)
    : null;
  const local = hostId(hostname());
  return forwardToManager(definition, options, revision, {
    spawn: forward,
    script: runScript,
    selection: {
      by,
      ...(options.allowUnmerged ? { allowUnmerged: true as const } : {}),
      // Only a declared worker is named: no other host name is recorded.
      handOff: {
        worker: definition.workers.some((worker) => worker.id === local)
          ? local
          : null,
      },
    },
  });
}

function scheduleStatus(
  settings: Settings,
  run: Runner
): Promise<CommandOutcome> {
  return managerSchedule(
    {
      action: 'status',
      revision: '',
      config: settings.config,
      authorized: false,
    },
    run
  );
}

function actionRequired(
  code: string,
  remedy: string,
  revision: string | null = null
): CommandOutcome {
  const report = managerFailure(canonicalDefinition, revision, code, remedy);
  return {
    exitCode: 1,
    data: report,
    text: managerText(report, { color: stdoutColor() }),
  };
}

function validate(options: FleetSyncOptions): void {
  validateSchedule(options.schedule);
  if (options.all && options.node?.length)
    throw new FleetUsageError('Choose --all or --node, not both.');
  if (options.revision !== undefined && !isRevision(options.revision))
    throw new FleetUsageError(
      '--revision requires an exact lowercase 40-character commit SHA.'
    );
  validateOnly(options);
  validateRollback(options);
  validateUnmerged(options);
  if (options.restartBusy && (options.only || options.schedule))
    throw new FleetUsageError(
      '--restart-busy applies to one full sync: it takes neither --only nor --schedule.'
    );
  validateMaintenance(options);
  if (options.dryRun && (options.apply || options.yes))
    throw new FleetUsageError(
      '--dry-run cannot be combined with apply confirmation.'
    );
}
function validateUnmerged(options: FleetSyncOptions): void {
  if (options.allowUnmerged && (options.only || options.schedule))
    throw new FleetUsageError(
      '--allow-unmerged applies to one sync a person starts: it takes neither --only nor --schedule.'
    );
  if (options.allowMiseDowngrade && (options.only || options.schedule))
    throw new FleetUsageError(
      '--allow-mise-downgrade applies to one sync a person starts: it takes neither --only nor --schedule.'
    );
}
function validateMaintenance(options: FleetSyncOptions): void {
  if (options.force && !options.maintenanceReboot)
    throw new FleetUsageError(
      '--force only goes with --maintenance-reboot: it reboots a worker even while agent turns run.'
    );
  if (
    options.maintenanceReboot &&
    (options.dryRun || options.schedule || options.only)
  )
    throw new FleetUsageError(
      '--maintenance-reboot reboots workers; it takes neither --dry-run, --schedule nor --only.'
    );
}
function validateRollback(options: FleetSyncOptions): void {
  if (!options.rollback) return;
  if (options.revision !== undefined || options.schedule)
    throw new FleetUsageError(
      '--rollback chooses the revision itself: drop --revision and --schedule.'
    );
  if (options.only)
    throw new FleetUsageError(
      '--rollback converges the whole fleet; it takes no --only.'
    );
}

function validateOnly(options: FleetSyncOptions): void {
  if (options.only !== undefined && options.only !== 'accounts')
    throw new FleetUsageError('--only takes one scope: accounts.');
  if (options.only && (options.dryRun || options.schedule))
    throw new FleetUsageError(
      '--only accounts applies at once; it takes neither --dry-run nor --schedule.'
    );
}

/** `--only accounts`: workers keep the revision they run; only their
 * accounts change.
 */
async function onlyAccounts(
  options: FleetSyncOptions,
  settings: Settings,
  run: Runner
): Promise<CommandOutcome> {
  const root = machineRoot();
  await ensurePrivateRoot(root);
  const state = await loadEnrollment(legacyHome() ? root : null);
  const revision =
    state?.approvedRevision ??
    (await selectedRevision(options.revision, undefined, settings, run))
      .revision;
  if (!isRevision(revision))
    return actionRequired(
      'FLEET_REVISION_REQUIRED',
      'No revision is applied yet. Run a full fleet-sync first.'
    );
  return syncAccounts(options, settings, { revision, run });
}

/** The workers that converged before this run. A fleet state written before
 * it recorded each worker's revision counts every worker of a fleet that
 * was applied as converged.
 */
function readyBefore(state: Enrollment | null): string[] {
  if (state?.workers) return Object.keys(state.workers);
  return state?.appliedRevision
    ? canonicalDefinition.workers.map((worker) => worker.id)
    : [];
}

function interactive(options: FleetSyncOptions): boolean {
  return (
    ![
      options.dryRun,
      options.apply,
      options.yes,
      options.json,
      options.nonInteractive,
      process.env['CI'],
    ].some(Boolean) && Boolean(process.stdin.isTTY && process.stderr.isTTY)
  );
}

/** The commit an installed package was published from: the version of
 * dev-fleet you run is the revision the fleet moves to.
 */
function packageRevision(): string | undefined {
  return packageInfo().revision ?? undefined;
}

async function scheduleRequest(
  options: FleetSyncOptions,
  revision: string,
  settings: Settings,
  run: Runner
): Promise<CommandOutcome> {
  const root = machineRoot();

  if (options.dryRun)
    return actionRequired(
      'FLEET_SCHEDULE_PREVIEW',
      'No schedule changed. Inspect --schedule status; scheduling writes require --apply --yes.'
    );
  if (!options.apply || !options.yes)
    return managerSchedule(
      {
        action: options.schedule!,
        revision,
        config: settings.config,
        authorized: false,
      },
      run
    );
  return withMachineLock(root, () =>
    managerSchedule(
      {
        action: options.schedule!,
        revision,
        config: settings.config,
        authorized: Boolean(options.apply && options.yes),
      },
      run
    )
  );
}

function validateSchedule(schedule: unknown): void {
  if (
    schedule !== undefined &&
    !['enable', 'pause', 'resume', 'disable', 'status'].includes(
      String(schedule)
    )
  )
    throw new FleetUsageError('Unknown manager schedule action.');
}

/** The revision a request names: --revision, or for --rollback the one
 * applied before the approved one (null when the fleet state records none).
 * After an approved revision that never became the applied one (its canary
 * failed), that is the applied revision itself.
 */
function requestedRevision(
  options: FleetSyncOptions,
  state: Enrollment | null
): string | undefined | null {
  if (!options.rollback) return options.revision;
  if (
    state?.appliedRevision &&
    state.appliedRevision !== state.approvedRevision
  )
    return state.appliedRevision;
  return state?.previousRevision ?? null;
}

/** The revision a run converges to and where it came from: the request, the
 * commit the installed package was published from, the HEAD of the checkout
 * the CLI runs from, then the revision already approved.
 */
async function selectedRevision(
  explicit: string | undefined,
  approved: string | undefined,
  settings: Settings,
  run: Runner
): Promise<{ revision: string | undefined; by: Selector }> {
  if (explicit) return { revision: explicit, by: 'revision' };
  const published = packageRevision();
  if (published) return { revision: published, by: 'package' };
  const head = await localCheckoutRevision(settings.workspace, run);
  if (head) return { revision: head, by: 'checkout' };
  return { revision: approved, by: 'approved' };
}

/** The revision each worker holds after this run, for the fleet state: a
 * worker that converged keeps its progress even when the fleet is not ready.
 */
function appliedRevisions(report: ManagerReport): Record<string, string> {
  return Object.fromEntries(
    report.nodes
      .filter((node) => node.role !== 'manager' && node.appliedRevision)
      .map((node) => [node.node, node.appliedRevision!])
  );
}

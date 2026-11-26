import { blocking, type Check, type Runner } from '../types';
import { disposableStorage, type FleetDefinition } from '../definition';
import type { ManagerNode } from '../manager-sync';
import { convergeProxy } from '../proxy-converge';
import { attempt } from '../node-converge-shared';
import { toolchainChecks } from '../toolchain-checks';
import { idesOf as managerIdes } from '../ide/definition';
import { pinnedT3Version, versionCheck } from '../t3/version';
import { liveServerVersion } from '../platform/t3-service';
import { managerQuotaCoverage } from '../t3/quota-coverage';
import { quotaLimited, verifyFleetProviders } from '../agents/fleet-verify';
import { verifyNativeAgents } from '../agents/native-verify';
import { accountContext, nodeAccountChecks } from '../accounts/context';
import { convergeManagerHub } from '../monitoring/manager-hub';
import { enrollManagerMonitoring } from './fleet-sync-monitoring';
import { installConfig, secretVia } from '../fleet-config';
import { IDES } from '../ide';
import { enabled, managerChecks } from '../ide/orchestrate';
import { idesOf } from '../ide/definition';
import { convergeGitIdentity, gitChecks } from '../git-identity';
import { stableWorkspace } from '../platform/t3-policy';
import { launcherCheck } from '../workstation-checks';
import { ansibleCommand } from '../platform/ansible';
import { runAnsibleWithReceipt } from '../platform/ansible-receipt';
import macos from '../../ansible/macos/policy.json';
import { scheduleIntervals } from '../schedule-check';
import { convergeGithub } from '../github/converge';
import { PACKAGE_ROOT } from '../package-info';
import { managerHealth } from '../manager-health';
import { holdManagerVault } from './fleet-sync-vault';
import { readFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import {
  MACOS_MANAGER,
  managerHost,
  type ManagerHost,
} from '../platform/manager-host';
import { join } from 'node:path';

/** The manager converges itself locally (never over SSH) before any worker:
 * it must be the declared manager, stay awake on AC power, and host every
 * singleton service (CLI proxy, Beszel hub). Workers only consume them.
 */
export async function convergeManager(
  definition: FleetDefinition,
  input: {
    revision: string;
    apply: boolean;
    workspace: string;
    /** Told the step that starts now, in words a progress line shows. */
    progress?: (step: string) => void;
  },
  run: Runner
): Promise<ManagerNode> {
  const started = Date.now();
  const id = definition.manager.id;
  const host = managerHost(definition.manager.os);
  const checks: Check[] = [];
  const say = (label: string) => input.progress?.(label);
  say('Checking that this is the manager');
  const [identity] = await timed(() => managerIdentity(id, run, host));
  checks.push(identity!);
  if (identity!.status === 'pass') {
    // Launchers and scheduled jobs on the manager read the installed copy.
    if (input.apply) {
      installConfig();
      // The public launcher and scheduled jobs need current even without T3.
      await stableWorkspace(input.workspace);
      say('Applying the manager playbook');
      checks.push(
        ...(await timed(() => convergeManagerPolicy(run, definition, host)))
      );
    }
    say('Measuring power, boot recovery, Docker, Vault, IDEs and health');
    checks.push(...(await managerMeasures(definition, input, run, host)));
    if (input.apply)
      checks.push(...(await managerAgents(definition, input, run)));
    say('Converging the CLI proxy');
    checks.push(
      ...(await timed(() =>
        convergeProxy(id, input.revision, run, {
          apply: input.apply,
          cwd: input.workspace,
        })
      ))
    );
    if (input.apply) {
      say('Converging the monitoring hub');
      const hub = await timed(() =>
        convergeManagerHub(input.workspace, definition, run)
      );
      checks.push(...hub);
      // The manager is always a monitored system on its own hub.
      if (!hub.some(blocking)) {
        say('Enrolling the manager in monitoring');
        checks.push(
          ...(await timed(() =>
            enrollManagerMonitoring(definition, input.workspace, run)
          ))
        );
      }
    }
  }
  return {
    node: id,
    role: 'manager',
    checks,
    reachability: 'online',
    desiredRevision: input.revision,
    appliedRevision:
      input.apply && !checks.some(blocking) ? input.revision : null,
    durationMs: Date.now() - started,
  };
}

/** One step's checks, each saying how long the step took. */
async function timed(work: () => Promise<Check | Check[]>): Promise<Check[]> {
  const began = Date.now();
  const found = [await work()].flat();
  const phaseDurationMs = Date.now() - began;
  return found.map((check) => ({ phaseDurationMs, ...check }));
}

/** Steps that do not depend on each other, run side by side; their checks
 * in the order the steps are written, whichever ended first.
 */
async function together(
  steps: (() => Promise<Check | Check[]>)[]
): Promise<Check[]> {
  return (await Promise.all(steps.map(timed))).flat();
}

/** What is measured of the manager itself: each reads or holds something of
 * its own (power settings, the boot recovery job, Docker, an IDE, the
 * disk), so they run side by side once the Vault session is held.
 */
async function managerMeasures(
  definition: FleetDefinition,
  input: { apply: boolean; workspace: string },
  run: Runner,
  host: ManagerHost
): Promise<Check[]> {
  const id = definition.manager.id;
  // The Vault session comes first and alone: later steps read secrets with
  // it. Its renewal job is a launch agent: macOS managers only.
  const vault =
    host.platform === 'macOS'
      ? await timed(() =>
          attempt('manager:vault-renewal', () =>
            holdManagerVault(run, { apply: input.apply, root: PACKAGE_ROOT })
          )
        )
      : [];
  const rest = await together([
    () => managerPower(run, input.workspace, host),
    () => managerBootRecovery(run, input.workspace, host),
    () => managerDocker(run),
    // Each enabled IDE: its settings, pinned version and policy.
    () =>
      managerChecks(enabled(idesOf(definition), IDES), {
        id,
        workspace: input.workspace,
        apply: input.apply,
        run,
      }),
    () => managerHealth(run),
  ]);
  if (definition.softwarePolicy) {
    rest.push(...await toolchainChecks(input.workspace,run));
    if (managerIdes(definition).includes('t3')) rest.push({...versionCheck(await liveServerVersion(run) ?? null, await pinnedT3Version(input.workspace), 'the manager','Restart the manager server when its active turns finish.'), id:'t3:running-version'});
  }
  return [...vault, ...rest];
}

/** The same provider profiles, Git identity, GitHub sign-in, agents,
 * versions and shared accounts as every worker: the instances launch from
 * these profiles, and the checks prove the credential works end to end
 * through the shared proxy.
 *
 * The profiles come first: every session launches from them. Git and GitHub
 * then run beside the providers, accounts and agent sessions, which use
 * neither.
 */
async function managerAgents(
  definition: FleetDefinition,
  input: { workspace: string; progress?: (step: string) => void },
  run: Runner
): Promise<Check[]> {
  const id = definition.manager.id;
  input.progress?.('Rendering agent profiles');
  const profiles = await timed(() =>
    attempt('configuration:apply', () =>
      managerAgentProfiles(id, input.workspace, run)
    )
  );
  input.progress?.(
    'Converging Git and GitHub; verifying providers, accounts and agent sessions'
  );
  const [git, agents] = await Promise.all([
    managerGit(definition, input.workspace, run),
    managerSessions(id, input.workspace, run),
  ]);
  return [...profiles, ...git, ...agents];
}

/** The Git identity, then what reads it: git asks gh for the token through
 * the helper git.yml declares, so these three keep their order.
 */
async function managerGit(
  definition: FleetDefinition,
  workspace: string,
  run: Runner
): Promise<Check[]> {
  const identity = await timed(() =>
    attempt('git:configuration', () =>
      convergeGitIdentity(workspace, definition.git, run)
    )
  );
  const { git } = definition;
  const checked = git ? await timed(() => gitChecks(git, run)) : [];
  // The same GitHub sign-in as every worker, or only a check of a person's
  // own login when the configuration names one.
  const github = await timed(() =>
    attempt('github:sync', async () => [
      await convergeGithub(workspace, run, undefined, {
        secrets: secretVia(run),
        role: 'manager',
      }),
    ])
  );
  return [...identity, ...checked, ...github];
}

/** Providers, then the accounts and the sessions that depend on what the
 * providers found out of quota.
 */
async function managerSessions(
  id: string,
  workspace: string,
  run: Runner
): Promise<Check[]> {
  const providers = await timed(() =>
    attempt('provider:verification', () => verifyFleetProviders(id))
  );
  const accounts = await accountContext();
  const roster = await timed(() =>
    attempt('accounts:verification', () => nodeAccountChecks(accounts))
  );
  const sessions = await timed(() =>
    attempt('agent:verification', () =>
      verifyNativeAgents(id, workspace, run, {
        outOfQuota: quotaLimited(providers),
        ...(accounts ? { accounts } : {}),
      })
    )
  );
  return [
    ...providers,
    ...roster,
    ...sessions,
    ...(await managerQuotaCoverage(accounts?.live ?? [], run)),
  ];
}

function playbookPassed(cached: boolean): Check {
  return cached
    ? {
        id: 'manager:playbook',
        status: 'pass',
        summary:
          'The manager playbook is unchanged since it was last applied, and its postconditions hold.',
        reused: 'receipt',
      }
    : {
        id: 'manager:playbook',
        status: 'pass',
        summary: 'The manager playbook was checked, then applied.',
      };
}

const PROFILE_TOOLS = [
  'codex',
  'claude',
  'gemini',
  'opencode',
  'grok',
  'antigravity',
] as const;

/** Applies the proxy agent profiles the managed T3 instances launch from
 * (codex-proxy.ts refuses to start with a missing or stale profile). Workers
 * apply the same profiles from a pinned deployment; the manager's checkout is
 * the human's working tree, so only the workstation sources must be clean
 * (the `agents apply` owner enforces that) and nothing else is touched.
 */
export async function managerAgentProfiles(
  id: string,
  workspace: string,
  run: Runner
): Promise<Check[]> {
  // One process for every tool: each start of the pinned Bun costs about
  // as much as applying a profile does.
  const result = await run(
    [
      'mise',
      'exec',
      '--locked',
      'bun',
      '--',
      'bun',
      'src/agents/cli.ts',
      '--json',
      '--yes',
      '--non-interactive',
      'agents',
      'apply',
      '--node',
      id,
      '--tool',
      PROFILE_TOOLS.join(','),
      '--profile',
      'proxy',
    ],
    { cwd: workspace, timeoutMs: 300_000 }
  );
  if (!result.ok) {
    const tool = failedTool(result.stdout) ?? PROFILE_TOOLS.join(',');
    return [
      {
        id: 'configuration:apply',
        status: 'fail',
        summary: 'MANAGER_AGENT_PROFILES_FAILED',
        remedy: {
          action: `Run bun src/agents/cli.ts --yes agents apply --node ${id} --tool ${tool} --profile proxy in the dev-fleet checkout on the manager and review the result.`,
        },
      },
    ];
  }
  return [
    {
      id: 'configuration:apply',
      status: 'pass',
      summary: `The manager has the same proxy agent profiles as every worker (${PROFILE_TOOLS.join(', ')}).`,
    },
  ];
}

/** The tool `agents apply` stopped at, from the line it printed for it. */
function failedTool(stdout: string): string | undefined {
  for (const line of stdout.split('\n').reverse()) {
    try {
      const said = JSON.parse(line) as { ok?: unknown; tool?: unknown };
      if (
        said.ok === false &&
        (PROFILE_TOOLS as readonly unknown[]).includes(said.tool)
      )
        return said.tool as string;
    } catch {
      /* Not a line of the command's own. */
    }
  }
  return undefined;
}

/** fleet-sync runs only on the declared manager. */
export async function managerIdentity(
  id: string,
  run: Runner,
  host: ManagerHost = MACOS_MANAGER,
  platform: NodeJS.Platform = process.platform
): Promise<Check> {
  const local = (await host.localHostName(run)) ?? '';
  return local === id
    ? {
        id: 'manager:identity',
        status: 'pass',
        summary: `This machine is the declared fleet manager (${id}).`,
      }
    : {
        id: 'manager:identity',
        status: 'fail',
        summary: 'FLEET_NOT_MANAGER',
        remedy: {
          action:
            platform === 'darwin'
              ? `Run fleet-sync on the manager (${id}). Workers are never controlled from another worker; change the manager only by editing manager in fleet.json and moving its singleton services.`
              : `This machine runs ${platform}, and the manager is always a macOS machine. Run fleet-sync on the manager (${id}), or from a worker that can SSH to it.`,
        },
      };
}

/** Workers depend on the manager's services, so it never sleeps on AC power.
 * Measures every setting `ansible/macos/manager.yml` declares, from the same
 * policy file the playbook applies. A setting pmset does not list on AC power
 * is one this Mac does not have (a virtual Mac has no womp): the playbook
 * skips it, so it is not applicable here either.
 */
export async function managerPower(
  run: Runner,
  workspace = '.',
  host: ManagerHost = MACOS_MANAGER
): Promise<Check> {
  const { drifted, notApplicable } = await host.powerDrift(run);
  return drifted.length === 0
    ? {
        id: 'manager:power',
        status: 'pass',
        summary:
          notApplicable.length === 0
            ? 'The manager never sleeps on AC power.'
            : `The manager never sleeps on AC power; not applicable on this Mac: ${notApplicable.join(' ')}.`,
      }
    : {
        id: 'manager:power',
        status: 'fail',
        summary: drifted.includes('sleep')
          ? 'MANAGER_SLEEPS_ON_POWER'
          : `MANAGER_POWER_POLICY_DRIFT ${drifted.join(' ')}`,
        remedy: {
          action: `Workers lose the CLI proxy and Beszel hub while the manager sleeps. Grant the manager its power settings once, as an administrator; every fleet-sync then applies the policy with no prompt: cd ${workspace} && ${ansibleCommand().join(' ')} -e user=$(id -un) -K ansible/macos/manager-privilege.yml`,
        },
      };
}

/** After a power cut the manager comes back by itself: the machine starts
 * again, a user session exists for its per-user services, and the container
 * engine that hosts the proxy and the hub starts with it. A FileVault Mac
 * waits for a person; that is reported as a warning with its consequence.
 */
export async function managerBootRecovery(
  run: Runner,
  workspace = '.',
  host: ManagerHost = MACOS_MANAGER,
  home = homedir()
): Promise<Check> {
  const items = await host.bootRecovery(run, home);
  const failing = items.filter((entry) => entry.status === 'fail');
  const warning = items.filter((entry) => entry.status === 'warn');
  if (!failing.length && !warning.length)
    return {
      id: 'manager:boot-recovery',
      status: 'pass',
      summary: 'The manager comes back by itself after a power cut or reboot.',
    };
  const named = failing.length ? failing : warning;
  return {
    id: 'manager:boot-recovery',
    status: failing.length ? 'fail' : 'warn',
    summary: `MANAGER_BOOT_RECOVERY_INCOMPLETE ${named.map((entry) => entry.item).join(' ')}`,
    remedy: {
      action: [
        ...[...failing, ...warning].map((entry) => entry.detail),
        host.bootRemedy(workspace),
      ].join(' '),
    },
  };
}

/** The receipt of the manager's own playbook, beside the workers' ones. */
export const MANAGER_RECEIPT = 'macos-manager';

/** On every applying sync the manager applies `ansible/macos/manager.yml`
 * like a worker applies its baseline: in check mode first, then for real,
 * with a receipt that skips an unchanged playbook while its postconditions
 * hold, and a full re-apply at least once a day. It never asks for a
 * password: what needs root goes through the grant manager-privilege.yml
 * installs once, and the playbook skips it without the grant.
 */
export async function convergeManagerPolicy(
  run: Runner,
  definition: Pick<FleetDefinition, 'manager' | 'storage'>,
  host: ManagerHost = MACOS_MANAGER,
  {
    root = PACKAGE_ROOT,
    scratch,
    receipts,
    uid = userInfo().uid,
    now,
  }: {
    root?: string;
    scratch?: string;
    receipts?: string;
    uid?: number;
    now?: number;
  } = {}
): Promise<Check> {
  if (host.platform !== 'macOS')
    return {
      id: 'manager:playbook',
      status: 'not-applicable',
      summary: 'The manager playbook is for a macOS manager.',
    };
  const result = await runAnsibleWithReceipt(
    run,
    join(root, 'ansible/macos/manager.yml'),
    {
      cwd: join(root, 'ansible/macos'),
      timeoutMs: 300_000,
      input: JSON.stringify({
        fleet_watch_minutes: scheduleIntervals(definition.manager).watchMinutes,
        // The disk GC's policy (storage.disposable in fleet.json).
        fleet_storage_disposable: disposableStorage(definition),
        fleet_storage_target_used_percent:
          definition.storage?.targetUsedPercent,
      }),
    },
    {
      name: MANAGER_RECEIPT,
      // The disk GC job runs the workers' collector with their policy.
      sources: [
        join(root, 'ansible/macos'),
        join(root, 'ansible/ubuntu/disk-gc.py'),
        join(root, 'ansible/ubuntu/policy.json'),
      ],
      checkFirst: true,
      verify: async () =>
        (await host.powerDrift(run)).drifted.length === 0 &&
        (await launcherCheck(run)).status === 'pass' &&
        (await watchLoaded(run, uid)) &&
        (await jobLoaded(run, uid, macos.diskGc.label)),
      ...(receipts ? { directory: receipts } : {}),
      ...(scratch ? { scratch } : {}),
      ...(now === undefined ? {} : { now }),
    }
  );
  if (result.ok) return playbookPassed(result.cached);
  return {
    id: 'manager:playbook',
    status: 'fail',
    summary:
      result.stage === 'check'
        ? 'MANAGER_PLAYBOOK_CHECK_FAILED'
        : 'MANAGER_PLAYBOOK_FAILED',
    remedy: {
      action: `Run the playbook in check mode on the manager and read the failing task: ${ansibleCommand().join(' ')} --check --diff ${join(root, 'ansible/macos/manager.yml')}. Nothing in it needs a password; what needs root comes from the one grant (manager-privilege.yml).`,
    },
  };
}

/** Whether launchd holds the fleet-watch job manager.yml installs. Reads only. */
export async function watchLoaded(run: Runner, uid: number): Promise<boolean> {
  return jobLoaded(run, uid, macos.fleetWatch.label);
}

/** Whether launchd holds a job of the user. Reads only. */
async function jobLoaded(
  run: Runner,
  uid: number,
  label: string
): Promise<boolean> {
  return (
    await run(['/bin/launchctl', 'print', `gui/${uid}/${label}`], {
      timeoutMs: 10_000,
    })
  ).ok;
}

/** The Docker Desktop release `mise.toml` pins, as the engine names itself. */
export function pinnedDockerDesktop(root = PACKAGE_ROOT): string {
  const { vars } = Bun.TOML.parse(
    readFileSync(join(root, 'mise.toml'), 'utf8')
  ) as { vars: Record<string, string> };
  return `Docker Desktop ${vars['docker_desktop_version']} (${vars['docker_desktop_build']})`;
}

/** The manager's services run in Docker Desktop, which no playbook installs
 * and which updates itself: the pinned release is measured, and a different
 * one warns instead of failing the run.
 */
export async function managerDocker(
  run: Runner,
  pinned = pinnedDockerDesktop()
): Promise<Check> {
  const result = await run(
    ['docker', 'version', '--format', '{{.Server.Platform.Name}}'],
    { timeoutMs: 20_000 }
  );
  const observed = result.ok ? result.stdout.trim() : '';
  if (observed === pinned)
    return {
      id: 'manager:docker',
      status: 'pass',
      summary: `The manager runs the pinned ${pinned}.`,
    };
  return {
    id: 'manager:docker',
    status: 'warn',
    summary: observed
      ? 'MANAGER_DOCKER_DESKTOP_DRIFT'
      : 'MANAGER_DOCKER_DESKTOP_UNOBSERVED',
    remedy: {
      action: `The manager's services are tested on ${pinned}. Install that release and turn off its automatic updates, or expect differences; fleet-sync does not install or replace Docker Desktop.`,
    },
  };
}

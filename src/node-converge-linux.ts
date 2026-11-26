import { FIREWALL_TABLE, parseFirewall } from './worker-exposure';
import { existsSync } from 'node:fs';
import { applyScreenSharing } from './screen-sharing';
import ubuntuPolicy from '../ansible/ubuntu/policy.json';
import { workerReadiness } from './worker-readiness';
import { runAnsible } from './platform/ansible';
import { runAnsibleWithReceipt } from './platform/ansible-receipt';
import {
  loadedT3Policy,
  stageT3Policy,
  stablePath,
  stableWorkspace,
} from './platform/t3-policy';
import { verifyUbuntuBoot } from './platform/ubuntu-verify';
import { verifyResourceSafety } from './platform/resource-verify';
import { convergeT3Route, T3_ROUTE } from './platform/t3-route';
import { convergeProxy } from './proxy-converge';
import { IDES } from './ide';
import { enabled, settingsChecks } from './ide/orchestrate';
import { idesOf } from './ide/definition';
import { fleet } from './fleet-config';
import { disposableStorage } from './definition';
import { quotaLimited, verifyFleetProviders } from './agents/fleet-verify';
import { verifyNativeAgents } from './agents/native-verify';
import { commandsPlay, linkAgentCommands } from './agents/commands';
import { accountContext, nodeAccountChecks } from './accounts/context';
import { managedT3, managedT3Desktop } from '../bootstrap/native-t3';
import {
  convergeT3Service,
  runningVersionCheck,
  t3StartedAt,
  t3Unit,
} from './platform/t3-service';
import {
  featuresCheck,
  presentParts,
  workerFeatures,
  type WorkerFeatures,
} from './worker-features';
import { userInfo } from 'node:os';
import { resolve } from 'node:path';
import { auditUbuntu } from './platform/ubuntu-audit';
import { detectMachineClass } from './machine/machine-class';
import { convergeGitIdentity } from './git-identity';
import { workerSelection } from '../bootstrap/worker-tools';
import { workerExposure } from './exposure';
import { agentSessionLimit } from './agent-session-limit';
import {
  applyAgentProfiles,
  attempt,
  configureWorkstation,
} from './node-converge-shared';
import { loginServer } from './tailnet-control';
import { tailscaleConfiguration } from './tailscale-configuration';
import type { Check, Runner } from './types';

/** Ubuntu worker convergence: Ansible owns OS policy, services and recovery; the
 * native T3, proxy and provider owners run only after the baseline passes.
 */
export async function convergeLinux(
  root: string,
  target: { node: string; revision: string; restartBusy?: boolean },
  run: Runner
): Promise<Check[]> {
  const { node, revision } = target;
  const restartBusy = target.restartBusy === true;
  const audit = await auditUbuntu(run);
  if (!audit.supported || !audit.passwordlessSudo)
    return [
      {
        id: 'ubuntu:prerequisites',
        status: 'fail',
        summary: audit.supported
          ? 'SUDO_AUTHORIZATION_REQUIRED'
          : 'UBUNTU_BASELINE_MISMATCH',
        remedy: {
          action:
            'Authorize designated-user sudo through the manager enrollment flow; unsupported releases require an explicit migration.',
        },
      },
    ];
  const checks: Check[] = [];
  checks.push(
    ...(await attempt('tailscale:configuration', async () => [
      await applyTailscale(root, node, run),
    ]))
  );
  const features = workerFeatures(fleet, node);
  const machine = fleet.workers.find((entry) => entry.id === node);
  if (
    !machine?.screenSharing &&
    existsSync('/etc/systemd/system/devfleet-rdp-credential.service')
  ) {
    const user = userInfo();
    const retired = await runAnsible(
      run,
      resolve(root, 'ansible/ubuntu/retire-screen-sharing.yml'),
      {
        input: JSON.stringify({
          development_user: user.username,
          development_uid: user.uid,
          development_home: user.homedir,
        }),
        timeoutMs: 120_000,
      }
    );
    if (!retired.ok)
      return [
        ...checks,
        {
          id: 'worker:screen-sharing-policy',
          status: 'fail',
          summary: 'RDP_RETIREMENT_FAILED',
          remedy: {
            action:
              'Restore the enrolled user session and rerun fleet-sync before changing the firewall.',
          },
        },
      ];
  }
  const before = await presentParts(run, userInfo().username, features);
  const { baseline, verified } = await baselineStep(root, run, node);
  checks.push(...baseline, ...verified);
  if (
    machine?.screenSharing &&
    baseline.every((check) => check.status === 'pass')
  )
    checks.push(
      ...(await attempt('worker:screen-sharing-policy', async () => [
        await applyScreenSharing(root, machine, run),
      ]))
    );
  checks.push(
    featuresCheck(
      features,
      await presentParts(run, userInfo().username, features),
      before
    )
  );
  checks.push(
    ...(await t3AfterBaseline(root, { node, baseline, run, restartBusy }))
  );
  checks.push(
    ...(await attempt('workstation:configuration', () =>
      configureWorkstation(root, run, node)
    ))
  );
  checks.push(
    ...(await attempt('git:configuration', () =>
      convergeGitIdentity(root, fleet.git, run)
    ))
  );
  checks.push(
    ...(await attempt('configuration:apply', () =>
      applyAgentProfiles(root, node, revision, run)
    ))
  );
  checks.push(
    ...(await attempt('agent:commands', async () => [
      await linkAgentCommands(root, commandsPlay(run)),
    ]))
  );
  checks.push(
    ...(await attempt('proxy:configuration', () =>
      convergeProxy(node, revision, run)
    ))
  );
  const providers = await attempt('provider:verification', () =>
    verifyFleetProviders(node)
  );
  checks.push(...providers);
  const accounts = await accountContext();
  checks.push(
    ...(await attempt('accounts:verification', () =>
      nodeAccountChecks(accounts)
    ))
  );
  checks.push(
    ...(await attempt('agent:verification', () =>
      verifyNativeAgents(node, root, run, {
        outOfQuota: quotaLimited(providers),
        // Where T3 starts them: the environment of its user service.
        t3Service: true,
        ...(accounts ? { accounts } : {}),
      })
    ))
  );
  checks.push(
    ...(await attempt('worker:readiness', () => workerReadiness(run, node)))
  );
  return checks;
}

/** Applies the baseline (skipped on an unchanged, verified receipt), then
 * measures boot and resource policy. Self-healing: if a skipped baseline's
 * effective policy no longer verifies, the baseline is applied in full and
 * measured again in the same run.
 */
async function baselineStep(
  root: string,
  run: Runner,
  node: string
): Promise<{ baseline: Check[]; verified: Check[] }> {
  const { machine } = await detectMachineClass(run);
  const measure = async () => [
    ...(await attempt('ubuntu:boot-policy', () =>
      verifyUbuntuBoot(userInfo().username, run, machine)
    )),
    ...(await attempt('ubuntu:resource-safety', () =>
      verifyResourceSafety(userInfo().homedir, run)
    )),
  ];
  let cached = false;
  let baseline = await attempt('ubuntu:baseline', async () => {
    await stableWorkspace(root);
    const applied = await applyBaseline(root, run, false, node);
    cached = applied.cached;
    return applied.checks;
  });
  let verified = await measure();
  if (cached && verified.some((check) => check.status === 'fail')) {
    baseline = await attempt('ubuntu:baseline', async () => {
      return (await applyBaseline(root, run, true, node)).checks;
    });
    verified = await measure();
  }
  return { baseline, verified };
}

async function applyBaseline(
  root: string,
  run: Runner,
  force: boolean,
  node: string
): Promise<{ cached: boolean; checks: Check[] }> {
  const user = userInfo();
  const features = workerFeatures(fleet, node);
  const ubuntu = resolve(root, 'ansible/ubuntu');
  const result = await runAnsibleWithReceipt(
    run,
    resolve(ubuntu, 'baseline.yml'),
    {
      cwd: ubuntu,
      timeoutMs: 900_000,
      input: JSON.stringify({
        development_source: stablePath(root),
        development_user: user.username,
        development_uid: user.uid,
        development_home: user.homedir,
        // The web profile brings headless Chromium (tasks/browser.yml).
        worker_tool_profiles: workerSelection(fleet, node).profiles,
        // What the firewall opens beyond the tailnet (tasks/firewall.yml).
        worker_exposure: workerExposure(fleet, node).policy,
        // What the declared features leave out (tasks/features.yml).
        worker_containers: features.containers,
        worker_session: features.session,
        // 0: no limit declared, so its unit is removed
        // (tasks/agent-session-limit.yml).
        worker_agent_session_limit: agentSessionLimit(fleet, node) ?? 0,
        // The disk GC's policy (tasks/resources.yml, storage.disposable).
        fleet_storage_disposable: disposableStorage(fleet),
      }),
    },
    {
      name: 'ubuntu-baseline',
      sources: [ubuntu, resolve(root, 'ansible/github')],
      force,
      verify: () =>
        baselineServicesActive(
          run,
          features,
          fleet.workers.find((entry) => entry.id === node)?.screenSharing?.port
        ),
    }
  );
  return {
    cached: result.cached,
    checks: [
      {
        id: 'ubuntu:baseline',
        status: result.ok ? 'pass' : 'fail',
        summary: result.ok
          ? result.cached
            ? 'Ubuntu baseline unchanged since its last successful apply and its services are active (re-applied in full at least daily).'
            : 'Ubuntu baseline tasks completed, including always-on service recovery; effective boot/session policies require separate verification.'
          : 'UBUNTU_BASELINE_INCOMPLETE',
        ...(result.ok && result.cached ? { reused: 'receipt' as const } : {}),
      },
    ],
  };
}

/** Cheap probe for what the baseline owns: system services and user timers. */
async function baselineServicesActive(
  run: Runner,
  features: WorkerFeatures,
  sharingPort?: number
): Promise<boolean> {
  if (sharingPort) {
    const rules = await run([
      'sudo',
      '-n',
      'nft',
      '-j',
      'list',
      'table',
      ...FIREWALL_TABLE,
    ]);
    if (
      !rules.ok ||
      !parseFirewall(rules.stdout).tailnetOnly.some(
        (p) => p.port === sharingPort && p.protocol === 'tcp'
      )
    )
      return false;
  }
  const system = await run([
    'systemctl',
    'is-active',
    '--quiet',
    'ssh.service',
    'tailscaled.service',
    ...(features.containers ? ['docker.service'] : []),
  ]);
  if (!system.ok) return false;
  if (features.containers) {
    const image = await run([
      'docker',
      'image',
      'inspect',
      '--format',
      '{{.Id}}',
      ubuntuPolicy.dockerSmokeTest.image,
    ]);
    if (!image.ok) return false;
  }
  const user = await run([
    'systemctl',
    '--user',
    'is-active',
    '--quiet',
    'personal-worker-auth.timer',
    'personal-worker-github.timer',
  ]);
  return user.ok;
}

/** A worker that was never logged in joins under its declared ID when the
 * seed or the bootstrap left it a single-use key; the key carries the fleet's
 * tag. A failed play is reported by the code it stopped on.
 */
async function applyTailscale(
  root: string,
  node: string,
  run: Runner
): Promise<Check> {
  const ubuntu = resolve(root, 'ansible/ubuntu');
  const running = async () => {
    const status = await run(['tailscale', 'status', '--json']);
    return (
      status.ok &&
      (JSON.parse(status.stdout) as { BackendState?: unknown }).BackendState ===
        'Running'
    );
  };
  const tailscale = await runAnsibleWithReceipt(
    run,
    'tailscale.yml',
    {
      cwd: ubuntu,
      timeoutMs: 300_000,
      input: JSON.stringify({
        tailnet_hostname: node,
        tailnet_login_server: loginServer(fleet.tailnet) ?? '',
      }),
    },
    { name: 'ubuntu-tailscale', sources: [ubuntu], verify: running }
  );
  return tailscaleConfiguration(tailscale, running);
}

async function convergeT3(
  root: string,
  node: string,
  run: Runner,
  restartBusy: boolean
): Promise<Check[]> {
  const artifact = managedT3();
  const { session } = workerFeatures(fleet, node);
  const startedAt = await t3StartedAt(run, session);
  const checks = await convergeT3Service(artifact, run, {
    prepare: async () => {
      const staged = await stageT3Policy(root, artifact.path, run, {
        node,
        restartBusy,
      });
      return staged.status === 'pass' ? [] : [staged];
    },
    install: () =>
      session === 'headless'
        ? installT3Headless(root, artifact.path, run, restartBusy)
        : installT3Desktop(root, run, restartBusy),
    session,
  });
  if (checks.every((check) => check.status === 'pass'))
    checks.push(
      await loadedT3Policy(artifact.path, run, {
        restarted: startedAt !== (await t3StartedAt(run, session)),
      })
    );
  const serviceReady = checks.some(
    (check) => check.id === 't3:service' && check.status === 'pass'
  );
  if (!serviceReady) return checks;
  // Settings are watched by T3: providers, names and the profile apply
  // without a restart.
  checks.push(
    ...(await settingsChecks(enabled(idesOf(fleet), IDES), {
      id: node,
      workspace: root,
      apply: true,
      run,
    }))
  );
  const version = await runningVersionCheck(
    run,
    userInfo().uid,
    Date.now(),
    session
  );
  checks.push(version);
  if (version.status !== 'fail')
    checks.push(
      ...(await convergeT3Route(run, () => publishT3Route(root, run)))
    );
  checks.push(...(await enableWorkerRecovery(root, run, session)));
  return checks;
}

async function publishT3Route(root: string, run: Runner): Promise<boolean> {
  const result = await runAnsible(run, 't3-route.yml', {
    cwd: resolve(root, 'ansible/ubuntu'),
    input: JSON.stringify({ t3_route_target: T3_ROUTE.proxy }),
    timeoutMs: 60_000,
  });
  return result.ok;
}

async function installT3Desktop(
  root: string,
  run: Runner,
  restartBusy: boolean
): Promise<boolean> {
  const user = userInfo();
  const desktop = managedT3Desktop();
  const ubuntu = resolve(root, 'ansible/ubuntu');
  const result = await runAnsibleWithReceipt(
    run,
    resolve(ubuntu, 't3-desktop.yml'),
    {
      cwd: root,
      timeoutMs: 600_000,
      input: JSON.stringify({
        development_source: stablePath(root),
        development_user: user.username,
        development_uid: user.uid,
        development_home: user.homedir,
        t3_desktop_url: desktop.url,
        t3_desktop_name: desktop.name,
        t3_desktop_sha256: desktop.sha256,
        t3_restart_busy: restartBusy,
      }),
    },
    {
      name: 'ubuntu-t3-desktop',
      sources: [ubuntu],
      // A stopped or disabled app reruns the play, which starts it.
      verify: async () =>
        (
          await run([
            'systemctl',
            '--user',
            'is-enabled',
            '--quiet',
            't3code-desktop.service',
          ])
        ).ok &&
        (
          await run([
            'systemctl',
            '--user',
            'is-active',
            '--quiet',
            't3code-desktop.service',
          ])
        ).ok &&
        (
          await run([
            'python3',
            '-I',
            '-B',
            '/usr/local/lib/personal-fleet/t3-listener.py',
          ])
        ).stdout.trim() === 'managed',
    }
  );
  return result.ok;
}

/** A headless worker's T3: the pinned server the toolchain installed, as a
 * lingering user service (t3-headless.yml). */
async function installT3Headless(
  root: string,
  server: string,
  run: Runner,
  restartBusy: boolean
): Promise<boolean> {
  const user = userInfo();
  const ubuntu = resolve(root, 'ansible/ubuntu');
  const unit = t3Unit('headless');
  const result = await runAnsibleWithReceipt(
    run,
    resolve(ubuntu, 't3-headless.yml'),
    {
      cwd: ubuntu,
      timeoutMs: 600_000,
      input: JSON.stringify({
        development_source: stablePath(root),
        development_user: user.username,
        development_uid: user.uid,
        development_home: user.homedir,
        t3_server_path: server,
        t3_restart_busy: restartBusy,
      }),
    },
    {
      name: 'ubuntu-t3-headless',
      sources: [ubuntu],
      // A stopped or disabled server reruns the play, which starts it.
      verify: async () =>
        (await run(['systemctl', '--user', 'is-enabled', '--quiet', unit]))
          .ok &&
        (await run(['systemctl', '--user', 'is-active', '--quiet', unit])).ok,
    }
  );
  return result.ok;
}

async function t3AfterBaseline(
  root: string,
  context: {
    node: string;
    baseline: Check[];
    run: Runner;
    restartBusy: boolean;
  }
): Promise<Check[]> {
  const { node, baseline, run, restartBusy } = context;
  if (baseline.some((check) => check.status !== 'pass'))
    return [
      {
        id: 't3:prerequisites',
        status: 'skip',
        summary: 'T3_BASELINE_PREREQUISITES_REQUIRED',
        remedy: {
          action:
            'Complete the designated-user baseline and lingering policy before changing native service lifecycle. Existing service state is preserved.',
        },
      },
    ];
  return attempt('t3:service', () => convergeT3(root, node, run, restartBusy));
}

async function enableWorkerRecovery(
  root: string,
  run: Runner,
  session: WorkerFeatures['session']
): Promise<Check[]> {
  const user = userInfo();
  const ubuntu = resolve(root, 'ansible/ubuntu');
  const result = await runAnsibleWithReceipt(
    run,
    resolve(ubuntu, 'recovery.yml'),
    {
      cwd: root,
      timeoutMs: 60_000,
      input: JSON.stringify({
        development_source: stablePath(root),
        development_user: user.username,
        development_uid: user.uid,
        development_home: user.homedir,
        ...(session === 'headless' ? { t3_unit: t3Unit(session) } : {}),
      }),
    },
    {
      name: 'ubuntu-recovery',
      sources: [ubuntu],
      verify: async () =>
        (
          await run([
            'systemctl',
            '--user',
            'is-active',
            '--quiet',
            'personal-worker-recovery.timer',
          ])
        ).ok,
    }
  );
  return [
    {
      id: 'worker:service-recovery',
      status: result.ok ? 'pass' : 'fail',
      summary: result.ok
        ? `T3 recovery enabled: a stopped ${session === 'headless' ? 'server' : 'desktop app'} is started and an unresponsive one restarted after three failed one-minute health checks.`
        : 'WORKER_RECOVERY_SETUP_FAILED',
    },
  ];
}

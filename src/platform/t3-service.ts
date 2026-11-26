import policy from '../../ansible/ubuntu/policy.json';
import type { Runner, Check } from '../types';
import type { Session } from '../../bootstrap/worker-features';

/** The user unit that runs the pinned desktop app (UI and embedded server). */
export const T3_DESKTOP_UNIT = 't3code-desktop.service';
/** The lingering user unit that runs the pinned native server on a headless
 * worker (`t3-headless.yml`). */
export const T3_HEADLESS_UNIT = 't3code-headless.service';

/** The unit that runs T3 for a session type. */
export function t3Unit(session: Session = 'desktop'): string {
  return session === 'headless' ? T3_HEADLESS_UNIT : T3_DESKTOP_UNIT;
}

/** Workers run one T3 process: on a desktop worker the desktop app, started
 * with the auto-login graphical session (`t3-desktop.yml`); on a headless
 * worker the pinned native server as a lingering user service
 * (`t3-headless.yml`). The play installs it, retires the other session
 * type's unit and starts it; this only refuses a foreign launcher beforehand
 * and measures the result afterwards. A launcher of the release the fleet
 * installed last is not foreign: the play upgrades it to the pin.
 */
export async function convergeT3Service(
  artifact: { path: string; version: string },
  run: Runner,
  steps: {
    /** Stages the policy; any check it returns stops here. */
    prepare?: () => Promise<Check[]>;
    /** Applies the session type's playbook. */
    install?: () => Promise<boolean>;
    session?: Session;
  } = {}
): Promise<Check[]> {
  const {
    prepare = async () => [],
    install = async () => true,
    session = 'desktop',
  } = steps;
  const existing = await run(['t3', '--version']);
  if (
    conflictingVersion(existing, artifact.version) &&
    conflictingVersion(existing, await installedRelease(run, session))
  )
    return pending(
      'T3_EXECUTABLE_OWNER_CONFLICT',
      'The existing T3 launcher has a different version. Review the pinned release; preserve its application data and active sessions.'
    );
  const preparation = await prepare();
  if (preparation.length) return preparation;
  const installed = await install();
  return measureService(run, session, installed);
}

async function measureService(
  run: Runner,
  session: Session,
  installed: boolean
): Promise<Check[]> {
  const words = SESSION_WORDS[session];
  const unit = t3Unit(session);
  const active = await userctl(run, 'is-active', unit);
  if (!active.ok && session === 'desktop') {
    const blocked = await desktopPrerequisite(run);
    if (blocked) return blocked;
  }
  if (!installed) return pending(...words.installFailed);
  const enabled = await userctl(run, 'is-enabled', unit);
  if (!active.ok || !enabled.ok) return pending(...words.stopped(unit));
  return [{ id: 't3:service', status: 'pass', summary: words.running }];
}

async function desktopPrerequisite(run: Runner): Promise<Check[] | undefined> {
  const graphical = await userctl(run, 'is-active', 'graphical-session.target');
  if (['inactive', 'failed'].includes(graphical.stdout.trim()))
    return pending(
      'T3_NO_GRAPHICAL_SESSION',
      'Establish the declared graphical login. The recovery timer will start T3 in that session.'
    );
  const listener = await run([
    'python3',
    '-I',
    '-B',
    '/usr/local/lib/personal-fleet/t3-listener.py',
  ]);
  if (listener.ok && listener.stdout.trim() === 'unknown')
    return pending(
      'T3_LISTENER_OWNER_UNKNOWN',
      'Inspect the process listening on port 3773 before starting the managed desktop.'
    );
  if (
    listener.ok &&
    /^app-com\.t3tools\.T3Code-.*\.scope$/.test(listener.stdout.trim())
  )
    return pending(
      'T3_DESKTOP_HANDOFF_PENDING',
      'Let the active turns finish. The recovery timer rechecks ownership and hands the listener to the managed desktop.'
    );
  return undefined;
}

/** How a worker's T3 restarts for a new release or policy, as the manager's
 * bootstrap passes it on to node convergence (`fleet-sync --restart-busy`).
 * The words cross from one revision's script to another: an interface.
 */
export const T3_RESTART_MODES = ['keep-turns', 'restart-busy'] as const;

/** What the check says of each session type: its codes and remedies. */
const SESSION_WORDS: Record<
  Session,
  {
    installFailed: [string, string];
    stopped: (unit: string) => [string, string];
    running: string;
  }
> = {
  desktop: {
    installFailed: [
      'T3_DESKTOP_INSTALL_FAILED',
      'Inspect the t3-desktop.yml Ansible output (package download, apt, GDM auto-login, user unit). T3 data in ~/.t3 is untouched.',
    ],
    stopped: (unit) => [
      'T3_DESKTOP_STOPPED',
      `The desktop app needs the auto-login graphical session. Reboot or log in on the machine, then inspect journalctl --user -u ${unit}; ~/.t3 is preserved.`,
    ],
    running:
      'Pinned T3 desktop app is enabled for the auto-login session and running. Private routing, policy and pairing remain separate checks.',
  },
  headless: {
    installFailed: [
      'T3_SERVER_INSTALL_FAILED',
      'Inspect the t3-headless.yml Ansible output (the pinned server in the toolchain, the user unit). T3 data in ~/.t3 is untouched.',
    ],
    stopped: (unit) => [
      'T3_SERVER_STOPPED',
      `The T3 server is a lingering user service and needs no login. Inspect journalctl --user -u ${unit} and loginctl show-user for Linger=yes; ~/.t3 is preserved.`,
    ],
    running:
      'Pinned T3 server is enabled as a lingering user service and running, with no display. Private routing, policy and pairing remain separate checks.',
  },
};

/** The recovery script, installed outside every revision (`tasks/recovery.yml`). */
export const T3_HEALTH_SCRIPT = '/usr/local/lib/personal-fleet/t3-health.sh';

/** The record of the package the desktop app was unpacked from
 * (`t3-desktop.yml`): `T3-Code-<version>-<arch>.deb`. */
export const T3_DESKTOP_RELEASE =
  '/opt/T3 Code (Nightly)/.personal-fleet-version';

/** Where a T3 restart that waits for agent turns to end is recorded
 * (`tasks/t3-restart.yml`, `t3-health.sh`): the second it was first deferred.
 * personal-worker-recovery clears it when it restarts the app. */
export function t3RestartMarker(uid: number): string {
  return `/run/user/${uid}/personal-t3-restart-pending`;
}

/** A restart deferred while agent turns run: how long it has waited, and
 * whether that is longer than the policy allows. personal-worker-recovery
 * applies it at the deadline although turns run (`t3-health.sh`), so an
 * overdue one means the recovery timer did not. */
export interface RestartDeferral {
  pending: boolean;
  overdue: boolean;
  /** Absent when the record holds no time. */
  waitedSeconds?: number;
}

export async function restartDeferral(
  run: Runner,
  uid: number,
  now: number = Date.now()
): Promise<RestartDeferral> {
  const marker = await run(['cat', t3RestartMarker(uid)]);
  if (!marker.ok) return { pending: false, overdue: false };
  const since = marker.stdout.trim();
  if (!/^\d+$/.test(since)) return { pending: true, overdue: false };
  const waitedSeconds = Math.max(0, Math.floor(now / 1000 - Number(since)));
  return {
    pending: true,
    overdue: waitedSeconds > policy.t3RestartMaxDeferralHours * 3600,
    waitedSeconds,
  };
}

const hoursAndMinutes = (seconds: number): string =>
  `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;

/** What a remedy says of a pending restart: how long it has waited and when
 * the deadline applies it. */
export function deferralRemedy(
  deferral: RestartDeferral,
  session: Session = 'desktop'
): string {
  const hours = policy.t3RestartMaxDeferralHours;
  const waited = deferral.waitedSeconds;
  if (deferral.overdue && waited !== undefined)
    return `The restart has waited ${hoursAndMinutes(waited)}, longer than the ${hours} hours a restart is deferred at most, and personal-worker-recovery has not applied it. Check worker:service-recovery, then run devfleet fleet-sync; restarting ${t3Unit(session)} on the worker ends its running turns.`;
  const deadline =
    waited === undefined
      ? `${hours} hours after it was first deferred`
      : `in ${hoursAndMinutes(Math.ceil((hours * 3600 - waited) / 60) * 60)}, ${hours} hours after it was first deferred`;
  return `${waited === undefined ? 'The restart waits' : `The restart has waited ${hoursAndMinutes(waited)}`} for agent turns to end. personal-worker-recovery applies it at the first check with no agent turn running, and at the latest ${deadline}: the turns still running then end.`;
}

/** The release the running server reports, compared with the one installed,
 * and any restart that waits. Asks the server itself, so it needs no `t3` on
 * the search path. A new release is installed beside a running app, which
 * restarts into it only while it runs no agent turn: until then, and while a
 * restart deferred for another reason waits (a policy, the address it serves
 * on), this is T3_RESTART_PENDING with how long the restart has waited and
 * when its deadline applies it; a failure once the deadline has passed. */
export async function runningVersionCheck(
  run: Runner,
  uid: number,
  now: number = Date.now(),
  session: Session = 'desktop'
): Promise<Check> {
  const running = await liveServerVersion(run);
  const release = await installedRelease(run, session);
  const id = 't3:running-version';
  if (!running || !release)
    return {
      id,
      status: 'fail',
      summary: 'T3_RUNNING_VERSION_UNKNOWN',
      remedy: {
        action:
          'The running server or the installed release could not be read. Check worker:t3-health, then rerun fleet-sync to reinstall the pinned T3.',
      },
    };
  const deferral = await restartDeferral(run, uid, now);
  if (running === release && !deferral.pending)
    return {
      id,
      status: 'pass',
      summary: `The running T3 server is the installed release ${release}.`,
    };
  return {
    id,
    status: deferral.overdue ? 'fail' : 'warn',
    summary: 'T3_RESTART_PENDING',
    remedy: {
      action: `${
        running === release
          ? `T3 runs the installed release ${release} and has not restarted for what fleet-sync staged since.`
          : `T3 runs ${running}; ${release} is installed.`
      } ${deferralRemedy(deferral, session)}`,
    },
  };
}

/** A restart applied at its deadline ends the agent turns that still ran:
 * personal-worker-recovery logs each one (`T3_RESTART_DEADLINE`,
 * `t3-health.sh`) and this counts those of the last 24 hours, so that turns
 * ended by the fleet are reported and not only logged. Only the count is
 * read, never a line of the journal. */
export async function deadlineRestartsCheck(run: Runner): Promise<Check> {
  const id = 'worker:t3-deadline-restarts';
  const logged = await run([
    'journalctl',
    '--user',
    '--quiet',
    '--unit=personal-worker-recovery.service',
    '--since=24 hours ago',
    '--output=cat',
    '--grep=^T3_RESTART_DEADLINE',
    '--lines=1000',
  ]);
  // journalctl exits 1 when --grep found nothing: only an error it names, or
  // a command that did not exit, is a journal that could not be read.
  if (!logged.ok && (logged.stderr.trim() || logged.reason !== 'exit'))
    return {
      id,
      status: 'warn',
      summary: 'Recent restarts of T3 at a deadline could not be read.',
    };
  const count = logged.stdout
    .split('\n')
    .filter((line) => line.startsWith('T3_RESTART_DEADLINE')).length;
  if (!count)
    return {
      id,
      status: 'pass',
      summary:
        'No pending restart of T3 reached its deadline in the last 24 hours.',
    };
  return {
    id,
    status: 'warn',
    summary: `T3 was restarted ${count === 1 ? 'once' : `${count} times`} in the last 24 hours at the deadline of a pending restart, although agent turns ran: they ended.`,
    remedy: {
      action: `The restart had waited ${policy.t3RestartMaxDeferralHours} hours for the worker to run no agent turn (t3RestartMaxDeferralHours in ansible/ubuntu/policy.json). Nothing is left to repair: send the threads whose turn ended their next message.`,
    },
  };
}

/** The release installed for the session: the desktop package the app was
 * unpacked from, or the versioned directory the server unit runs. */
async function installedRelease(
  run: Runner,
  session: Session
): Promise<string | undefined> {
  if (session === 'headless') {
    const shown = await run([
      'systemctl',
      '--user',
      'show',
      '--property=ExecStart',
      '--value',
      T3_HEADLESS_UNIT,
    ]);
    return shown.ok
      ? /\/t3-([\w.+-]+?)-linux-[a-z0-9]+\/t3\b/.exec(shown.stdout)?.[1]
      : undefined;
  }
  const installed = await run(['cat', T3_DESKTOP_RELEASE]);
  return /^T3-Code-(.+)-[a-z0-9]+\.deb$/.exec(
    installed.ok ? installed.stdout.trim() : ''
  )?.[1];
}

export async function liveServerVersion(run: Runner, transport: string[] = []) {
  const server = await run(
    [
      ...transport,
      'curl',
      '--fail',
      '--silent',
      '--max-time',
      '10',
      'http://127.0.0.1:3773/.well-known/t3/environment',
    ],
    { timeoutMs: 15_000 }
  );
  return serverVersion(server.ok ? server.stdout : '');
}

function serverVersion(body: string): string | undefined {
  try {
    const value: unknown = JSON.parse(body);
    const version =
      typeof value === 'object' && value !== null
        ? (value as Record<string, unknown>)['serverVersion']
        : undefined;
    return typeof version === 'string' && /^[\w.+-]+$/.test(version)
      ? version
      : undefined;
  } catch {
    return undefined;
  }
}

/** When T3 last started; changes exactly when it restarts. */
export async function t3StartedAt(
  run: Runner,
  session: Session = 'desktop'
): Promise<string> {
  const shown = await run([
    'systemctl',
    '--user',
    'show',
    '--property=ActiveEnterTimestampMonotonic',
    '--value',
    t3Unit(session),
  ]);
  return shown.ok ? shown.stdout.trim() : '';
}

function userctl(run: Runner, verb: string, unit: string) {
  return run(['systemctl', '--user', verb, unit]);
}

function pending(code: string, action: string): Check[] {
  return [
    { id: 't3:service', status: 'fail', summary: code, remedy: { action } },
  ];
}

function conflictingVersion(
  result: { ok: boolean; stdout: string },
  version: string | undefined
): boolean {
  return result.ok && result.stdout.trim() !== `t3 v${version}`;
}

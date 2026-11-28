import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { runAnsible } from '../platform/ansible';
import { shellQuote } from '../ssh';
import type { MachineContext } from '../ide/ide';
import type { Check } from '../types';
import { versionCheck } from './version';

const BUNDLE_ID = 'com.t3tools.t3code';
const APP = 'T3 Code (Nightly).app';
// Ask Launch Services about live applications. The marker alone survives a quit.
const runningApp = `ObjC.import('AppKit');
function run(argv) {
  const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(argv[0]);
  if (Number(apps.count) !== 1) return 'absent-or-ambiguous';
  const url = apps.objectAtIndex(0).bundleURL;
  const version = ObjC.unwrap($.NSBundle.bundleWithURL(url).objectForInfoDictionaryKey('CFBundleShortVersionString'));
  const owner = ObjC.unwrap(url.path) === argv[1] ? 'managed' : 'other';
  return owner + ' ' + version;
}`;

export async function managerDesktop(
  context: MachineContext,
  home = homedir()
): Promise<Check[]> {
  const { vars } = Bun.TOML.parse(
    await readFile(join(context.workspace, 'mise.toml'), 'utf8')
  ) as { vars: { t3_version: string; t3_desktop_darwin_arm64_sha256: string } };
  const version = String(vars.t3_version);
  const digest = String(vars.t3_desktop_darwin_arm64_sha256);
  if (
    !/^\d+\.\d+\.\d+(?:-nightly\.\d{8}\.\d+)?$/.test(version) ||
    !/^[a-f0-9]{64}$/.test(digest)
  )
    throw new Error('Invalid macOS desktop pin.');
  const parent = join(
    home,
    'Applications/homelab',
    version + '-' + digest.slice(0, 12)
  );
  const app = join(parent, APP);
  // The archive pin authenticates the download. Check the installed bundle's
  // sealed resources, publisher, bundle identity and release on every sync.
  const requirement = `anchor apple generic and identifier "${BUNDLE_ID}" and certificate leaf[subject.OU] = "ARK85ZXQ4Z" and info[CFBundleShortVersionString] = "${version}"`;
  const verify = async () =>
    (
      await context.run(
        ['/usr/bin/codesign', '--verify', '--strict', '-R=' + requirement, app],
        { timeoutMs: 90_000 }
      )
    ).ok;
  let installed = await verify();
  if (!installed && context.apply) {
    const applied = await runAnsible(
      context.run,
      join(context.workspace, 'ansible/macos/t3-desktop.yml'),
      {
        input: JSON.stringify({
          t3_version: version,
          t3_checksum: digest,
          t3_directory: parent,
          t3_app: APP,
          t3_requirement: requirement,
        }),
        timeoutMs: 600_000,
      }
    );
    installed = applied.ok && (await verify());
  }
  const installation: Check = {
    id: 't3:desktop-installed',
    status: installed ? 'pass' : context.apply ? 'fail' : 'warn',
    summary: installed
      ? `Verified the signed macOS desktop bundle for ${version}.`
      : `The managed macOS desktop for ${version} is missing or failed verification.`,
    ...(!installed
      ? {
          remedy: {
            action: `Run converge to stage the pinned app. If ${app} already exists and fails verification, quit it during maintenance and move it aside first.`,
          },
        }
      : {}),
  };
  return [
    installation,
    await runningDesktop(context, { app, version, installed }),
  ];
}

async function runningDesktop(
  context: MachineContext,
  pin: { app: string; version: string; installed: boolean }
): Promise<Check> {
  const { app, version, installed } = pin;
  const observed = await observeDesktop(context.run, app);
  // A repeat converge of the same release is a no-op: the path can differ
  // (Dock copy, a previous digest directory) without there being an update.
  // Quitting that process kills a converge started in its terminal.
  const update = observed !== null && observed[2] !== version;
  if (context.apply && installed && update)
    return switchDesktop(context, pin, observed[2]!);
  const action = installed
    ? `When manager sessions have finished, quit T3 Code, then run open ${shellQuote(app)}. Pin that copy in the Dock.`
    : 'Stage the verified desktop with converge before opening it.';
  const running = versionCheck(
    observed?.[2] ?? null,
    version,
    'the manager',
    action
  );
  if (!observed)
    running.remedy = {
      action: `No single running desktop could be verified. ${action}`,
    };
  else if (observed[1] !== 'managed' && running.status === 'pass')
    return {
      id: running.id,
      status: 'warn',
      summary: `T3 on the manager runs ${version} from another installation.`,
      remedy: { action },
    };
  return running;
}

/** Quit the running release and open the verified bundle. A converge that is
 * itself a child of that desktop only warns: quitting it would end the run. */
async function switchDesktop(
  context: MachineContext,
  pin: { app: string; version: string; installed: boolean },
  runningVersion: string
): Promise<Check> {
  if (await convergeRunsInsideDesktop(context.run))
    return {
      id: 't3:version',
      status: 'warn',
      summary: 'T3_DESKTOP_SWITCH_DEFERRED',
      remedy: {
        action: `The verified desktop for ${pin.version} is staged at ${pin.app}. This converge is running inside T3 ${runningVersion}, so the switch waits. Run homelab converge from Terminal or another session once this one has finished.`,
      },
    };
  const switched = await runAnsible(
    context.run,
    join(context.workspace, 'ansible/macos/t3-activate.yml'),
    {
      input: JSON.stringify({ bundle_id: BUNDLE_ID, desktop_path: pin.app }),
      timeoutMs: 90_000,
    }
  );
  if (!switched.ok)
    return {
      id: 't3:version',
      status: 'fail',
      summary: 'T3_DESKTOP_ACTIVATION_FAILED',
      remedy: {
        action: `Open the verified desktop with open ${shellQuote(pin.app)} and rerun converge.`,
      },
    };
  return runningDesktop({ ...context, apply: false }, pin);
}

const DESKTOP_PROCESS = /(?:^|\/)t3code(?:\s|$)|T3 Code \(Nightly\)\.app/;

/** True when this process descends from the live T3 desktop. `ps` goes
 * through the runner so a test can answer it; a host with no answer is
 * treated as outside the desktop, which is the safe switch. */
async function convergeRunsInsideDesktop(
  run: MachineContext['run']
): Promise<boolean> {
  const listed = await run(['ps', '-A', '-o', 'pid=,ppid=,command=']);
  if (!listed.ok) return false;
  const rows = new Map<number, { ppid: number; command: string }>();
  for (const line of listed.stdout.split('\n')) {
    const row = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!row) continue;
    rows.set(Number(row[1]), { ppid: Number(row[2]), command: row[3] ?? '' });
  }
  const seen = new Set<number>();
  for (let pid = process.pid; rows.has(pid) && !seen.has(pid);) {
    seen.add(pid);
    const row = rows.get(pid)!;
    if (DESKTOP_PROCESS.test(row.command)) return true;
    if (row.ppid === pid || row.ppid === 0) break;
    pid = row.ppid;
  }
  return false;
}

async function observeDesktop(run: MachineContext['run'], app: string) {
  const live = await run([
    '/usr/bin/osascript',
    '-l',
    'JavaScript',
    '-e',
    runningApp,
    BUNDLE_ID,
    app,
  ]);
  return live.ok
    ? /^(managed|other) (\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)$/.exec(
        live.stdout.trim()
      )
    : null;
}

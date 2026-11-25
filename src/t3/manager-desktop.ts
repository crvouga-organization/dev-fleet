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
  if (apps.count !== 1) return 'absent-or-ambiguous';
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
    'Applications/dev-fleet',
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
            action: `Run fleet-sync to stage the pinned app. If ${app} already exists and fails verification, quit it during maintenance and move it aside first.`,
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
  const live = await context.run([
    '/usr/bin/osascript',
    '-l',
    'JavaScript',
    '-e',
    runningApp,
    BUNDLE_ID,
    app,
  ]);
  const observed = live.ok
    ? /^(managed|other) (\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)$/.exec(
        live.stdout.trim()
      )
    : null;
  const action = installed
    ? `When manager sessions have finished, quit T3 Code, then run open ${shellQuote(app)}. Pin that copy in the Dock.`
    : 'Stage the verified desktop with fleet-sync before opening it.';
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

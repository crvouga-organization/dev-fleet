import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { FleetUsageError } from '../errors';
import { fleet } from '../fleet-config';
import { runCommand } from '../runner';
import { blocking, type Check, type Runner } from '../types';
import {
  nativeLoginCheck,
  nativeLogins,
  providerAccountChecks,
  rosterCurrentCheck,
} from '../accounts/checks';
import { exposedVersion, t3Settings } from '../accounts/context';
import { parseRoster, type ProxyRoster } from '../accounts/roster';
import { exposedInstances } from '../accounts/sessions';
import { forwardSourceOperation, ownerCheckout } from './source-operations';
import type { CommandOutcome } from './contracts';
import type { Settings } from './settings';
import { fleetSync } from './fleet-sync';

export interface FleetAccountsOptions {
  authPlan?: boolean;
  diff?: boolean;
  add?: boolean;
  relogin?: boolean;
  remove?: boolean;
  removeNativeLogins?: boolean;
  yes?: boolean;
}

export interface AccountsDependencies {
  run?: Runner;
  /** Runs a proxy command attached to the terminal (a sign-in). */
  operate?: (args: string[]) => Promise<number>;
  /** `converge --only accounts`. */
  propagate?: () => Promise<CommandOutcome>;
  home?: string;
  settingsFile?: string;
}

const PROVIDER = /^[a-z][a-z0-9-]{0,31}$/;

/** `homelab accounts`: the provider account roster the proxy holds,
 * each account's state, and the account checks. `--add`, `--relogin` and
 * `--remove` change one account on the proxy and propagate the result to
 * every node at once.
 */
export async function fleetAccounts(
  options: FleetAccountsOptions,
  args: string[],
  settings: Settings,
  dependencies: AccountsDependencies = {}
): Promise<CommandOutcome> {
  if (options.authPlan) return authPlan(options, args, settings, dependencies);
  const home = dependencies.home ?? homedir();
  if (options.removeNativeLogins)
    return removeNativeLogins(Boolean(options.yes), home);
  const change = lifecycle(options, args);
  const changed = change
    ? await applyChange(change, settings, dependencies)
    : undefined;
  if (changed && !changed.data) return failedChange();
  return report(options, settings, dependencies, { change, changed });
}

async function authPlan(
  options: FleetAccountsOptions,
  args: string[],
  settings: Settings,
  dependencies: AccountsDependencies
): Promise<CommandOutcome> {
  if (
    args.length ||
    options.add ||
    options.relogin ||
    options.remove ||
    options.removeNativeLogins ||
    options.diff ||
    options.yes
  )
    throw new FleetUsageError('Run --auth-plan on its own.');
  const roster = await readRoster(
    dependencies.run ?? runCommand,
    settings.workspace
  );
  return {
    exitCode: roster.managementApi ? 0 : 1,
    data: {
      version: 1,
      command: 'accounts',
      ok: roster.managementApi,
      managementApi: roster.managementApi,
      signIns: roster.accounts
        .filter((account) => account.state === 'needs-login')
        .map(({ provider, index }) => ({ provider, index })),
      ...(!roster.managementApi && {
        summary:
          'The proxy management API is unavailable. The sign-in plan may be incomplete.',
      }),
    },
  };
}

async function report(
  options: FleetAccountsOptions,
  settings: Settings,
  dependencies: AccountsDependencies,
  {
    change,
    changed,
  }: { change: string[] | null; changed: CommandOutcome | undefined }
): Promise<CommandOutcome> {
  const home = dependencies.home ?? homedir();
  const roster = await readRoster(
    dependencies.run ?? runCommand,
    settings.workspace
  );
  const checks: Check[] = providerAccountChecks(
    roster,
    fleet.services.proxy.accounts?.minimumUsable
  );
  if (options.diff)
    checks.push(...(await thisMachine(roster, home, dependencies)));
  const ok = !checks.some(blocking) && !changed?.exitCode;
  return {
    exitCode: ok ? 0 : 1,
    data: {
      version: 1,
      command: 'accounts',
      ok,
      ...listing(roster),
      checks,
      ...(change && {
        changed: change.slice(0, 2),
        propagation: changed?.data,
      }),
    },
  };
}

/** The roster as listed: no routing prefix, no file. */
function listing(roster: ProxyRoster) {
  return {
    rosterVersion: roster.rosterVersion,
    managementApi: roster.managementApi,
    accounts: roster.accounts.map(
      ({ provider, index, label, state, until, cooldowns }) => ({
        provider,
        index,
        label,
        state,
        until,
        cooldowns,
      })
    ),
  };
}

/** Runs the change on the proxy, then propagates it to every node. A change
 * the proxy did not complete answers with no data: nothing was propagated.
 */
async function applyChange(
  change: string[],
  settings: Settings,
  dependencies: AccountsDependencies
): Promise<CommandOutcome> {
  const operate =
    dependencies.operate ??
    ((forwarded: string[]) =>
      forwardSourceOperation(['proxy', ...forwarded], settings));
  if ((await operate(change)) !== 0) return { exitCode: 1, data: null };
  return (
    dependencies.propagate ??
    (() => fleetSync({ only: 'accounts', json: true }, settings))
  )();
}

function failedChange(): CommandOutcome {
  return {
    exitCode: 1,
    data: {
      version: 1,
      command: 'accounts',
      ok: false,
      error: 'ACCOUNT_CHANGE_FAILED',
      summary:
        'The proxy did not complete the change; an interrupted sign-in leaves no credential behind. Nothing was propagated.',
    },
  };
}

/** `--diff`: what this machine offers against the roster. */
async function thisMachine(
  roster: ProxyRoster,
  home: string,
  dependencies: AccountsDependencies
): Promise<Check[]> {
  const exposed = await exposedInstances(
    dependencies.settingsFile ?? t3Settings()
  );
  return [
    rosterCurrentCheck(roster.rosterVersion, exposedVersion(exposed)),
    nativeLoginCheck(nativeLogins(home)),
  ];
}

/** The proxy command a lifecycle flag stands for, or null for a listing. */
function lifecycle(
  options: FleetAccountsOptions,
  [provider, index]: string[]
): string[] | null {
  const chosen = (['add', 'relogin', 'remove'] as const).filter(
    (flag) => options[flag]
  );
  if (chosen.length === 0) return null;
  if (chosen.length > 1)
    throw new FleetUsageError('Choose one of --add, --relogin and --remove.');
  const flag = chosen[0]!;
  if (!provider || !PROVIDER.test(provider))
    throw new FleetUsageError(
      `--${flag} needs a provider, such as claude or codex.`
    );
  if (flag === 'add') return ['add-account', provider];
  if (!index || !/^[1-9][0-9]{0,3}$/.test(index))
    throw new FleetUsageError(
      `--${flag} needs the account's index, as homelab accounts lists it.`
    );
  return [flag === 'relogin' ? 'relogin' : 'remove-account', provider, index];
}

/** The roster as the proxy on this manager reports it. */
async function readRoster(
  run: Runner,
  workspace: string
): Promise<ProxyRoster> {
  const checkout = ownerCheckout(workspace);
  if (!checkout)
    throw new FleetUsageError(
      'The account roster is kept by the proxy on the manager. Run homelab accounts there, after a first converge.'
    );
  const result = await run(
    [
      'python3',
      '-B',
      join(checkout, 'cliproxy/scripts/cli.py'),
      'accounts',
      '--json',
    ],
    { cwd: checkout, timeoutMs: 60_000 }
  );
  try {
    if (!result.ok) throw new Error();
    return parseRoster(result.stdout);
  } catch {
    throw new FleetUsageError(
      'The proxy did not report its accounts. Check it with homelab proxy status.'
    );
  }
}

/** Opt-in: deletes the provider logins agent CLIs keep outside the proxy. */
async function removeNativeLogins(
  yes: boolean,
  home: string
): Promise<CommandOutcome> {
  const found = nativeLogins(home);
  if (!yes)
    return {
      exitCode: found.length ? 1 : 0,
      data: {
        version: 1,
        command: 'accounts',
        ok: found.length === 0,
        applied: false,
        checks: [nativeLoginCheck(found)],
        next: found.length
          ? 'Add --yes to remove these logins from this machine.'
          : undefined,
      },
    };
  for (const login of found) await rm(login.path, { force: true });
  return {
    exitCode: 0,
    data: {
      version: 1,
      command: 'accounts',
      ok: true,
      applied: true,
      removed: [...new Set(found.map((login) => login.cli))].sort(),
      checks: [nativeLoginCheck(nativeLogins(home))],
    },
  };
}

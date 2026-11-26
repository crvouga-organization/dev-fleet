import { quotaCoverage } from '../../../src/t3/quota-coverage';
import { expect } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import policy from '../../../ansible/macos/policy.json';
import type { Account } from '../../../src/agents/accounts';
import { fleet } from '../../../src/fleet-config';
import {
  managerAgentProfiles,
  managerDocker,
  convergeManagerPolicy,
  managerPower,
  pinnedDockerDesktop,
} from '../../../src/cli/fleet-sync-manager';
import { holdManagerVault } from '../../../src/cli/fleet-sync-vault';
import { machineProviders } from '../../../src/t3/providers';
import { MACOS_MANAGER } from '../../../src/platform/manager-host';
import type { Check, Status } from '../../../src/types';
import { failed, succeeded } from '../../support/commands';
import type { DataTable } from '../../support/gherkin';
import {
  ROOT,
  fleetSync,
  temporary,
  type FleetSyncWorld,
} from '../support/world';

const { Given, When, Then } = fleetSync;

/** What these steps keep between them. */
interface Manager {
  accounts: Account[];
  /** T3's home on the manager. */
  t3Home: string | undefined;
  battery: Record<string, string>;
  /** What pmset reports on AC power. */
  power: Record<string, string>;
  /** One check for each setting reported as drifted in turn. */
  drifted: { setting: string; check: Check }[];
}
const managers = new WeakMap<FleetSyncWorld, Manager>();

function manager(world: FleetSyncWorld): Manager {
  let found = managers.get(world);
  if (!found) {
    found = {
      accounts: [],
      t3Home: undefined,
      battery: {},
      power: {},
      drifted: [],
    };
    managers.set(world, found);
  }
  return found;
}

// ── T3 providers ─────────────────────────────────────────────────────────

Given('the proxy has these accounts signed in:', (world, table: DataTable) => {
  manager(world).accounts = table.hashes().map((row) => ({
    tool: row['tool']!,
    email: row['email']!,
    prefix: row['prefix']!,
    models: row['models']!.split(',').map((model) => model.trim()),
  }));
});

Given('T3 on the manager is configured with:', (world, settings: string) => {
  const home = temporary(world, 'manager-t3-');
  mkdirSync(join(home, 'userdata'), { recursive: true });
  writeFileSync(join(home, 'userdata/settings.json'), settings);
  manager(world).t3Home = home;
});

const unchecked = new WeakMap<FleetSyncWorld, string>();
Given('T3 cannot authenticate instance {string}', (world, id: string) => {
  unchecked.set(world, id);
});

function providers(
  world: FleetSyncWorld,
  id: string,
  apply: boolean
): Promise<Check> {
  const { accounts, t3Home } = manager(world);
  return machineProviders(id, ROOT, apply, {
    t3Home: t3Home!,
    roster: async () => accounts,
    keys: async () => {},
    refresh: async (instanceId) => instanceId !== unchecked.get(world),
  });
}

Given(
  'the providers of {string} have been applied',
  async (world, id: string) => {
    expect((await providers(world, id, true)).status).toBe('pass');
  }
);

When(
  /^the providers of "([^"]*)" are (planned|applied)$/,
  async (world, id: string, action: string) => {
    world.checks = [await providers(world, id, action === 'applied')];
  }
);

function instances(world: FleetSyncWorld): Record<string, unknown> {
  const settings = JSON.parse(
    readFileSync(join(manager(world).t3Home!, 'userdata/settings.json'), 'utf8')
  ) as { providerInstances: Record<string, unknown> };
  return settings.providerInstances;
}

Then('T3 has exactly these provider instances:', (world, table: DataTable) => {
  expect(Object.keys(instances(world)).sort()).toEqual(table.list().sort());
});

Then('the provider instances of T3 are exactly:', (world, json: string) => {
  expect(instances(world)).toEqual(JSON.parse(json));
});

Then(
  'the provider instance {string} is displayed as {string}',
  (world, id: string, name: string) => {
    expect(instances(world)[id]).toMatchObject({ displayName: name });
  }
);

Then('the provider instances name {string}', (world, text: string) => {
  expect(JSON.stringify(instances(world))).toContain(text);
});

// ── Agent profiles ───────────────────────────────────────────────────────

Given('every agent profile applies cleanly', (world) => {
  world.commands.otherwise = succeeded();
});

Given(
  'every agent profile applies cleanly, except that of {string}',
  (world, tool: string) => {
    // As `agents apply` prints: one line for each tool, until one fails.
    world.commands.otherwise = {
      ok: false,
      stdout: `{"ok":true}\n{"ok":false,"tool":"${tool}","error":"x"}\n`,
      stderr: '',
      reason: 'exit',
    };
  }
);

Given(
  'no agent profile can be applied, and the command does not say which failed',
  (world) => {
    world.commands.otherwise = failed();
  }
);

When(
  'the agent profiles of {string} are applied',
  async (world, id: string) => {
    world.checks = await managerAgentProfiles(id, ROOT, world.commands.run);
  }
);

const after = (argv: string[], flag: string): string | undefined =>
  argv[argv.indexOf(flag) + 1];

Then(
  'one command applied a profile for each of these tools, in this order:',
  (world, table: DataTable) => {
    expect(
      world.commands.calls.map((call) =>
        after(call.command, '--tool')?.split(',')
      )
    ).toEqual([table.list()]);
  }
);

Then(/^every profile was applied with "([^"]*)"$/, (world, flag: string) => {
  for (const call of world.commands.calls) expect(call.command).toContain(flag);
});

Then(
  'every profile was applied with {string} set to {string}',
  (world, flag: string, value: string) => {
    for (const call of world.commands.calls)
      expect(after(call.command, flag)).toBe(value);
  }
);

// ── Power ────────────────────────────────────────────────────────────────

/** `pmset -g custom`, as macOS prints it. */
function pmset(world: FleetSyncWorld, power: Record<string, string>): void {
  const lines = (settings: Record<string, string>): string[] =>
    Object.entries(settings).map(
      ([key, value]) => ` ${key.padEnd(20)} ${value}`
    );
  world.commands.otherwise = succeeded(
    [
      'Battery Power:',
      ...lines(manager(world).battery),
      'AC Power:',
      ...lines(power),
    ].join('\n')
  );
}

Given('pmset reports on battery power:', (world, table: DataTable) => {
  manager(world).battery = table.rowsHash();
});

Given(
  /^pmset reports on AC power every setting the manager's power policy declares(?:, but "([^"]*)" as "([^"]*)")?$/,
  (world, setting: string | undefined, value: string | undefined) => {
    manager(world).power = {
      ...policy.pmset,
      ...(setting ? { [setting]: value ?? '' } : {}),
    };
  }
);

Given(
  "pmset reports on AC power every setting the manager's power policy declares except {string}",
  (world, absent: string) => {
    manager(world).power = Object.fromEntries(
      Object.entries(policy.pmset).filter(([key]) => key !== absent)
    );
  }
);

When('the power settings of the manager are measured', async (world) => {
  pmset(world, manager(world).power);
  world.checks = [await managerPower(world.commands.run)];
});

// ── The manager playbook, its receipt and its check-mode run ────────────

/** How the stand-in playbook behaves, and what the manager holds. */
interface Playbook {
  check: 'passes' | 'fails';
  apply: 'passes' | 'fails';
  /** Whether launchd holds the fleet-watch job. */
  watching: boolean;
  /** Whether fleet.json says storage is disposable. */
  disposable?: boolean;
  /** Where the receipts and variables of the scenario are kept. */
  receipts?: string;
  scratch?: string;
  /** The variables the playbook was last given. */
  variables?: Record<string, unknown>;
}
const playbooks = new WeakMap<FleetSyncWorld, Playbook>();

function playbook(world: FleetSyncWorld): Playbook {
  let found = playbooks.get(world);
  if (!found) {
    found = { check: 'passes', apply: 'passes', watching: true };
    playbooks.set(world, found);
  }
  return found;
}

const managerPlaybookRuns = (world: FleetSyncWorld) =>
  world.commands.ran((command) =>
    command.some((arg) => arg.endsWith('ansible/macos/manager.yml'))
  );

Given(
  /^the manager playbook (passes|fails) its check(?: and (passes|fails) when applied)?$/,
  (world, check: 'passes' | 'fails', apply?: 'passes' | 'fails') => {
    playbook(world).check = check;
    if (apply) playbook(world).apply = apply;
  }
);

Given("launchd does not hold the manager's watch job", (world) => {
  playbook(world).watching = false;
});

Given('fleet.json says storage is disposable', (world) => {
  playbook(world).disposable = true;
});

/** One applying sync of the manager's policy, `hours` after the first. */
async function convergePolicy(world: FleetSyncWorld, hours: number) {
  const kept = playbook(world);
  kept.receipts ??= temporary(world, 'manager-receipts-');
  kept.scratch ??= temporary(world, 'manager-variables-');
  pmset(world, { ...policy.pmset });
  world.commands.answer('test -x', succeeded());
  world.commands.answer(
    (command) => command[0] === '/bin/launchctl' && command[1] === 'print',
    () => (kept.watching ? succeeded('state = waiting') : failed())
  );
  world.commands.answer(
    (command) =>
      command.some((arg) => arg.endsWith('ansible/macos/manager.yml')),
    (command) => {
      const file = command.at(-1)!.replace(/^@/, '');
      kept.variables = JSON.parse(readFileSync(file, 'utf8')) as Record<
        string,
        unknown
      >;
      const stage = command.includes('--check') ? kept.check : kept.apply;
      if (stage === 'fails') return failed();
      if (!command.includes('--check')) kept.watching = true;
      return succeeded();
    }
  );
  world.checks = [
    await convergeManagerPolicy(
      world.commands.run,
      {
        manager: { ...fleet.manager },
        ...(kept.disposable ? { storage: { disposable: true } } : {}),
      },
      MACOS_MANAGER,
      {
        root: ROOT,
        receipts: kept.receipts,
        scratch: kept.scratch,
        uid: 501,
        now: Date.parse('2026-11-01T08:00:00Z') + hours * 3_600_000,
      }
    ),
  ];
}

Given("an applying sync converged the manager's policy", async (world) => {
  await convergePolicy(world, 0);
});

When("an applying sync converges the manager's policy", async (world) => {
  await convergePolicy(world, 0);
});

When(
  "an applying sync converges the manager's policy {int} hours later",
  async (world, hours: number) => {
    await convergePolicy(world, hours);
  }
);

Then('manager.yml was run, in this order:', (world, table: DataTable) => {
  expect(
    managerPlaybookRuns(world).map((command) =>
      command.includes('--check') ? 'check mode' : ('applied' as string)
    )
  ).toEqual(table.list());
});

Then('manager.yml was never run with a password prompt', (world) => {
  const runs = managerPlaybookRuns(world);
  expect(runs.length).toBeGreaterThan(0);
  for (const command of runs) {
    expect(command).not.toContain('-K');
    expect(command).not.toContain('--ask-become-pass');
  }
});

Then(
  /^manager\.yml was given the watch interval of (\d+) minutes and (disposable|the default) storage$/,
  (world, minutes: string, storage: string) => {
    expect(playbook(world).variables).toEqual({
      fleet_watch_minutes: Number(minutes),
      fleet_storage_disposable: storage === 'disposable',
    });
  }
);

When(
  "each setting the manager's power policy declares, except {string}, is in turn reported as {string} on a manager whose checkout is {string}",
  async (world, except: string, value: string, checkout: string) => {
    for (const setting of Object.keys(policy.pmset).filter(
      (key) => key !== except
    )) {
      pmset(world, { ...policy.pmset, [setting]: value });
      manager(world).drifted.push({
        setting,
        check: await managerPower(world.commands.run, checkout),
      });
    }
  }
);

/** Every setting reported in turn: there has to be one, or nothing is said. */
function drifted(world: FleetSyncWorld): { setting: string; check: Check }[] {
  expect(manager(world).drifted.length).toBeGreaterThan(0);
  return manager(world).drifted;
}

Then("each time the check's status is {string}", (world, status: Status) => {
  for (const { check } of drifted(world)) expect(check.status).toBe(status);
});

Then(
  "each time the check's summary is {string} and the name of that setting",
  (world, code: string) => {
    for (const { setting, check } of drifted(world))
      expect(check.summary).toBe(`${code} ${setting}`);
  }
);

Then(
  "each time the check's remedy contains {string}",
  (world, text: string) => {
    for (const { check } of drifted(world))
      expect(check.remedy?.action).toContain(text);
  }
);

Then(
  "each time the check's remedy ends with {string}",
  (world, text: string) => {
    for (const { check } of drifted(world))
      expect(check.remedy?.action).toEndWith(text);
  }
);

// ── Docker Desktop ───────────────────────────────────────────────────────

Then(
  'the Docker Desktop that mise.toml pins is named "Docker Desktop", a release number and a build number in brackets',
  () => {
    expect(pinnedDockerDesktop()).toMatch(
      /^Docker Desktop \d+\.\d+\.\d+ \(\d+\)$/
    );
  }
);

Given(
  'the Docker engine names itself as the Docker Desktop that mise.toml pins',
  (world) => {
    world.commands.otherwise = succeeded(`${pinnedDockerDesktop()}\n`);
  }
);

Given('the Docker engine names itself {string}', (world, name: string) => {
  world.commands.otherwise = succeeded(`${name}\n`);
});

Given('the Docker engine does not answer', (world) => {
  world.commands.otherwise = failed();
});

When('the Docker Desktop of the manager is measured', async (world) => {
  world.checks = [await managerDocker(world.commands.run)];
});

// ── The manager's Vault session ──────────────────────────────────────────

const vault = new WeakMap<
  FleetSyncWorld,
  {
    session: boolean;
    /** Whether Vault itself answers, unsealed. */
    reachable: boolean;
    loaded: boolean;
    applied: string[];
    /** The `data` of what looking the token up prints. */
    token: Record<string, unknown> | undefined;
    /** What launchd prints about the renewal job. */
    job: string;
  }
>();

function vaultOf(world: FleetSyncWorld) {
  let found = vault.get(world);
  if (!found)
    vault.set(
      world,
      (found = {
        session: true,
        reachable: true,
        loaded: false,
        applied: [],
        token: undefined,
        job: '',
      })
    );
  return found;
}

/** The instant the manager's clock reads in these scenarios: a token's times
 * are written in the feature as seconds before or after it.
 */
const VAULT_NOW = Date.parse('2026-12-01T12:00:00Z');

Given("the manager's Vault renewal job is loaded", (world) => {
  vaultOf(world).loaded = true;
});

Given(
  "the last run of the manager's Vault renewal job ended with the exit code {int}",
  (world, code: number) => {
    vaultOf(world).job = `\tstate = not running\n\tlast exit code = ${code}\n`;
  }
);

Given(
  /^the manager's Vault token is (renewable|not renewable), with (\d+) seconds left(?:, (\d+) seconds after a renewal that left it (\d+))?$/,
  (
    world,
    renewable: string,
    left: string,
    ago: string | null,
    granted: string | null
  ) => {
    const now = VAULT_NOW / 1000;
    const renewed = ago === null ? null : now - Number(ago);
    vaultOf(world).token = {
      renewable: renewable === 'renewable',
      ttl: Number(left),
      explicit_max_ttl: 0,
      creation_time: now - 86_400,
      // As Vault writes them: the expiry with nanoseconds, the renewal in
      // whole seconds, and no renewal at all for a token nobody renewed.
      expire_time: new Date(
        (renewed === null ? now + Number(left) : renewed + Number(granted)) *
          1000
      )
        .toISOString()
        .replace('.000Z', '.123456789Z'),
      ...(renewed === null ? {} : { last_renewal_time: renewed }),
    };
  }
);

const tokenOf = (world: FleetSyncWorld): Record<string, unknown> => {
  const { token } = vaultOf(world);
  if (!token) throw new Error('The scenario describes no Vault token.');
  return token;
};

Given(
  'that token is periodic, renewed for {int} seconds at a time',
  (world, period: number) => {
    tokenOf(world)['period'] = period;
  }
);

Given(
  'that token was created {int} seconds ago with a maximum lifetime of {int} seconds',
  (world, ago: number, lifetime: number) => {
    Object.assign(tokenOf(world), {
      creation_time: VAULT_NOW / 1000 - ago,
      explicit_max_ttl: lifetime,
    });
  }
);

Given(
  'looking that token up also prints the token {string}',
  (world, token: string) => {
    tokenOf(world)['id'] = token;
  }
);

Then(
  'the macOS policy has the renewal job ask Vault for {int} hours, and the manager warn {int} hours before a login ends',
  (_world, increment: number, lead: number) => {
    expect(policy.vaultRenewal).toEqual({
      incrementHours: increment,
      expiryWarnHours: lead,
    });
    expect(increment).toBeGreaterThan(lead);
  }
);

Then(
  '{string} renews for the hours the macOS policy names',
  (_world, playbook: string) => {
    const text = readFileSync(join(ROOT, playbook), 'utf8');
    expect(text).toContain('- policy.json');
    expect(text).toContain(
      '<string>-increment={{ vaultRenewal.incrementHours | int }}h</string>'
    );
  }
);

Given('the manager is logged in to Vault', (world) => {
  vaultOf(world).session = true;
});

Given("the manager's Vault session has lapsed", (world) => {
  vaultOf(world).session = false;
});

Given('Vault does not answer the manager', (world) => {
  vaultOf(world).session = false;
  vaultOf(world).reachable = false;
});

Given("the manager's Vault renewal job is not loaded", (world) => {
  vaultOf(world).loaded = false;
});

async function holdVault(world: FleetSyncWorld, apply: boolean) {
  const state = vaultOf(world);
  world.commands.answer(
    (command) => command[0] === 'vault' && command[2] === 'lookup',
    () =>
      state.session
        ? succeeded(state.token ? JSON.stringify({ data: state.token }) : '')
        : failed()
  );
  world.commands.answer(
    (command) => command[0] === 'vault' && command[1] === 'status',
    () => (state.reachable ? succeeded('{"sealed":false}') : failed())
  );
  world.commands.answer(
    (command) => command[0] === 'launchctl' && command[1] === 'print',
    () => (state.loaded ? succeeded(state.job) : failed())
  );
  world.commands.answer(
    (command) => command.some((arg) => arg.endsWith('vault-renew.yml')),
    (command) => {
      // The variables file is removed after the run: read it while it exists.
      const file = command[command.indexOf('--extra-vars') + 1]!.slice(1);
      state.applied.push(readFileSync(file, 'utf8'));
      state.applied.push(command.join(' '));
      state.loaded = true;
      return succeeded();
    }
  );
  const scratch = mkdtempSync(join(tmpdir(), 'devfleet-vault-'));
  world.defer(() => rmSync(scratch, { recursive: true, force: true }));
  world.checks = await holdManagerVault(world.commands.run, {
    apply,
    root: ROOT,
    home: '/Users/fixture',
    uid: 501,
    scratch,
    now: VAULT_NOW,
  });
}

When("an applying sync holds the manager's Vault session", (world) =>
  holdVault(world, true)
);

When("the manager's Vault session is measured", (world) =>
  holdVault(world, false)
);

Then(
  'vault-renew.yml was applied for {string} without a password prompt',
  (world, address: string) => {
    const [variables, command] = vaultOf(world).applied;
    expect(JSON.parse(variables!)).toEqual({
      vault_address: address,
      mise: '/Users/fixture/.local/bin/mise',
    });
    expect(command).not.toContain(' -K');
    expect(command).not.toContain('--ask-become-pass');
  }
);

When(
  'a proxy source at {string} reports Antigravity windows last read {int} minutes ago',
  (world, path: string, age: number) => {
    const origin = 'https://proxy.example.invalid';
    const now = Date.now();
    const checkedAt = new Date(now - age * 60_000).toISOString();
    const account = {
      tool: 'antigravity',
      email: 'one@example.invalid',
      prefix: 'antigravity-one',
      models: [],
    };
    quotaResults.set(
      world,
      quotaCoverage(
        [account],
        origin + '/hub',
        [
          {
            kind: 'cliproxy',
            origin,
            endpoint: origin + path,
            checkedAt,
            accounts: [
              {
                driver: account.tool,
                email: account.email,
                usageLimits: { checkedAt, windows: [{ id: 'test' }] },
              },
            ],
          },
        ],
        now
      ).status
    );
  }
);
const quotaResults = new WeakMap<object, string>();
Then('the account quota check reports {string}', (world, status: string) =>
  expect(quotaResults.get(world)).toBe(status)
);

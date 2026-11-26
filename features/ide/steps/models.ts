import { expect } from 'bun:test';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import type { DataTable } from '../../support/gherkin';
import { preferredModels, type Account } from '../../../src/agents/accounts';
import { accountInstanceId, accountDriver } from '../../../src/t3/accounts';
import { modelsCheck } from '../../../src/t3/models';
import { ide, type IdeWorld } from './world';

const { Given, When, Then } = ide;

interface Models {
  accounts: Account[] | null;
  required: Record<string, string[]>;
  /** How often T3 still rewrites its settings during a sync. */
  interruptions: number;
  /** The settings file as the last sync found it. */
  writtenAt: number | undefined;
}
const models = new WeakMap<IdeWorld, Models>();
const of = (world: IdeWorld): Models => {
  let value = models.get(world);
  if (!value)
    models.set(
      world,
      (value = {
        accounts: [],
        required: {},
        interruptions: 0,
        writtenAt: undefined,
      })
    );
  return value;
};

const PROVIDERS: Record<string, string> = {
  antigravity: 'antigravity',
  codex: 'codex',
  claude: 'claude',
  opencode: 'antigravity',
};
const list = (text: string): string[] =>
  text
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

const file = (world: IdeWorld, name: string): string => {
  mkdirSync(join(world.t3Home, 'userdata'), { recursive: true });
  return join(world.t3Home, 'userdata', name);
};
const readJson = (path: string): Record<string, unknown> =>
  existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>)
    : {};

Given('the proxy serves these models:', (world, table: DataTable) => {
  of(world).accounts = table.hashes().map((row) => ({
    tool: row['tool']!,
    email: row['account']!,
    prefix: `${PROVIDERS[row['tool']!]}-${row['account']}`,
    models: list(row['models']!),
  }));
});

Given('the proxy does not answer', (world) => {
  of(world).accounts = null;
});

Given('T3 holds the instances of every account the proxy serves', (world) => {
  const instances = Object.fromEntries(
    (of(world).accounts ?? []).map((account) => [
      accountInstanceId(account),
      { driver: accountDriver(account.tool), enabled: true, config: {} },
    ])
  );
  writeFileSync(
    file(world, 'settings.json'),
    JSON.stringify({ providerInstances: instances })
  );
});

Given(
  "T3's catalogue for the driver {string} is {string}",
  (world, driver: string, catalogue: string) => {
    const path = file(world, 'model-manifest.json');
    const manifest = readJson(path) as {
      manifest?: { currentModels?: Record<string, string[]> };
    };
    writeFileSync(
      path,
      JSON.stringify({
        fetchedAtMs: 0,
        manifest: {
          ...manifest.manifest,
          currentModels: {
            ...manifest.manifest?.currentModels,
            [driver]: list(catalogue),
          },
        },
      })
    );
  }
);

Given(
  'the instance of {string} adds the custom model {string}',
  (world, email: string, model: string) => {
    const path = file(world, 'settings.json');
    const settings = readJson(path) as {
      providerInstances: Record<string, { config: Record<string, unknown> }>;
    };
    const account = of(world).accounts!.find(
      (candidate) => candidate.email === email
    )!;
    settings.providerInstances[accountInstanceId(account)]!.config[
      'customModels'
    ] = [{ slug: model, name: model }];
    writeFileSync(path, JSON.stringify(settings));
  }
);

Given(
  'the fleet requires the model {string} for {string}',
  (world, model: string, tool: string) => {
    of(world).required[tool] = [model];
  }
);

Given(
  'the preferred defaults of {string} are {string}',
  (_world, tool: string, preferred: string) => {
    expect(preferredModels(tool)).toEqual(list(preferred));
  }
);

Given("T3's settings hold these model preferences:", (world, text: string) => {
  const path = file(world, 'settings.json');
  writeFileSync(
    path,
    JSON.stringify({
      ...readJson(path),
      providerModelPreferences: JSON.parse(text) as unknown,
    })
  );
});

Given(
  "T3's setting {string} names the model {string} on the instance of {string}",
  (world, setting: string, model: string, email: string) => {
    const path = file(world, 'settings.json');
    const account = of(world).accounts!.find(
      (candidate) => candidate.email === email
    )!;
    writeFileSync(
      path,
      JSON.stringify({
        ...readJson(path),
        [setting]: { instanceId: accountInstanceId(account), model },
      })
    );
  }
);

Given(
  'T3 rewrites its settings while the models are synced, {int} time(s)',
  (world, times: number) => {
    of(world).interruptions = times;
  }
);

const check = async (world: IdeWorld, apply: boolean): Promise<void> => {
  const state = of(world);
  const path = file(world, 'settings.json');
  state.writtenAt = existsSync(path) ? statSync(path).ino : undefined;
  world.checks = [
    await modelsCheck({
      t3Home: world.t3Home,
      roster: async () => {
        if (!state.accounts)
          throw new Error('The CLI proxy did not list its models.');
        return state.accounts;
      },
      required: state.required,
      apply,
      pause: async () => {},
      // T3 writing its own settings between dev-fleet's read and write.
      beforeWrite: async () => {
        if (state.interruptions <= 0) return;
        state.interruptions--;
        const current = readJson(path);
        writeFileSync(
          path,
          JSON.stringify({
            ...current,
            lastOpened: Number(current['lastOpened'] ?? 0) + 1,
          })
        );
      },
    }),
  ];
};

Given('the models T3 offers have been synced', async (world) => {
  await check(world, true);
});

When('the models T3 offers are checked', async (world) => {
  await check(world, false);
});

When('the models T3 offers are synced', async (world) => {
  await check(world, true);
});

Then("T3's settings were not written again", (world) => {
  // A write replaces the file through a rename: a new inode.
  expect(statSync(file(world, 'settings.json')).ino).toBe(of(world).writtenAt!);
});

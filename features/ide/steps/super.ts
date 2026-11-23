import { expect } from 'bun:test';
import type { DataTable } from '../../support/gherkin';
import { failed, succeeded } from '../../support/commands';
import type { MachineDefinition } from '../../../src/definition';
import { superIde } from '../../../src/ide/super';
import type { CommandResult } from '../../../src/types';
import { ide, ROOT, type IdeWorld } from './world';

const { Given, When, Then } = ide;

interface Super {
  cli: string;
  home: string;
  workers: MachineDefinition[];
}
const supers = new WeakMap<IdeWorld, Super>();
const of = (world: IdeWorld): Super => {
  let value = supers.get(world);
  if (!value) supers.set(world, (value = { cli: '', home: '', workers: [] }));
  return value;
};

/** The app's CLI asked for `words`, whatever follows them. */
const asked =
  (world: IdeWorld, words: string) =>
  (command: string[]): boolean =>
    command[0] === of(world).cli &&
    command.slice(1).join(' ').startsWith(words);

/** The app prints an error as JSON and exits with a failure. */
const answer = (text: string): CommandResult =>
  text.includes('cli_error') ? { ...failed(), stdout: text } : succeeded(text);

Given("the app's CLI on the manager is {string}", (world, cli: string) => {
  const state = of(world);
  state.cli = cli;
  state.home = cli.slice(0, cli.indexOf('/.super.engineering'));
});

Given("the app's CLI is not on the manager", (world) => {
  world.commands.answer((command) => command[0] === of(world).cli, {
    ok: false,
    stdout: '',
    stderr: '',
    reason: 'missing',
  });
});

Given(
  /^the app answers "([^"]+)" with (.+)$/,
  (world, words: string, text: string) => {
    world.commands.answer(asked(world, words), answer(text));
  }
);

function holds(world: IdeWorld, rows: Record<string, string>[]): void {
  world.commands.answer(
    asked(world, 'workspace list'),
    succeeded(
      JSON.stringify({
        kind: 'workspaces',
        response: {
          workspaces: rows.map((row) => ({ id: row['id'], title: row['id'] })),
        },
      })
    )
  );
  for (const row of rows)
    world.commands.answer(
      asked(world, `workspace get ${row['id']}`),
      succeeded(
        JSON.stringify({
          kind: 'workspace',
          response: {
            workspace: {
              id: row['id'],
              name: row['id'],
              type: row['type'],
              ...(row['ssh target'] ? { ssh_target: row['ssh target'] } : {}),
            },
          },
        })
      )
    );
  world.commands.answer(asked(world, 'workspace create'), (command) =>
    succeeded(
      JSON.stringify({
        kind: 'workspace_created',
        response: { workspace: { id: 'new', name: command[3] } },
      })
    )
  );
}

Given('the app holds these workspaces:', (world, table: DataTable) => {
  holds(world, table.hashes());
});

Given('the app holds no workspace', (world) => {
  holds(world, []);
});

const session =
  (target: string) =>
  (command: string[]): boolean =>
    command[0] === 'ssh' && command.at(-2) === target;

function finds(world: IdeWorld, target: string, commands: string[]): void {
  world.commands.answer(
    session(target),
    succeeded(commands.map((command) => `${command}\n`).join(''))
  );
}

Given(
  "the manager's own SSH finds these commands on {string}:",
  (world, target: string, table: DataTable) => {
    finds(
      world,
      target,
      table.hashes().map((row) => row['command']!)
    );
  }
);

Given(
  /^the manager's own SSH finds on "([^"]+)" only (.+)$/,
  (world, target: string, commands: string) => {
    finds(world, target, commands.split(', '));
  }
);

Given(
  "the manager's own SSH does not reach {string}",
  (world, target: string) => {
    world.commands.answer(session(target), failed('Permission denied'));
  }
);

Given(
  'the worker {string} is declared without an alias, as {string} at {string}',
  (world, id: string, user: string, name: string) => {
    of(world).workers.push({
      id,
      os: 'linux',
      network: { tailscaleName: name, user, sshPort: 22, t3Port: 3773 },
    } as MachineDefinition);
  }
);

const subject = (world: IdeWorld) =>
  superIde({ home: of(world).home, workers: of(world).workers });

When("the manager's super.engineering is checked", async (world) => {
  world.checks = await subject(world).manager({
    id: 'manager-mac',
    workspace: ROOT,
    apply: true,
    run: world.run,
  });
});

When(
  'the worker {string} is converged for super.engineering',
  async (world, id: string) => {
    const declared = of(world).workers.find((worker) => worker.id === id);
    world.checks = await subject(world).worker(
      {
        id,
        ssh: declared?.network?.tailscaleName ?? id,
        workspace: '/w',
        required: [],
      },
      { run: world.run, workspace: ROOT, earlier: [] }
    );
  }
);

Then('the app was asked to {string}', (world, words: string) => {
  expect(world.lines).toContain(`${of(world).cli} ${words}`);
});

Then('the app was not asked to create a workspace', (world) => {
  expect(world.commands.ran(asked(world, 'workspace create'))).toEqual([]);
});

Then('the worker was reached with {string}', (world, line: string) => {
  expect(world.lines.filter((ran) => ran.startsWith(`${line} `))).toHaveLength(
    1
  );
});

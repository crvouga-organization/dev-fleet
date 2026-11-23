import { expect } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { steps } from '../../support/gherkin';
import { linkAgentCommands, renderedNode } from '../../../src/agents/commands';
import { NATIVE_AGENTS } from '../../../src/agents/native-verify';
import type { Check } from '../../../src/types';
import { failed } from '../../support/commands';
import { lockedCommandsPlay } from '../support/ansible';
import { part, type AgentsWorld } from './world';

export const commands = steps<AgentsWorld>();
const { Given, When, Then } = commands;

const ROOT = resolve(import.meta.dir, '../../..');
const BIN = join(ROOT, 'agents/bin');

const state = part((world) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'agent-commands-')));
  world.defer(() => rmSync(home, { recursive: true, force: true }));
  return {
    home,
    fleet: join(home, '.local/share/personal/fleet'),
    /** The checkout a run applies. */
    root: '',
    launcher: '',
    listed: [] as string[],
    check: undefined as Check | undefined,
    /** How often the play was run. */
    played: 0,
    /** The play fails instead of running. */
    broken: false,
    node: undefined as string | undefined,
  };
});

When(
  'the launcher of the agent command {string} is read',
  (world, command: string) => {
    state(world).launcher = join(BIN, command);
  }
);

Then('it is an executable file', (world) => {
  expect(statSync(state(world).launcher).mode & 0o111).not.toBe(0);
});

Then(
  'it starts {string} beside the directory it is in',
  (world, file: string) => {
    expect(readFileSync(state(world).launcher, 'utf8')).toContain(
      `exec bun "\${self%/*}/../${file}" "$@"`
    );
    expect(existsSync(join(dirname(BIN), file))).toBe(true);
  }
);

Then('it puts the pinned shims ahead of itself on the PATH', (world) => {
  expect(readFileSync(state(world).launcher, 'utf8')).toContain(
    'export PATH="$HOME/.local/share/mise/shims:$PATH"'
  );
});

When('the agent commands of the repository are listed', (world) => {
  state(world).listed = readdirSync(BIN);
});

Then('each of the agents T3 offers has one', (world) => {
  for (const agent of NATIVE_AGENTS)
    expect(state(world).listed).toContain(agent.binary);
});

Given(
  'a worker whose applied revision is {string} of its fleet directory',
  (world, revision: string) => {
    const { fleet } = state(world);
    state(world).root = join(fleet, revision);
    mkdirSync(join(fleet, revision, 'agents/bin'), { recursive: true });
    symlinkSync(revision, join(fleet, 'current'));
  }
);

Given(
  '{string} in the fleet directory already links to {string}',
  (world, name: string, target: string) => {
    symlinkSync(target, join(state(world).fleet, name));
  }
);

Given(
  '{string} in the fleet directory is a directory that holds {string}',
  (world, name: string, file: string) => {
    mkdirSync(join(state(world).fleet, name));
    writeFileSync(join(state(world).fleet, name, file), '');
  }
);

Given('the agent commands play fails', (world) => {
  state(world).broken = true;
});

/** The real play, counted; or one that fails, when the scenario says so. */
const converge = async (world: AgentsWorld, root: string): Promise<void> => {
  const current = state(world);
  const play = current.broken ? null : await lockedCommandsPlay(world);
  current.check = await linkAgentCommands(
    root,
    async (variables) => {
      current.played += 1;
      return play ? play(variables) : failed('PRIVATE_SENTINEL');
    },
    current.home
  );
};

When(
  /^the agent commands of the worker are converged(?: again)?$/,
  async (world) => {
    await converge(world, state(world).root);
  }
);

Given('the agent commands of the worker have been converged', async (world) => {
  await converge(world, state(world).root);
  state(world).played = 0;
});

When(
  'the agent commands are converged from the checkout {string} of the home directory',
  async (world, checkout: string) => {
    await converge(world, join(state(world).home, checkout));
  }
);

Then(
  /^the agent commands play was (not run|run once)$/,
  (world, how: string) => {
    expect(state(world).played).toBe(how === 'not run' ? 0 : 1);
  }
);

Then('nothing the play printed is reported', (world) => {
  expect(JSON.stringify(state(world).check)).not.toContain('PRIVATE_SENTINEL');
});

Then(
  /^the (?:worker|machine) reports "([^"]+)" as (done|skipped)$/,
  (world, id: string, verdict: string) => {
    expect(state(world).check).toMatchObject({
      id,
      status: verdict === 'done' ? 'pass' : 'skip',
    });
  }
);

Then(
  'the worker reports {string} as failed with {string}',
  (world, id: string, summary: string) => {
    expect(state(world).check).toMatchObject({ id, status: 'fail', summary });
  }
);

Then(
  '{string} in the fleet directory links to {string}',
  (world, name: string, target: string) => {
    expect(readlinkSync(join(state(world).fleet, name))).toBe(target);
  }
);

Then(
  '{string} in the fleet directory still holds {string}',
  (world, name: string, file: string) => {
    expect(readdirSync(join(state(world).fleet, name))).toEqual([file]);
  }
);

Then('the fleet directory holds no {string}', (world, name: string) => {
  expect(existsSync(join(state(world).fleet, name))).toBe(false);
});

Given(
  /^the agent profiles of the machine are those of (.+)$/,
  (world, holds: string) => {
    const root = join(state(world).home, '.config/personal/agents');
    mkdirSync(root, { recursive: true });
    for (const [, node] of holds.matchAll(/"([^"]+)"/g))
      mkdirSync(join(root, node!));
    if (holds.includes('backups')) mkdirSync(join(root, 'backups'));
  }
);

When('the node of a launch nothing names is resolved', (world) => {
  state(world).node = renderedNode(
    join(state(world).home, '.config/personal/agents')
  );
});

Then(/^it is (?:"([^"]+)"|no node)$/, (world, node: string | undefined) => {
  expect(state(world).node).toBe(node ?? '');
});

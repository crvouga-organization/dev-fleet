import { expect } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import schema from '../../../schema/fleet.schema.json';
import { conforms } from '../../core/support/json-schema';
import type { DataTable } from '../../support/gherkin';
import { DefinitionError, parseDefinition } from '../../../src/definition';
import {
  agentSessionLimit,
  kernelSessionLimit,
} from '../../../src/agent-session-limit';
import {
  REFUSED_EXIT_CODE,
  admission,
  refusal,
} from '../../../src/agents/admission';
import { machines, type MachinesWorld } from './world';

const { Given, When, Then } = machines;

const ROOT = resolve(import.meta.dir, '../../..');
const GUARD = join(ROOT, 'ansible/ubuntu/agent-session-limit.py');
const UID = 1000;
const MANAGER = `user.slice/user-${UID}.slice/user@${UID}.service`;

/** What one scenario holds: a fleet configuration being written, a stand-in
 * cgroup tree, and what a launcher or the unit made of it. */
interface Limit {
  written?: Record<string, unknown>;
  failure?: unknown;
  limit?: number | undefined;
  /** The stand-in cgroup mount, and the slices the scenario named. */
  mount?: string;
  slices: string[];
  exit?: number;
  /** The launcher's own cgroup and the files beside it. */
  cgroup?: string;
  files: Map<string, string>;
  directories: Map<string, string[]>;
  message?: string | undefined;
  asked: boolean;
}
const limits = new WeakMap<MachinesWorld, Limit>();
function limitOf(world: MachinesWorld): Limit {
  let state = limits.get(world);
  if (!state) {
    state = {
      slices: [],
      files: new Map(),
      directories: new Map(),
      asked: false,
    };
    limits.set(world, state);
  }
  return state;
}

// ── The declared limit ──────────────────────────────────────────────────

Given('the fleet configuration of the example', (world) => {
  limitOf(world).written = JSON.parse(
    readFileSync(join(ROOT, 'examples/fleet.json'), 'utf8')
  ) as Record<string, unknown>;
});

Given(
  /^the worker policy declares an agent session limit of (.+)$/,
  (world, value: string) => {
    const policy = limitOf(world).written!['worker'] as Record<string, unknown>;
    policy['agentSessionLimit'] = JSON.parse(value);
  }
);

Given(
  /^"([^"]+)" declares an agent session limit of (.+)$/,
  (world, id: string, value: string) => {
    const workers = limitOf(world).written!['workers'] as Record<
      string,
      unknown
    >[];
    workers.find((entry) => entry['id'] === id)!['agentSessionLimit'] =
      JSON.parse(value);
  }
);

When('the agent session limit of {string} is read', (world, id: string) => {
  const state = limitOf(world);
  state.limit = agentSessionLimit(parseDefinition(state.written), id);
});

When('the fleet configuration is read', (world) => {
  const state = limitOf(world);
  try {
    parseDefinition(state.written);
  } catch (error) {
    state.failure = error;
  }
});

Then('no agent session limit is declared', (world) => {
  expect(limitOf(world).limit).toBeUndefined();
});

Then(
  'the agent session limit is {int} and the kernel holds {int} scopes',
  (world, limit: number, held: number) => {
    expect(limitOf(world).limit).toBe(limit);
    expect(kernelSessionLimit(limit)).toBe(held);
  }
);

Then(
  'the fleet configuration is refused at {string}',
  (world, path: string) => {
    const { failure } = limitOf(world);
    expect(failure).toBeInstanceOf(DefinitionError);
    expect((failure as DefinitionError).problem.path).toBe(path);
  }
);

Then('the schema of the fleet configuration refuses it too', (world) => {
  expect(conforms(schema, limitOf(world).written)).toBe(false);
});

// ── The unit that holds the kernel's limit ──────────────────────────────

Given(
  'a user manager whose cgroup tree holds these slices:',
  async (world, table: DataTable) => {
    const state = limitOf(world);
    const mount = await mkdtemp(join(tmpdir(), 'fleet-session-limit-'));
    world.defer(() => rm(mount, { recursive: true, force: true }));
    state.mount = mount;
    for (const { slice, descendants } of table.hashes()) {
      const path = join(mount, MANAGER, slice!);
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, 'cgroup.max.descendants'), `${descendants}\n`);
      state.slices.push(slice!);
    }
    // What the unit reads of itself: a service of that user manager.
    writeFileSync(
      join(mount, 'self'),
      `0::/${MANAGER}/app.slice/personal-fleet-agent-session-limit.service\n`
    );
  }
);

const guard = (state: Limit, held: number, ...flags: string[]) => [
  'python3',
  '-I',
  '-B',
  GUARD,
  '--limit',
  String(held),
  '--interval',
  '0.05',
  '--cgroup',
  join(state.mount!, 'self'),
  '--mount',
  state.mount!,
  ...flags,
];

const held = (state: Limit, slice: string) =>
  readFileSync(
    join(state.mount!, MANAGER, slice, 'cgroup.max.descendants'),
    'utf8'
  ).trim();

When('the unit that holds {int} scopes runs once', (world, scopes: number) => {
  const state = limitOf(world);
  state.exit = Bun.spawnSync(guard(state, scopes, '--once')).exitCode;
});

When(
  'the unit that holds {int} scopes runs until it is stopped',
  async (world, scopes: number) => {
    const state = limitOf(world);
    const unit = Bun.spawn(guard(state, scopes), {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    const owned = state.slices.filter((slice) =>
      basename(slice).startsWith('app-t3code-agents-')
    );
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (owned.every((slice) => held(state, slice) === String(scopes))) break;
      await Bun.sleep(25);
    }
    // It held the limit before it was stopped: otherwise "max" proves nothing.
    expect(owned.map((slice) => held(state, slice))).toEqual(
      owned.map(() => String(scopes))
    );
    unit.kill('SIGTERM');
    state.exit = await unit.exited;
  }
);

Then('the slices hold:', (world, table: DataTable) => {
  const state = limitOf(world);
  expect(state.exit).toBe(0);
  expect(
    state.slices.map((slice) => ({ slice, descendants: held(state, slice) }))
  ).toEqual(table.hashes() as { slice: string; descendants: string }[]);
});

Then('the unit ends with an error and changes no slice', (world) => {
  const state = limitOf(world);
  expect(state.exit).not.toBe(0);
  expect(state.slices.map((slice) => held(state, slice))).toEqual([
    'max',
    'max',
    '9',
    'max',
  ]);
});

// ── The launcher's own refusal ──────────────────────────────────────────

const AGENTS = `/${MANAGER}/app.slice/app-t3code.slice/app-t3code-agents.slice`;

Given(
  'a launcher started in the scope {string} of the slice {string}',
  (world, scope: string, slice: string) => {
    limitOf(world).cgroup = `${AGENTS}/${slice}/${scope}`;
  }
);

Given(
  'a launcher started in the cgroup {string} of the user manager',
  (world, cgroup: string) => {
    limitOf(world).cgroup = `/${MANAGER}/${cgroup}`;
  }
);

Given(
  'that slice runs {int} agent scopes and its kernel limit reads {string}',
  (world, scopes: number, limit: string) => {
    const state = limitOf(world);
    const slice = join('/sys/fs/cgroup', dirname(state.cgroup!));
    state.files.set(join(slice, 'cgroup.max.descendants'), `${limit}\n`);
    state.directories.set(slice, [
      'cgroup.max.descendants',
      'cgroup.procs',
      ...Array.from(
        { length: scopes },
        (_, index) => `t3code-claude-0000000${index + 1}.scope`
      ),
    ]);
  }
);

Given('the kernel limit beside it reads {string}', (world, limit: string) => {
  const state = limitOf(world);
  const beside = join('/sys/fs/cgroup', dirname(state.cgroup!));
  state.files.set(join(beside, 'cgroup.max.descendants'), `${limit}\n`);
  state.directories.set(
    beside,
    Array.from(
      { length: 9 },
      (_, index) => `t3code-claude-0000000${index}.scope`
    )
  );
});

When('the launcher asks whether it may start', (world) => {
  const state = limitOf(world);
  const found = <Value>(from: Map<string, Value>, path: string): Value => {
    const value = from.get(path);
    if (value === undefined) throw new Error(`ENOENT: ${path}`);
    return value;
  };
  const waiting = admission({
    file: (path) =>
      path === '/proc/self/cgroup'
        ? `0::${state.cgroup}\n`
        : found(state.files, path),
    directory: (path) => found(state.directories, path),
  });
  state.message = waiting && refusal(waiting);
  state.asked = true;
});

Then('the launcher starts its agent', (world) => {
  const state = limitOf(world);
  expect(state.asked).toBe(true);
  expect(state.message).toBeUndefined();
});

Then('the launcher refuses the session', (world) => {
  expect(limitOf(world).message).toStartWith('AGENT_SESSION_REFUSED: ');
  // sysexits' EX_TEMPFAIL: T3 shows the code a provider ended with.
  expect(REFUSED_EXIT_CODE).toBe(75);
});

Then('the launcher refuses the session, saying:', (world, text: string) => {
  expect(limitOf(world).message).toBe(text.trim());
});

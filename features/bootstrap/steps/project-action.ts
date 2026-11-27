import { expect } from 'bun:test';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { steps } from '../../support/gherkin';
import { part, type BootstrapWorld } from './world';

const source = resolve(import.meta.dir, '../../..');

interface ActionRun {
  root: string;
  head: string;
  exit: number | null;
  asked: string | null;
  warmed: boolean;
}

export const projectAction = steps<BootstrapWorld>();
const { Given, When, Then } = projectAction;

const run = part((world): ActionRun => ({
  root: world.directory('project-action-'),
  head: '',
  exit: null,
  asked: null,
  warmed: false,
}));

function git(root: string, args: string[]): void {
  const result = Bun.spawnSync(
    ['git', '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args],
    { cwd: root }
  );
  if (result.exitCode !== 0)
    throw new Error(result.stderr.toString() || 'git failed');
}

function text(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

Given(
  'a checkout whose project action stands in for the toolchain and for homelab',
  (world) => {
    const state = run(world);
    const bootstrap = join(state.root, 'bootstrap');
    mkdirSync(bootstrap, { recursive: true });
    const script = join(bootstrap, 'project-action.sh');
    copyFileSync(join(source, 'bootstrap/project-action.sh'), script);
    chmodSync(script, 0o755);
    writeFileSync(
      join(bootstrap, 'bootstrap.sh'),
      '#!/bin/sh\nprintf warmed > "$(dirname "$0")/../warmed"\n',
      { mode: 0o755 }
    );
    writeFileSync(
      join(bootstrap, 'homelab'),
      '#!/bin/sh\nprintf \'%s\\n\' "$*" > "$(dirname "$0")/../homelab-args"\n',
      { mode: 0o755 }
    );
    writeFileSync(join(state.root, 'README'), 'checkout\n');
    git(state.root, ['init', '-q']);
    git(state.root, ['add', 'README']);
    git(state.root, ['commit', '-q', '-m', 'checkout']);
    const head = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
      cwd: state.root,
    });
    if (head.exitCode !== 0) throw new Error(head.stderr.toString());
    state.head = head.stdout.toString().trim();
  }
);

function invoke(world: BootstrapWorld, args: string[]): void {
  const state = run(world);
  const result = Bun.spawnSync(
    ['bash', 'bootstrap/project-action.sh', ...args],
    { cwd: state.root }
  );
  state.exit = result.exitCode;
  world.exit = result.exitCode;
  state.warmed = text(join(state.root, 'warmed')) === 'warmed';
  state.asked = text(join(state.root, 'homelab-args'))?.trim() ?? null;
}

When('the project action {string} runs', (world, action: string) => {
  invoke(world, action.split(' '));
});

When('the project action runs with no name', (world) => {
  invoke(world, []);
});

Then('the toolchain was warmed', (world) => {
  expect(run(world).warmed).toBe(true);
});

Then('the toolchain was not warmed', (world) => {
  expect(run(world).warmed).toBe(false);
});

Then('homelab was not run', (world) => {
  expect(run(world).asked).toBeNull();
});

Then('homelab was asked to {string}', (world, command: string) => {
  expect(run(world).exit).toBe(0);
  expect(run(world).asked).toBe(command);
});

Then('homelab was asked to converge to that checkout', (world) => {
  const state = run(world);
  expect(state.exit).toBe(0);
  expect(state.asked).toBe(`converge --revision ${state.head}`);
});

Then(
  'homelab was asked to converge to that checkout with {string}',
  (world, extra: string) => {
    const state = run(world);
    expect(state.exit).toBe(0);
    expect(state.asked).toBe(`converge --revision ${state.head} ${extra}`);
  }
);

Then(
  'homelab was asked to converge this machine to that checkout with {string}',
  (world, extra: string) => {
    const state = run(world);
    expect(state.exit).toBe(0);
    expect(state.asked).toBe(
      `converge-local --revision ${state.head} ${extra}`
    );
  }
);

import { expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { orchestration, type OrchestrationWorld } from '../support/world';

/** The configuration-install step of the remote bootstrap, cut from the
 * script between its markers and run in a real shell, in a home directory
 * of the scenario's own.
 */
const { Given, When, Then } = orchestration;

const SCRIPT = resolve(
  import.meta.dir,
  '../../../bootstrap/fleet-remote-bootstrap.sh'
);

function between(begin: string, end: string): string {
  const text = readFileSync(SCRIPT, 'utf8');
  const from = text.indexOf(begin);
  const to = text.indexOf(end);
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return text.slice(from, to);
}

interface Worker {
  home: string;
  stdout?: string;
}
const workers = new WeakMap<OrchestrationWorld, Worker>();

function worker(world: OrchestrationWorld): Worker {
  let found = workers.get(world);
  if (!found) {
    const home = mkdtempSync(join(tmpdir(), 'devfleet-worker-copy-'));
    world.defer(() => rmSync(home, { recursive: true, force: true }));
    found = { home };
    workers.set(world, found);
  }
  return found;
}

const directory = (world: OrchestrationWorld): string =>
  join(worker(world).home, '.config/dev-fleet');
const copy = (world: OrchestrationWorld): string =>
  join(directory(world), 'fleet.json');
const record = (world: OrchestrationWorld): string =>
  join(directory(world), 'fleet.json.sha256');

/** The step as the bootstrap runs it: the configuration arrives as one
 * base64 line, held in a shell variable.
 */
function install(world: OrchestrationWorld, configuration: string): string {
  const program = [
    'set -eu',
    'umask 077',
    'die() { echo "$1"; exit 1; }',
    `configuration=${Buffer.from(configuration).toString('base64')}`,
    'config_dir="$HOME/.config/dev-fleet"',
    between('# configuration-install: begin', '# configuration-install: end'),
    'echo INSTALLED',
  ].join('\n');
  const result = spawnSync('/bin/sh', ['-c', program], {
    env: { PATH: '/usr/bin:/bin', HOME: worker(world).home },
    encoding: 'utf8',
    timeout: 20_000,
  });
  return result.stdout.trim();
}

Given(
  'the worker was sent the configuration {string}',
  (world, configuration: string) => {
    expect(install(world, configuration)).toBe('INSTALLED');
  }
);

Given(
  'the copy on the worker was edited to {string}',
  (world, text: string) => {
    writeFileSync(copy(world), text);
  }
);

Given(
  'the worker holds the copy {string} and no record',
  (world, text: string) => {
    mkdirSync(directory(world), { recursive: true });
    writeFileSync(copy(world), text);
  }
);

When(
  'the worker is sent the configuration {string}',
  (world, configuration: string) => {
    worker(world).stdout = install(world, configuration);
  }
);

Then('the configuration is installed', (world) => {
  expect(worker(world).stdout).toBe('INSTALLED');
});

Then('the configuration install stops with {string}', (world, code: string) => {
  expect(worker(world).stdout).toBe(code);
});

Then('the copy on the worker holds {string}', (world, text: string) => {
  expect(readFileSync(copy(world), 'utf8')).toBe(text);
});

Then('the record on the worker is the SHA-256 of the copy', (world) => {
  expect(readFileSync(record(world), 'utf8')).toBe(
    createHash('sha256')
      .update(readFileSync(copy(world)))
      .digest('hex') + '\n'
  );
});

Then('nothing half written is left beside the copy', (world) => {
  expect(readdirSync(directory(world)).sort()).toEqual([
    'fleet.json',
    'fleet.json.sha256',
  ]);
});

Then(
  'the remedy the bootstrap prints for {string} mentions {string}',
  (_world, code: string, text: string) => {
    const program = [
      between('remedy() {', '# apt-failure: begin'),
      `remedy ${code}`,
    ].join('\n');
    const result = spawnSync('/bin/sh', ['-c', program], {
      env: { PATH: '/usr/bin:/bin' },
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(result.stdout).toContain(text);
  }
);

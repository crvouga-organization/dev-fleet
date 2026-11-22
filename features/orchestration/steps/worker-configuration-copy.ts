import { expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { orchestration, type OrchestrationWorld } from '../support/world';

/** The configuration-install step of the remote bootstrap, cut from the
 * script between its markers and run in a real shell, in a home directory
 * of the scenario's own. A run is an operation as the script records it:
 * it reads the record of the operation before it, writes its own, installs
 * the copy and, having got that far, holds a checkout of its revision.
 */
const { Given, When, Then } = orchestration;

const SCRIPT = resolve(
  import.meta.dir,
  '../../../bootstrap/fleet-remote-bootstrap.sh'
);
const SCRIPT_PATH = 'bootstrap/fleet-remote-bootstrap.sh';

function between(begin: string, end: string, text = script()): string {
  const from = text.indexOf(begin);
  const to = text.indexOf(end);
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return text.slice(from, to);
}

const script = (): string => readFileSync(SCRIPT, 'utf8');

/** The script of a revision from before the record existed: this one's,
 * installing the copy as every revision did until then.
 */
function scriptWithoutRecord(): string {
  const text = script();
  const begin = '# configuration-install: begin';
  const end = '# configuration-install: end';
  const old = [
    `${begin}`,
    '  mkdir -p "$config_dir" || die CONFIGURATION_INSTALL_FAILED',
    '  printf \'%s\' "$configuration" | base64 -d >"$config_dir/fleet.json.new" || die CONFIGURATION_INSTALL_FAILED',
    '  mv "$config_dir/fleet.json.new" "$config_dir/fleet.json" || die CONFIGURATION_INSTALL_FAILED',
    '  ',
  ].join('\n');
  const without =
    text.slice(0, text.indexOf('# prior-operation: begin')) +
    between('operation lock', begin) +
    old +
    text.slice(text.indexOf(end));
  expect(without).not.toContain('fleet.json.sha256');
  return without;
}

interface Worker {
  home: string;
  stdout?: string;
  /** Seconds since the epoch: each thing that happens is later than the last. */
  clock: number;
  /** The revision that keeps no record, once one ran here. */
  recordless?: string;
}
const workers = new WeakMap<OrchestrationWorld, Worker>();

function worker(world: OrchestrationWorld): Worker {
  let found = workers.get(world);
  if (!found) {
    const home = mkdtempSync(join(tmpdir(), 'devfleet-worker-copy-'));
    world.defer(() => rmSync(home, { recursive: true, force: true }));
    found = { home, clock: Math.floor(Date.now() / 1000) - 86_400 };
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
const fleetRoot = (world: OrchestrationWorld): string =>
  join(worker(world).home, '.local/share/personal/fleet');
const operationRecord = (world: OrchestrationWorld): string =>
  join(fleetRoot(world), 'remote-operation.json');

/** A minute later on the worker, as the modification time of `path`. */
function later(world: OrchestrationWorld, path: string): void {
  const at = (worker(world).clock += 60);
  if (existsSync(path)) utimesSync(path, at, at);
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
    },
  });
  expect(result.status).toBe(0);
  return result.stdout.trim();
}

/** A commit that holds `text` as its bootstrap script: its name. */
function revisionHolding(world: OrchestrationWorld, text: string): string {
  const source = mkdtempSync(join(tmpdir(), 'devfleet-worker-revision-'));
  world.defer(() => rmSync(source, { recursive: true, force: true }));
  mkdirSync(join(source, 'bootstrap'));
  writeFileSync(join(source, SCRIPT_PATH), text);
  git(source, 'init', '-q');
  git(source, 'add', SCRIPT_PATH);
  git(source, 'commit', '-q', '-m', 'fixture');
  return git(source, 'rev-parse', 'HEAD');
}

/** The fleet-owned checkout of `revision`, as a finished transfer leaves it. */
function checkOut(
  world: OrchestrationWorld,
  revision: string,
  text: string
): void {
  const deployment = join(fleetRoot(world), 'revisions', revision);
  if (existsSync(deployment)) return;
  mkdirSync(join(deployment, 'bootstrap'), { recursive: true });
  writeFileSync(join(deployment, SCRIPT_PATH), text);
  git(deployment, 'init', '-q');
  git(deployment, 'add', SCRIPT_PATH);
  git(deployment, 'commit', '-q', '-m', 'fixture');
  expect(git(deployment, 'rev-parse', 'HEAD')).toBe(revision);
}

/** One operation of the revision that holds `text`: the steps of that
 * script up to the installed copy, the configuration arriving as one base64
 * line held in a shell variable. Then the rest of a bootstrap that got that
 * far: the checkout, and the operation's last record.
 */
function operate(
  world: OrchestrationWorld,
  configuration: string,
  text = script()
): { stdout: string; revision: string } {
  const revision = revisionHolding(world, text);
  const program = [
    'set -eu',
    'umask 077',
    'die() { echo "$1"; exit 1; }',
    `revision=${revision}`,
    'node=worker',
    'started=0',
    'root="$HOME/.local/share/personal/fleet"',
    'mkdir -p "$root"',
    between('operation() {', '# prior-operation: begin'),
    text.includes('# prior-operation: begin')
      ? between('# prior-operation: begin', '# prior-operation: end', text)
      : '',
    'operation lock',
    `configuration=${Buffer.from(configuration).toString('base64')}`,
    'config_dir="$HOME/.config/dev-fleet"',
    between(
      '# configuration-install: begin',
      '# configuration-install: end',
      text
    ),
    'echo INSTALLED',
  ].join('\n');
  const result = spawnSync('/bin/sh', ['-c', program], {
    env: { PATH: '/usr/bin:/bin', HOME: worker(world).home },
    encoding: 'utf8',
    timeout: 20_000,
  });
  const stdout = result.stdout.trim();
  if (stdout === 'INSTALLED') {
    later(world, copy(world));
    checkOut(world, revision, text);
  }
  later(world, operationRecord(world));
  return { stdout, revision };
}

Given(
  'the worker was sent the configuration {string}',
  (world, configuration: string) => {
    expect(operate(world, configuration).stdout).toBe('INSTALLED');
  }
);

Given(
  'the worker was refused the configuration {string}',
  (world, configuration: string) => {
    expect(operate(world, configuration).stdout).toBe(
      'FLEET_CONFIGURATION_COPY_CHANGED'
    );
  }
);

Given(
  'a revision that keeps no record then installed {string} on the worker',
  (world, configuration: string) => {
    const ran = operate(world, configuration, scriptWithoutRecord());
    expect(ran.stdout).toBe('INSTALLED');
    worker(world).recordless = ran.revision;
  }
);

Given('the checkout of that revision is no longer on the worker', (world) => {
  const revision = worker(world).recordless;
  expect(revision).toBeDefined();
  rmSync(join(fleetRoot(world), 'revisions', revision!), {
    recursive: true,
  });
});

Given(
  'the copy on the worker was edited to {string}',
  (world, text: string) => {
    writeFileSync(copy(world), text);
    later(world, copy(world));
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
    worker(world).stdout = operate(world, configuration).stdout;
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

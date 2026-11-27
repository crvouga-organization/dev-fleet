import { expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { managerSync } from '../../../src/cli/fleet-sync';
import { fleet } from '../../../src/fleet-config';
import { STATE_ROSTER, writeRosterText } from '../../../src/state/roster';
import type { CommandResult, Runner } from '../../../src/types';
import type { DataTable } from '../../support/gherkin';
import { scratch, state, type StateWorld } from './world';

/** Workers that answer the one question a manager asks before it changes
 * anything, and nothing else. Each has a home directory of the scenario's
 * own; the question is run there in a real POSIX shell, as it arrives. Any
 * other session is refused, so a scenario also shows no worker was changed.
 */
const { Given, When, Then } = state;

const SCRIPT_PATH = 'bootstrap/fleet-remote-bootstrap.sh';
const SCRIPT = resolve(import.meta.dir, '../../..', SCRIPT_PATH);

const fleetWorkers = scratch<{
  /** The SSH name of each enrolled worker, and whether it answers. */
  answers: Map<string, boolean>;
  /** What each worker was asked over SSH. */
  asked: { worker: string; command: string }[];
}>(() => ({ answers: new Map(), asked: [] }));

const home = (world: StateWorld, worker: string): string =>
  join(world.root, 'workers', worker);
const copy = (world: StateWorld, worker: string): string =>
  join(home(world, worker), '.config/homelab/fleet.json');

const answer = (ok: boolean, stdout = ''): CommandResult => ({
  ok,
  stdout,
  stderr: '',
  reason: 'exit',
});

/** One SSH session: its last word is the command, the one before the worker. */
function ssh(world: StateWorld, argv: string[]): CommandResult {
  const { answers, asked } = fleetWorkers(world);
  const [worker, command] = argv.slice(-2) as [string, string];
  asked.push({ worker, command });
  if (!answers.get(worker))
    return { ...answer(false), stderr: 'ssh: connect to host: timed out' };
  if (!command.includes('fleet-configuration-copy')) return answer(false);
  const result = spawnSync('/bin/sh', ['-c', command], {
    env: { PATH: '/usr/bin:/bin', HOME: home(world, worker) },
    encoding: 'utf8',
    timeout: 20_000,
  });
  return answer(result.status === 0, result.stdout);
}

/** Git on the manager: its copy of the source repository holds every
 * revision, on its default branch, and each one's remote bootstrap is the
 * tracked script. Anything else Git is asked fails, as it does where there
 * is no checkout.
 */
function git(argv: string[]): CommandResult {
  if (argv[1] === 'show' && argv[2]?.endsWith(`:${SCRIPT_PATH}`))
    return answer(true, readFileSync(SCRIPT, 'utf8'));
  if (argv[1] === 'rev-parse' && argv[2] === '--verify')
    return answer(true, `${argv[3]!.replace('^{commit}', '')}\n`);
  if (argv[1] === 'remote') return answer(true, `${fleet.source.repository}\n`);
  return answer(
    argv[1] === 'merge-base' ||
      argv[1] === 'fetch' ||
      (argv[1] === 'rev-parse' && argv.includes('--quiet'))
  );
}

Given(
  'converge runs on a manager with these workers enrolled:',
  async (world, table: DataTable) => {
    const manager = world.manager();
    world.bind(manager);
    const nodes = table.hashes().map((row) => {
      mkdirSync(home(world, row['worker']!), { recursive: true });
      fleetWorkers(world).answers.set(row['worker']!, true);
      return { id: row['worker']!, ssh: row['worker']!, workspace: '/' };
    });
    await writeRosterText(
      STATE_ROSTER,
      JSON.stringify({ version: 1, nodes }),
      manager.env,
      manager.home
    );
    const run: Runner = (argv, options) => {
      if (argv[0] === 'mise' || argv[0] === '/pinned/litestream')
        return world.litestream.run(argv, options);
      if (argv[0] === 'git') return Promise.resolve(git(argv));
      if (argv[0] === 'ssh') return Promise.resolve(ssh(world, argv));
      return Promise.resolve({ ...answer(false), reason: 'missing' });
    };
    manager.run = run;
  }
);

Given(
  'converge last wrote the copy {string} on worker {string}',
  (world, text: string, worker: string) => {
    mkdirSync(join(copy(world, worker), '..'), { recursive: true });
    writeFileSync(copy(world, worker), text);
    writeFileSync(
      `${copy(world, worker)}.sha256`,
      createHash('sha256').update(text).digest('hex') + '\n'
    );
  }
);

Given(
  'the copy on worker {string} was edited to {string}',
  (world, worker: string, text: string) => {
    writeFileSync(copy(world, worker), text);
  }
);

When(
  /^converge runs for revision "([a-f0-9]{40})" on worker "([^"]+)" only$/,
  (world, revision: string, worker: string) => {
    const manager = world.manager();
    const run = () =>
      managerSync(
        { revision, node: [worker], json: true, nonInteractive: true },
        { workspace: '/no-checkout', config: STATE_ROSTER },
        {
          run: manager.run,
          root: join(manager.home, 'manager'),
          home: manager.home,
          restart: run,
        }
      );
    return world.attempt(run);
  }
);

Given('worker {string} does not answer SSH', (world, worker: string) => {
  fleetWorkers(world).answers.set(worker, false);
});

Then(
  'the copy on worker {string} still holds {string}',
  (world, worker: string, text: string) => {
    expect(readFileSync(copy(world, worker), 'utf8')).toBe(text);
  }
);

Then(
  'these workers were asked about their copy:',
  (world, table: DataTable) => {
    expect(
      fleetWorkers(world)
        .asked.filter(({ command }) =>
          command.includes('fleet-configuration-copy')
        )
        .map(({ worker }) => worker)
        .sort()
    ).toEqual(table.hashes().map((row) => row['worker']!));
  }
);

Then('no worker was asked anything else', (world) => {
  expect(
    fleetWorkers(world).asked.filter(
      ({ command }) => !command.includes('fleet-configuration-copy')
    )
  ).toEqual([]);
});

Then(
  'the report gives worker {string} the check {string} with the remedy the bootstrap prints for {string}',
  (world, worker: string, id: string, code: string) => {
    const script = readFileSync(SCRIPT, 'utf8');
    const printed = spawnSync(
      '/bin/sh',
      [
        '-c',
        `${script.slice(script.indexOf('remedy() {'), script.indexOf('# failure-report: end'))}\nremedy ${code}`,
      ],
      { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 20_000 }
    ).stdout.trim();
    expect(printed).not.toBe('');
    const report = world.outcome<{ data: unknown }>().data as {
      nodes: { node: string; checks: unknown[] }[];
    };
    expect(report.nodes.find((node) => node.node === worker)?.checks).toEqual([
      { id, status: 'fail', summary: code, remedy: { action: printed } },
    ]);
  }
);

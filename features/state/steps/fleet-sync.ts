import { expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandOutcome } from '../../../src/cli/contracts';
import { managerSync, type ManagerSync } from '../../../src/cli/fleet-sync';
import { parseDefinition } from '../../../src/definition';
import { fleet, reloadFleet } from '../../../src/fleet-config';
import { loadEnrollment } from '../../../src/state/enrollment';
import {
  SELECTED_BY_ENV,
  selectionText,
} from '../../../src/revision-selection';
import { parseBucket, writeBucket } from '../../../src/state/bucket';
import { STATE_ROSTER } from '../../../src/state/roster';
import { readDocument } from '../../../src/state/store';
import type { Runner } from '../../../src/types';
import {
  STATE,
  WHO,
  act,
  json,
  phrase,
  scratch,
  state,
  type StateWorld,
} from './world';

const { Given, When, Then } = state;

const sync = scratch<{
  /** How often a run started over after its state was replaced. */
  restarts: number;
  /** The enrollment document as the last run found it. */
  enrollmentBefore: string | null;
  /** The revisions the default branch of the source repository lacks. */
  unmerged: Set<string>;
  /** Whether the source repository answers a fetch. */
  reachable: boolean;
}>(() => ({
  restarts: 0,
  enrollmentBefore: null,
  unmerged: new Set(),
  reachable: true,
}));

/** Git on the manager, as far as fleet-sync asks it here: its own copy of
 * the fleet's source repository, whose default branch holds every revision
 * but the ones a scenario names. Anything else Git is asked fails, as it
 * does where there is no checkout.
 */
function git(world: StateWorld, argv: string[]) {
  const answer = (ok: boolean, stdout = '') => ({
    ok,
    stdout,
    stderr: '',
    reason: 'exit' as const,
  });
  const { unmerged, reachable } = sync(world);
  if (argv[1] === 'remote') return answer(true, `${fleet.source.repository}\n`);
  if (argv[1] === 'merge-base') return answer(!unmerged.has(argv[3]!));
  if (argv[1] === 'fetch') return answer(reachable);
  if (argv[1] === 'rev-parse' && argv.includes('--quiet')) return answer(true);
  return answer(false);
}

Given('fleet-sync runs on a manager with no worker enrolled', (world) => {
  const manager = world.manager();
  world.bind(manager);
  // Litestream answers, and Git about the manager's copy of the source
  // repository; every other command is absent, as on a bare machine.
  const run: Runner = (argv, options) => {
    if (argv[0] === 'mise' || argv[0] === '/pinned/litestream')
      return world.litestream.run(argv, options);
    if (argv[0] === 'git') return Promise.resolve(git(world, argv));
    return Promise.resolve({
      ok: false,
      stdout: '',
      stderr: '',
      reason: 'missing',
    });
  };
  manager.run = run;
});

Given(
  /^the default branch of the source repository does not hold revision "([a-f0-9]{40})"$/,
  (world, revision: string) => {
    sync(world).unmerged.add(revision);
  }
);

Given('the source repository cannot be fetched', (world) => {
  sync(world).reachable = false;
});

Given(
  /^the process runs from the fleet-owned checkout of revision "([a-f0-9]{40})", told "([^"]+)"$/,
  (world, revision: string, told: string) => {
    world.setEnv('PERSONAL_FLEET_RUN_CHECKOUT', revision);
    world.setEnv(SELECTED_BY_ENV, told);
  }
);

Given('the process is told {string}', (world, told: string) => {
  world.setEnv(SELECTED_BY_ENV, told);
});

Given(
  phrase(WHO, ' saved the bucket "([^"]+)" in its bucket\\.json'),
  (world, name: string | undefined, directory: string) => {
    const manager = world.manager(name);
    manager.bucket = parseBucket({
      directory: world.expand(directory, manager),
    });
    writeBucket(manager.bucketFile, manager.bucket);
  }
);

Given(
  phrase('the process runs with the fleet\\.json "([^"]+)"'),
  (world, path: string) => {
    world.setEnv('DEVFLEET_CONFIG', world.expand(path, world.manager()));
    reloadFleet();
  }
);

/** fleet-sync on the manager this process is bound to. A run whose state was
 * replaced under it starts the same request over.
 */
function run(
  world: StateWorld,
  request: {
    revision?: string;
    dryRun?: boolean;
    rollback?: boolean;
    allowUnmerged?: boolean;
  }
): Promise<CommandOutcome> {
  const manager = world.manager();
  const settings = { workspace: '/no-checkout', config: STATE_ROSTER };
  const options = { ...request, json: true, nonInteractive: true };
  sync(world).enrollmentBefore = readDocument(manager.database, 'enrollment');
  const services: ManagerSync = {
    run: manager.run,
    root: join(manager.home, 'manager'),
    home: manager.home,
    restart: () => {
      sync(world).restarts += 1;
      return managerSync(options, settings, services);
    },
  };
  return managerSync(options, settings, services);
}

Given(
  /^fleet-sync (runs|ran) for revision "([a-f0-9]{40})"( with --allow-unmerged)?$/,
  (world, verb: string, revision: string, allowed: string | undefined) =>
    act(world, verb, () =>
      run(world, { revision, ...(allowed ? { allowUnmerged: true } : {}) })
    )
);
When(
  /^fleet-sync previews revision "([a-f0-9]{40})"$/,
  (world, revision: string) =>
    world.attempt(() => run(world, { revision, dryRun: true }))
);

When(/^fleet-sync rolls back( with --allow-unmerged)?$/, (world, allowed) =>
  world.attempt(() =>
    run(world, { rollback: true, ...(allowed ? { allowUnmerged: true } : {}) })
  )
);

Then(
  'the fleet state says the approved revision was selected by {string}',
  async (world, text: string) => {
    const enrollment = await loadEnrollment(null, world.manager().stateEnv);
    expect(
      enrollment?.selectedBy ? selectionText(enrollment.selectedBy) : null
    ).toBe(text);
  }
);

Then('the run started over {int} time(s)', (world, count: number) => {
  expect(sync(world).restarts).toBe(count);
});

Then(
  phrase('the enrollment in ', STATE, ' is what it was before the run'),
  (world, name: string | undefined) => {
    expect(readDocument(world.manager(name).database, 'enrollment')).toBe(
      sync(world).enrollmentBefore
    );
  }
);

Then(
  phrase(
    STATE,
    ' holds the configuration that "([^"]+)" on ',
    WHO,
    ' declares'
  ),
  (
    world,
    holder: string | undefined,
    path: string,
    name: string | undefined
  ) => {
    const declared = json(
      readFileSync(world.expand(path, world.manager(name)), 'utf8')
    );
    expect(
      json(readDocument(world.manager(holder).database, 'definition')!)
    ).toEqual(parseDefinition(declared));
  }
);

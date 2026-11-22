import { expect } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildImage } from '../fresh-box/support/image';
import type { DataTable } from '../support/gherkin';
import { rules, type RulesWorld } from './steps';

const { Given, When, Then } = rules;
const root = resolve(import.meta.dir, '../..');

/** One build of the image, answered by the scenario. */
interface Build {
  failures: number;
  attempts: number;
  pauses: number[];
  failure?: Error;
}
const builds = new WeakMap<RulesWorld, Build>();
const build = (world: RulesWorld): Build => {
  const found = builds.get(world);
  if (!found) throw new Error('No image build in this scenario.');
  return found;
};

Given('the build of the image fails {int} times', (world, failures: number) => {
  builds.set(world, { failures, attempts: 0, pauses: [] });
});

When('the image of the fresh machines is built', async (world) => {
  const state = build(world);
  try {
    await buildImage(
      async () => (state.attempts += 1) > state.failures,
      async (ms) => void state.pauses.push(ms)
    );
  } catch (error) {
    state.failure = error as Error;
  }
});

Then('the build was tried {int} times', (world, attempts: number) => {
  expect(build(world).attempts).toBe(attempts);
});

Then(/^the image (was built|was not built)$/, (world, outcome: string) => {
  expect(build(world).failure === undefined).toBe(outcome === 'was built');
});

Then(
  'it paused for these seconds between the attempts:',
  (world, table: DataTable) => {
    expect(build(world).pauses.map((ms) => ms / 1000)).toEqual(
      table.raw().map(([seconds]) => Number(seconds))
    );
  }
);

Then('the failure says {string}', (world, message: string) => {
  expect(build(world).failure?.message).toBe(message);
});

When('the file {string} is read', async (world, path: string) => {
  world.script = await readFile(resolve(root, path), 'utf8');
});

Then(
  'it builds the image of the fresh machines before every scenario',
  (world) => {
    expect(world.script).toMatch(/beforeAll\(\s*\(\) => freshImage\(\)/);
  }
);

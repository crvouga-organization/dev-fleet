import { expect } from 'bun:test';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { managerClientSettings } from '../../../src/state/t3-client-settings';
import { databasePath } from '../../../src/state/paths';
import { readDocument, writeDocument } from '../../../src/state/store';
import { installClientSettings } from '../../../src/t3/client-settings';
import type { PackagePlaybook } from '../../../src/platform/ansible';
import { succeeded } from '../../support/commands';
import { ide } from './world';

const { Given, When, Then } = ide;
const play: PackagePlaybook = async (name, vars) => {
  expect(name).toBe('t3-client-settings.yml');
  const { client_path, client_source } = vars as {
    client_path: string;
    client_source: string;
  };
  await copyFile(client_source, client_path);
  return succeeded();
};

Given(
  /^the (manager|worker)'s T3 client settings file holds:$/,
  async (world, machine: string, raw: string) => {
    await writeFile(join(world.t3Home, machine), raw);
  }
);

Given(
  'the fleet state holds these client preferences:',
  (world, raw: string) => {
    writeDocument(databasePath(world.t3Home), 't3-client-settings', raw);
  }
);

When(
  "the manager's preferences are captured and installed on the worker",
  async (world) => {
    try {
      const document = await managerClientSettings(
        { root: world.t3Home, bucket: null, run: world.run },
        join(world.t3Home, 'manager'),
        play
      );
      await installClientSettings(
        document,
        join(world.t3Home, 'worker'),
        true,
        play
      );
    } catch (error) {
      world.refusal = error;
    }
  }
);

Then(
  /^the (manager|worker)'s client preferences are:$/,
  async (world, machine: string, raw: string) => {
    expect(
      JSON.parse(await readFile(join(world.t3Home, machine), 'utf8'))
    ).toEqual(JSON.parse(raw));
  }
);

Then('the fleet state holds the same client preferences', async (world) => {
  expect(
    JSON.parse(readDocument(databasePath(world.t3Home), 't3-client-settings')!)
  ).toEqual(JSON.parse(await readFile(join(world.t3Home, 'worker'), 'utf8')));
});

Then('the saved client preferences are:', (world, raw: string) => {
  expect(
    JSON.parse(readDocument(databasePath(world.t3Home), 't3-client-settings')!)
  ).toEqual(JSON.parse(raw));
});

Then('the snapshot is refused', (world) => {
  expect(world.refusal).toBeInstanceOf(Error);
});

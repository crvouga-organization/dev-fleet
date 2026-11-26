import { expect } from 'bun:test';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ide, type IdeWorld } from './world';
import { succeeded } from '../../support/commands';
import type { DataTable } from '../../support/gherkin';
import type { PackagePlaybook } from '../../../src/platform/ansible';
import { managerCustomizations } from '../../../src/state/t3-customizations';
import {
  captureCustomizations,
  installCustomizations,
  withCustomizations,
} from '../../../src/t3/customizations';
import { readDocument } from '../../../src/state/store';
import { databasePath } from '../../../src/state/paths';
const { Given, When, Then } = ide;
const play: PackagePlaybook = async (name, vars) => {
  expect(name).toBe('t3/customizations.yml');
  const {
    userdata,
    customization_source,
    changed_files,
    removed_files,
    manager_marker,
    marker_body,
  } = vars as {
    userdata: string;
    customization_source: string;
    changed_files: string[];
    removed_files: string[];
    manager_marker: string;
    marker_body: string;
  };
  await mkdir(join(userdata, 'themes'), { recursive: true });
  for (const file of changed_files)
    await copyFile(join(customization_source, file), join(userdata, file));
  for (const file of removed_files) await rm(join(userdata, file));
  if (manager_marker) await writeFile(manager_marker, marker_body);
  return succeeded();
};
const context = (world: IdeWorld) => ({
  run: world.run,
  root: world.t3Home,
  bucket: null,
});
async function sync(world: IdeWorld, apply = play) {
  const files = await managerCustomizations(
    context(world),
    join(world.t3Home, 'manager'),
    apply
  );
  await withCustomizations(files, world.run, (stage) =>
    installCustomizations(
      files,
      stage,
      { userdata: join(world.t3Home, 'worker') },
      apply
    )
  );
}
Given(
  'the manager has these T3 customization files:',
  async (world, table: DataTable) => {
    for (const row of table.hashes()) {
      const path = join(world.t3Home, 'manager', row['file']!);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, row['content']!);
    }
  }
);
Given('the native theme reader lists {string}', (world, ids: string) => {
  world.commands.answer(
    'theme show --base-dir',
    succeeded('Environment theme: not set.\n\nPublished themes: ' + ids + '.\n')
  );
});
Given('the manager has already synced those customizations', async (world) => {
  await sync(world);
});
When(
  'the manager syncs its customizations twice and a replacement manager recovers them',
  async (world) => {
    await sync(world);
    let writes = 0;
    await sync(world, async (...args) => {
      writes++;
      return play(...args);
    });
    world.result = writes;
    await managerCustomizations(
      context(world),
      join(world.t3Home, 'replacement'),
      play
    );
  }
);
Then(
  'the worker and replacement manager have the original customizations',
  async (world) => {
    const original = await captureCustomizations(join(world.t3Home, 'manager'));
    for (const machine of ['worker', 'replacement'])
      expect(await captureCustomizations(join(world.t3Home, machine))).toEqual(
        original
      );
  }
);
Then('the second sync makes no customization writes', (world) =>
  expect(world.result).toBe(0)
);
When(
  'the manager removes {string} and syncs again',
  async (world, file: string) => {
    await rm(join(world.t3Home, 'manager', file));
    await sync(world);
  }
);
Then('the worker lacks {string}', async (world, file: string) => {
  expect(await Bun.file(join(world.t3Home, 'worker', file)).exists()).toBe(
    false
  );
});
Then(
  'the worker file {string} contains {string}',
  async (world, file: string, body: string) => {
    expect(await readFile(join(world.t3Home, 'worker', file), 'utf8')).toBe(
      body
    );
  }
);
When('the manager tries to sync its customizations', async (world) => {
  try {
    await sync(world);
  } catch (error) {
    world.refusal = error;
  }
});
Then(
  'the saved customization snapshot still matches the worker',
  async (world) => {
    expect(
      JSON.parse(readDocument(databasePath(world.t3Home), 't3-customizations')!)
    ).toEqual(await captureCustomizations(join(world.t3Home, 'worker')));
  }
);

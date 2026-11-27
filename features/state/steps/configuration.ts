import { expect } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDefinition, type FleetDefinition } from '../../../src/definition';
import {
  configPath,
  definitionSource,
  fleet,
  fleetJson,
  installConfig,
  reloadFleet,
} from '../../../src/fleet-config';
import { actAsOperator, isOperator } from '../../../src/state/operator';
import { databasePath } from '../../../src/state/paths';
import { readDocument, writeDocument } from '../../../src/state/store';
import { exampleFleet } from './common';
import { EXAMPLE, WHO, act, phrase, state } from './world';

const { Given, When, Then } = state;

/** The example fleet as the configuration it is read as. */
const example = (): FleetDefinition => parseDefinition(exampleFleet());

// ── The configuration of this process ────────────────────────────────────

Then('the configuration names the manager the example fleet names', () => {
  expect(fleet.manager.id).toBe(example().manager.id);
});
Then('the configuration has the keys of the example fleet, in order', () => {
  expect(Object.keys(fleet)).toEqual(Object.keys(example()));
});
Then('the configuration has a {string} key', (_world, key: string) => {
  expect(key in fleet).toBe(true);
});
Then('the configuration prints as the JSON of the example fleet', () => {
  expect(JSON.stringify(fleet, null, 2)).toBe(
    JSON.stringify(example(), null, 2)
  );
});
Then('a copy of the configuration equals the example fleet', () => {
  expect({ ...fleet }).toEqual(example());
});

Given('the process is pointed at a fleet.json that does not exist', (world) => {
  world.setEnv('HOMELAB_CONFIG', join(world.root, 'absent.json'));
  reloadFleet();
});

When('the manager is read from the configuration', (world) =>
  world.attempt(() => fleet.manager)
);
Given('reading the manager from the configuration was refused', () => {
  expect(() => fleet.manager).toThrow();
});

Given(
  /^the example fleet (is|was) written there with "([^"]+)" renamed "([^"]+)"$/,
  (_world, _verb: string, from: string, to: string) => {
    writeFileSync(
      process.env['HOMELAB_CONFIG']!,
      readFileSync(EXAMPLE, 'utf8').replaceAll(from, to)
    );
  }
);

Then(
  /^the configuration (?:names|named) the manager "([^"]+)"$/,
  (_world, id: string) => {
    expect(fleet.manager.id).toBe(id);
  }
);

When(
  'the process is pointed back at the example fleet and forgets what it read',
  () => {
    process.env['HOMELAB_CONFIG'] = EXAMPLE;
    reloadFleet();
  }
);

// ── Where a command on a manager reads its configuration from ────────────

Given(
  'the fleet state holds the example fleet as its configuration',
  (world) => {
    writeDocument(
      world.manager().database,
      'definition',
      readFileSync(EXAMPLE, 'utf8')
    );
  }
);

Given('the process is the homelab CLI', (world) => {
  actAsOperator((root) => readDocument(databasePath(root), 'definition'));
  world.defer(() => actAsOperator(null));
});
Given('the process is passed no fleet.json of its own', (world) => {
  const before = process.env['HOMELAB_CONFIG'];
  delete process.env['HOMELAB_CONFIG'];
  reloadFleet();
  world.defer(() => {
    if (before === undefined) delete process.env['HOMELAB_CONFIG'];
    else process.env['HOMELAB_CONFIG'] = before;
    reloadFleet();
  });
});
Then('the process is not the homelab CLI', () => {
  expect(isOperator()).toBe(false);
});

const KIND: Record<string, string> = {
  'the installed copy': 'installed',
  'an installed copy': 'installed',
  'the file': 'file',
  'a file': 'file',
  'the fleet state as': 'state',
  'the fleet state': 'state',
};

Then(
  phrase(
    'a command on ',
    WHO,
    ' takes its configuration from (the installed copy|the file|the fleet state as) "([^"]+)"'
  ),
  (world, name: string | undefined, from: string, path: string) => {
    const manager = world.manager(name);
    expect(definitionSource(manager.env, manager.home)).toEqual({
      kind: KIND[from] as never,
      path: world.expand(path, manager),
    });
  }
);
Then(
  phrase(
    'a command on ',
    WHO,
    ' takes its configuration from (an installed copy|a file|the fleet state)'
  ),
  (world, name: string | undefined, from: string) => {
    const manager = world.manager(name);
    expect(definitionSource(manager.env, manager.home).kind).toBe(
      KIND[from] as never
    );
  }
);

When(
  phrase('a command on ', WHO, ' asks for the path of its configuration'),
  (world, name: string | undefined) => {
    const manager = world.manager(name);
    return world.attempt(() => configPath(manager.env, manager.home));
  }
);
Then('the path is {string}', (world, path: string) => {
  expect(world.outcome<string>()).toBe(world.expand(path, world.manager()));
});
Then(
  phrase('commands on ', WHO, ' are now passed HOMELAB_CONFIG "([^"]+)"'),
  (world, name: string | undefined, path: string) => {
    const manager = world.manager(name);
    expect(manager.env['HOMELAB_CONFIG']).toBe(world.expand(path, manager));
  }
);

// ── How a remedy names fleet.json ────────────────────────────────────────

Then(
  phrase('a remedy on ', WHO, ' names "([^"]+)"'),
  (world, name: string | undefined, text: string) => {
    const manager = world.manager(name);
    expect(fleetJson(manager.env, manager.home)).toBe(
      text.replace('(~/', `(${manager.home}/`)
    );
  }
);
Then(
  phrase(
    'a remedy on ',
    WHO,
    ' names the project the fleet is synced from, and not the copy at "([^"]+)"'
  ),
  (world, name: string | undefined, path: string) => {
    const manager = world.manager(name);
    expect(fleetJson(manager.env, manager.home)).toBe(
      `fleet.json (the one in the project the fleet is synced from, on the manager; not ${world.expand(path, manager)}, the copy fleet-sync installs from it)`
    );
  }
);

// ── The copy fleet-sync installs ─────────────────────────────────────────

Given(
  phrase('fleet-sync (installs|installed) the configuration on ', WHO),
  (world, verb: string, name: string | undefined) =>
    act(world, verb, () => installConfig(world.manager(name).home))
);
Then(/^the copy was (written|left as it was)$/, (world, what: string) => {
  expect(world.outcome<boolean>()).toBe(what === 'written');
});

// ── The probe ────────────────────────────────────────────────────────────

When('the probe workers run is bundled', (world) =>
  world.attempt(async () => {
    const { bundleProbe } = await import('../../../src/transport');
    return bundleProbe();
  })
);
Then('the bundle does not contain {string}', (world, text: string) => {
  expect(world.outcome<string>()).not.toContain(text);
});

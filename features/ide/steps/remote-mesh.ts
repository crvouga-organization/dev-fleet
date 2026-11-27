import { expect } from 'bun:test';
import type { DataTable } from '../../support/gherkin';
import { failed, succeeded } from '../../support/commands';
import type {
  MachineDefinition,
  ManagerDefinition,
} from '../../../src/definition';
import {
  meshMembers,
  meshOf,
  ORCA,
  PARADEV,
} from '../../../src/ide/remote-mesh';
import type { CommandResult, FleetNode } from '../../../src/types';
import { ide, type IdeWorld } from './world';

const { Given, When, Then } = ide;

interface Mesh {
  workers: MachineDefinition[];
  manager: ManagerDefinition;
}
const meshes = new WeakMap<IdeWorld, Mesh>();
const of = (world: IdeWorld): Mesh => {
  let value = meshes.get(world);
  if (!value) {
    value = {
      manager: {
        id: 'manager-mac',
        os: 'macOS',
        network: {
          tailscaleName: 'manager-mac.example.ts.net',
          user: 'dev',
        },
        neverSleepOnPower: true,
      },
      workers: [],
    };
    meshes.set(world, value);
  }
  return value;
};

const json = (value: unknown): CommandResult =>
  succeeded(JSON.stringify(value));

Given(
  'the remote mesh has a manager {string} and workers {string} and {string}',
  (world, manager: string, one: string, two: string) => {
    const state = of(world);
    state.manager = { ...state.manager, id: manager };
    state.workers = [one, two].map(
      (id) =>
        ({
          id,
          ssh: id,
          os: 'linux',
          network: {
            tailscaleName: `${id}.example.ts.net`,
            user: 'dev',
            sshPort: 22,
            t3Port: 3773,
          },
        }) as MachineDefinition
    );
    world.commands.otherwise = json({ ok: true });
  }
);

function commandOf(command: string[]): string {
  return command[0] === 'ssh' ? command.at(-1)! : command.join(' ');
}

/** What the manager's own Orca lists. A worker lists nothing until a step says so. */
function orcaLists(world: IdeWorld, hosts: Record<string, string>[]): void {
  world.commands.answer(
    (command) => command[0] === 'orca' && command[1] === 'status',
    json({ ok: true })
  );
  world.commands.answer(
    (command) =>
      command[0] === 'orca' && command.join(' ').includes('host list'),
    json({ hosts })
  );
  world.commands.answer((command) => command[0] === 'ssh', json({ hosts: [] }));
}

Given('orca on the manager lists these hosts:', (world, table: DataTable) => {
  orcaLists(world, table.hashes());
});

Given('orca on the manager lists no host', (world) => {
  orcaLists(world, []);
});

Given(
  'paradev on the manager is signed in and its host is running',
  (world) => {
    world.commands.answer(
      (command) => commandOf(command).includes('auth whoami'),
      json({ userId: 'user', organizationId: 'org' })
    );
    world.commands.answer(
      (command) => commandOf(command).includes('paradev status'),
      json({ running: true, hostId: 'host', organizationId: 'org' })
    );
  }
);

Given('paradev on the manager is not signed in', (world) => {
  world.commands.answer(
    (command) => command.join(' ').startsWith('paradev status'),
    json({ running: false })
  );
  world.commands.answer(
    (command) => command.join(' ').includes('auth whoami'),
    { ...failed(), stdout: JSON.stringify({ code: 'UNAUTHENTICATED' }) }
  );
});

Given('paradev on the manager lists no host', (world) => {
  world.commands.answer(
    (command) => command[0] === 'ssh',
    (command) => {
      const line = commandOf(command);
      if (line.includes('hosts list')) return json({ hosts: [] });
      if (line.includes('hosts add'))
        return json({
          hostId: 'added',
          name: 'worker',
          credential: 'signed-in',
        });
      if (line.includes('paradev status'))
        return json({ running: true, hostId: 'host', organizationId: 'org' });
      return json({ ok: true });
    }
  );
  world.commands.answer(
    (command) =>
      command[0] === 'paradev' && command.join(' ').includes('hosts list'),
    json({ hosts: [] })
  );
  world.commands.answer(
    (command) =>
      command[0] === 'paradev' && command.join(' ').includes('hosts add'),
    json({ hostId: 'added', name: 'worker', credential: 'signed-in' })
  );
});

Given(
  'paradev on the manager lists these hosts:',
  (world, table: DataTable) => {
    const hosts = json({ hosts: table.hashes() });
    world.commands.answer(
      (command) =>
        command[0] === 'paradev' && command.join(' ').includes('hosts list'),
      hosts
    );
    world.commands.answer(
      (command) => command[0] === 'ssh',
      (command) => {
        const line = commandOf(command);
        if (line.includes('hosts list')) return hosts;
        if (line.includes('paradev status'))
          return json({ running: true, hostId: 'host', organizationId: 'org' });
        return json({ ok: true });
      }
    );
  }
);

Given('paradev hosts add prints {string}', (world, secret: string) => {
  world.commands.answer((command) => commandOf(command).includes('hosts add'), {
    ...failed(),
    stdout: secret,
    stderr: '',
  });
});

function nodes(world: IdeWorld): FleetNode[] {
  return of(world).workers.map((worker) => ({
    id: worker.id,
    ssh: worker.ssh ?? worker.id,
    workspace: '/home/dev/fleet',
    required: [],
  }));
}

async function measure(
  world: IdeWorld,
  id: 'orca' | 'paradev',
  apply: boolean
) {
  const state = of(world);
  const fleet = meshMembers(state.manager, state.workers, nodes(world));
  world.checks = await meshOf({
    spec: id === 'orca' ? ORCA : PARADEV,
    manager: fleet.manager,
    workers: fleet.workers,
    run: world.run,
    apply,
  });
}

When('the orca mesh is applied', (world) => measure(world, 'orca', true));
When('the orca mesh is previewed', (world) => measure(world, 'orca', false));
When('the paradev mesh is applied', (world) => measure(world, 'paradev', true));

Then('a command contains {string}', (world, text: string) => {
  const lines = world.commands.calls.map((call) => call.command.join(' '));
  expect(lines.some((line) => line.includes(text))).toBe(true);
});

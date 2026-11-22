import { expect } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import type { DataTable } from '../../support/gherkin';
import { succeeded } from '../../support/commands';
import { managerHealth } from '../../../src/manager-health';
import { inspectBootstrap } from '../../../src/manager-sync';
import { NODE } from '../../support/fixtures';
import { parseTailnet, keyExpiryCheck } from '../../../src/tailscale';
import { workerCapacity } from '../../../src/worker-capacity';
import { rebootPendingCheck } from '../../../src/worker-host-checks';
import type { Check } from '../../../src/types';
import { core, need, root, type CoreWorld } from './world';

/** The health of a machine itself: its disk, its clock, its pending reboot,
 * its Tailscale key and, on the manager, its operating system.
 */
const { Given, When, Then } = core;

function reported(world: CoreWorld, checks: Check[]): void {
  world.checks = checks;
  world.outcome = checks;
}

When('the capacity of the worker is checked', async (world) => {
  reported(world, await workerCapacity(root, 'worker-a', world.commands.run));
});

When(
  /^the capacity of the worker is checked against the manager's clock at (\d+)$/,
  async (world, reference: string) => {
    reported(
      world,
      await workerCapacity(
        root,
        'worker-a',
        world.commands.run,
        Number(reference)
      )
    );
  }
);

When(
  /^the pending reboot of the worker is checked on "([^"]+)"$/,
  async (world, date: string) => {
    reported(world, [
      await rebootPendingCheck(true, world.commands.run, Date.parse(date)),
    ]);
  }
);

When('a worker with no pending reboot is checked', async (world) => {
  reported(world, [await rebootPendingCheck(false, world.commands.run)]);
});

When(
  'the Tailscale key of the computer {string} is checked on {string}',
  (world, id: string, date: string) => {
    const tailnet = parseTailnet(
      need(world, world.tailscale, 'a status of Tailscale')
    );
    reported(world, [
      keyExpiryCheck(
        tailnet.computers.find((computer) => computer.id === id),
        Date.parse(date)
      ),
    ]);
  }
);

When(
  /^the manager inspects the worker, its own clock reading (\d+) when it sends the probe and (\d+) when the answer comes back$/,
  async (world, sent: string, received: string) => {
    const readings = [Number(sent) * 1000, Number(received) * 1000];
    reported(
      world,
      await inspectBootstrap(NODE, world.commands.run, () => readings.shift()!)
    );
  }
);

When('the health of the manager is checked', async (world) => {
  // The manager's user is "dev" (uid 501), whose home is /Users/dev here.
  reported(
    world,
    await managerHealth(world.commands.run, '/Users/dev', {
      uid: 501,
      user: 'dev',
    })
  );
});

core.Then('the check {string} has a remedy', (world, id: string) => {
  const check = world.checks.find((entry) => entry.id === id);
  if (!check?.remedy?.action) throw new Error(`${id} has no remedy.`);
});

// ── The container watchdog ───────────────────────────────────────────────

const watchdog = new WeakMap<
  CoreWorld,
  { memory: Record<string, { capped: number | null }>; restart: string[][] }
>();

/** The watchdog's own decision, from its own module, run once per sample. */
const DECIDE = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('watchdog', sys.argv[1])
watchdog = importlib.util.module_from_spec(spec); spec.loader.exec_module(watchdog)
memory = {'proxy': {'unhealthy': 0, 'restarts': [1000.0 - 60 * i for i in range(int(sys.argv[3]))], 'capped': None}}
restart = []
for status in sys.argv[2].split(', '):
    memory, started = watchdog.decide(memory, {'proxy': status}, 1000.0, 3, 3)
    restart += started
print(json.dumps({'memory': memory, 'restart': restart}))`;

core.When(
  /^the watchdog has seen the container "proxy" as (.+), having restarted it (\d+) times in the last hour$/,
  (world, seen: string, restarts: string) => {
    const out = Bun.spawnSync([
      'python3',
      '-I',
      '-B',
      '-c',
      DECIDE,
      join(root, 'ansible/monitoring/container-watchdog.py'),
      seen,
      restarts,
    ]);
    if (out.exitCode !== 0) throw new Error(out.stderr.toString());
    watchdog.set(world, JSON.parse(out.stdout.toString()));
  }
);

core.Then(
  'the watchdog restarts {string}, {string}',
  (world, name: string, reason: string) => {
    const decided = watchdog.get(world)!;
    expect(decided.restart).toEqual([[name, reason]]);
    expect(decided.memory['proxy']!.capped).toBeNull();
  }
);

core.Then(
  /^the watchdog restarts nothing( and caps "proxy")?$/,
  (world, caps) => {
    const decided = watchdog.get(world)!;
    expect(decided.restart).toEqual([]);
    expect(decided.memory['proxy']!.capped !== null).toBe(Boolean(caps));
  }
);

core.Given(
  'the container watchdog remembers {string}, where NOW is the time now',
  (world, memory: string) => {
    world.commands.answer(
      (argv) => argv[0] === 'cat',
      () => succeeded(memory.replaceAll('NOW', String(Date.now() / 1000)))
    );
  }
);

// ── The capacity probe itself, against a cgroup tree of the scenario ─────

/** The cgroup tree each scenario's worker has, in place of the kernel's. */
const cgroups = new WeakMap<CoreWorld, string>();

/** A cgroup tree that holds this user's manager and nothing in it. */
function userManager(world: CoreWorld): string {
  const tree = mkdtempSync(join(tmpdir(), 'devfleet-cgroup-'));
  world.defer(() => rmSync(tree, { recursive: true, force: true }));
  cgroups.set(world, tree);
  const { uid } = userInfo();
  const manager = join(
    tree,
    `user.slice/user-${uid}.slice/user@${uid}.service`
  );
  mkdirSync(manager, { recursive: true });
  return manager;
}

Given('T3 Code runs no scope on a worker', (world) => {
  userManager(world);
});

Given('T3 Code runs these scopes on a worker:', (world, table: DataTable) => {
  // Where T3 Code starts things: terminals and what outlives a restart
  // beside the slice it owns for its state directory, the rest inside it.
  const agents = join(
    userManager(world),
    'app.slice/app-t3code.slice/app-t3code-agents.slice'
  );
  const slices: Record<string, string> = {
    beside: agents,
    owned: join(agents, 'app-t3code-agents-18b8ec851b3f.slice'),
  };
  for (const row of table.hashes()) {
    const scope = join(
      need(world, slices[row['slice']!], 'a slice'),
      row['scope']!
    );
    mkdirSync(scope, { recursive: true });
    writeFileSync(
      join(scope, 'memory.peak'),
      `${Number(row['peak MiB']) * 1024 * 1024}\n`
    );
  }
});

When('the capacity probe reads that worker', async (world) => {
  const probe = Bun.spawn(['sh', join(root, 'ansible/net/remote-probe.sh')], {
    env: {
      ...process.env,
      DEVFLEET_PROBE_CGROUP: need(world, cgroups.get(world), 'a cgroup tree'),
    },
    stdout: 'pipe',
    stderr: 'ignore',
  });
  world.text = await new Response(probe.stdout).text();
  await probe.exited;
});

Then('the capacity probe prints these lines:', (world, table: DataTable) => {
  const printed = need(world, world.text, 'what the probe printed').split('\n');
  for (const line of table.list()) expect(printed).toContain(line);
});

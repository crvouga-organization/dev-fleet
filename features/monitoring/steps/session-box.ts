import { expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { nativeT3Artifact } from '../../../bootstrap/native-t3';
import { runCommand } from '../../../src/runner';
import { agentBox, must, on } from './agent-box';
import { monitoring, type MonitoringWorld } from './world';

const { Given, When, Then } = monitoring;

const root = resolve(import.meta.dir, '../../..');
const FLEET = '/fleet';
const SUPPORT = `${FLEET}/features/monitoring/support/session-box`;
const UBUNTU = `${FLEET}/ansible/ubuntu`;
const USER = 'ubuntu';
const UID = 1000;
const HOME = `/home/${USER}`;
const RUNTIME = `/run/user/${UID}`;
const MANAGER = `user@${UID}.service`;
const PROJECT = `${HOME}/project`;
const T3 = '/opt/t3/t3';
const UNIT = 'personal-fleet-agent-session-limit.service';
const AGENTS = 'app.slice/app-t3code.slice/app-t3code-agents.slice';
const PROVIDERS = {
  'through the fleet launcher': { id: 'box_fleet', started: 'fleet' },
  directly: { id: 'box_plain', started: 'plain' },
} as const;
type Way = keyof typeof PROVIDERS;
const WAY = '(through the fleet launcher|directly)';

/** What a scenario learned from T3 about the last session it started. */
interface Session {
  /** A model T3 lists for the stand-in providers. */
  model: string;
  thread?: string;
  /** What the baseline's tasks last applied. */
  limit: number;
}
const sessions = new WeakMap<MonitoringWorld, Session>();
let model: string | undefined;

/** A command on the machine as the worker's user, in its user manager. */
const asUser = (container: string, command: string, timeoutMs = 120_000) =>
  runCommand(
    [
      'docker',
      'exec',
      '-u',
      USER,
      '-w',
      HOME,
      '-e',
      `HOME=${HOME}`,
      '-e',
      `XDG_RUNTIME_DIR=${RUNTIME}`,
      container,
      'sh',
      '-c',
      command,
    ],
    { timeoutMs }
  );

async function until(
  what: string,
  done: () => Promise<boolean>,
  seconds = 90
): Promise<void> {
  for (let waited = 0; waited < seconds * 2; waited += 1) {
    if (await done()) return;
    await Bun.sleep(500);
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

/** The pinned T3 server archive, checked against its pin before it is used. */
async function pinnedServer(container: string): Promise<void> {
  const config = Bun.TOML.parse(
    await readFile(join(root, 'mise.toml'), 'utf8')
  ) as Parameters<typeof nativeT3Artifact>[0];
  const artifact = nativeT3Artifact(config, process.arch, 'linux');
  const scratch = await mkdtemp(join(tmpdir(), 'fleet-session-box-'));
  try {
    const response = await fetch(artifact.url, {
      signal: AbortSignal.timeout(300_000),
    });
    if (!response.ok) throw new Error('The pinned T3 server is unavailable.');
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      artifact.sha256
    );
    const archive = join(scratch, 't3.tar.gz');
    await writeFile(archive, bytes);
    await must(['docker', 'cp', archive, `${container}:/opt/t3.tar.gz`]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  const unpacked = await on(
    container,
    `tar -xzf /opt/t3.tar.gz -C /opt && rm /opt/t3.tar.gz && ln -sfn /opt/${artifact.name} /opt/t3 && ${T3} --version`
  );
  expect(unpacked.stdout.trim()).toBe(`t3 v${artifact.version}`);
}

/** The machine as a worker with a T3 server: the user's lingering manager,
 * the tracked playbook tasks and launcher code, and T3 with two providers. */
async function prepare(container: string): Promise<void> {
  expect((await on(container, `loginctl enable-linger ${USER}`)).ok).toBe(true);
  await until(
    'the user manager',
    async () => (await on(container, `test -S ${RUNTIME}/bus`)).ok
  );
  // What a worker's checkout holds of this, at the paths it holds it.
  expect(
    (
      await on(
        container,
        `mkdir -p ${UBUNTU} ${FLEET}/ansible/net ${FLEET}/src/agents ${SUPPORT} /etc/t3code ${PROJECT} /var/tmp/session-box ${HOME}/.config/systemd/user`
      )
    ).ok
  ).toBe(true);
  for (const [from, to] of [
    ['ansible/ubuntu/.', UBUNTU],
    ['ansible/net/remote-probe.sh', `${FLEET}/ansible/net/remote-probe.sh`],
    ['src/agent-session-limit.ts', `${FLEET}/src/agent-session-limit.ts`],
    ['src/agents/admission.ts', `${FLEET}/src/agents/admission.ts`],
    ['features/monitoring/support/session-box/.', SUPPORT],
    [process.execPath, '/usr/local/bin/bun'],
  ] as const)
    await must(['docker', 'cp', from, `${container}:${to}`]);
  expect(
    (
      await on(
        container,
        `cp ${SUPPORT}/limit.yml ${UBUNTU}/session-box-limit.yml && cp ${SUPPORT}/policy.json /etc/t3code/policy.json && cp ${SUPPORT}/t3code-headless.service ${HOME}/.config/systemd/user/ && chmod 0755 /usr/local/bin/bun && chown -R ${USER}:${USER} ${HOME} /var/tmp/session-box`
      )
    ).ok
  ).toBe(true);
  await pinnedServer(container);
  expect(
    (
      await asUser(
        container,
        'systemctl --user daemon-reload && systemctl --user start t3code-headless.service'
      )
    ).ok
  ).toBe(true);
  await ready(container);
  expect((await asUser(container, `${T3} project add ${PROJECT}`)).ok).toBe(
    true
  );
  // T3 names the models a provider lists when asked for one it does not.
  const listed = await asUser(
    container,
    `${T3} thread start --provider box_fleet --model fleet-session-box ${PROJECT} probe 2>&1`
  );
  model = /Advertised models: ([\w.-]+)/.exec(listed.stdout)?.[1];
  expect(model).toBeDefined();
}

const log = async (container: string) =>
  (
    await asUser(
      container,
      'journalctl --user -u t3code-headless.service --no-pager -o cat'
    )
  ).stdout;

/** How often this T3 unit has said it is ready: once for each start. */
const starts = async (container: string) =>
  (await log(container)).split('T3 Code server is ready').length - 1;

async function ready(container: string, after = 0): Promise<void> {
  await until('the T3 server', async () => (await starts(container)) > after);
}

const count = async (container: string, command: string) =>
  Number((await asUser(container, command)).stdout.trim());

const scopes = (container: string) =>
  count(
    container,
    "systemctl --user list-units 't3code-*.scope' --state=active --plain --no-legend | wc -l"
  );

/** Every agent scope T3 knows of, for a failure to show. */
const units = async (container: string) =>
  (
    await asUser(
      container,
      "systemctl --user list-units 't3code-*.scope' --all --plain --no-legend"
    )
  ).stdout;

const started = (container: string, way: Way) =>
  count(
    container,
    `cat /var/tmp/session-box/${PROVIDERS[way].started} 2>/dev/null | wc -l`
  );

/** The cgroup of the user manager, as the kernel names it on this machine. */
async function managerCgroup(container: string): Promise<string> {
  const own = (
    await on(
      container,
      `cat /proc/$(systemctl show -p MainPID --value ${MANAGER})/cgroup`
    )
  ).stdout;
  const path = new RegExp(`^0::(/.*${MANAGER})`, 'm').exec(own)?.[1];
  expect(path).toBeDefined();
  return `/sys/fs/cgroup${path}`;
}

async function applyLimit(world: MonitoringWorld, limit: number) {
  const result = await on(
    world.box,
    `cd ${UBUNTU} && ANSIBLE_NOCOLOR=1 ansible-playbook session-box-limit.yml --extra-vars worker_agent_session_limit=${limit}`
  );
  world.output = result.stdout;
  expect(result.ok).toBe(true);
  world.changed = Number(
    /changed=(\d+)/.exec(result.stdout.split('PLAY RECAP').at(-1)!)?.[1]
  );
  sessions.get(world)!.limit = limit;
}

/** Starts one session through T3 and waits until T3 knows how it went:
 * its agent runs in a scope, or its provider exited. */
async function start(world: MonitoringWorld, way: Way): Promise<boolean> {
  const state = sessions.get(world)!;
  const before = await scopes(world.box);
  const answer = await asUser(
    world.box,
    `${T3} thread start --provider ${PROVIDERS[way].id} --model ${state.model} --json ${PROJECT} "wait"`
  );
  const thread = /"threadId":"([^"]+)"/.exec(answer.stdout)?.[1];
  expect(thread).toBeDefined();
  state.thread = thread!;
  let running = false;
  let seen = 0;
  await until('T3 to start or refuse the session', async () => {
    if ((await status(world)) === 'failed') return true;
    // A refused launcher's scope exists for a moment: it has to stay.
    seen = (await scopes(world.box)) > before ? seen + 1 : 0;
    running = seen >= 6;
    return running;
  });
  return running;
}

async function show(world: MonitoringWorld): Promise<string> {
  return (
    await asUser(
      world.box,
      `${T3} thread show ${sessions.get(world)!.thread} 2>&1`
    )
  ).stdout;
}

async function status(world: MonitoringWorld): Promise<string | undefined> {
  const shown = await asUser(
    world.box,
    `${T3} thread show --json ${sessions.get(world)!.thread}`
  );
  return /"status":"([^"]+)"/.exec(shown.stdout)?.[1];
}

Given(
  'the pinned T3 Code server runs there in the user manager of {string}',
  async (world, user: string) => {
    expect(user).toBe(USER);
    const box = await agentBox();
    box.sessions ??= prepare(box.container);
    await box.sessions;
    sessions.set(world, { model: model!, limit: 0 });
  }
);

Given(
  'the baseline declared a limit of {int} agent sessions there',
  async (world, limit: number) => {
    await applyLimit(world, limit);
  }
);

Given('no agent session runs', async (world) => {
  await asUser(
    world.box,
    `systemctl --user stop ${AGENTS.split('/').at(-1)}; systemctl --user reset-failed 't3code-*.scope'; rm -f /var/tmp/session-box/fleet /var/tmp/session-box/plain`
  );
  await until('the agents to end', async () => (await scopes(world.box)) === 0);
});

Given(
  new RegExp(`^(\\d+) agent sessions were started ${WAY}$`),
  async (world, sessionsWanted: string, way: Way) => {
    for (let index = 0; index < Number(sessionsWanted); index += 1)
      if (!(await start(world, way)))
        throw new Error(
          `T3 did not start session ${index + 1}: ${await show(world)}\n${await units(world.box)}`
        );
    expect(await scopes(world.box)).toBe(Number(sessionsWanted));
  }
);

Given('one of them ended', async (world) => {
  const before = await scopes(world.box);
  expect(
    (
      await asUser(
        world.box,
        "systemctl --user stop \"$(systemctl --user list-units 't3code-*.scope' --state=active --plain --no-legend | head -1 | cut -d' ' -f1)\""
      )
    ).ok
  ).toBe(true);
  await until(
    'the session to end',
    async () => (await scopes(world.box)) === before - 1
  );
});

When(
  new RegExp(`^another session is started ${WAY}$`),
  async (world, way: Way) => {
    await start(world, way);
  }
);

When('the unit that holds the limit is stopped', async (world) => {
  expect((await asUser(world.box, `systemctl --user stop ${UNIT}`)).ok).toBe(
    true
  );
});

When('the baseline is applied with no limit declared', async (world) => {
  await applyLimit(world, 0);
});

Then(
  'T3 reports that its provider exited with code {int} before it started',
  async (world, code: number) => {
    expect(await status(world)).toBe('failed');
    expect(await show(world)).toContain(`exited with code ${code}`);
  }
);

Then("T3's server log says {string}", async (world, text: string) => {
  await until('the launcher to be logged', async () =>
    (await log(world.box)).includes(text)
  );
});

Then('{int} agent scopes run', async (world, wanted: number) => {
  expect(await scopes(world.box)).toBe(wanted);
});

Then(
  new RegExp(`^(\\d+) agents were started ${WAY}$`),
  async (world, wanted: string, way: Way) => {
    expect(await started(world.box, way)).toBe(Number(wanted));
  }
);

Then(
  'the slice T3 owns admits {string} scopes',
  async (world, wanted: string) => {
    const agents = `${await managerCgroup(world.box)}/${AGENTS}`;
    // The unit looks every two seconds, and a stopped one answers at once.
    let held = '';
    await until(
      'the kernel limit',
      async () => {
        held = (
          await on(
            world.box,
            `cat ${agents}/app-t3code-agents-*.slice/cgroup.max.descendants`
          )
        ).stdout.trim();
        return held === wanted;
      },
      20
    ).catch(() => undefined);
    expect(held).toBe(wanted);
  }
);

Then(
  'the slice T3 probes scope support in admits {string} scopes',
  async (world, wanted: string) => {
    expect(
      (
        await on(
          world.box,
          `cat ${await managerCgroup(world.box)}/${AGENTS}/cgroup.max.descendants`
        )
      ).stdout.trim()
    ).toBe(wanted);
  }
);

Then('the capacity probe reports {string}', async (world, line: string) => {
  expect(
    (
      await asUser(world.box, `sh ${FLEET}/ansible/net/remote-probe.sh`)
    ).stdout.split('\n')
  ).toContain(line);
});

Then('applying the baseline again changes nothing', async (world) => {
  await applyLimit(world, sessions.get(world)!.limit);
  expect(world.changed).toBe(0);
});

Then('the command T3 probes scope support with succeeds', async (world) => {
  // src/process/agentScope.ts of T3 Code: its probe, in the slice it probes in.
  const probe = await asUser(
    world.box,
    'systemd-run --user --scope --quiet --collect --slice=app-t3code-agents.slice --property=TimeoutStopSec=10s --property=Delegate=yes --property=OOMPolicy=stop -- true'
  );
  expect(probe.ok).toBe(true);
});

Then('a T3 that restarts starts its agents in scopes', async (world) => {
  const before = await starts(world.box);
  const since = (await log(world.box)).split('Agent scopes are on').length;
  expect(
    (
      await asUser(
        world.box,
        'systemctl --user restart t3code-headless.service'
      )
    ).ok
  ).toBe(true);
  // The next scenario starts sessions: wait for this start, not the last.
  await ready(world.box, before);
  expect((await log(world.box)).split('Agent scopes are on').length).toBe(
    since + 1
  );
  expect(await log(world.box)).not.toContain('Agent scopes are off');
});

Then(
  new RegExp(`^another session started ${WAY} runs$`),
  async (world, way: Way) => {
    const before = await scopes(world.box);
    expect(await start(world, way)).toBe(true);
    expect(await scopes(world.box)).toBe(before + 1);
  }
);

Then("the limit's unit and its script are gone", async (world) => {
  expect(
    (
      await on(
        world.box,
        `ls /etc/systemd/user/${UNIT} /usr/local/lib/personal-fleet-agent-session-limit.py 2>/dev/null | wc -l`
      )
    ).stdout.trim()
  ).toBe('0');
  expect(
    (
      await asUser(world.box, `systemctl --user is-active ${UNIT}`)
    ).stdout.trim()
  ).not.toBe('active');
});

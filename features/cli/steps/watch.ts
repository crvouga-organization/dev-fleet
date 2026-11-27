import { expect } from 'bun:test';
import type { DataTable } from '../../support/gherkin';
import {
  bucketStore,
  fleetWatch,
  type WatchedRevision,
  type WatchStore,
} from '../../../src/cli/fleet-watch';
import { parseNotify, type NotifyConfig } from '../../../src/notify';
import type { SecretName, SecretsLogin } from '../../../src/secrets';
import {
  SECRETS_FAULT,
  secretsFault,
  standInSecrets,
} from '../../support/secrets';
import type { Check, NodeReport } from '../../../src/types';
import { cli, outcome, part, temporary, type CliWorld } from './world';

/** notify against a webhook and an ntfy receiver on this machine. The
 * fleet's health is what the scenario says check sees; the watcher's
 * memory lives in a directory that stands in for the bucket.
 */
const { Given, When, Then } = cli;

interface Received {
  path: string;
  headers: Record<string, string>;
  body: string;
}

const watch = part(() => ({
  notify: undefined as NotifyConfig | undefined,
  secrets: {} as Partial<Record<SecretName, string>>,
  login: 'held' as SecretsLogin,
  received: [] as Received[],
  answer: 200,
  store: undefined as WatchStore | null | undefined,
  nodes: [] as NodeReport[],
  revision: null as WatchedRevision | null | 'unreadable',
}));

function nodes(failing: Record<string, string>): NodeReport[] {
  return Object.entries(failing).map(([node, ids]) => ({
    node,
    checks: [
      { id: 'worker:ubuntu', status: 'pass', summary: 'fine' },
      ...ids
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
        .map((id): Check => ({
          id,
          status: 'fail',
          summary: `PRIVATE raw summary of ${id}`,
        })),
    ],
  }));
}

Given(
  /^an? (webhook|ntfy) receiver on this machine(?:, answering (\d+))?$/,
  (world, kind: string, answer: string | undefined) => {
    const state = watch(world);
    if (answer) state.answer = Number(answer);
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (request) => {
        state.received.push({
          path: new URL(request.url).pathname,
          headers: Object.fromEntries(
            request.headers as unknown as [string, string][]
          ),
          body: await request.text(),
        });
        return new Response('PRIVATE receiver answer', {
          status: state.answer,
        });
      },
    });
    world.defer(() => server.stop(true));
    state.secrets[kind === 'ntfy' ? 'notify-ntfy-url' : 'notify-webhook-url'] =
      `http://127.0.0.1:${server.port}/${kind}/PRIVATE-TOKEN`;
  }
);

Given('the fleet configuration says:', (world, json: string) => {
  const notify = parseNotify((JSON.parse(json) as { notify: unknown }).notify);
  if (!notify) throw new Error('The notify block is invalid.');
  watch(world).notify = notify;
});

Given(SECRETS_FAULT, (world, fault: string) => {
  watch(world).login = secretsFault(fault);
});

Given('the fleet configuration has no notify block', (world) => {
  watch(world).notify = undefined;
});

Given('the bucket is a directory', async (world) => {
  watch(world).store = bucketStore({
    kind: 'directory',
    path: await temporary(world, 'watch-bucket-'),
  });
});

Given(
  'the fleet state says of the approved revision:',
  (world, json: string) => {
    watch(world).revision = JSON.parse(json) as WatchedRevision;
  }
);

Given(
  'the watcher ran while the fleet state said of the approved revision:',
  async (world, json: string) => {
    watch(world).revision = JSON.parse(json) as WatchedRevision;
    await run(world, false, '2026-11-10T23:45:00Z');
  }
);

Given(
  'the watcher ran while the fleet state could not be read',
  async (world) => {
    watch(world).revision = 'unreadable';
    await run(world, false, '2026-11-10T23:50:00Z');
  }
);

When('the watcher runs twice', async (world) => {
  await run(world, false, '2026-11-11T00:00:00Z');
  await run(world, false, '2026-11-11T00:15:00Z');
});

Then(
  'the webhook receiver was told of the revision:',
  (world, json: string) => {
    const body = JSON.parse(watch(world).received.at(-1)!.body) as Record<
      string,
      unknown
    >;
    expect({
      event: body['event'],
      node: body['node'],
      revision: body['revision'],
      text: body['text'],
    }).toEqual(JSON.parse(json));
  }
);

Then('notify reports the revision:', (world, json: string) => {
  expect((outcome(world).data as { revision?: unknown }).revision).toEqual(
    JSON.parse(json)
  );
});

Then('notify prints {string}', (world, line: string) => {
  expect((outcome(world).text ?? '').split('\n')).toContain(line);
});

Then('notify reports no revision', (world) => {
  expect(outcome(world).data).not.toHaveProperty('revision');
});

Given('check sees every worker ready', (world) => {
  watch(world).nodes = nodes({ 'worker-a': '', 'worker-b': '' });
});

async function run(world: CliWorld, test: boolean, at: string) {
  const state = watch(world);
  world.outcome = await fleetWatch(test ? { test } : {}, {
    notify: state.notify,
    status: () => Promise.resolve(state.nodes),
    revision: () =>
      state.revision === 'unreadable'
        ? Promise.reject(new Error('The fleet state cannot be read.'))
        : Promise.resolve(state.revision),
    store: state.store ?? null,
    secrets: standInSecrets(
      (name) => state.secrets[name],
      () => state.login
    ),
    send: fetch,
    now: () => new Date(at),
  });
}

When('the watcher runs', async (world) => {
  await run(world, false, '2026-11-11T00:00:00Z');
});

When('the watcher sends a test notification', async (world) => {
  await run(world, true, '2026-11-11T00:00:00Z');
});

When(
  'the watcher runs at these times, while check sees these failing checks:',
  async (world, table: DataTable) => {
    for (const row of table.hashes()) {
      const { time, ...failing } = row;
      watch(world).nodes = nodes(failing);
      await run(world, false, time!);
    }
  }
);

Then(/^the receiver got (\d+) notifications?$/, (world, count: string) => {
  expect(watch(world).received).toHaveLength(Number(count));
});

Then('the webhook receiver got, in order:', (world, table: DataTable) => {
  expect(
    watch(world).received.map((entry) => {
      const body = JSON.parse(entry.body) as {
        event: string;
        node: string;
        checks: string[];
      };
      return {
        event: body.event,
        node: body.node,
        checks: body.checks.join(', '),
      };
    })
  ).toEqual(
    table.hashes() as { event: string; node: string; checks: string }[]
  );
});

Then('the ntfy receiver got the text {string}', (world, text: string) => {
  expect(watch(world).received.map((entry) => entry.body)).toEqual([text]);
});

Then('nothing the receiver got contains {string}', (world, text: string) => {
  for (const entry of watch(world).received)
    // The address itself is the secret the receiver was reached at.
    expect(entry.body + JSON.stringify(entry.headers)).not.toContain(text);
});

Then(
  'nothing notify reported contains {string}',
  (world, text: string) => {
    expect(JSON.stringify(outcome(world).data)).not.toContain(text);
    expect(outcome(world).text ?? '').not.toContain(text);
  }
);

Then(
  /^notify exits with (\d+) and its check "([^"]+)" (passes|fails|warns)$/,
  (world, code: string, id: string, verdict: string) => {
    const result = outcome(world);
    expect(result.exitCode).toBe(Number(code));
    const checks = (result.data as { checks: Check[] }).checks;
    expect(checks.find((check) => check.id === id)?.status).toBe(
      ({ passes: 'pass', fails: 'fail', warns: 'warn' } as const)[
        verdict as 'passes'
      ]
    );
  }
);

Then(
  'the check {string} of notify says {string}',
  (world, id: string, summary: string) => {
    const { checks } = outcome(world).data as { checks: Check[] };
    expect(checks.find((check) => check.id === id)?.summary).toBe(summary);
  }
);

Then(
  'the bucket holds a heartbeat from {string}',
  async (world, at: string) => {
    const text = await watch(world).store!.read();
    expect((JSON.parse(text!) as { heartbeatAt: string }).heartbeatAt).toBe(
      new Date(at).toISOString()
    );
  }
);

Then('the notify block {string} is refused', (_world, json: string) => {
  expect(parseNotify(JSON.parse(json))).toBeNull();
});

Given(
  'check warns about {string} on {string}',
  (world, id: string, node: string) => {
    watch(world).nodes = [
      { node, checks: [{ id, status: 'warn', summary: 'low disk' }] },
    ];
  }
);

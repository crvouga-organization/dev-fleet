import { expect } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import images from '../../cliproxy/image.lock.json';
import { discoverAccounts } from '../../src/agents/accounts';
import { registry } from '../../src/agents/registry';
import { inferenceRequest } from '../../src/agents/verify';
import { runCommand } from '../../src/runner';
import type { AccountsWorld } from './steps';
import { accounts } from './steps';

const { Given, When, Then } = accounts;

/** The proxy the fleet pins, by digest: the one every manager runs. */
const IMAGE = images['eceasy/cli-proxy-api'];
const KEY = 'proxy-box-client-key';
const MODEL = 'claude-sonnet-5-5';

/** The pinned proxy in a container of its own, and the stand-in its one
 * account's requests end at.
 */
export interface ProxyBox {
  url: string;
  key: string;
  /** `<provider>-<account>/<model>`: served by that account alone. */
  model: string;
  /** What the stand-in provider answers, and how often it was asked. */
  provider: {
    status: number;
    body: string;
    retryAfter?: string;
    asked: number;
  };
  /** The proxy's last answer to a request a scenario made itself. */
  answer?: { status: number; retryAfter: string | null; body: string };
}

async function docker(words: string[], timeoutMs = 300_000): Promise<string> {
  const result = await runCommand(['docker', ...words], { timeoutMs });
  if (!result.ok)
    throw new Error(`docker ${words[0]} failed: ${result.stderr.slice(-400)}`);
  return result.stdout.trim();
}

/** A port nothing listens on: the container shares the host's network. */
const freePort = (): Promise<number> =>
  new Promise((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => done(port));
    });
  });

/** The least configuration the proxy starts with: one client key and one
 * account of the Claude provider, under the prefix the proxy gives a
 * signed-in account, sent to the stand-in. No retry, so one request of a
 * scenario is one request to the provider.
 */
const configuration = (port: number, prefix: string, provider: string) =>
  [
    'config-version: 8',
    'server:',
    "  host: '127.0.0.1'",
    `  port: ${port}`,
    'management:',
    "  secret-key: ''",
    'access:',
    '  api-keys:',
    `    - ${KEY}`,
    'oauth:',
    '  auth-dir: /state/auths',
    'routing:',
    '  strategy: fill-first',
    '  retry:',
    '    request-retry: 0',
    '    max-retry-credentials: 0',
    '    max-retry-interval: 0',
    '  cooldown:',
    '    disable-cooling: false',
    'api-keys:',
    '  claude:',
    '    - name: stand-in',
    `      prefix: '${prefix}'`,
    `      base-url: '${provider}'`,
    '      models:',
    `        - name: '${MODEL}'`,
    `          alias: '${MODEL}'`,
    '      keys:',
    "        - api-key: 'stand-in-provider-key'",
    '',
  ].join('\n');

async function listed(box: ProxyBox): Promise<boolean> {
  try {
    const response = await fetch(`${box.url}/v1/models`, {
      headers: { Authorization: `Bearer ${box.key}` },
      signal: AbortSignal.timeout(2_000),
    });
    const body = (await response.json()) as { data?: { id?: string }[] };
    return (body.data ?? []).some((model) => model.id === box.model);
  } catch {
    return false;
  }
}

async function startBox(world: AccountsWorld, account: string): Promise<void> {
  const prefix = `claude-${account}`;
  const provider: ProxyBox['provider'] = { status: 200, body: '{}', asked: 0 };
  const standIn = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => {
      provider.asked += 1;
      return new Response(provider.body, {
        status: provider.status,
        headers: {
          'Content-Type': 'application/json',
          ...(provider.retryAfter
            ? { 'Retry-After': provider.retryAfter }
            : {}),
        },
      });
    },
  });
  world.defer(() => void standIn.stop(true));
  const state = await mkdtemp(join(tmpdir(), 'fleet-proxy-box-'));
  world.defer(() => rm(state, { recursive: true, force: true }));
  await mkdir(join(state, 'auths'));
  const port = await freePort();
  await writeFile(
    join(state, 'config.yaml'),
    configuration(port, prefix, `http://127.0.0.1:${standIn.port}`)
  );
  const { uid, gid } = userInfo();
  const container = await docker([
    'run',
    '-d',
    '--network',
    'host',
    '--user',
    `${uid}:${gid}`,
    '-v',
    `${state}:/state`,
    IMAGE,
    '/CLIProxyAPI/CLIProxyAPI',
    '-config',
    '/state/config.yaml',
  ]);
  world.defer(() => docker(['rm', '-f', container]));
  const box: ProxyBox = {
    url: `http://127.0.0.1:${port}`,
    key: KEY,
    model: `${prefix}/${MODEL}`,
    provider,
  };
  for (let attempt = 0; attempt < 120 && !(await listed(box)); attempt++)
    await Bun.sleep(500);
  world.box = box;
  // The roster, read as a node reads it: from what the proxy lists.
  const live = await discoverAccounts(KEY, ((url: string, init: RequestInit) =>
    fetch(
      url.replace(registry.proxy.endpoint, box.url),
      init
    )) as unknown as typeof fetch);
  world.models = live.flatMap((entry) =>
    entry.models.map((model) => `${entry.prefix}/${model}`)
  );
  expect(world.models).toEqual([box.model]);
}

/** One request for the account's model, as the check of an account of
 * `tool` sends it.
 */
async function ask(box: ProxyBox, tool: string): Promise<void> {
  const { path, body } = inferenceRequest({
    tool: tool as Parameters<typeof inferenceRequest>[0]['tool'],
    model: box.model,
  });
  const response = await fetch(box.url + path, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${box.key}`,
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  box.answer = {
    status: response.status,
    retryAfter: response.headers.get('retry-after'),
    body: await response.text(),
  };
}

Given(
  'the pinned CLI proxy runs with the Claude account {string}, whose provider is a stand-in',
  startBox
);

Given(
  /^the provider answers that account with the status (\d+)(?: saying "(.*)")?(?: and "Retry-After: (\d+)")?$/,
  (world, status: string, message?: string, retryAfter?: string) => {
    Object.assign(world.box!.provider, {
      status: Number(status),
      body: JSON.stringify({
        type: 'error',
        error: { type: 'error', message: message ?? 'PROVIDER_SENTINEL' },
      }),
      retryAfter,
    });
  }
);

Given(
  /^the proxy was already asked for that model (once|0 times)$/,
  async (world, asked: string) => {
    if (asked === 'once') await ask(world.box!, 'claude');
  }
);

When(
  'the proxy is asked for that model as the check of a {word} account asks',
  async (world, tool: string) => {
    await ask(world.box!, tool);
  }
);

Then('the proxy answers with the status {int}', (world, status: number) => {
  expect(world.box!.answer!.status).toBe(status);
});

Then('the provider was asked {int} time(s)', (world, times: number) => {
  expect(world.box!.provider.asked).toBe(times);
});

Then('its answer says in "Retry-After" how many seconds are left', (world) => {
  expect(world.box!.answer!.retryAfter).toMatch(/^[1-9]\d*$/);
});

Then('its answer carries no "Retry-After"', (world) => {
  expect(world.box!.answer!.retryAfter).toBeNull();
});

Then(
  /^its answer (names|does not name) "model_cooldown" with the same seconds in "reset_seconds"$/,
  (world, names: string) => {
    const { body, retryAfter } = world.box!.answer!;
    const error = (
      JSON.parse(body) as { error?: { code?: string; reset_seconds?: number } }
    ).error;
    if (names === 'names') {
      expect(error?.code).toBe('model_cooldown');
      expect(error?.reset_seconds).toBe(Number(retryAfter));
    } else {
      expect(body).not.toContain('model_cooldown');
      expect(body).not.toContain('reset_seconds');
    }
  }
);

Then('its answer names what the provider said', (world) => {
  expect(world.box!.answer!.body).toContain('Verify your account to continue.');
});

Then(
  'the check {string} names the instant the proxy says the cooldown clears',
  async (world, id: string) => {
    const summary = world.checks.find((check) => check.id === id)!.summary;
    const until = / until (\S+Z);/.exec(summary)?.[1];
    expect(until).toBeDefined();
    await ask(world.box!, 'claude');
    const named = Date.now() + Number(world.box!.answer!.retryAfter) * 1000;
    // The check and this request were seconds apart, and each rounds up.
    expect(Math.abs(Date.parse(until!) - named)).toBeLessThan(15_000);
  }
);

Then('no check repeats what the provider said', (world) => {
  expect(world.checks.length).toBeGreaterThan(0);
  const said = (
    JSON.parse(world.box!.provider.body) as { error: { message: string } }
  ).error.message;
  for (const check of world.checks)
    expect(
      [check.summary, check.remedy?.action, check.remedy?.command].join('\n')
    ).not.toContain(said);
});

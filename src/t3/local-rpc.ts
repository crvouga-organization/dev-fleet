import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { record } from '../config';
import type { Runner } from '../types';

/** The two requests to the manager's T3 server, injected by scenarios. */
export interface T3Transport {
  /** POSTs to the server with the session as a bearer token; the JSON body. */
  post(url: string, bearer: string): Promise<unknown>;
  /** Sends one message on a WebSocket and answers with the first message
   * that ends request `id`. */
  call(url: string, message: object, id: string): Promise<unknown>;
}

const ORCHESTRATION_PROTOCOL = '2';

export async function localRpc(
  run: Runner,
  request: { tag: string; payload: object },
  sessionArgs: string[],
  options: {
    home?: string;
    transport?: T3Transport;
    read?: (path: string) => Promise<string>;
  } = {}
) {
  const home = resolve(
    options.home ?? process.env['T3CODE_HOME'] ?? join(homedir(), '.t3')
  );
  const transport = options.transport ?? webTransport;
  const read = options.read ?? ((path: string) => readFile(path, 'utf8'));
  const origin = await loopbackOrigin(read, home);
  if (!origin) return null;
  const issued = await run(
    ['t3', 'auth', 'session', 'issue', '--json', ...sessionArgs],
    { timeoutMs: 30_000 }
  );
  const session = parseSession(issued.ok ? issued.stdout : '');
  if (!session) return null;
  try {
    const ticket = await transport.post(
      `${origin}/api/auth/websocket-ticket/rpc`,
      session.token
    );
    if (!record(ticket) || typeof ticket['ticket'] !== 'string') return null;
    const socket = new URL('/ws', origin);
    socket.protocol = 'ws:';
    socket.searchParams.set('orchestrationProtocol', ORCHESTRATION_PROTOCOL);
    socket.searchParams.set('wsTicket', ticket['ticket']);
    const reply = await transport.call(
      socket.href,
      {
        _tag: 'Request',
        id: '1',
        ...request,
        headers: [],
      },
      '1'
    );
    return reply;
  } catch {
    return null;
  } finally {
    await run(['t3', 'auth', 'session', 'revoke', session.id], {
      timeoutMs: 30_000,
    });
  }
}

/** The origin the manager's T3 server records for itself, when it is on
 * this machine: a code is never sent anywhere else. */
async function loopbackOrigin(
  read: (path: string) => Promise<string>,
  home: string
): Promise<string | undefined> {
  try {
    const runtime: unknown = JSON.parse(
      await read(join(home, 'userdata/server-runtime.json'))
    );
    if (!record(runtime) || typeof runtime['origin'] !== 'string') return;
    const origin = new URL(runtime['origin']);
    return origin.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)
      ? origin.origin
      : undefined;
  } catch {
    return undefined;
  }
}

function parseSession(text: string): { id: string; token: string } | null {
  try {
    const value: unknown = JSON.parse(text);
    return record(value) &&
      typeof value['sessionId'] === 'string' &&
      /^[A-Za-z0-9_-]{1,128}$/.test(value['sessionId']) &&
      typeof value['token'] === 'string' &&
      value['token'].length > 0
      ? { id: value['sessionId'], token: value['token'] }
      : null;
  } catch {
    return null;
  }
}

const webTransport: T3Transport = {
  async post(url, bearer) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok ? ((await response.json()) as unknown) : null;
  },
  call(url, message, id) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error('timeout'));
      }, 100_000);
      const end = (value: unknown, error?: Error) => {
        clearTimeout(timer);
        socket.close();
        if (error) reject(error);
        else resolve(value);
      };
      socket.onopen = () => socket.send(JSON.stringify(message));
      socket.onmessage = (event) => {
        try {
          const reply: unknown = JSON.parse(String(event.data));
          if (
            record(reply) &&
            reply['_tag'] === 'Exit' &&
            reply['requestId'] === id
          )
            end(reply);
        } catch {
          // Not the reply; keep waiting.
        }
      };
      socket.onerror = () => end(null, new Error('socket'));
      socket.onclose = () => end(null, new Error('closed'));
    });
  },
};

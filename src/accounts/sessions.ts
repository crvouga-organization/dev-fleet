import { readFile } from 'node:fs/promises';
import type { Account } from '../agents/accounts';
import { registry, type Selection } from '../agents/registry';
import { inferenceRequest } from '../agents/verify';
import type { Check } from '../types';

/** The tools T3 offers once per proxy account, by T3 driver. */
const DRIVERS: Record<string, string> = {
  claudeAgent: 'claude',
  codex: 'codex',
  opencode: 'opencode',
};

/** One per-account instance a node offers: its tool and account. */
export interface Instance {
  tool: string;
  account: string;
}

/** The per-account instances this node's T3 settings offer, read from the
 * account each one pins (WS_AGENT_ACCOUNT). An unreadable file offers none.
 */
export async function exposedInstances(settings: string): Promise<Instance[]> {
  try {
    const parsed = JSON.parse(await readFile(settings, 'utf8')) as {
      providerInstances?: Record<
        string,
        {
          driver?: unknown;
          environment?: { name?: unknown; value?: unknown }[];
        }
      >;
    };
    return Object.values(parsed.providerInstances ?? {}).flatMap((instance) => {
      const tool = DRIVERS[String(instance.driver)];
      const account = (instance.environment ?? []).find(
        (variable) => variable.name === 'WS_AGENT_ACCOUNT'
      )?.value;
      return tool && typeof account === 'string' ? [{ tool, account }] : [];
    });
  } catch {
    return [];
  }
}

/** What a session says about its account. Only `ok` passes and only
 * `cooling-down` warns: the provider limited the account, which clears on
 * its own. `verification-required` and `rejected` are the account's and need
 * a person; `timed-out` is a session that never ended, which says nothing
 * about the sign-in.
 */
export type SessionResult =
  | 'ok'
  | 'cooling-down'
  | 'verification-required'
  | 'rejected'
  | 'timed-out'
  | 'failed';

/** Runs one real, cheap session through the instance's launcher. */
export type Session = (instance: Instance) => Promise<SessionResult>;

/** What is reported for a session that did not answer, for `who` (the tool
 * and the account's index): a summary that starts with a stable code, and
 * what to do about it.
 */
const UNANSWERED: Record<
  Exclude<SessionResult, 'ok'>,
  { status: Check['status']; summary: (who: string) => string; action?: string }
> = {
  'cooling-down': {
    status: 'warn',
    summary: (who) =>
      `AGENT_ACCOUNT_COOLING_DOWN: ${who} is rate limited; checked again on the next status.`,
  },
  'verification-required': {
    status: 'fail',
    summary: (who) =>
      `AGENT_ACCOUNT_VERIFICATION_REQUIRED: ${who} must be verified with its provider before it serves requests.`,
    action:
      'Sign in to the provider as this account and complete the verification it asks for. Signing in again on the proxy does not replace it. Find the account by its index.',
  },
  rejected: {
    status: 'fail',
    summary: (who) =>
      `AGENT_ACCOUNT_AUTH_REJECTED: ${who} was refused its credentials.`,
    action:
      'Read the state of this account on the proxy; one that needs a login is signed in again with --relogin.',
  },
  'timed-out': {
    status: 'fail',
    summary: (who) =>
      `AGENT_ACCOUNT_SESSION_TIMED_OUT: ${who} did not end a session before the deadline; the proxy named no cooldown and no refusal for it.`,
    action:
      'Read which models the proxy holds back on this account, then run status again; signing in again does not help a session that hangs.',
  },
  failed: {
    status: 'fail',
    summary: (who) =>
      `AGENT_ACCOUNT_SESSION_FAILED: ${who} did not run a session.`,
    action: 'Check this account on the proxy.',
  },
};

/** `agent:<tool>:account-<index>:session`, one per account instance: the
 * accounts the proxy holds and any instance the node still offers. An
 * instance whose account the proxy no longer holds fails without being run;
 * a rate-limited account is `cooling-down`, a warning and never a pass. The
 * index is the account's position among its provider's, never its name.
 */
export async function accountSessionChecks(
  live: Account[],
  exposed: Instance[],
  session: Session
): Promise<Check[]> {
  const key = (instance: Instance) => `${instance.tool}\0${instance.account}`;
  const held = new Set(
    live.map((account) => key({ tool: account.tool, account: account.email }))
  );
  const index = (instance: Instance) =>
    live
      .filter((account) => account.tool === instance.tool)
      .findIndex((account) => account.email === instance.account) + 1;
  const removed = exposed.filter((instance) => !held.has(key(instance)));
  const checks = await Promise.all(
    live.map(async (account): Promise<Check> => {
      const instance = { tool: account.tool, account: account.email };
      const id = `agent:${account.tool}:account-${index(instance)}:session`;
      const result = await session(instance);
      if (result === 'ok')
        return {
          id,
          status: 'pass',
          summary: `${account.tool} account ${index(instance)} runs a session through its T3 launcher.`,
        };
      const { status, summary, action } = UNANSWERED[result];
      return {
        id,
        status,
        summary: summary(`${account.tool} account ${index(instance)}`),
        ...(action
          ? { remedy: { action, command: 'devfleet fleet-accounts' } }
          : {}),
      };
    })
  );
  const byTool = new Map<string, number>();
  for (const instance of removed) {
    const count = (byTool.get(instance.tool) ?? 0) + 1;
    byTool.set(instance.tool, count);
    checks.push({
      id: `agent:${instance.tool}:removed-${count}:session`,
      status: 'fail',
      summary: `AGENT_ACCOUNT_REMOVED: this node still offers a ${instance.tool} instance for an account the proxy no longer holds.`,
      remedy: {
        action: 'Propagate the accounts to every node.',
        command: 'devfleet fleet-sync --only accounts',
      },
    });
  }
  return checks;
}

/** What a provider or the proxy said, by the condition it names. The text
 * itself is never reported: only which of these it matched.
 */
const SAID: [RegExp, SessionResult][] = [
  [/verify your account/i, 'verification-required'],
  [
    /cooling down until|model_cooldown|rate[ _-]?limit|\b429\b|quota|resource_exhausted/i,
    'cooling-down',
  ],
  [
    /unauthori[sz]ed|invalid_grant|authentication_error|invalid api key/i,
    'rejected',
  ],
];

const said = (text: string): SessionResult | undefined =>
  SAID.find(([pattern]) => pattern.test(text))?.[1];

/** What a session's output says about its account. A session ended at its
 * deadline (`timedOut`) that printed nothing telling is `timed-out`: the
 * caller asks the proxy what holds the account back (`proxyVerdict`).
 */
export function sessionResult(
  ok: boolean,
  output: string,
  timedOut = false
): SessionResult {
  if (ok && /\bOK\b/.test(output)) return 'ok';
  return said(output) ?? (timedOut ? 'timed-out' : 'failed');
}

/** What the proxy answers when it is asked for one account's model directly,
 * read after a session of that account timed out. OpenCode retries a refused
 * request quietly until the deadline, so only the proxy still knows why. A
 * model the proxy holds back answers 429 at once, without a request to the
 * provider; one it does not hold back is asked of the provider once, with
 * the bounded request the provider checks send. Anything else leaves the
 * session `timed-out`: the account answered, or nothing said why it does
 * not. The answer is read for its condition only and never kept.
 */
export async function proxyVerdict(
  account: Account,
  key: string,
  send: typeof fetch = fetch
): Promise<SessionResult> {
  const { path, body } = inferenceRequest({
    tool: account.tool as Selection['tool'],
    model: `${account.prefix}/${account.models[0]}`,
  });
  try {
    const response = await send(registry.proxy.endpoint + path, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 429) {
      await response.body?.cancel().catch(() => undefined);
      return 'cooling-down';
    }
    if (response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return 'timed-out';
    }
    const reason = said((await response.text()).slice(0, 4096));
    if (reason) return reason;
    return response.status === 401 || response.status === 403
      ? 'rejected'
      : 'timed-out';
  } catch {
    return 'timed-out';
  }
}

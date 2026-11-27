import type { Check, Runner } from './types';
import { fleet } from './fleet-config';
import { secretsProvider, vaultStatus, vaultTokenLookup } from './secrets';
import { WORKER_SECRETS_LOGIN, unreadSecret } from './secrets-blocked';
import { registry } from './agents/registry';
import { resolveVaultConfig, usesVault } from './vault-config';
import { record } from './config';
import { githubCredential } from './github/credential';
import { hostId } from './topology';
import { hostname } from 'node:os';
import { githubSignInState } from './github/sync';

/** Inject every subprocess; never put credentials in argv, reports, or logs. */
export async function workerAccessChecks(
  run: Runner,
  nodeId?: string
): Promise<Check[]> {
  return [
    await githubSync(run, nodeId),
    await proxyAuthentication(run),
    ...(usesVault() ? [await vaultRenewalCheck(run)] : []),
  ];
}

const GITHUB_REMEDIES: Record<string, string> = {
  GITHUB_TOKEN_MISSING:
    'The secrets provider holds no GitHub token for this worker. Store it under github-token (github-token-<node> with github.credential "per-node"); the next sign-in job or fleet-sync signs the worker in.',
  GITHUB_TOKEN_REJECTED:
    'GitHub refuses the stored token: it was revoked or has expired. Store a new one under github-token; nothing about the secret store itself needs fixing.',
  GITHUB_LOGIN_MISMATCH:
    'The stored token belongs to another account than worker.githubLogin. Store the fleet login’s token, or correct worker.githubLogin in the fleet configuration.',
  GITHUB_UNREACHABLE:
    'GitHub did not answer from this worker. Check its network and DNS; the worker keeps the sign-in it has.',
  GITHUB_SIGN_IN_FAILED:
    'The stored token is valid but this worker has not adopted it. Inspect the job with: journalctl --user -u personal-worker-github.service, or run fleet-sync.',
};

/** GitHub sign-in is measured on its own, so a GitHub fault is never reported
 * as a fault of the secret store's renewal, and the code names the system to
 * fix. A token this worker could not read at all is not a missing token: it
 * is the worker's login, which worker:vault-renewal owns.
 */
async function githubSync(run: Runner, nodeId?: string): Promise<Check> {
  const login = fleet.worker?.githubLogin;
  if (!login)
    return {
      id: 'worker:github-sync',
      status: 'fail',
      summary: 'GITHUB_LOGIN_UNDECLARED',
      remedy: {
        action: 'Declare the fleet GitHub login as worker.githubLogin.',
      },
    };
  const store = secrets(run);
  const code = await githubSignInState({
    run,
    login,
    token: githubCredential(fleet, nodeId ?? hostId(hostname()), store),
  });
  if (code === 'GITHUB_OK')
    return {
      id: 'worker:github-sync',
      status: 'pass',
      summary:
        'Worker GitHub authentication matches the declared common account.',
    };
  const failure = {
    id: 'worker:github-sync',
    status: 'fail' as const,
    summary: code,
    remedy: { action: GITHUB_REMEDIES[code]! },
  };
  return code === 'GITHUB_TOKEN_MISSING'
    ? unreadSecret(store, failure, WORKER_SECRETS_LOGIN)
    : failure;
}

const secrets = (run: Runner) =>
  secretsProvider(fleet.secrets, {
    run: async (argv) => {
      const result = await run(argv, { timeoutMs: 20_000 });
      return result.ok ? result.stdout : null;
    },
  });

/** Vault refuses a read the token's policy does not allow with a 403. */
const PERMISSION_DENIED = /permission denied|Code: 403/i;

async function proxyAuthentication(run: Runner): Promise<Check> {
  // Read through the declared provider, remembering only whether Vault said
  // the policy forbids it: never what it printed.
  let denied = false;
  const secret = secretsProvider(fleet.secrets, {
    run: async (argv) => {
      const result = await run(argv, { timeoutMs: 20_000 });
      if (!result.ok && PERMISSION_DENIED.test(result.stderr)) denied = true;
      return result.ok ? result.stdout : null;
    },
  });
  const forbidden = {
    id: 'worker:proxy-authentication',
    status: 'fail' as const,
    summary: 'VAULT_POLICY_PERMISSION_REQUIRED',
    remedy: {
      action:
        'This worker’s Vault identity was refused the proxy client key by its policy. Grant that identity read access to the declared location in the Vault policy you manage. fleet-sync seeds no secret, writes no policy and adds no secret store.',
    },
  };
  const unavailable = {
    id: 'worker:proxy-authentication',
    status: 'fail' as const,
    summary: 'UNATTENDED_PROXY_AUTHENTICATION_REQUIRED',
    remedy: {
      action:
        'Restore this worker’s own Vault authorization and renewal; no other node’s login or gateway identity is copied.',
    },
  };
  try {
    const key = (await secret('proxy-client-key')) ?? '';
    // A policy refuses a session that answers. Vault says the same 403 to a
    // session that lapsed, and nothing at all when it is out of reach: both
    // are this worker's login, not its policy and not a missing key.
    if (denied) return unreadSecret(secret, forbidden, WORKER_SECRETS_LOGIN);
    if (!/^[\x21-\x7e]{16,4096}$/.test(key))
      return unreadSecret(secret, unavailable, WORKER_SECRETS_LOGIN);
    const result = await run(
      [
        'curl',
        '--fail',
        '--silent',
        '--show-error',
        '--max-time',
        '10',
        '--header',
        '@-',
        `${registry.proxy.endpoint}/v1/models`,
      ],
      { input: `Authorization: Bearer ${key}\n`, timeoutMs: 15_000 }
    );
    const data: unknown = JSON.parse(result.stdout);
    if (
      !result.ok ||
      !record(data) ||
      !Array.isArray(data['data']) ||
      !data['data'].length
    )
      return unavailable;
    return {
      ...unavailable,
      status: 'pass',
      summary:
        'Worker credential authenticates to the declared singleton gateway model catalog.',
    };
  } catch {
    return unavailable;
  }
}

/** The check that owns this worker's login (`WORKER_SECRETS_LOGIN`): every
 * check here that needed a secret the worker could not read names it. A
 * session that does not answer is a lapsed one only when Vault itself
 * answers; otherwise Vault is out of this worker's reach, which no new token
 * repairs (`secretsLogin` in src/secrets.ts tells them the same way).
 */
async function vaultRenewalCheck(run: Runner): Promise<Check> {
  const unavailable: Check = {
    id: 'worker:vault-renewal',
    status: 'fail',
    summary: 'UNATTENDED_VAULT_IDENTITY_REQUIRED',
    remedy: {
      action:
        'Enroll this worker’s own periodic token or auto-auth identity. Ordinary expiring user sessions are not evidence of unattended renewal; no credentials are copied between machines.',
    },
  };
  try {
    const { addr } = resolveVaultConfig();
    const result = await run(vaultTokenLookup(addr));
    if (!result.ok && !(await vaultAnswers(run, addr)))
      return { ...unavailable, ...VAULT_UNREACHABLE(addr) };
    const data: unknown = JSON.parse(result.stdout);
    if (!result.ok || !record(data) || !unattended(data['data']))
      return unavailable;
    if (!(await lastRenewalSucceeded(run)))
      return {
        ...unavailable,
        summary: 'VAULT_RENEWAL_FAILING',
        remedy: {
          action:
            'The identity is renewable, but the last run of the renewal job failed. Inspect it on this worker with: journalctl --user -u personal-worker-auth.service. Its token expires unless a renewal succeeds; no credentials are copied between machines.',
        },
      };
    return {
      ...unavailable,
      status: 'pass',
      summary:
        'This worker has a renewable periodic Vault identity with sufficient lifetime for the renewal timer, and its last renewal succeeded.',
    };
  } catch {
    return unavailable;
  }
}

/** A renewable periodic token with enough lifetime left for the renewal
 * timer, in what a lookup printed.
 */
const unattended = (token: unknown): boolean =>
  record(token) &&
  token['renewable'] === true &&
  typeof token['period'] === 'number' &&
  token['period'] > 0 &&
  typeof token['ttl'] === 'number' &&
  token['ttl'] > 1200;

/** Whether Vault answers this worker and is unsealed: its status needs no
 * session.
 */
const vaultAnswers = async (run: Runner, addr: string): Promise<boolean> =>
  (await run(vaultStatus(addr), { timeoutMs: 20_000 })).ok;

const VAULT_UNREACHABLE = (
  addr: string
): Pick<Check, 'summary' | 'remedy'> => ({
  summary: 'VAULT_UNREACHABLE',
  remedy: {
    action: `Vault at ${addr} does not answer this worker, or is sealed; a new token does not help, so issue none. On the worker, vault status -address=${addr} says which: no answer is the network between them (the tailnet, DNS, the address under secrets in the fleet configuration) or a Vault that is not running; "Sealed true" is a Vault to unseal. Then run homelab fleet-sync. A session the worker held is still held if Vault returns before it lapses; no credentials are copied between machines.`,
  },
});

/** An active timer is not evidence that renewal works: the result of the
 * job's last run is. A job that has not run yet has nothing to say.
 */
async function lastRenewalSucceeded(run: Runner): Promise<boolean> {
  const shown = await run([
    'systemctl',
    '--user',
    'show',
    'personal-worker-auth.service',
    '--property=Result,ExecMainStatus',
  ]);
  if (!shown.ok) return true;
  const result = /^Result=(.*)$/m.exec(shown.stdout)?.[1];
  const status = /^ExecMainStatus=(.*)$/m.exec(shown.stdout)?.[1];
  return (
    (result === undefined || result === 'success') &&
    (status === undefined || status === '0')
  );
}

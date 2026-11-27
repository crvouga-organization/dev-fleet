import { record } from '../config';
import type { Check, Runner } from '../types';
import type { Account } from '../agents/accounts';
import { registry } from '../agents/registry';
import { localRpc } from './local-rpc';

export async function managerQuotaCoverage(
  accounts: Account[],
  run: Runner
): Promise<Check[]> {
  const managed = accounts.filter((account) => account.tool === 'antigravity');
  if (!managed.length) return [];
  const sources = await localRpc(
    run,
    { tag: 'subscribeServerConfig', payload: { usageLimitSources: true } },
    [
      '--scope',
      'orchestration:read',
      '--ttl',
      '2m',
      '--label',
      'homelab quota check',
    ]
  );
  return [quotaCoverage(managed, registry.proxy.endpoint, sources)];
}

function fresh(value: unknown, now: number) {
  const age = typeof value === 'string' ? now - Date.parse(value) : NaN;
  return age >= 0 && age <= 15 * 60_000;
}

function accountKeys(account: unknown, now: number): string[] {
  if (!record(account) || account['driver'] !== 'antigravity') return [];
  const limits = account['usageLimits'];
  if (
    !record(limits) ||
    limits['unavailable'] ||
    !fresh(limits['checkedAt'], now) ||
    !Array.isArray(limits['windows']) ||
    !limits['windows'].length
  )
    return [];
  return [account['email'], account['id']]
    .filter((key): key is string => typeof key === 'string')
    .map((key) => key.replace(/\.json$/i, '').toLowerCase());
}

function matches(source: unknown, endpoint: string, now: number): unknown[] {
  if (
    !record(source) ||
    source['kind'] !== 'cliproxy' ||
    source['error'] ||
    !fresh(source['checkedAt'], now)
  )
    return [];
  const authority = source['endpoint'] ?? source['origin'];
  return typeof authority === 'string' &&
    authority.replace(/\/$/, '') === endpoint.replace(/\/$/, '') &&
    Array.isArray(source['accounts'])
    ? source['accounts']
    : [];
}

export function quotaCoverage(
  accounts: Account[],
  endpoint: string,
  sources: unknown,
  now = Date.now()
): Check {
  const covered = new Set(
    Array.isArray(sources)
      ? sources
          .flatMap((source) => matches(source, endpoint, now))
          .flatMap((account) => accountKeys(account, now))
      : []
  );
  const missing = accounts.flatMap((account, i) =>
    covered.has(account.email.toLowerCase()) ||
    covered.has(account.prefix.toLowerCase())
      ? []
      : [i + 1]
  );
  const id = 't3:quota-coverage';
  return missing.length
    ? {
        id,
        status: 'warn',
        summary: `T3_QUOTA_COVERAGE_MISSING: account positions ${missing.join(', ')} of ${accounts.length}.`,
        remedy: {
          action:
            'Check the CLI proxy usage-limit source on the manager in T3 Settings. Refresh the affected account on the hub and rerun converge.',
        },
      }
    : {
        id,
        status: 'pass',
        summary: `The manager's CLI proxy quota source reports windows for all ${accounts.length} managed Antigravity accounts.`,
      };
}

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
      'dev-fleet quota check',
    ]
  );
  return [quotaCoverage(managed, registry.proxy.endpoint, sources)];
}

export function quotaCoverage(
  accounts: Account[],
  endpoint: string,
  sources: unknown
): Check {
  const origin = new URL(endpoint).origin;
  const covered = new Set<string>();
  if (Array.isArray(sources))
    for (const source of sources) {
      if (
        !record(source) ||
        source['kind'] !== 'cliproxy' ||
        source['origin'] !== origin ||
        source['error'] ||
        !Array.isArray(source['accounts'])
      )
        continue;
      for (const account of source['accounts']) {
        if (!record(account) || account['driver'] !== 'antigravity') continue;
        const limits = account['usageLimits'];
        if (
          !record(limits) ||
          limits['unavailable'] ||
          !Array.isArray(limits['windows']) ||
          !limits['windows'].length
        )
          continue;
        if (typeof account['email'] === 'string')
          covered.add(account['email'].toLowerCase());
        if (typeof account['id'] === 'string')
          covered.add(account['id'].replace(/\.json$/i, '').toLowerCase());
      }
    }
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
            'Check the CLI proxy usage-limit source on the manager in T3 Settings. Refresh the affected account on the hub and rerun fleet-sync.',
        },
      }
    : {
        id,
        status: 'pass',
        summary: `The manager's CLI proxy quota source reports windows for all ${accounts.length} managed Antigravity accounts.`,
      };
}

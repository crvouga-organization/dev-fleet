import type { Check, Runner } from '../types';
import { record } from '../config';
import { runCommand } from '../runner';
import { localRpc, missingT3Cli, type T3Transport } from './local-rpc';

/** An explicit model refresh opens a disposable ACP session using this
 * instance's launcher, and publishes its sign-in status in T3 Settings. */
export async function refreshAntigravity(
  id: string,
  home?: string,
  options: { run?: Runner; transport?: T3Transport } = {}
) {
  const reply = await localRpc(
    options.run ?? runCommand,
    {
      tag: 'server.refreshProviders',
      payload: { instanceId: id, refreshModels: true },
    },
    [
      '--scope',
      'orchestration:read',
      '--ttl',
      '2m',
      '--label',
      'dev-fleet provider check',
    ],
    {
      ...(home ? { home } : {}),
      ...(options.transport ? { transport: options.transport } : {}),
    }
  );
  if (reply === missingT3Cli) return missingT3Cli;
  if (!record(reply) || reply['_tag'] !== 'Exit') return false;
  const exit = reply['exit'];
  if (!record(exit) || exit['_tag'] !== 'Success' || !record(exit['value']))
    return false;
  const providers = exit['value']['providers'];
  return (
    Array.isArray(providers) &&
    providers.some(
      (provider: unknown) =>
        record(provider) &&
        provider['instanceId'] === id &&
        provider['enabled'] === true &&
        provider['installed'] === true &&
        provider['status'] === 'ready' &&
        record(provider['auth']) &&
        provider['auth']['status'] === 'authenticated'
    )
  );
}

export async function checkedProviders(
  instances: Record<string, unknown>,
  home?: string,
  refresh = refreshAntigravity
): Promise<Check> {
  const managed = Object.entries(instances).filter(
    ([, instance]) => record(instance) && instance['driver'] === 'antigravity'
  );
  const failed: number[] = [];
  for (const [index, [instanceId]] of managed.entries()) {
    const result = await refresh(instanceId, home);
    if (result === missingT3Cli)
      return {
        id: 't3:providers',
        status: 'fail',
        summary: 'T3_CLI_MISSING',
        remedy: {
          action:
            'Restore the T3 CLI in the user installation or on the fleet-sync PATH, then rerun fleet-sync.',
        },
      };
    if (!result) failed.push(index + 1);
  }
  if (failed.length)
    return {
      id: 't3:providers',
      status: 'fail',
      summary: `T3_ANTIGRAVITY_SESSION_UNVERIFIED: account positions ${failed.join(', ')} of ${managed.length}.`,
      remedy: {
        action:
          'Open T3 Settings > Providers on this machine and refresh the affected Antigravity instances. Check their account-specific proxy sessions and rerun fleet-sync.',
      },
    };
  return {
    id: 't3:providers',
    status: 'pass',
    summary: managed.length
      ? `T3 reconciled its managed providers and authenticated all ${managed.length} Antigravity account sessions.`
      : 'T3 on this machine offers exactly the managed provider instances every machine gets.',
  };
}

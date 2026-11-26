import { dirname, join } from 'node:path';
import { proxyKey } from '../agents/secrets';
import { record } from '../config';
import { PACKAGE_ROOT } from '../package-info';
import { runAnsible } from '../platform/ansible';
import { runCommand } from '../runner';
import type { Change } from './plan';

// T3 encodes each segment of its provider-config secret name independently.
function slot(id: string) {
  return (
    'provider-config-' +
    [id, 'antigravity', 'apiKey']
      .map((value) => Buffer.from(value).toString('base64url'))
      .join('-') +
    '.bin'
  );
}

export async function reconcileProviderKeys(
  settings: string,
  instances: Record<string, unknown>,
  changes: Change[]
) {
  const active = Object.entries(instances)
    .filter(([, v]) => record(v) && v['driver'] === 'antigravity')
    .map(([id]) => slot(id));
  const retired = changes
    .filter(
      (c) => c.action === 'delete' && c.id.startsWith('personal_antigravity_')
    )
    .map((c) => slot(c.id));
  if (!active.length && !retired.length) return;
  const result = await runAnsible(runCommand, 'provider-keys.yml', {
    cwd: join(PACKAGE_ROOT, 'ansible/t3'),
    input: JSON.stringify({
      t3_keys_dir: join(dirname(settings), 'secrets'),
      t3_client_key: active.length ? await proxyKey() : '',
      t3_active_keys: active,
      t3_retired_keys: retired,
    }),
  });
  if (!result.ok)
    throw new Error('Could not reconcile the local T3 provider credentials.');
}

import { readFile } from 'node:fs/promises';
import {
  clientDocument,
  clientSettingsPath,
  installClientSettings,
} from '../t3/client-settings';
import { packagePlaybook, type PackagePlaybook } from '../platform/ansible';
import { databasePath } from './paths';
import { readDocument, writeDocument } from './store';
import { mutateState, type StateContext } from './sync';

/** Read once per sync. A replacement manager recovers the last snapshot. */
export async function managerClientSettings(
  context: StateContext,
  path = clientSettingsPath(),
  play: PackagePlaybook = packagePlaybook(context.run)
) {
  const raw = await readFile(path, 'utf8').catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  );
  const current = raw === null ? null : clientDocument(raw);
  const file = databasePath(context.root);
  const { value } = await mutateState(context, () => {
    const saved = readDocument(file, 't3-client-settings');
    const body = current ?? clientDocument(saved ?? '{}');
    writeDocument(file, 't3-client-settings', body);
    return { body, restore: current === null && saved !== null };
  });
  if (value.restore) await installClientSettings(value.body, path, false, play);
  return value.body;
}

import {
  customizationDocument,
  installCustomizations,
  withCustomizations,
} from './customizations';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir, userInfo } from 'node:os';
import {
  variablesDirectory,
  packagePlaybook,
  type PackagePlaybook,
} from '../platform/ansible';
import type { Check, Runner } from '../types';
import { read, canonical, safePath, hash } from './files';
import { record } from '../config';

export const clientSettingsPath = () =>
  resolve(
    process.env['T3CODE_HOME'] ?? join(homedir(), '.t3'),
    'userdata/client-settings.json'
  );

/** The desktop also accepts JSON with comments and an older settings envelope. */
export function clientDocument(raw: string): string {
  const parsed: unknown = Bun.JSONC.parse(raw);
  if (!record(parsed)) throw new Error('T3_CLIENT_SETTINGS_INVALID');
  const settings = Object.hasOwn(parsed, 'settings')
    ? parsed['settings']
    : parsed;
  if (!record(settings)) throw new Error('T3_CLIENT_SETTINGS_INVALID');
  const body = canonical(settings) + '\n';
  if (Buffer.byteLength(body) > 1024 * 1024)
    throw new Error('T3_CLIENT_SETTINGS_TOO_LARGE');
  return body;
}

export async function installClientSettings(
  body: string,
  path: string,
  desktopService: boolean,
  play: PackagePlaybook
): Promise<void> {
  await safePath(path);
  const scratch = variablesDirectory();
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(scratch, 'preferences-'));
  const source = join(directory, 'client-settings.json');
  try {
    await writeFile(source, body, { mode: 0o600, flag: 'wx' });
    const result = await play(
      't3/client-settings.yml',
      {
        client_path: path,
        client_source: source,
        client_checksum: hash(body),
        desktop_service: desktopService,
        runtime_directory: `/run/user/${userInfo().uid}`,
      },
      120_000
    );
    if (!result.ok || clientDocument((await read(path)) ?? 'null') !== body)
      throw new Error('T3_CLIENT_SETTINGS_UNVERIFIED');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export const clientFailure = (): Check => ({
  id: 't3:client-settings',
  status: 'fail',
  summary: 'T3_CLIENT_SETTINGS_UNVERIFIED',
  remedy: {
    action:
      'Check that the T3 desktop settings and keybindings are readable, the pinned T3 CLI accepts the published themes, the user session is available and the fleet state is accessible. Rerun converge.',
  },
});

export async function workerClientSettings(
  body: string,
  desktop: boolean,
  run: Runner
): Promise<Check> {
  try {
    const payload: unknown = JSON.parse(body);
    const path = clientSettingsPath();
    const play = packagePlaybook(run);
    if (Array.isArray(payload)) {
      const [settings, artifacts] = payload as unknown[];
      if (payload.length !== 2 || typeof settings !== 'string')
        throw new Error();
      const files = customizationDocument(artifacts);
      await withCustomizations(files, run, (stage) =>
        installCustomizations(files, stage, { userdata: dirname(path) }, play)
      );
      body = settings;
    }
    await installClientSettings(body, path, desktop, play);
    return {
      id: 't3:client-settings',
      status: 'pass',
      summary: 'Verified the manager’s desktop preferences on this worker.',
    };
  } catch {
    return clientFailure();
  }
}

import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { managedT3 } from '../../bootstrap/native-t3';
import { record } from '../config';
import { variablesDirectory, type PackagePlaybook } from '../platform/ansible';
import type { Runner } from '../types';
import { canonical, safePath } from './files';

// Values are base64, including binary theme backgrounds. The same document
// travels through fleet state and SSH. Only these native files can be addressed.
export type Customizations = Record<string, string>;
const bindings = ['keybindings-migrations', 'keybindings.json'];
const theme = /^themes\/[a-z0-9-]+\.(?:json|webp|png|jpe?g)$/;
const limit = 1024 * 1024;
const invalid = () => new Error('T3_CUSTOMIZATIONS_INVALID');
const marker = '.homelab-customizations';
export const managerMarker = (userdata: string) => join(userdata, marker);
const markerBody = 'homelab\n';

export function customizationDocument(value: unknown): Customizations {
  if (!record(value) || Buffer.byteLength(JSON.stringify(value)) > limit)
    throw invalid();
  for (const [name, encoded] of Object.entries(value)) {
    if (
      (!bindings.includes(name) && !theme.test(name)) ||
      typeof encoded !== 'string' ||
      Buffer.from(encoded, 'base64').toString('base64') !== encoded
    )
      throw invalid();
    if (
      name === 'keybindings.json' &&
      !Array.isArray(Bun.JSONC.parse(Buffer.from(encoded, 'base64').toString()))
    )
      throw invalid();
  }
  return value as Customizations;
}

async function captureFile(path: string) {
  await safePath(path);
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > limit) throw invalid();
    return (await readFile(path)).toString('base64');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function captureCustomizations(
  userdata: string,
  incoming: Customizations = {}
): Promise<Customizations> {
  const dir = join(userdata, 'themes');
  await safePath(dir);
  const entries = await readdir(dir).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return [];
    throw err;
  });
  const files: Customizations = {};
  const names = new Set([
    ...entries,
    ...Object.keys(incoming)
      .filter((name) => name.startsWith('themes/'))
      .map((name) => name.slice(7)),
  ]);
  let size = 0;
  for (const name of [
    ...bindings,
    ...entries
      .map((item) => 'themes/' + item)
      .filter(
        (name) =>
          theme.test(name) &&
          names.has(name.slice(7).replace(/\.[^.]+$/, '.json'))
      )
      .sort(),
  ]) {
    const content = await captureFile(join(userdata, name));
    if (content !== null) {
      size += Buffer.byteLength(content);
      if (size > limit) throw invalid();
      files[name] = content;
    }
  }
  return files;
}

/** Validate exactly the staged bytes with the pinned server's theme loader.
 * Its source of settings is an empty temporary home, even on the manager. */
export async function withCustomizations<T>(
  files: Customizations,
  run: Runner,
  use: (stage: string) => Promise<T>
) {
  const scratch = variablesDirectory();
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  const stage = await mkdtemp(join(scratch, 'customizations-'));
  try {
    const userdata = join(stage, 'userdata');
    const ids: string[] = [];
    for (const [name, encoded] of Object.entries(
      customizationDocument(files)
    )) {
      const path = join(userdata, name);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, Buffer.from(encoded, 'base64'), { mode: 0o600 });
      if (name.startsWith('themes/') && name.endsWith('.json'))
        ids.push(name.slice(7, -5));
    }
    if (ids.length) {
      const result = await run([
        managedT3().path,
        'theme',
        'show',
        '--base-dir',
        stage,
      ]);
      if (
        !result.ok ||
        !result.stdout
          .trimEnd()
          .endsWith('\nPublished themes: ' + ids.sort().join(', ') + '.')
      )
        throw invalid();
    }
    return await use(userdata);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export async function installCustomizations(
  files: Customizations,
  stage: string,
  { userdata, manager = false }: { userdata: string; manager?: boolean },
  play: PackagePlaybook
) {
  const existing = await captureCustomizations(userdata, files);
  const changed = Object.keys(files)
    .sort()
    .filter((name) => files[name] !== existing[name]);
  const removed = Object.keys(existing)
    .filter((name) => !Object.hasOwn(files, name))
    .sort((a, b) => Number(a.endsWith('.json')) - Number(b.endsWith('.json')));
  await safePath(managerMarker(userdata));
  if (!changed.length && !removed.length && !manager) return;
  const result = await play(
    't3/customizations.yml',
    {
      userdata,
      customization_source: stage,
      changed_files: changed,
      removed_files: removed,
      manager_marker: manager ? managerMarker(userdata) : '',
      marker_body: markerBody,
    },
    120_000
  );
  if (
    !result.ok ||
    canonical(await captureCustomizations(userdata)) !== canonical(files)
  )
    throw invalid();
}

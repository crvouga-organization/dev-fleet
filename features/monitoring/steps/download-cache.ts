/** Optional download cache for the agent job: the T3 server archive and the
 * agent-box image. Off unless HOMELAB_DOWNLOAD_CACHE is set. A file is named
 * by what it contains, so an older cache entry is never loaded for a new pin. */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from '../../../src/runner';

export function downloadCacheDir(): string | undefined {
  const value = process.env['HOMELAB_DOWNLOAD_CACHE'];
  if (!value) return undefined;
  if (value.startsWith('/') || value.startsWith('~'))
    return value.replace(/^~/, homedir());
  return join(homedir(), '.cache', 'devfleet-downloads');
}

export async function readHashed(sha256: string): Promise<Buffer | undefined> {
  const dir = downloadCacheDir();
  if (!dir) return undefined;
  const file = join(dir, sha256);
  if (!existsSync(file)) return undefined;
  try {
    const bytes = await readFile(file);
    if (createHash('sha256').update(bytes).digest('hex') === sha256)
      return bytes;
  } catch (error) {
    console.warn(`The download cache could not be read: ${message(error)}`);
  }
  return undefined;
}

export async function writeHashed(
  sha256: string,
  bytes: Buffer
): Promise<void> {
  const dir = downloadCacheDir();
  if (!dir) return;
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) return;
  try {
    await mkdir(dir, { recursive: true });
    const file = join(dir, sha256);
    const part = `${file}.part`;
    await writeFile(part, bytes);
    await rename(part, file);
  } catch (error) {
    console.warn(`The download cache could not be written: ${message(error)}`);
  }
}

export async function loadImageTar(
  dockerfile: string,
  repo: string
): Promise<boolean> {
  const tar = await imageTar(dockerfile, repo);
  if (!tar || !existsSync(tar)) return false;
  const loaded = await runCommand(['docker', 'load', '-i', tar], {
    cwd: repo,
    timeoutMs: 300_000,
  });
  if (!loaded.ok) {
    console.warn('The cached agent image could not be loaded.');
    return false;
  }
  return true;
}

export async function saveImageTar(
  dockerfile: string,
  image: string,
  repo: string
): Promise<void> {
  const tar = await imageTar(dockerfile, repo);
  if (!tar) return;
  try {
    const part = `${tar}.part`;
    const saved = await runCommand(['docker', 'save', '-o', part, image], {
      cwd: repo,
      timeoutMs: 300_000,
    });
    if (!saved.ok) {
      console.warn('The agent image could not be saved to the cache.');
      return;
    }
    await rename(part, tar);
  } catch (error) {
    console.warn(
      `The agent image could not be saved to the cache: ${message(error)}`
    );
  }
}

async function imageTar(
  dockerfile: string,
  repo: string
): Promise<string | undefined> {
  const dir = downloadCacheDir();
  if (!dir) return undefined;
  const docker = await readFile(join(repo, dockerfile));
  const hash = createHash('sha256').update(docker).digest('hex').slice(0, 16);
  await mkdir(dir, { recursive: true });
  return join(dir, `agent-box-${hash}.tar`);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

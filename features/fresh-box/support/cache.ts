/** Optional apt, mise and image caches for the fresh-worker job.
 * Off unless HOMELAB_FRESH_BOX_CACHE is set on Linux, so a laptop run
 * stays a machine with empty caches. Each container gets its own hardlinked
 * copy: workers bootstrap at the same time and must not share one apt
 * directory. */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from '../../../src/runner';

const ROOT = join(homedir(), '.cache', 'homelab-fresh');

export function freshCacheEnabled(): boolean {
  return (
    Boolean(process.env['HOMELAB_FRESH_BOX_CACHE']) &&
    process.platform === 'linux'
  );
}

export async function loadFreshImage(
  release: string,
  repo: string
): Promise<boolean> {
  const tar = await imageTar(release, repo);
  if (!existsSync(tar)) return false;
  const loaded = await runCommand(['docker', 'load', '-i', tar], {
    cwd: repo,
    timeoutMs: 300_000,
  });
  if (!loaded.ok) {
    console.warn('The cached fresh image could not be loaded.');
    return false;
  }
  return true;
}

export async function saveFreshImage(
  image: string,
  release: string,
  repo: string
): Promise<void> {
  try {
    const tar = await imageTar(release, repo);
    const part = `${tar}.part`;
    const saved = await runCommand(['docker', 'save', '-o', part, image], {
      cwd: repo,
      timeoutMs: 300_000,
    });
    if (!saved.ok) {
      console.warn('The fresh image could not be saved to the cache.');
      return;
    }
    await rename(part, tar);
  } catch (error) {
    console.warn(
      `The fresh image could not be saved to the cache: ${message(error)}`
    );
  }
}

async function imageTar(release: string, repo: string): Promise<string> {
  const docker = await readFile(join(repo, 'features/fresh-box/Dockerfile'));
  const hash = createHash('sha256')
    .update(release)
    .update(docker)
    .digest('hex')
    .slice(0, 16);
  await mkdir(ROOT, { recursive: true });
  return join(ROOT, `image-${hash}.tar`);
}

export interface Seeded {
  args: string[];
  giveBack: (remove: boolean) => Promise<void>;
}

/** Private apt and mise caches, hardlinked from the shared cache. */
export async function seedCaches(): Promise<Seeded> {
  const apt = await seed('apt', 'fleet-apt-');
  const mise = await seed('mise', 'fleet-mise-');
  return {
    args: [
      '-v',
      `${apt}:/var/cache/apt/archives`,
      '-v',
      `${mise}:/var/cache/mise`,
    ],
    giveBack: (remove) => giveBack(apt, mise, remove),
  };
}

async function seed(kind: string, prefix: string): Promise<string> {
  const shared = join(ROOT, kind);
  await mkdir(shared, { recursive: true });
  const dir = await mkdirTemp(prefix);
  const copy = await runCommand(['cp', '-al', `${shared}/.`, dir]);
  if (!copy.ok) console.warn(`The ${kind} cache could not be hardlinked.`);
  return dir;
}

function mkdirTemp(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function prepareFreshCache(container: string): Promise<void> {
  const mode = await runCommand([
    'docker',
    'exec',
    container,
    'chmod',
    '1777',
    '/var/cache/apt/archives',
    '/var/cache/mise',
  ]);
  if (!mode.ok) console.warn('The fresh caches could not be made writable.');
  const environment = await runCommand([
    'docker',
    'exec',
    container,
    'sh',
    '-c',
    "grep -q '^MISE_CACHE_DIR=' /etc/environment || echo MISE_CACHE_DIR=/var/cache/mise >> /etc/environment",
  ]);
  if (!environment.ok)
    console.warn('MISE_CACHE_DIR could not be added to /etc/environment.');
}

async function giveBack(
  apt: string,
  mise: string,
  remove: boolean
): Promise<void> {
  try {
    await mkdir(join(ROOT, 'apt'), { recursive: true });
    await mkdir(join(ROOT, 'mise'), { recursive: true });
    await runCommand([
      'bash',
      '-c',
      `shopt -s nullglob; cp -an ${apt}/*.deb ${join(ROOT, 'apt')}/`,
    ]);
    await runCommand(['cp', '-an', `${mise}/.`, join(ROOT, 'mise')]);
  } catch (error) {
    console.warn(`The fresh caches could not be saved: ${message(error)}`);
  }
  if (!remove) return;
  // apt and mise write these as root inside the container. A directory the
  // runner cannot remove must not fail the scenarios that already passed.
  await removeTree(apt);
  await removeTree(mise);
}

async function removeTree(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
    return;
  } catch (error) {
    const denied =
      error instanceof Error &&
      'code' in error &&
      (error as { code?: unknown }).code === 'EACCES';
    if (!denied) {
      console.warn(
        `The fresh cache ${path} could not be removed: ${message(error)}`
      );
      return;
    }
  }
  const cleared = await runCommand(['sudo', '-n', 'rm', '-rf', '--', path]);
  if (!cleared.ok)
    console.warn(`The fresh cache ${path} could not be removed.`);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

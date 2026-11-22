import { approvedLocalSource } from './local-source';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { Runner } from '../types';
import { ensurePrivateRoot } from './state';
import { fleet } from '../fleet-config';

const repository = (): string => fleet.source.repository;

/** Called after approval; local sources supply Git objects only, never dirty files. */
export async function prepareSource(
  root: string,
  revision: string,
  run: Runner,
  checkout?: string
): Promise<string | null> {
  if (checkout) {
    const local = await approvedLocalSource(checkout, revision, run);
    if (local) return local;
  }
  return prepareRemoteSource(root, revision, run);
}

/** The manager's own copy of the fleet's source repository, cloned into its
 * caches when there is none. Null when it cannot be made, or when the copy
 * there is of another repository.
 */
async function ownedSource(
  root: string,
  run: Runner,
  declared: string
): Promise<string | null> {
  const source = join(root, 'source');
  await ensurePrivateRoot(source);
  await mkdir(root, { recursive: true, mode: 0o700 });
  let origin = await run(['git', 'remote', 'get-url', 'origin'], {
    cwd: source,
  });
  if (!origin.ok) {
    const cloned = await run(
      ['git', 'clone', '--no-checkout', '--origin', 'origin', declared, source],
      { timeoutMs: 120_000 }
    );
    if (!cloned.ok) return null;
    origin = await run(['git', 'remote', 'get-url', 'origin'], { cwd: source });
  }
  return origin.ok && origin.stdout.trim() === declared ? source : null;
}

async function prepareRemoteSource(
  root: string,
  revision: string,
  run: Runner
): Promise<string | null> {
  const source = await ownedSource(root, run, repository());
  if (!source) return null;
  let found = await run(
    ['git', 'rev-parse', '--verify', `${revision}^{commit}`],
    { cwd: source }
  );
  if (!found.ok || found.stdout.trim() !== revision) {
    const fetch = await run(['git', 'fetch', '--no-tags', 'origin', revision], {
      cwd: source,
      timeoutMs: 120_000,
    });
    if (!fetch.ok) return null;
    found = await run(
      ['git', 'rev-parse', '--verify', `${revision}^{commit}`],
      { cwd: source }
    );
  }
  return found.ok && found.stdout.trim() === revision ? source : null;
}

/** The default branch of the source repository, as the manager's copy of it
 * last fetched it.
 */
const DEFAULT_BRANCH = 'refs/remotes/origin/HEAD';

/** Whether the default branch of the source repository holds a revision:
 * `merged`, `unmerged`, or `unverified` when the repository could not be
 * asked.
 */
export type Ancestry = 'merged' | 'unmerged' | 'unverified';

/** Asks the manager's own copy of the source repository, never the directory
 * fleet-sync was started in: a checkout there may be on any branch. A
 * revision the copy already knows to be on the default branch stays on it,
 * so that answer needs no network; anything else is fetched first.
 */
export async function defaultBranchHolds(
  root: string,
  revision: string,
  run: Runner,
  declared: string = repository()
): Promise<Ancestry> {
  const source = await ownedSource(root, run, declared);
  if (!source) return 'unverified';
  const held = async (): Promise<boolean> =>
    (
      await run(
        ['git', 'merge-base', '--is-ancestor', revision, DEFAULT_BRANCH],
        { cwd: source }
      )
    ).ok;
  if (await held()) return 'merged';
  const fetched = await run(['git', 'fetch', '--no-tags', 'origin'], {
    cwd: source,
    timeoutMs: 120_000,
  });
  const branch = await run(
    ['git', 'rev-parse', '--verify', '--quiet', `${DEFAULT_BRANCH}^{commit}`],
    { cwd: source }
  );
  if (!fetched.ok || !branch.ok) return 'unverified';
  return (await held()) ? 'merged' : 'unmerged';
}

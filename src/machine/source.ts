import { approvedLocalSource } from './local-source';
import { join } from 'node:path';
import { mkdir, rename, rm } from 'node:fs/promises';
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

/** Why the manager has no copy of the fleet's source repository to ask:
 * `unavailable` when none could be made, `mismatched` when the copy there is
 * of another repository and the declared one could not be cloned to replace
 * it.
 */
type NoSource = 'unavailable' | 'mismatched';

/** The manager's own copy of the fleet's source repository, cloned into its
 * caches when there is none. A copy whose origin is another repository (one
 * made before the fleet's source moved) can never answer for this one, so it
 * is replaced: the declared repository is cloned beside it first, and only a
 * complete clone takes its place. The copy is a disposable cache; the run
 * checkouts made from the old one are recreated when they are next used.
 */
async function ownedSource(
  root: string,
  run: Runner,
  declared: string
): Promise<string | NoSource> {
  const source = join(root, 'source');
  await ensurePrivateRoot(source);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const origin = await run(['git', 'remote', 'get-url', 'origin'], {
    cwd: source,
  });
  if (origin.ok && origin.stdout.trim() === declared) return source;
  const clone = async (into: string): Promise<boolean> =>
    (
      await run(
        ['git', 'clone', '--no-checkout', '--origin', 'origin', declared, into],
        { timeoutMs: 120_000 }
      )
    ).ok;
  if (!origin.ok) return (await clone(source)) ? source : 'unavailable';
  const replacement = `${source}.new`;
  await rm(replacement, { recursive: true, force: true });
  if (!(await clone(replacement))) {
    await rm(replacement, { recursive: true, force: true });
    return 'mismatched';
  }
  try {
    await rm(source, { recursive: true, force: true });
    await rename(replacement, source);
  } catch {
    return 'mismatched';
  }
  return source;
}

async function prepareRemoteSource(
  root: string,
  revision: string,
  run: Runner
): Promise<string | null> {
  const source = await ownedSource(root, run, repository());
  if (source === 'unavailable' || source === 'mismatched') return null;
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

/** What to do when the manager's copy of the source repository is of
 * another repository and could not be replaced: it is not known whether the
 * revision is merged, so --allow-unmerged is not the answer.
 */
export function sourceMismatchRemedy(declared: string): string {
  return `The manager's own copy of the source repository (~/.local/share/personal/fleet/manager/source) is a clone of another repository, and ${declared} could not be cloned to replace it, so nothing was changed and it is not known whether the revision is merged. Check the manager's network and Git access to ${declared}, and that source.repository in fleet.json names it, then run fleet-sync again: the copy is replaced by itself. Removing that directory on the manager has the same effect.`;
}

/** The default branch of the source repository, as the manager's copy of it
 * last fetched it.
 */
const DEFAULT_BRANCH = 'refs/remotes/origin/HEAD';

/** Whether the default branch of the source repository holds a revision:
 * `merged`, `unmerged`, `unverified` when the repository could not be
 * asked, or `mismatched` when the manager's copy is of another repository
 * and could not be replaced with one of it.
 */
export type Ancestry = 'merged' | 'unmerged' | 'unverified' | 'mismatched';

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
  if (source === 'unavailable') return 'unverified';
  if (source === 'mismatched') return source;
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

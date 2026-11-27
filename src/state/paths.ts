import { homedir } from 'node:os';
import { join } from 'node:path';

/** The one directory that holds the manager's fleet state. Everything in it is
 * a local copy: the storage bucket is the source of truth, so the directory
 * can be deleted and restored with `state --restore`. `HOMELAB_STATE`
 * names another directory (a test fixture, a second fleet).
 */
export function stateRoot(env = process.env, home = homedir()): string {
  return (
    env['HOMELAB_STATE'] ||
    env['DEVFLEET_STATE'] ||
    join(home, '.local/share/homelab/state')
  );
}

/** The fleet state database Litestream replicates. */
export const databasePath = (root: string): string => join(root, 'fleet.db');

/** Records the bucket's head this copy last matched (see `standing`). */
export const replicatedPath = (root: string): string =>
  join(root, 'replicated.json');

/** The definition as a file, for the subprocesses that take a path. Rewritten
 * from the database; never edited.
 */
export const definitionPath = (root: string): string =>
  join(root, 'definition.json');

/** The bucket this manager replicates to, and its credentials. The only local
 * file that is not a copy of something else. `HOMELAB_BUCKET` names another.
 */
export function bucketPath(env = process.env, home = homedir()): string {
  return (
    env['HOMELAB_BUCKET'] ||
    env['DEVFLEET_BUCKET'] ||
    join(home, '.config/homelab/bucket.json')
  );
}

/** The home directory whose earlier files (kept before the fleet state
 * existed) may still be read, or null. A state directory named with
 * `HOMELAB_STATE` is another fleet's: this machine's earlier files are not
 * part of it.
 */
export function legacyHome(env = process.env, home = homedir()): string | null {
  return env['HOMELAB_STATE'] || env['DEVFLEET_STATE'] ? null : home;
}

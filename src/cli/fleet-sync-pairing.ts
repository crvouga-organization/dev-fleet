import { spawnSync } from 'node:child_process';
import type { SyncProgress } from './fleet-sync-progress';

/** A synchronous terminal prompt, like the attached Vault login: two workers
 * converging concurrently cannot consume each other's answers.
 */
export function authorizeFirstPairing(
  id: string,
  configured: boolean | undefined,
  ui: { interactiveAuthorization: boolean; progress: SyncProgress }
): boolean {
  if (configured !== undefined) return configured;
  if (!ui.interactiveAuthorization || !process.stdin.isTTY) return false;
  ui.progress.stop();
  process.stderr.write(
    `Pair this manager's T3 with enrolled worker ${id} (approval-required access)? [y/N] `
  );
  return (
    spawnSync(
      'sh',
      [
        '-c',
        'IFS= read -r answer && case "$answer" in y|Y|yes|YES) exit 0;; *) exit 1;; esac',
      ],
      { stdio: 'inherit' }
    ).status === 0
  );
}

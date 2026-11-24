import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Check, Runner } from './types';

/** This machine has the `devfleet` launcher, linked into a checkout. */
export async function launcherCheck(
  run: Runner,
  home = homedir()
): Promise<Check> {
  const launcher = join(home, '.local/bin/devfleet');
  const result = await run(['test', '-x', launcher], { timeoutMs: 5_000 });
  return result.ok
    ? {
        id: 'workstation:configuration',
        status: 'pass',
        summary: 'The devfleet launcher is installed.',
      }
    : {
        id: 'workstation:configuration',
        status: 'fail',
        summary: 'The devfleet launcher is missing.',
        remedy: {
          action:
            'Run npx devfleet fleet-sync from the fleet project on the manager to reinstall the launcher.',
        },
      };
}

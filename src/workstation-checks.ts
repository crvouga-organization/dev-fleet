import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Check, Runner } from './types';

/** This machine has the `homelab` launcher, linked into a checkout. */
export async function launcherCheck(
  run: Runner,
  home = homedir()
): Promise<Check> {
  const launcher = join(home, '.local/bin/homelab');
  const result = await run(['test', '-x', launcher], { timeoutMs: 5_000 });
  return result.ok
    ? {
        id: 'workstation:configuration',
        status: 'pass',
        summary: 'The homelab launcher is installed.',
      }
    : {
        id: 'workstation:configuration',
        status: 'fail',
        summary: 'The homelab launcher is missing.',
        remedy: {
          action:
            'Run npx homelab fleet-sync from the fleet project on the manager to reinstall the launcher.',
        },
      };
}

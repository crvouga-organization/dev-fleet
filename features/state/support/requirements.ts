import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { runCommand } from '../../../src/runner';
import type { Runner } from '../../../src/types';
import { miseInstalls } from '../../support/setup';

const checkout = resolve(import.meta.dir, '../../..');
const lookupEnvironment = {
  MISE_INSTALLS_DIR: miseInstalls,
  MISE_TRUSTED_CONFIG_PATHS: checkout,
  MISE_CEILING_PATHS: dirname(checkout),
};

// Both the prerequisite and the CLI look up the pin from this checkout.
// Only the read-only lookup sees the existing installations. Litestream and
// any install the CLI attempts still run inside the temporary home.
export const runWithLitestream: Runner = (command, options) =>
  command[0] === 'mise' && command[1] === 'which' && command[2] === 'litestream'
    ? runCommand(command, {
        ...options,
        env: { ...options?.env, ...lookupEnvironment },
      })
    : runCommand(command, options);

/** What the scenarios that run the real Litestream need. They are skipped
 * where a piece is missing (the plain Check job), except where
 * DEVFLEET_TEST_LITESTREAM=required: the Fleet state job in CI installs the
 * toolchain and starts an S3 service, so there a missing piece fails.
 */
export const requirements = {
  /** The Litestream mise.toml pins is installed. */
  installed:
    spawnSync('mise', ['which', 'litestream'], {
      cwd: checkout,
      env: { ...process.env, ...lookupEnvironment },
      stdio: 'ignore',
    }).status === 0,
  /** Nothing may be skipped. */
  required: process.env['DEVFLEET_TEST_LITESTREAM'] === 'required',
  /** The origin of a throwaway S3 service, such as http://127.0.0.1:5000. */
  s3: process.env['DEVFLEET_TEST_S3'],
};

/** Whether a scenario carrying these tags is skipped here. */
export function skipped(tags: string[]): boolean {
  const { installed, required, s3 } = requirements;
  // `@linux`: the scenario runs a worker's own script, which uses what
  // Ubuntu has (sha256sum). No requirement can make another system run it.
  if (tags.includes('@linux') && process.platform !== 'linux') return true;
  if (tags.includes('@required')) return !required;
  if (required) return false;
  return (
    (tags.includes('@litestream') && !installed) ||
    (tags.includes('@s3') && !s3)
  );
}

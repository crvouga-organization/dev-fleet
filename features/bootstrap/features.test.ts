import { existsSync } from 'node:fs';
import { runFeatures } from '../support/gherkin';
import { BootstrapWorld, bootstrap } from './steps';
import { pwsh } from './steps/windows';

// What a tagged scenario needs and this machine may not have.
const missing: Record<string, boolean> = {
  '@linux': process.platform !== 'linux',
  '@bash': !existsSync('/bin/bash'),
  '@zsh': !existsSync('/bin/zsh'),
  // Skipped where no PowerShell is on PATH, unless DEVFLEET_TEST_PWSH=required
  // (CI), where a missing one fails the scenarios instead.
  '@pwsh': pwsh() === null && process.env['DEVFLEET_TEST_PWSH'] !== 'required',
  // pnpm comes from mise.toml; CI installs it and sets
  // DEVFLEET_TEST_PNPM=required, where a missing one fails the scenarios.
  '@pnpm':
    Bun.which('pnpm') === null &&
    process.env['DEVFLEET_TEST_PNPM'] !== 'required',
};

runFeatures({
  directory: import.meta.dir,
  steps: bootstrap,
  world: () => new BootstrapWorld(),
  skip: (tags) => tags.some((tag) => missing[tag]),
});

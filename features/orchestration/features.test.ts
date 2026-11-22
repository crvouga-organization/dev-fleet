import { runFeatures } from '../support/gherkin';
import { OrchestrationWorld, orchestration } from './steps';

runFeatures({
  directory: import.meta.dir,
  steps: [orchestration],
  world: () => new OrchestrationWorld(),
  // `@posix`: the scenario runs a POSIX shell; `@linux`: it runs a worker's
  // own script, which uses what Ubuntu has (sha256sum).
  skip: (tags) =>
    (tags.includes('@posix') && process.platform === 'win32') ||
    (tags.includes('@linux') && process.platform !== 'linux'),
  timeoutMs: 30_000,
});

import { runFeatures } from '../support/gherkin';
import { RulesWorld, rules } from './steps';
import './contracts';
import './fresh-box-image';
import './heartbeat-steps';
import './worker-requirements';

runFeatures({
  directory: import.meta.dir,
  steps: [rules],
  world: () => new RulesWorld(),
  timeoutMs: 30_000,
});

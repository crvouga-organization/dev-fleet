import { runFeatures } from '../support/gherkin';
import { AccountsWorld, accounts } from './steps';
import './proxy-box';

// The pinned proxy in a container downloads its image: run on request.
//   HOMELAB_TEST_PROXY_BOX=1 bun test features/accounts
runFeatures({
  directory: import.meta.dir,
  steps: [accounts],
  world: () => new AccountsWorld(),
  skip: (tags) =>
    tags.includes('@proxy-box') && !process.env['HOMELAB_TEST_PROXY_BOX'],
});

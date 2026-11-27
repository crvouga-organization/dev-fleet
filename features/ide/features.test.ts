import { runFeatures } from '../support/gherkin';
import { IdeWorld, ide } from './steps/world';
import './steps/seam';
import './steps/profile';
import './steps/client-settings';
import './steps/customizations';
import './steps/models';
import './steps/manager';
import './steps/pairing';
import './steps/mesh';
import './steps/work-in-progress';
import './steps/super';
import './steps/remote-mesh';

runFeatures({
  directory: import.meta.dir,
  steps: [ide],
  world: () => new IdeWorld(),
  skip: (tags) =>
    (tags.includes('@posix') && process.platform === 'win32') ||
    (tags.includes('@t3-desktop') &&
      !process.env['HOMELAB_TEST_MANAGER_DESKTOP']),
  timeoutMs: 30_000,
});

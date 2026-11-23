import { runFeatures } from '../support/gherkin';
import { ansibleAvailable } from '../agents/support/ansible';
import './steps/steps';
import './steps/git-play';
import { GithubWorld, github } from './steps/world';

runFeatures({
  directory: import.meta.dir,
  steps: [github],
  world: () => new GithubWorld(),
  skip: (tags) => tags.includes('@ansible') && !ansibleAvailable,
});

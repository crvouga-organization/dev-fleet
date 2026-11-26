import { expect } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { convergeGitIdentity } from '../../../src/git-identity';
import { ansibleCommand } from '../../../src/platform/ansible';
import { runCommand } from '../../../src/runner';
import type { CommandResult } from '../../../src/types';
import { github, type GithubWorld } from './world';

/** The real ansible/github/git.yml, run by the locked Ansible against a home
 * directory of the scenario's: Git reads that home's files, Ansible keeps
 * its own state beside them, and nothing of the test machine's is touched.
 */
const { Given, When, Then } = github;

const checkout = resolve(import.meta.dir, '../../..');

interface Node {
  home: string;
  scratch: string;
  gitconfig?: string;
  play?: CommandResult;
}

const nodes = new WeakMap<GithubWorld, Node>();

async function node(world: GithubWorld): Promise<Node> {
  const known = nodes.get(world);
  if (known) return known;
  const scratch = await mkdtemp(join(tmpdir(), 'git-play-'));
  world.defer(() => rm(scratch, { recursive: true, force: true }));
  const home = join(scratch, 'home');
  await mkdir(home, { recursive: true });
  const made: Node = { home, scratch };
  nodes.set(world, made);
  return made;
}

/** A newline is written ␊ in a table cell. */
const lines = (text: string) => text.replaceAll('␊', '\n').trimEnd() + '\n';

Given(/^the node's ~\/\.gitconfig holds:$/, async (world, text: string) => {
  const at = await node(world);
  at.gitconfig = lines(text);
  await writeFile(join(at.home, '.gitconfig'), at.gitconfig);
});

When(
  /^the Git identity "([^"]+)" <([^>]+)> is converged on the node$/,
  async (world, name: string, email: string) => {
    const at = await node(world);
    world.checks = await convergeGitIdentity(
      checkout,
      { name, email },
      async (command, options) => {
        const playbook = command.indexOf('ansible-playbook');
        at.play = await runCommand(
          [
            ...ansibleCommand('darwin', checkout),
            ...command.slice(playbook + 1),
          ],
          {
            ...options,
            env: {
              ...options?.env,
              ANSIBLE_HOME: join(at.scratch, 'ansible'),
              ANSIBLE_LOCAL_TEMP: join(at.scratch, 'tmp'),
              ANSIBLE_NOCOLOR: '1',
            },
          }
        );
        return at.play;
      },
      at.home
    );
  }
);

Then('the play stopped with {string}', async (world, code: string) => {
  const at = await node(world);
  expect(at.play?.ok).toBe(false);
  expect(`${at.play?.stdout}${at.play?.stderr}`).toContain(code);
});

Then(/^the node's ~\/\.gitconfig is as it was$/, async (world) => {
  const at = await node(world);
  expect(await readFile(join(at.home, '.gitconfig'), 'utf8')).toBe(
    at.gitconfig!
  );
});

Given(
  'the fleet gh shim refuses to run inside a project containing mise.toml',
  async (world) => {
    const { home } = await node(world);
    const shims = join(home, '.local/share/mise/shims');
    await mkdir(shims, { recursive: true });
    await writeFile(
      join(shims, 'gh'),
      `#!/bin/sh
test ! -f mise.toml && test "$*" = 'auth git-credential get' || exit 1
echo username=fixture
echo password=fixture-password
`,
      { mode: 0o755 }
    );
    const cwd = join(home, 'checkout');
    await mkdir(cwd);
    await writeFile(join(cwd, 'mise.toml'), '[tools]\n');
    expect((await runCommand(['git', 'init', '--quiet'], { cwd })).ok).toBe(
      true
    );
  }
);

Then(
  'Git obtains the fixture credential inside the untrusted checkout',
  async (world) => {
    const { home } = await node(world);
    const result = await runCommand(['git', 'credential', 'fill'], {
      cwd: join(home, 'checkout'),
      env: {
        HOME: home,
        XDG_CONFIG_HOME: join(home, '.config'),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
      input: 'protocol=https\nhost=github.com\n\n',
    });
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain('password=fixture-password');
  }
);

import { expect } from 'bun:test';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ANCESTRY_GUARD } from '../../../src/cli/fleet-sync-forward';
import { defaultBranchHolds } from '../../../src/machine/source';
import type { Runner } from '../../../src/types';
import { ROOT, fleetSync } from '../support/world';
import { git, manager, sha, type Manager } from './run-script';

/** Whether the default branch of the source repository holds a revision, as
 * the manager's own copy of it says: the real Git, against the repositories
 * the run-script steps make in a manager's home.
 */
const { Given, When, Then } = fleetSync;

/** Starts what fleet-sync would, with the home and identity of the manager. */
const real =
  (node: Manager): Runner =>
  (command, options) => {
    let ok = false;
    let stdout = '';
    try {
      const result = Bun.spawnSync(command, {
        env: node.env,
        ...(options?.cwd ? { cwd: options.cwd } : {}),
      });
      ok = result.exitCode === 0;
      stdout = result.stdout.toString();
    } catch {
      // A directory that is not there yet: the command could not start.
    }
    return Promise.resolve({ ok, stdout, stderr: '', reason: 'exit' });
  };

/** A commit on a branch of its own, named after its message. */
function onBranch(node: Manager, message: string, write: () => void): void {
  git(node, node.origin, 'checkout', '--quiet', '-b', message);
  write();
  git(node, node.origin, 'add', '--all');
  git(node, node.origin, 'commit', '--quiet', '--message', message);
  node.commits.set(message, git(node, node.origin, 'rev-parse', 'HEAD'));
  git(node, node.origin, 'checkout', '--quiet', 'main');
}

Given(
  /^a branch of the fleet's source repository holds the commit "([^"]*)"$/,
  (world, message: string) => {
    const node = manager(world);
    onBranch(node, message, () =>
      writeFileSync(join(node.origin, 'file'), message)
    );
  }
);

Given(
  /^a branch of the fleet's source repository holds the commit "([^"]*)", whose mise\.toml pins mise "([^"]*)"$/,
  (world, message: string, pinned: string) => {
    const node = manager(world);
    onBranch(node, message, () => {
      // The toolchain bootstrap of this checkout, and the pin it reads. No
      // archive is downloaded in these scenarios, so the digests are unused.
      mkdirSync(join(node.origin, 'bootstrap'), { recursive: true });
      copyFileSync(
        resolve(ROOT, 'bootstrap/bootstrap.sh'),
        join(node.origin, 'bootstrap/bootstrap.sh')
      );
      writeFileSync(
        join(node.origin, 'mise.toml'),
        [
          `min_version = "${pinned}"`,
          '[vars]',
          ...['linux_x64', 'linux_arm64', 'macos_x64', 'macos_arm64'].map(
            (platform) => `mise_${platform}_sha256 = "${'0'.repeat(64)}"`
          ),
          '',
        ].join('\n')
      );
    });
  }
);

Given(
  'the branch that holds the commit {string} is merged into the default branch',
  (world, message: string) => {
    const node = manager(world);
    git(node, node.origin, 'merge', '--quiet', '--ff-only', sha(node, message));
  }
);

Given("the fleet's source repository can no longer be reached", (world) => {
  const node = manager(world);
  renameSync(node.origin, `${node.origin}.gone`);
});

Given(
  'the manager runs mise {string}, and the toolchain bootstrap really runs',
  (world, version: string) => {
    const node = manager(world);
    const bin = join(node.home, '.local/bin');
    const calls = join(node.home, 'calls');
    // mise says its version and records every other call; a download would
    // be recorded too, and fail.
    writeFileSync(
      join(bin, 'mise'),
      `#!/bin/sh\nif [ "$1" = --version ]; then echo "${version} fixture"; exit 0; fi\necho "mise $*" >> ${calls}\n`
    );
    writeFileSync(
      join(bin, 'curl'),
      `#!/bin/sh\necho "curl $*" >> ${calls}\nexit 1\n`
    );
    chmodSync(join(bin, 'curl'), 0o755);
    rmSync(join(bin, 'bash'));
  }
);

When(
  /^the manager's copy of the source repository is asked whether the default branch holds (?:the commit "([^"]*)"|the revision "([a-f0-9]{40})")$/,
  async (world, message: string | undefined, revision: string | undefined) => {
    const node = manager(world);
    world.answer = await defaultBranchHolds(
      dirname(node.cache),
      revision ?? sha(node, message!),
      real(node),
      node.origin
    );
  }
);

When(
  /^the guard of a hand-off runs on the manager for (?:the commit "([^"]*)"|the revision "([a-f0-9]{40})")$/,
  (world, message: string | undefined, revision: string | undefined) => {
    const node = manager(world);
    world.answer = Bun.spawnSync(
      [
        '/bin/sh',
        '-c',
        ANCESTRY_GUARD,
        'fleet-revision-guard',
        revision ?? sha(node, message!),
      ],
      { env: node.env }
    ).exitCode;
  }
);

Then('the guard exits with {int}', (world, code: number) => {
  expect(world.answer).toBe(code);
});

Then('the manager still runs mise {string}', (world, version: string) => {
  const node = manager(world);
  const printed = Bun.spawnSync(
    [join(node.home, '.local/bin/mise'), '--version'],
    { env: node.env }
  ).stdout.toString();
  expect(printed.split(' ')[0]).toBe(version);
});

Then(
  'the toolchain setup log of the commit {string} says {string}',
  (world, message: string, text: string) => {
    const node = manager(world);
    expect(
      readFileSync(join(node.runs, `${sha(node, message)}.setup.log`), 'utf8')
    ).toContain(text);
  }
);

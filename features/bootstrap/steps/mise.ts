import { expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { steps } from '../../support/gherkin';
import { part, type BootstrapWorld } from './world';

/** The real bootstrap/bootstrap.sh, in a home of its own. Its download is
 * answered with an archive made here, whose digest the checkout's mise.toml
 * pins; the mise in that home says its version and records every other call.
 */
export const mise = steps<BootstrapWorld>();
const { Given, When, Then } = mise;

const BOOTSTRAP = resolve(import.meta.dir, '../../../bootstrap/bootstrap.sh');
const PLATFORM = `${process.platform === 'darwin' ? 'macos' : 'linux'}_${
  process.arch === 'arm64' ? 'arm64' : 'x64'
}`;

/** A mise that says it is `version`, and records how else it is called. */
const standIn = (version: string, calls: string): string =>
  `#!/bin/sh\nif [ "$1" = --version ]; then echo "${version} fixture"; exit 0; fi\necho "mise $*" >> ${calls}\n`;

function executable(path: string, text: string): void {
  writeFileSync(path, text);
  chmodSync(path, 0o755);
}

const machine = part((world) => {
  const root = world.directory('bootstrap-mise-');
  const home = join(root, 'home');
  const tools = join(root, 'tools');
  const checkout = join(root, 'checkout');
  const calls = join(root, 'calls');
  for (const directory of [home, tools, join(checkout, 'bootstrap')])
    mkdirSync(directory, { recursive: true });
  writeFileSync(calls, '');
  copyFileSync(BOOTSTRAP, join(checkout, 'bootstrap/bootstrap.sh'));
  // The download: the archive of the release the checkout pins, when asked.
  executable(
    join(tools, 'curl'),
    [
      '#!/bin/sh',
      `echo "curl $*" >> ${calls}`,
      'while [ "$#" -gt 0 ]; do [ "$1" != -o ] || out=$2; shift; done',
      `cp ${join(root, 'release.tar.gz')} "$out"`,
      '',
    ].join('\n')
  );
  executable(join(tools, 'unzip'), '#!/bin/sh\n');
  return {
    root,
    home,
    checkout,
    calls,
    env: { HOME: home, PATH: `${tools}:/usr/bin:/bin` },
    said: '',
  };
});

Given('a machine that runs mise {string}', (world, version: string) => {
  const { home, calls } = machine(world);
  mkdirSync(join(home, '.local/bin'), { recursive: true });
  executable(join(home, '.local/bin/mise'), standIn(version, calls));
});

Given('a machine that has no mise', (world) => {
  expect(existsSync(join(machine(world).home, '.local/bin/mise'))).toBe(false);
});

Given(
  'a checkout whose mise.toml pins mise {string}',
  (world, version: string) => {
    const { root, checkout, calls, env } = machine(world);
    // The release archive of that version, as its publisher lays it out.
    mkdirSync(join(root, 'release/mise/bin'), { recursive: true });
    executable(join(root, 'release/mise/bin/mise'), standIn(version, calls));
    const packed = spawnSync(
      'tar',
      [
        '-czf',
        join(root, 'release.tar.gz'),
        '-C',
        join(root, 'release'),
        'mise',
      ],
      { env }
    );
    expect(packed.status).toBe(0);
    const digest = createHash('sha256')
      .update(readFileSync(join(root, 'release.tar.gz')))
      .digest('hex');
    writeFileSync(
      join(checkout, 'mise.toml'),
      `min_version = "${version}"\n[vars]\nmise_${PLATFORM}_sha256 = "${digest}"\n`
    );
  }
);

When(
  /^the checkout's bootstrap runs with "([^"]*)"$/,
  (world, flags: string) => {
    const { checkout, env } = machine(world);
    const result = spawnSync(
      '/bin/bash',
      [join(checkout, 'bootstrap/bootstrap.sh'), ...flags.split(' ')],
      { env, encoding: 'utf8' }
    );
    world.exit = result.status;
    machine(world).said = result.stderr;
  }
);

Then('the machine runs mise {string}', (world, version: string) => {
  const { home, env } = machine(world);
  const printed = spawnSync(join(home, '.local/bin/mise'), ['--version'], {
    env,
    encoding: 'utf8',
  }).stdout;
  expect(printed.split(' ')[0]).toBe(version);
});

Then(
  /^the bootstrap downloaded (nothing|the mise release "[^"]*")$/,
  (world, what: string) => {
    const version = /"([^"]*)"/.exec(what)?.[1];
    const downloads = readFileSync(machine(world).calls, 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('curl '));
    if (!version) expect(downloads).toEqual([]);
    else {
      expect(downloads).toHaveLength(1);
      expect(downloads[0]).toContain(`/v${version}/mise-v${version}-`);
    }
  }
);

Then('the bootstrap says {string}', (world, text: string) => {
  expect(machine(world).said).toContain(text);
});

Then('the bootstrap does not say {string}', (world, text: string) => {
  expect(machine(world).said).not.toContain(text);
});

Then(
  'the bootstrap went on to install the pinned tools with the mise of that machine',
  (world) => {
    expect(readFileSync(machine(world).calls, 'utf8')).toContain(
      'mise install --locked bun'
    );
  }
);

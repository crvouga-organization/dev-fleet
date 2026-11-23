import { expect } from 'bun:test';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { steps, type DataTable } from '../../support/gherkin';
import { part, type BootstrapWorld } from './world';

const MISE_TOML = resolve(import.meta.dir, '../../../mise.toml');

/** The [env] of mise.toml, with its one template, the home, filled in. */
function declaredEnvironment(home: string): Record<string, string> {
  const { env } = Bun.TOML.parse(readFileSync(MISE_TOML, 'utf8')) as {
    env: Record<string, string>;
  };
  return Object.fromEntries(
    Object.entries(env).map(([name, value]) => [
      name,
      value.replaceAll('{{env.HOME}}', home),
    ])
  );
}

const stores = part((world) => ({
  home: '',
  root: world.directory('package-stores-'),
  environment: {} as Record<string, string>,
  tarball: '',
  name: '',
  worktrees: [] as string[],
}));

export const packageStores = steps<BootstrapWorld>();
const { Given, When, Then } = packageStores;

When(
  'the environment mise.toml declares for every fleet machine is read with the home {string}',
  (world, home: string) => {
    stores(world).environment = declaredEnvironment(home);
  }
);

Then('it sets:', (world, table: DataTable) => {
  const { environment } = stores(world);
  for (const [name, value] of table.raw())
    expect(`${name}=${environment[name!]}`).toBe(`${name}=${value}`);
});

Given(
  'a home directory with the environment mise.toml declares for every fleet machine',
  (world) => {
    const state = stores(world);
    state.home = join(state.root, 'home');
    mkdirSync(state.home);
    state.environment = declaredEnvironment(state.home);
  }
);

Given('a package {string} packed as a tarball', (world, name: string) => {
  const state = stores(world);
  const source = join(state.root, 'package');
  mkdirSync(source);
  writeFileSync(
    join(source, 'package.json'),
    JSON.stringify({ name, version: '1.0.0' })
  );
  writeFileSync(join(source, 'index.js'), 'module.exports = 1;\n');
  state.tarball = join(state.root, `${name}.tgz`);
  const packed = Bun.spawnSync([
    'tar',
    '-czf',
    state.tarball,
    '-C',
    state.root,
    '--transform',
    's,^package,package,',
    'package',
  ]);
  expect(packed.exitCode).toBe(0);
  state.name = name;
});

Given(
  'two worktrees {string} and {string} that depend on it',
  (world, first: string, second: string) => {
    const state = stores(world);
    for (const name of [first, second]) {
      const worktree = join(state.home, '.t3/worktrees/project', name);
      mkdirSync(worktree, { recursive: true });
      writeFileSync(
        join(worktree, 'package.json'),
        JSON.stringify({
          name,
          version: '1.0.0',
          dependencies: { [state.name]: `file:${state.tarball}` },
        })
      );
      state.worktrees.push(worktree);
    }
  }
);

When('pnpm installs each worktree offline', (world) => {
  const state = stores(world);
  for (const worktree of state.worktrees) {
    const out = Bun.spawnSync(['pnpm', 'install', '--offline'], {
      cwd: worktree,
      env: { ...process.env, HOME: state.home, ...state.environment },
    });
    expect(out.stderr.toString()).toBe('');
    expect(out.exitCode).toBe(0);
  }
});

Then(
  '{string} of {string} is one file on disk in both worktrees',
  (world, file: string, name: string) => {
    const { worktrees } = stores(world);
    const [one, two] = worktrees.map((worktree) =>
      statSync(join(worktree, 'node_modules', name, file))
    );
    expect(one!.ino).toBe(two!.ino);
    expect(one!.nlink).toBeGreaterThan(1);
  }
);

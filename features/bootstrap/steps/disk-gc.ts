import { expect } from 'bun:test';
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { steps, type DataTable } from '../../support/gherkin';
import { part, type BootstrapWorld } from './world';

const gc = resolve(import.meta.dir, '../../../ansible/ubuntu/disk-gc.py');
const DAY = 24 * 3600;

/** What the collector is told when it measures a filesystem, whichever one. */
interface Disk {
  freeMib: number;
  inodesFreePercent: number;
  /** The size of the filesystem; twice what is free unless a scenario says. */
  sizeMib?: number;
}

interface Event {
  event: string;
  step?: string;
  dry_run?: boolean;
  reclaimed_mib?: number;
  until_hours?: number | null;
}

const collector = part((world) => {
  // Resolved, as the working directory of a real process always is: on macOS
  // the temporary directory is reached through a link.
  const home = realpathSync(world.directory('disk-gc-'));
  const proc = join(home, 'proc');
  mkdirSync(proc);
  return {
    home,
    repo: join(home, 'project'),
    /** A stand-in for /proc: what each running process has as its directory. */
    proc,
    /** Top-level entries the checkout ignores, without the trailing slash. */
    ignored: [] as string[],
    files: [] as string[],
    options: [] as string[],
    events: [] as Event[],
    worktree: '',
    cache: '',
    mise: '',
    disk: undefined as Disk | undefined,
    /** Where a stand-in for lsof is, when the scenario has one. */
    bin: '',
  };
});

/** The collector, measuring the scenario's disk instead of the machine's.
 *
 * It is the deployed file, run unchanged behind a stand-in for `os.statvfs`.
 * The stand-in is a file of its own so that the collector's second run of
 * itself, as the development user, measures the same disk.
 */
function collectorOn(world: BootstrapWorld): string {
  const { disk } = collector(world);
  if (!disk) throw new Error('The scenario does not say what the disk holds.');
  const blocks = disk.freeMib * 256;
  const size = (disk.sizeMib ?? disk.freeMib * 2) * 256;
  const script = join(world.directory('disk-gc-disk-'), 'disk-gc.py');
  writeFileSync(
    script,
    [
      'import os, types',
      'DISK = types.SimpleNamespace(',
      `    f_frsize=4096, f_blocks=${size}, f_bavail=${blocks}, f_bfree=${blocks},`,
      `    f_files=1000000, f_favail=${Math.round(disk.inodesFreePercent * 10000)})`,
      'os.statvfs = lambda path: DISK',
      `exec(compile(open(${JSON.stringify(gc)}).read(), ${JSON.stringify(gc)}, 'exec'))`,
      '',
    ].join('\n')
  );
  return script;
}

function eventsOf(stdout: Uint8Array): Event[] {
  return stdout
    .toString()
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Event);
}

function git(cwd: string, ...args: string[]): void {
  const out = Bun.spawnSync(['git', '-c', 'safe.directory=*', ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
  });
  expect(out.exitCode).toBe(0);
}

export const diskGc = steps<BootstrapWorld>();
const { Given, When, Then } = diskGc;

Given(
  'a home directory with one checkout that ignores:',
  (world, table: DataTable) => {
    const state = collector(world);
    mkdirSync(state.repo);
    writeFileSync(
      join(state.repo, '.gitignore'),
      table.list().join('\n') + '\n'
    );
    state.ignored = table.list().map((entry) => entry.replace(/\/$/, ''));
  }
);

Given(
  'the checkout holds these files, all committed except the ignored ones:',
  (world, table: DataTable) => {
    const state = collector(world);
    state.files = table.list();
    for (const file of state.files) {
      mkdirSync(dirname(join(state.repo, file)), { recursive: true });
      writeFileSync(join(state.repo, file), 'x');
    }
    git(state.repo, 'init', '--quiet');
    git(state.repo, 'add', '.');
    git(state.repo, 'commit', '--quiet', '-m', 'fixture');
  }
);

/** Last used: the checkout, what Git touches on every command, the ignored
 * directories and every tracked file all carry that time.
 */
Given(/^the checkout was last used (\d+) days? ago$/, (world, days: string) => {
  const { repo, ignored, files } = collector(world);
  const when = Date.now() / 1000 - Number(days) * DAY;
  const tracked = files.filter(
    (file) => !ignored.includes(file.split('/')[0]!)
  );
  for (const path of [
    repo,
    join(repo, '.git', 'index'),
    join(repo, '.git', 'HEAD'),
    join(repo, '.git', 'logs', 'HEAD'),
    ...ignored.map((entry) => join(repo, entry)),
    ...tracked.map((file) => join(repo, file)),
  ])
    utimesSync(path, when, when);
});

Given(
  '{string} was edited just now and not committed',
  (world, file: string) => {
    writeFileSync(join(collector(world).repo, file), 'changed');
  }
);

Given(
  'a process is running in {string} of the checkout',
  (world, directory: string) => {
    const { repo, proc } = collector(world);
    mkdirSync(join(proc, '4242'));
    symlinkSync(join(repo, directory), join(proc, '4242', 'cwd'));
  }
);

Given(
  /^a disk with (\d+) MiB and ([\d.]+)% of its inodes free$/,
  (world, free: string, inodes: string) => {
    collector(world).disk = {
      freeMib: Number(free),
      inodesFreePercent: Number(inodes),
    };
  }
);

Given('old, open and recent files in the host temporary caches', (world) => {
  const { home, proc, options } = collector(world);
  const bin = world.directory('fixture-processes-');
  writeFileSync(join(bin, 'ps'), '#!/bin/sh\necho idle', { mode: 0o755 });
  collector(world).bin = bin;
  const root = join(home, 'host-tmp');
  const old = Date.now() / 1000 - 10 * DAY;
  for (const file of [
    'metro-cache/stale',
    'node-compile-cache/open',
    'metro-cache/new',
    'other/keep',
  ]) {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'cache');
    if (!file.endsWith('/new')) utimesSync(path, old, old);
  }
  for (const [suffix, packageName] of [
    ['native', 'native'],
    ['project', 'different'],
  ]) {
    const dir = join(root, '.123abc-1.' + suffix);
    mkdirSync(dir);
    const manifest = join(dir, 'package.json');
    writeFileSync(
      manifest,
      JSON.stringify({ name: packageName, version: '1.0.0' })
    );
    utimesSync(manifest, old, old);
    utimesSync(dir, old, old);
  }
  symlinkSync(join(root, 'other'), join(root, 'metro-cache', 'link'));
  mkdirSync(join(proc, '123', 'fd'), { recursive: true });
  symlinkSync(home, join(proc, '123', 'cwd'));
  symlinkSync('/var/tmp/node-compile-cache/open', join(proc, '123', 'fd', '3'));
  writeFileSync(join(proc, '123', 'maps'), '');
  options.push('--host-var-tmp', root, '--home-cache-mib', '32');
});

When(/^the disk GC runs( as a dry run)?$/, (world, dry: string | undefined) =>
  runCollector(world, Boolean(dry))
);

When('the disk GC runs with these limits:', (world, table: DataTable) => {
  collector(world).options.push(...table.raw().flat());
  runCollector(world, false);
});

function runCollector(world: BootstrapWorld, dry: boolean): void {
  const state = collector(world);
  const out = Bun.spawnSync(
    [
      'python3',
      '-I',
      '-B',
      collectorOn(world),
      '--home',
      state.home,
      '--path',
      state.home,
      '--proc',
      state.proc,
      // Never prune the machine's own Docker or apt cache.
      '--home-only',
      ...state.options,
      ...(dry ? ['--dry-run'] : []),
    ],
    {
      env: {
        ...process.env,
        PATH: [state.bin, process.env['PATH'] ?? ''].filter(Boolean).join(':'),
      },
    }
  );
  expect(out.stderr.toString()).toBe('');
  expect(out.exitCode).toBe(0);
  state.events = eventsOf(out.stdout);
}

Then('these are gone from the checkout:', (world, table: DataTable) => {
  for (const path of table.list())
    expect(`${path}: ${existsSync(join(collector(world).repo, path))}`).toBe(
      `${path}: false`
    );
});

Then('these are still in the checkout:', (world, table: DataTable) => {
  for (const path of table.list())
    expect(`${path}: ${existsSync(join(collector(world).repo, path))}`).toBe(
      `${path}: true`
    );
});

Then('it reports a removal marked as a dry run', (world) => {
  expect(
    collector(world).events.some(
      (event) => event.event === 'removed' && event.dry_run === true
    )
  ).toBe(true);
});

// ── Stores that only grow ───────────────────────────────────────────────

const MIB = 1024 * 1024;

Given('the checkout has a remote that holds its commits', (world) => {
  const { home, repo } = collector(world);
  const origin = join(home, 'origin.git');
  git(home, 'init', '--quiet', '--bare', origin);
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main');
  git(repo, 'fetch', '--quiet', 'origin');
});

Given(
  /^an agent worktree "([^"]+)" of the checkout under "([^"]+)" with (.+)$/,
  (world, name: string, under: string, work: string) => {
    const state = collector(world);
    const worktree = join(state.home, under, name);
    mkdirSync(dirname(worktree), { recursive: true });
    git(state.repo, 'worktree', 'add', '--quiet', '-b', name, worktree);
    state.worktree = worktree;
    const commit = () => {
      writeFileSync(join(worktree, 'src/main.ts'), 'fixed');
      git(worktree, 'commit', '--quiet', '-am', 'fix');
    };
    const origin = join(state.home, 'origin.git');
    switch (work) {
      case 'nothing unsaved':
        break;
      case 'a commit no remote holds':
        commit();
        break;
      case 'an uncommitted edit':
        writeFileSync(join(worktree, 'src/main.ts'), 'half done');
        break;
      case 'an untracked file':
        writeFileSync(join(worktree, 'notes.md'), 'ideas');
        break;
      case 'a process running in it':
        mkdirSync(join(state.proc, '4343'));
        symlinkSync(worktree, join(state.proc, '4343', 'cwd'));
        break;
      // The WIP guard itself saves it, as it does every 15 minutes on a
      // worker; the GC is told the same node name.
      case 'an uncommitted edit the WIP guard saved':
        writeFileSync(join(worktree, 'src/main.ts'), 'half done');
        wipGuard(state.home, under);
        break;
      case 'a commit no remote holds, which the WIP guard saved':
        commit();
        wipGuard(state.home, under);
        break;
      case 'an uncommitted edit the WIP guard saved 40 days ago':
        writeFileSync(join(worktree, 'src/main.ts'), 'half done');
        wipGuard(state.home, under, Date.now() / 1000 - 40 * DAY);
        break;
      // A pull request merged with a merge commit, or fast-forward.
      case "a commit merged into the remote's main branch":
        commit();
        git(worktree, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main');
        break;
      // A pull request squashed and its branch deleted on the remote.
      case 'a pushed commit whose branch was deleted on the remote':
        commit();
        git(worktree, 'push', '--quiet', '-u', 'origin', name);
        git(origin, 'branch', '--quiet', '-D', name);
        break;
      case 'a branch pushed with no commit of its own':
        git(worktree, 'push', '--quiet', '-u', 'origin', name);
        break;
      default:
        throw new Error(`Unknown work in a worktree: ${work}`);
    }
  }
);

/** The node name the WIP guard and the disk GC are given in a scenario. */
const NODE = 'scenario-node';

/** Runs the deployed WIP guard over the worktrees under `under`, its
 * snapshot dated `when` (seconds) when given. */
function wipGuard(home: string, under: string, when?: number): void {
  const guard = resolve(
    import.meta.dir,
    '../../../ansible/ubuntu/wip-guard.py'
  );
  const out = Bun.spawnSync(
    ['python3', '-I', '-B', guard, '--root', join(home, under), '--node', NODE],
    {
      env: {
        ...process.env,
        ...(when === undefined
          ? {}
          : { GIT_COMMITTER_DATE: `@${Math.floor(when)} +0000` }),
      },
    }
  );
  expect(out.exitCode).toBe(0);
  expect(out.stdout.toString()).toContain('"pushed"');
}

When(
  'the disk GC of a disposable fleet runs with these limits:',
  (world, table: DataTable) => {
    collector(world).options.push(
      '--disposable',
      '--recovery-node',
      NODE,
      ...table.raw().flat()
    );
    runCollector(world, false);
  }
);

/** Every file of the worktree and what Git touches for it carry that time,
 * so only what is in it can keep it. */
Given(/^the worktree was last used (\d+) days ago$/, (world, days: string) => {
  const { repo, worktree } = collector(world);
  const when = Date.now() / 1000 - Number(days) * DAY;
  const admin = join(repo, '.git', 'worktrees', basename(worktree));
  const paths = [
    join(admin, 'index'),
    join(admin, 'HEAD'),
    join(admin, 'logs', 'HEAD'),
  ];
  const walk = (directory: string): void => {
    paths.push(directory);
    for (const entry of readdirSync(directory, { withFileTypes: true }))
      if (entry.isDirectory()) walk(join(directory, entry.name));
      else paths.push(join(directory, entry.name));
  };
  walk(worktree);
  for (const path of paths) if (existsSync(path)) utimesSync(path, when, when);
});

Then(/^the worktree is (removed|kept)$/, (world, verdict: string) => {
  const { repo, worktree } = collector(world);
  expect(existsSync(worktree)).toBe(verdict === 'kept');
  // The branch outlives its worktree.
  git(
    repo,
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/heads/${basename(worktree)}`
  );
});

Given(
  'the cache {string} holds {int} files of {int} MiB, written an hour apart',
  (world, cache: string, count: number, size: number) => {
    const state = collector(world);
    state.cache = join(state.home, cache);
    mkdirSync(join(state.cache, 'packages'), { recursive: true });
    const now = Date.now() / 1000;
    for (let index = 0; index < count; index += 1) {
      const path = join(state.cache, 'packages', `entry-${index}`);
      writeFileSync(path, Buffer.alloc(size * MIB, 1));
      const when = now - (count - index) * 3600;
      utimesSync(path, when, when);
    }
  }
);

const cacheFiles = (cache: string): string[] =>
  readdirSync(join(cache, 'packages')).sort();

Then(
  'the cache {string} holds {int} MiB or less',
  (world, _cache: string, mib: number) => {
    const { cache } = collector(world);
    const total = cacheFiles(cache).reduce(
      (sum, name) => sum + statSync(join(cache, 'packages', name)).size,
      0
    );
    expect(total).toBeLessThanOrEqual(mib * MIB);
  }
);

Then('the newest file of the cache is still there', (world) => {
  expect(cacheFiles(collector(world).cache)).toContain('entry-5');
});

Then('the run reports at least {int} MiB reclaimed', (world, mib: number) => {
  const finished = collector(world).events.find(
    (event) => event.event === 'finished'
  );
  expect(finished?.reclaimed_mib).toBeGreaterThanOrEqual(mib);
});

Given(
  'the directory {string} holds these downloads, oldest first:',
  (world, directory: string, table: DataTable) => {
    const target = join(collector(world).home, directory);
    mkdirSync(target);
    const now = Date.now() / 1000;
    table.list().forEach((name, index, names) => {
      writeFileSync(join(target, name), name);
      const when = now - (names.length - index) * 3600;
      utimesSync(join(target, name), when, when);
    });
  }
);

Then(
  'the directory {string} holds exactly:',
  (world, directory: string, table: DataTable) => {
    expect(readdirSync(join(collector(world).home, directory)).sort()).toEqual(
      table.list().sort()
    );
  }
);

When(
  /^the disk GC dry-runs on the whole machine( without containers)?, with a docker command on its path and a floor of (\d+) MiB free$/,
  (world, without: string | undefined, floor: string) =>
    dockerDryRun(world, Boolean(without), floor)
);

function dockerDryRun(
  world: BootstrapWorld,
  without: boolean,
  floor: string
): void {
  const state = collector(world);
  // A docker that would only record a call: in a dry run none is made.
  const bin = join(state.home, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'docker'), '#!/bin/sh\nexit 0\n', {
    mode: 0o755,
  });
  const out = Bun.spawnSync(
    [
      'python3',
      '-I',
      '-B',
      collectorOn(world),
      '--home',
      state.home,
      '--path',
      state.home,
      '--proc',
      state.proc,
      '--pressure-mib',
      floor,
      '--dry-run',
      ...(without ? ['--no-docker'] : []),
      ...state.options,
    ],
    { env: { ...process.env, PATH: `${bin}:${process.env['PATH'] ?? ''}` } }
  );
  expect(out.exitCode).toBe(0);
  state.events = eventsOf(out.stdout);
}

Then(
  /^the run would prune these Docker steps: (.+)$/,
  (world, expected: string) => {
    expect(
      collector(world)
        .events.filter(
          (event) =>
            event.event === 'would_run' &&
            String(event.step).startsWith('docker_')
        )
        .map((event) => event.step)
    ).toEqual(expected === '(none)' ? [] : expected.split(', '));
  }
);

Then(
  /^the checkout's "([^"]+)" is (gone|kept)$/,
  (world, path: string, verdict: string) => {
    expect(existsSync(join(collector(world).repo, path))).toBe(
      verdict === 'kept'
    );
  }
);

Given('a stand-in for mise that records how it is run', (world) => {
  const state = collector(world);
  state.mise = join(state.home, 'mise');
  writeFileSync(
    state.mise,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${state.mise}.log'\n`,
    { mode: 0o755 }
  );
});

When('the disk GC runs with the stand-in for mise', (world) => {
  const state = collector(world);
  state.options.push('--mise', state.mise);
  runCollector(world, false);
});

Then('the stand-in for mise was run with {string}', (world, args: string) => {
  expect(readFileSync(`${collector(world).mise}.log`, 'utf8')).toBe(
    `${args}\n`
  );
});

Then(
  /^the cache child "([^"]+)" is (removed|kept)$/,
  (world, child: string, state: string) => {
    expect(existsSync(join(collector(world).home, child))).toBe(
      state === 'kept'
    );
  }
);

When(
  'the disk GC runs with the stand-in for mise and these limits:',
  (world, table: DataTable) => {
    const state = collector(world);
    state.options.push('--mise', state.mise, ...table.raw().flat());
    runCollector(world, false);
  }
);

Then(
  /^the package store command "([^"]+)" (ran|was skipped)$/,
  (world, args: string, verdict: string) => {
    const lines = readFileSync(collector(world).mise + '.log', 'utf8')
      .trim()
      .split('\n');
    expect(lines.includes('exec -- ' + args)).toBe(verdict === 'ran');
  }
);

// ── The manager: no /proc ───────────────────────────────────────────────

Given(
  /^lsof answers (with a process in "[^"]+" of the checkout|with processes elsewhere only|with an error)$/,
  (world, answer: string) => {
    const directory = /"([^"]+)"/.exec(answer)?.[1];
    const state = collector(world);
    state.bin = join(state.home, 'bin');
    mkdirSync(state.bin, { recursive: true });
    // What `lsof -F n` prints: p<pid>, f<descriptor>, n<name> on lines.
    const lines = answer.startsWith('with an error')
      ? null
      : [
          'p100',
          'fcwd',
          `n${state.home}/elsewhere`,
          ...(directory
            ? ['p4242', 'fcwd', `n${join(state.repo, directory)}`]
            : []),
        ];
    writeFileSync(
      join(state.bin, 'lsof'),
      lines
        ? `#!/bin/sh\nprintf '%s\\n' ${lines.map((line) => `'${line}'`).join(' ')}\n`
        : '#!/bin/sh\necho "lsof: cannot list processes" >&2\nexit 2\n',
      { mode: 0o755 }
    );
    // /proc is no help: there is none.
    state.options.push('--proc', join(state.home, 'no-proc'), '--lsof');
  }
);

// ── dev-fleet's own checkouts ───────────────────────────────────────────

Given(
  'the directory {string} holds these dev-fleet checkouts, oldest first:',
  (world, directory: string, table: DataTable) => {
    const target = join(collector(world).home, directory);
    const now = Date.now() / 1000;
    table.list().forEach((name, index, names) => {
      mkdirSync(join(target, name, 'node_modules'), { recursive: true });
      writeFileSync(join(target, name, 'node_modules', 'blob'), name);
      const when = now - (names.length - index) * 3600;
      utimesSync(join(target, name), when, when);
    });
  }
);

Given(
  'the link {string} points at the checkout {string} of {string}',
  (world, link: string, name: string, directory: string) => {
    const { home } = collector(world);
    mkdirSync(dirname(join(home, link)), { recursive: true });
    symlinkSync(join(home, directory, name), join(home, link));
  }
);

Given(
  'a process is running in the checkout {string} of {string}',
  (world, name: string, directory: string) => {
    const { home, proc } = collector(world);
    mkdirSync(join(proc, '4444'));
    symlinkSync(join(home, directory, name), join(proc, '4444', 'cwd'));
  }
);

// ── Scratch space ───────────────────────────────────────────────────────

Given(
  'the directory {string} holds these entries:',
  (world, directory: string, table: DataTable) => {
    const target = join(collector(world).home, directory);
    const now = Date.now() / 1000;
    for (const { entry, 'last written': written } of table.hashes()) {
      const hours = Number(/^(\d+) hours? ago$/.exec(written!)?.[1]);
      const when = now - hours * 3600;
      mkdirSync(join(target, entry!), { recursive: true });
      writeFileSync(join(target, entry!, 'output.log'), entry!);
      utimesSync(join(target, entry!, 'output.log'), when, when);
      utimesSync(join(target, entry!), when, when);
    }
  }
);

// ── Pressure as a share of the disk ─────────────────────────────────────

Given(
  /^a disk of (\d+) MiB with (\d+) MiB free$/,
  (world, size: string, free: string) => {
    collector(world).disk = {
      freeMib: Number(free),
      sizeMib: Number(size),
      inodesFreePercent: 50,
    };
  }
);

// ── What fleet-status reads ─────────────────────────────────────────────

Given(
  'the package store {string} holds a file of {int} MiB, linked into the worktree as {string}',
  (world, store: string, mib: number, path: string) => {
    const { home, worktree } = collector(world);
    const stored = join(home, store, 'files', 'blob');
    mkdirSync(dirname(stored), { recursive: true });
    writeFileSync(stored, Buffer.alloc(mib * MIB, 1));
    mkdirSync(dirname(join(worktree, path)), { recursive: true });
    linkSync(stored, join(worktree, path));
  }
);

Then('the report {string} says:', (world, file: string, table: DataTable) => {
  const report = JSON.parse(
    readFileSync(join(collector(world).home, file), 'utf8')
  ) as Record<string, unknown>;
  for (const [field, expected] of table.raw()) {
    const value = report[field!];
    if (expected!.startsWith('at least '))
      expect(`${field}: ${Number(value) >= Number(expected!.slice(9))}`).toBe(
        `${field}: true`
      );
    else
      expect(`${field}: ${JSON.stringify(value)}`).toBe(
        `${field}: ${expected}`
      );
  }
});

Then(
  'the report {string} names how much each of these reclaimed:',
  (world, file: string, table: DataTable) => {
    const report = JSON.parse(
      readFileSync(join(collector(world).home, file), 'utf8')
    ) as { categoriesMiB: Record<string, number> };
    for (const category of table.list())
      expect(typeof report.categoriesMiB[category]).toBe('number');
  }
);

When(
  'the disk GC of a disposable fleet dry-runs on the whole machine, with a docker command on its path and a floor of {int} MiB free',
  (world, floor: number) => {
    collector(world).options.push('--disposable');
    dockerDryRun(world, false, String(floor));
  }
);

Then(
  /^the run would prune (?:Docker images and build cache older than (\d+) hours|every Docker image and all build cache no container uses, whatever their age)$/,
  (world, hours: string | undefined) => {
    const steps = collector(world).events.filter(
      (event) =>
        event.event === 'would_run' &&
        ['docker_images', 'docker_build_cache'].includes(String(event.step))
    );
    expect(steps.map((event) => event.step)).toEqual([
      'docker_images',
      'docker_build_cache',
    ]);
    for (const event of steps)
      expect(event.until_hours ?? null).toBe(hours ? Number(hours) : null);
  }
);

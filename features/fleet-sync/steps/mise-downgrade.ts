import { expect } from 'bun:test';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MISE_GUARD } from '../../../src/cli/fleet-sync-forward';
import {
  ALLOW_MISE_DOWNGRADE_ENV,
  miseDowngrade,
  miseDowngradeRemedy,
  miseRefusalCode,
  type MiseDowngrade,
} from '../../../src/cli/fleet-sync-mise';
import type { Runner } from '../../../src/types';
import type { DataTable } from '../../support/gherkin';
import { fleetSync, type FleetSyncWorld } from '../support/world';
import { git, manager, sha, startRunScript } from './run-script';

/** What a revision's own bootstrap would do to mise: the question the
 * starting run asks, against Git and machines that answer from the scenario;
 * and the guard of a hand-off, run by the real shell against the real Git in
 * a manager's home.
 */
const { Given, When, Then } = fleetSync;

const REVISION = 'e'.repeat(40);
const HOME = '/home/fixture';

/** A toolchain bootstrap as it was before the rule: it installs the mise
 * its revision pins whenever the machine runs another.
 */
const BEFORE_THE_RULE = [
  '#!/usr/bin/env bash',
  'pin() { sed -n "s/^$1 = \\"\\(.*\\)\\"\\$/\\1/p" mise.toml | head -n 1; }',
  'MISE_VERSION=$(pin min_version)',
  'installed_mise=$("$HOME/.local/bin/mise" --version 2>/dev/null | awk \'{print $1}\')',
  'if [[ "$installed_mise" != "$MISE_VERSION" ]]; then install_mise=true; fi',
  '',
].join('\n');

/** One that keeps a newer mise unless it is given the flag. */
const KEEPS_NEWER = `${BEFORE_THE_RULE}for arg; do [[ "$arg" != --allow-mise-downgrade ]] || allow_downgrade=true; done\n`;

interface Asked {
  manager: string;
  workers: string[];
  /** The revision's files, by path; a missing one cannot be shown. */
  files: Map<string, string>;
  /** What each machine answers about its mise. */
  machines: Map<string, string>;
  /** The machines that were asked. */
  measured: string[];
  found: MiseDowngrade | null | undefined;
}
const askeds = new WeakMap<FleetSyncWorld, Asked>();
function asked(world: FleetSyncWorld): Asked {
  let found = askeds.get(world);
  if (!found) {
    found = {
      manager: '',
      workers: [],
      files: new Map(),
      machines: new Map(),
      measured: [],
      found: undefined,
    };
    askeds.set(world, found);
  }
  return found;
}

Given(
  "the fleet's manager is {string} and the run is about to converge the workers {string}",
  (world, id: string, workers: string) => {
    asked(world).manager = id;
    asked(world).workers = workers.split(', ');
  }
);

Given(
  "the revision's mise.toml pins mise {string}",
  (world, pinned: string) => {
    asked(world).files.set(
      'mise.toml',
      `# Shared workstation toolchain.\nmin_version = "${pinned}"\n\n[tools]\nbun = "1.4.4"\n`
    );
  }
);

Given('the revision has no mise.toml', (world) => {
  asked(world).files.delete('mise.toml');
});

Given(
  /^the revision's toolchain bootstrap (is from before the rule that keeps a newer mise|keeps a newer mise)(?:, and holds the line "([^"]*)")?$/,
  (world, kind: string, line: string | undefined) => {
    asked(world).files.set(
      'bootstrap/bootstrap.sh',
      (kind.startsWith('keeps') ? KEEPS_NEWER : BEFORE_THE_RULE) +
        (line ? `${line}\n` : '')
    );
  }
);

Given("the revision's files cannot be read", (world) => {
  asked(world).files.clear();
});

Given('the machines run these mise releases:', (world, table: DataTable) => {
  for (const row of table.hashes())
    asked(world).machines.set(row['machine']!, row['mise']!);
});

/** What a machine answers when asked for its mise: its release; where there
 * is no mise, nothing on the manager (the command is not there) and `none`
 * on a worker, which is asked in a shell; a failed session where the
 * machine does not answer; and whatever else the scenario names, as it is.
 */
function version(state: Asked, machine: string) {
  state.measured.push(machine);
  const mise = state.machines.get(machine) ?? 'no answer';
  const worker = machine !== state.manager;
  const ok = mise !== 'no answer' && (worker || mise !== 'none');
  const released = /^\d/.test(mise);
  return {
    ok,
    stdout: !ok
      ? ''
      : released
        ? `${mise} linux-arm64 (2026-11-01)\n`
        : `${mise}\n`,
    stderr: '',
    reason: mise === 'no answer' ? ('timeout' as const) : ('exit' as const),
  };
}

When(
  "the run asks what the revision's bootstrap would do to mise",
  async (world) => {
    const state = asked(world);
    const run: Runner = (argv) => {
      if (argv[0] === 'git' && argv[1] === 'show') {
        const file = state.files.get(argv[2]!.replace(`${REVISION}:`, ''));
        return Promise.resolve({
          ok: file !== undefined,
          stdout: file ?? '',
          stderr: '',
          reason: 'exit',
        });
      }
      if (argv[0] === join(HOME, '.local/bin/mise'))
        return Promise.resolve(version(state, state.manager));
      const worker = state.workers.find((id) => argv.includes(id));
      if (argv[0] === 'ssh' && worker)
        return Promise.resolve(version(state, worker));
      throw new Error(`Unexpected command: ${argv.join(' ')}`);
    };
    state.found = await miseDowngrade(
      { revision: REVISION, source: '/source' },
      {
        manager: state.manager,
        home: HOME,
        workers: state.workers.map((id) => ({ id, ssh: id })),
      },
      run
    );
  }
);

const replaced = (table: DataTable) =>
  table
    .hashes()
    .map((row) => ({ node: row['machine']!, installed: row['mise']! }));

Then(
  'it would replace a newer mise than {string} on:',
  (world, pinned: string, table: DataTable) => {
    expect(asked(world).found).toMatchObject({
      pinned,
      machines: replaced(table),
    });
  }
);

Then(
  'it would replace a mise the revision does not name on:',
  (world, table: DataTable) => {
    expect(asked(world).found).toMatchObject({
      pinned: null,
      machines: replaced(table),
    });
  }
);

Then(
  'no machine is known to run a newer mise than {string}',
  (world, pinned: string) => {
    expect(asked(world).found).toMatchObject({ pinned, machines: [] });
  }
);

Then(
  'these workers did not say which mise they run:',
  (world, table: DataTable) => {
    expect(asked(world).found?.unmeasured).toEqual(table.list());
  }
);

Then('the run is refused with {string}', (world, code: string) => {
  expect<string>(miseRefusalCode(asked(world).found!)).toBe(code);
});

Then(
  /^the manager's mise (would be replaced|is not at risk)$/,
  (world, verdict: string) => {
    const state = asked(world);
    expect(
      state.found?.machines.some((entry) => entry.node === state.manager) ??
        false
    ).toBe(verdict === 'would be replaced');
  }
);

Then('no mise would be replaced', (world) => {
  expect(asked(world).found).toBeNull();
});

Then('no machine was asked for its mise', (world) => {
  expect(asked(world).measured).toEqual([]);
});

Then('the refusal says each of:', (world, table: DataTable) => {
  const text = miseDowngradeRemedy(REVISION, asked(world).found!);
  for (const part of table.list()) expect(text).toContain(part);
});

// ── The guard of a hand-off, and the run script, in a manager's home ─────

Given(
  /^a branch of the fleet's source repository holds the commit "([^"]*)", whose mise\.toml pins mise "([^"]*)" and whose toolchain bootstrap is from before the rule that keeps a newer mise$/,
  (world, message: string, pinned: string) => {
    const node = manager(world);
    git(node, node.origin, 'checkout', '--quiet', '-b', message);
    mkdirSync(join(node.origin, 'bootstrap'), { recursive: true });
    writeFileSync(join(node.origin, 'bootstrap/bootstrap.sh'), BEFORE_THE_RULE);
    writeFileSync(
      join(node.origin, 'mise.toml'),
      `min_version = "${pinned}"\n`
    );
    git(node, node.origin, 'add', '--all');
    git(node, node.origin, 'commit', '--quiet', '--message', message);
    node.commits.set(message, git(node, node.origin, 'rev-parse', 'HEAD'));
    git(node, node.origin, 'checkout', '--quiet', 'main');
  }
);

Given('the manager runs mise {string}', (world, version: string) => {
  const path = join(manager(world).home, '.local/bin/mise');
  writeFileSync(path, `#!/bin/sh\necho "${version} fixture"\n`);
  chmodSync(path, 0o755);
});

Given('the manager has no mise', (world) => {
  rmSync(join(manager(world).home, '.local/bin/mise'));
});

/** The devfleet installed on a manager: a stand-in on its PATH that records
 * what it is asked, then does what the scenario says.
 */
function installDevfleet(world: FleetSyncWorld, answer: string): void {
  const node = manager(world);
  const installed = join(node.home, 'installed');
  mkdirSync(installed, { recursive: true });
  writeFileSync(
    join(installed, 'devfleet'),
    `#!/bin/sh\necho "devfleet $*" >> ${join(node.home, 'calls')}\n${answer}\n`
  );
  chmodSync(join(installed, 'devfleet'), 0o755);
  node.env['PATH'] = `${installed}:/usr/bin:/bin`;
}

Given(
  'the devfleet installed on the manager answers that no mise would be replaced',
  (world) => {
    installDevfleet(world, 'echo \'{"version":1,"ok":true}\'\nexit 0');
  }
);

Given(
  'the devfleet installed on the manager refuses the question with:',
  (world, report: string) => {
    const node = manager(world);
    writeFileSync(join(node.home, 'refusal'), `${report}\n`);
    installDevfleet(world, `cat ${join(node.home, 'refusal')}\nexit 1`);
  }
);

Given(
  'the devfleet installed on the manager is from before the question',
  (world) => {
    // What a command line that does not know an option does with it.
    installDevfleet(
      world,
      'echo "error: unknown option \'--measure-mise\'" >&2\nexit 1'
    );
  }
);

const printed = new WeakMap<FleetSyncWorld, string>();

When(
  /^the mise guard of a hand-off runs on the manager for the commit "([^"]*)"(?:, for a request with "([^"]*)")?$/,
  (world, message: string, flags: string | undefined) => {
    const node = manager(world);
    node.before = node.calls().length;
    const result = Bun.spawnSync(
      [
        '/bin/sh',
        '-c',
        MISE_GUARD,
        'fleet-mise-guard',
        sha(node, message),
        ...(flags ? flags.split(' ') : []),
      ],
      { env: node.env }
    );
    world.answer = result.exitCode;
    printed.set(world, result.stdout.toString());
  }
);

const asks = (world: FleetSyncWorld): string[] => {
  const node = manager(world);
  return node
    .calls()
    .slice(node.before)
    .split('\n')
    .filter((line) => line.startsWith('devfleet '))
    .map((line) => line.slice('devfleet '.length));
};

Then(
  'the devfleet installed on the manager was asked {string}',
  (world, command: string) => {
    const node = manager(world);
    expect(asks(world)).toEqual([
      command.replace(/<([^>]+)>/g, (_all, message: string) =>
        sha(node, message)
      ),
    ]);
  }
);

Then('the devfleet installed on the manager was not asked', (world) => {
  expect(asks(world)).toEqual([]);
});

Then('the guard prints:', (world, text: string) => {
  expect(printed.get(world)).toBe(`${text}\n`);
});

Then('the guard prints nothing', (world) => {
  expect(printed.get(world)).toBe('');
});

When(
  'the run script is started for the commit {string} with {string}, told that mise may be downgraded for the commit {string}',
  (world, message: string, flags: string, told: string) => {
    startRunScript(
      world,
      (node) => sha(node, message),
      flags,
      (node) => ({ [ALLOW_MISE_DOWNGRADE_ENV]: sha(node, told) })
    );
  }
);

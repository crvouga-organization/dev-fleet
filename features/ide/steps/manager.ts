import { runCommand } from '../../../src/runner';
import type { Runner } from '../../../src/types';
import { managerDesktop } from '../../../src/t3/manager-desktop';
import { expect } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { parse } from 'yaml';
import { nativeT3Artifact } from '../../../bootstrap/native-t3';
import { updatesCheck, workerVersion } from '../../../src/t3/version';
import { failed, succeeded } from '../../support/commands';
import { ide, ROOT, withPin, type IdeWorld } from './world';

const { Given, When, Then } = ide;

type Play = { tasks: { [module: string]: Record<string, unknown> }[] };
interface Manager {
  artifact?: { name: string; sha256: string; url: string } | null;
  desktopRoot?: string;
  desktopCommands?: string[];
  policy?: string;
  playbook?: Play[];
}
const managers = new WeakMap<IdeWorld, Manager>();
const of = (world: IdeWorld): Manager => {
  let value = managers.get(world);
  if (!value) managers.set(world, (value = {}));
  return value;
};

const mise = (): string => readFileSync(join(ROOT, 'mise.toml'), 'utf8');

When(
  /^the pinned T3 archive for (\w+) (\w+) is resolved$/,
  (world, platform: string, architecture: string) => {
    const config = Bun.TOML.parse(mise()) as Parameters<
      typeof nativeT3Artifact
    >[0];
    try {
      of(world).artifact = nativeT3Artifact(config, architecture, platform);
    } catch {
      of(world).artifact = null;
    }
  }
);

Then(
  'it is the file {string} with a SHA-256 digest from mise.toml',
  (world, name: string) => {
    const artifact = of(world).artifact!;
    expect(artifact.url.endsWith(`/${withPin(name)}`)).toBe(true);
    expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(mise()).toContain(`"${artifact.sha256}"`);
  }
);

Then('no archive is pinned', (world) => {
  expect(of(world).artifact).toBeNull();
});

function reportDesktop(world: IdeWorld, version: string, owner: string) {
  world.commands.answer(
    (argv) => argv[0] === '/usr/bin/osascript',
    succeeded(version ? owner + ' ' + withPin(version) : 'absent-or-ambiguous')
  );
  world.commands.answer((argv) => argv[0] === '/usr/bin/codesign', succeeded());
}

Given(
  'the running desktop on the manager reports {string}',
  (world, version: string) => {
    reportDesktop(world, version, 'managed');
  }
);

Given(
  'the running desktop on the manager reports {string} from another installation',
  (world, version: string) => {
    reportDesktop(world, version, 'other');
  }
);

Given('this converge is running inside the desktop', (world) => {
  world.commands.answer(
    (argv) => argv[0] === 'ps',
    succeeded(
      [
        '1 0 /sbin/launchd',
        '40 1 /Applications/T3 Code (Nightly).app/Contents/MacOS/t3code',
        `${process.pid} 40 homelab converge`,
      ].join('\n')
    )
  );
});

Given('this converge is running outside the desktop', (world) => {
  world.commands.answer(
    (argv) => argv[0] === 'ps',
    succeeded(
      [
        '1 0 /sbin/launchd',
        `${process.pid} 1 /bin/zsh -c homelab converge`,
      ].join('\n')
    )
  );
});

Given('the managed desktop is absent until its play succeeds', (world) => {
  let staged = false;
  world.commands.answer(
    (argv) => argv[0] === '/usr/bin/codesign',
    () => (staged ? succeeded() : failed())
  );
  world.commands.answer(
    (argv) => argv.some((arg) => arg.endsWith('/ansible/macos/t3-desktop.yml')),
    () => {
      staged = true;
      return succeeded();
    }
  );
});

Given('the activation play opens the verified desktop', (world) => {
  world.commands.answer('ansible/macos/t3-activate.yml', () => {
    world.commands.answer(
      '/usr/bin/osascript',
      succeeded('managed ' + withPin('<pinned>'))
    );
    return succeeded();
  });
});

When(
  /^the T3 desktop of the manager is (checked|applied)$/,
  async (world, mode: string) => {
    world.checks = await managerDesktop({
      id: 'manager',
      workspace: ROOT,
      apply: mode === 'applied',
      run: world.run,
    });
  }
);

/** The opt-in macOS runner uses the real Apple tools and release asset,
 * and stages the bundle only inside the scenario's temporary directory. */
async function stagePublishedDesktop(world: IdeWorld) {
  const commands: string[] = [];
  const run: Runner = async (command, options) => {
    commands.push(command[0]!);
    const result = await runCommand(command, options);
    if (command[0] === '/usr/bin/osascript') expect(result.ok).toBe(true);
    return result;
  };
  world.checks = await managerDesktop(
    { id: 'manager', workspace: ROOT, apply: true, run },
    of(world).desktopRoot!
  );
  of(world).desktopCommands = commands;
}

Given(
  'the pinned macOS desktop has been staged in a temporary directory',
  async (world) => {
    of(world).desktopRoot = world.directory('manager-desktop-');
    await stagePublishedDesktop(world);
    expect(
      world.checks.find((check) => check.id === 't3:desktop-installed')?.status
    ).toBe('pass');
  }
);

When('the manager applies the same macOS desktop again', stagePublishedDesktop);

Then('the playbook {string} was not run', (world, playbook: string) => {
  expect(
    world.commands.calls.some((call) => call.command.includes(playbook))
  ).toBe(false);
});

Then(
  'macOS verified the installed app again without running the installer',
  (world) => {
    expect(of(world).desktopCommands).toEqual([
      '/usr/bin/codesign',
      '/usr/bin/osascript',
    ]);
  }
);

Given(
  'Launch Services returns the application count {string} as text',
  (world, count: string) => {
    world.commands.answer('/usr/bin/codesign', succeeded());
    world.commands.answer('/usr/bin/osascript', (command) => {
      const args = command.slice(-2);
      const app = { bundleURL: { path: args[1] } };
      const result: unknown = runInNewContext(
        command[command.indexOf('-e') + 1] + '\nrun(args)',
        {
          args,
          ObjC: { import() {}, unwrap: (value: unknown) => value },
          $: {
            NSRunningApplication: {
              runningApplicationsWithBundleIdentifier: () => ({
                count,
                objectAtIndex: () => app,
              }),
            },
            NSBundle: {
              bundleWithURL: () => ({
                objectForInfoDictionaryKey: () => withPin('<pinned>'),
              }),
            },
          },
        }
      );
      return succeeded(String(result));
    });
  }
);

Given(
  /^the worker server answers the environment query with '(.*)'$/,
  (world, body: string) => {
    world.commands.answer(
      (argv) =>
        argv[0] === 'ssh' &&
        argv.includes('http://127.0.0.1:3773/.well-known/t3/environment'),
      body === 'unreachable' ? failed() : succeeded(withPin(body))
    );
  }
);

When(
  'the T3 version of the worker {string} is checked',
  async (world, id: string) => {
    world.checks = [
      await workerVersion(
        { id, ssh: id, workspace: '/w', required: [] },
        world.run,
        ROOT
      ),
    ];
  }
);

Given(
  'the T3 administrator policy on the manager is:',
  (world, text: string) => {
    of(world).policy = join(world.directory('ide-policy-'), 'policy.json');
    writeFileSync(of(world).policy!, text);
  }
);

When('the T3 updater of the manager is checked', async (world) => {
  world.checks = [
    await updatesCheck(
      of(world).policy!,
      'ansible-playbook -K manager-privilege.yml'
    ),
  ];
});

When("the manager's T3 playbook is read", (world) => {
  of(world).playbook = parse(
    readFileSync(join(ROOT, 'ansible/macos/t3-policy.yml'), 'utf8')
  ) as Play[];
});

const copies = (world: IdeWorld) =>
  of(world).playbook!.flatMap((play) =>
    play.tasks.flatMap((task) =>
      task['ansible.builtin.copy'] ? [task['ansible.builtin.copy']] : []
    )
  );
const policyDirectory = '/Library/Application Support/T3Code';

Then(
  'it installs {string} at {string}',
  (world, source: string, path: string) => {
    const install = copies(world).find((copy) =>
      String(copy['dest']).endsWith('/policy.json')
    )!;
    expect(String(install['content'])).toContain(`'${source}'`);
    expect(
      String(install['dest']).replace(
        '{{ t3_policy_directory }}',
        policyDirectory
      )
    ).toBe(path);
  }
);

Then('it records the ownership marker {string}', (world, marker: string) => {
  const record = copies(world).find((copy) =>
    String(copy['dest']).endsWith('/.personal-fleet-policy')
  )!;
  expect(record['content']).toBe(`${marker}\n`);
  // The same text the workers' policy playbook records.
  expect(
    readFileSync(join(ROOT, 'ansible/ubuntu/t3-policy.yml'), 'utf8')
  ).toContain(`content: "${marker}\\n"`);
});

Then('{string} imports it', (_world, playbook: string) => {
  const plays = parse(readFileSync(join(ROOT, playbook), 'utf8')) as Record<
    string,
    unknown
  >[];
  expect(
    plays.some(
      (play) => play['ansible.builtin.import_playbook'] === 't3-policy.yml'
    )
  ).toBe(true);
});

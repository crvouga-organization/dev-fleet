import { expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { steps, type DataTable } from '../../support/gherkin';
import { part, type BootstrapWorld } from './world';

/** The real bootstrap/bootstrap.ps1 under PowerShell, in a home of its own.
 * Its downloads are answered from a directory made here: the release
 * archive and the checksum list, laid out as the publisher of mise does. The
 * mise.exe in that home says its version and records every other call.
 */
export const windows = steps<BootstrapWorld>();
const { Given, When, Then } = windows;

const BOOTSTRAP = resolve(import.meta.dir, '../../../bootstrap/bootstrap.ps1');

/** The PowerShell these run under: the one on PATH, as `@pwsh` asks. */
export const pwsh = (): string | null => Bun.which('pwsh');

/** A mise that says it is `version`, and records how else it is called. */
const standIn = (version: string, calls: string): string =>
  `#!/bin/sh\nif [ "$1" = --version ]; then echo "${version} fixture"; exit 0; fi\necho "mise $*" >> ${calls}\n`;

function executable(path: string, text: string): void {
  writeFileSync(path, text);
  chmodSync(path, 0o755);
}

/** PowerShell with the script's downloads answered from `published`. A
 * function is found before the cmdlet of the same name, in the script too.
 */
const downloads = (published: string, calls: string): string =>
  [
    'function Invoke-WebRequest {',
    '  param([Parameter(Position = 0)][string]$Uri, [string]$OutFile, [switch]$UseBasicParsing)',
    `  Add-Content -LiteralPath '${calls}' -Value "download $Uri"`,
    `  Copy-Item -LiteralPath (Join-Path '${published}' (Split-Path $Uri -Leaf)) -Destination $OutFile`,
    '}',
  ].join('\n');

const machine = part((world) => {
  // PowerShell resolves the checkout's path, so the scenario names it resolved.
  const root = realpathSync(world.directory('bootstrap-windows-'));
  const home = join(root, 'home');
  const checkout = join(root, 'checkout');
  const published = join(root, 'published');
  const calls = join(root, 'calls');
  for (const directory of [home, published, join(checkout, 'bootstrap')])
    mkdirSync(directory, { recursive: true });
  writeFileSync(calls, '');
  copyFileSync(BOOTSTRAP, join(checkout, 'bootstrap/bootstrap.ps1'));
  return {
    root,
    home,
    checkout,
    published,
    calls,
    env: {
      HOME: home,
      // Git, which the script asks for before anything else.
      PATH: '/usr/bin:/bin',
      // What Windows says on an x64 machine.
      PROCESSOR_ARCHITECTURE: 'AMD64',
      POWERSHELL_TELEMETRY_OPTOUT: '1',
      POWERSHELL_UPDATECHECK: 'Off',
      NO_COLOR: '1',
    } as Record<string, string>,
    said: '',
  };
});

/** Runs PowerShell commands in the machine's environment. */
function powershell(world: BootstrapWorld, command: string) {
  return spawnSync(
    pwsh() ?? 'pwsh',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
    { env: machine(world).env, encoding: 'utf8' }
  );
}

const recorded = (world: BootstrapWorld, kind: string): string[] =>
  readFileSync(machine(world).calls, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith(`${kind} `))
    .map((line) => line.slice(kind.length + 1));

Given('a Windows machine that runs mise {string}', (world, version: string) => {
  const { home, calls } = machine(world);
  mkdirSync(join(home, '.local/bin'), { recursive: true });
  executable(join(home, '.local/bin/mise.exe'), standIn(version, calls));
});

Given('a Windows machine that has no mise', (world) => {
  expect(existsSync(join(machine(world).home, '.local/bin/mise.exe'))).toBe(
    false
  );
});

Given(
  'the machine says its architecture is {string}',
  (world, architecture: string) => {
    machine(world).env['PROCESSOR_ARCHITECTURE'] = architecture;
  }
);

Given(
  'a checkout whose mise.toml pins mise {string}, whose Windows release is published',
  (world, version: string) => {
    const { root, checkout, published, calls } = machine(world);
    // The release archive of that version, as its publisher lays it out.
    mkdirSync(join(root, 'release/mise/bin'), { recursive: true });
    executable(
      join(root, 'release/mise/bin/mise.exe'),
      standIn(version, calls)
    );
    const asset = `mise-v${version}-windows-x64.zip`;
    const packed = powershell(
      world,
      `[IO.Compression.ZipFile]::CreateFromDirectory('${join(root, 'release')}', '${join(published, asset)}')`
    );
    expect(packed.stderr).toBe('');
    expect(packed.status).toBe(0);
    const digest = createHash('sha256')
      .update(readFileSync(join(published, asset)))
      .digest('hex');
    writeFileSync(
      join(published, 'SHASUMS256.txt'),
      `${'0'.repeat(64)}  ./mise-v${version}-linux-x64.tar.gz\n${digest}  ./${asset}\n`
    );
    writeFileSync(join(checkout, 'mise.toml'), `min_version = "${version}"\n`);
  }
);

Given('a checkout whose mise.toml pins no mise', (world) => {
  writeFileSync(
    join(machine(world).checkout, 'mise.toml'),
    '[tools]\nbun = "1.4.4"\n'
  );
});

Given(
  'the published checksum list names another digest for the archive',
  (world) => {
    const list = join(machine(world).published, 'SHASUMS256.txt');
    writeFileSync(
      list,
      readFileSync(list, 'utf8').replace(
        /^[0-9a-f]{64}( {2}\.\/mise-v[^\n]*-windows-x64\.zip)$/m,
        `${'f'.repeat(64)}$1`
      )
    );
  }
);

When(
  /^the checkout's Windows bootstrap runs(?: with "([^"]*)")?$/,
  (world, flags: string | undefined) => {
    const { checkout, published, calls } = machine(world);
    const result = powershell(
      world,
      `${downloads(published, calls)}\n& '${join(checkout, 'bootstrap/bootstrap.ps1')}' ${flags ?? ''}`
    );
    world.exit = result.status;
    machine(world).said = result.stdout + result.stderr;
  }
);

Then('the Windows machine runs mise {string}', (world, version: string) => {
  const { home, env } = machine(world);
  const printed = spawnSync(join(home, '.local/bin/mise.exe'), ['--version'], {
    env,
    encoding: 'utf8',
  }).stdout;
  expect(printed.split(' ')[0]).toBe(version);
});

Then(
  /^the Windows bootstrap downloaded (nothing|the mise release "[^"]*")$/,
  (world, what: string) => {
    const version = /"([^"]*)"/.exec(what)?.[1];
    const base = `https://github.com/jdx/mise/releases/download/v${version}`;
    expect(recorded(world, 'download')).toEqual(
      version
        ? [`${base}/mise-v${version}-windows-x64.zip`, `${base}/SHASUMS256.txt`]
        : []
    );
  }
);

Then(
  'the Windows bootstrap downloaded these, in order:',
  (world, table: DataTable) => {
    expect(recorded(world, 'download')).toEqual(table.list());
  }
);

Then('the Windows bootstrap says {string}', (world, text: string) => {
  expect(machine(world).said).toContain(text);
});

Then('the Windows bootstrap does not say {string}', (world, text: string) => {
  expect(machine(world).said).not.toContain(text);
});

Then(
  'the Windows bootstrap went on to run, with the mise of that machine:',
  (world, table: DataTable) => {
    const { checkout } = machine(world);
    expect(recorded(world, 'mise').map((call) => `mise ${call}`)).toEqual(
      table.list().map((call) => call.replace('<checkout>', checkout))
    );
  }
);

Then(
  'the Windows bootstrap ran nothing with the mise of that machine',
  (world) => {
    expect(recorded(world, 'mise')).toEqual([]);
  }
);

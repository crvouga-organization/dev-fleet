import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  installedDefinition,
  parseDefinition,
  type FleetDefinition,
} from './definition';
import { FleetUsageError } from './errors';
import { pinnedPath } from './agents/toolchain';
import type { Runner } from './types';
import {
  secretsProvider,
  type SecretCommand,
  type SecretName,
  type SecretsProvider,
} from './secrets';
import { isOperator, stateDefinition } from './state/operator';
import type { BucketLocation } from './state/bucket';
import { definitionPath, stateRoot } from './state/paths';
import { expandRecords } from './worker-records';

/** Where every machine keeps the fleet configuration converge approved.
 * Launchers and scheduled jobs get no environment and read it from here.
 */
export const installedPath = (home: string): string =>
  join(home, '.config/homelab/fleet.json');

/** Beside the installed copy: the SHA-256 of the copy as converge last
 * wrote it, so the next run can tell a copy edited by hand from one the
 * configuration has moved on from. A cache: converge writes it again. The
 * copy itself is JSON that Node and Python read, and cannot carry a header.
 */
const recordPath = (home: string): string => `${installedPath(home)}.sha256`;

/** Where this process reads the fleet configuration from, in this order:
 * - `file`: the file `HOMELAB_CONFIG` names. The homelab CLI sets it to the
 *   `fleet.json` of the project it is run from (src/cli/project.ts);
 * - `state`: the `definition` document in the manager's fleet state, the
 *   configuration converge last applied, which only the homelab CLI
 *   reads. `path` is its copy as a file;
 * - `installed`: the copy converge installed on this machine.
 */
export interface DefinitionSource {
  kind: 'file' | 'state' | 'installed';
  path: string;
}

export function definitionSource(
  env = process.env,
  home = homedir()
): DefinitionSource {
  const root = stateRoot(env, home);
  const copy = definitionPath(root);
  const named = env['HOMELAB_CONFIG'] || env['DEVFLEET_CONFIG'];
  // A homelab command names the state's copy for the commands it starts.
  const inherited = named === copy && isOperator();
  if (named && !inherited) return { kind: 'file', path: named };
  if (stateDefinition(root) !== null) return { kind: 'state', path: copy };
  return { kind: 'installed', path: installedPath(home) };
}

function writePrivate(path: string, content: string): boolean {
  if (existsSync(path) && readFileSync(path, 'utf8') === content) return false;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(`${path}.new`, content, { mode: 0o600 });
  renameSync(`${path}.new`, path);
  return true;
}

/** The file that holds the configuration this process runs with, for the
 * subprocesses that take a path. Every command this process starts reads the
 * same one.
 */
export function configPath(env = process.env, home = homedir()): string {
  const source = definitionSource(env, home);
  if (source.kind !== 'state') return source.path;
  const body = stateDefinition(stateRoot(env, home));
  if (body !== null) writePrivate(source.path, body);
  env['HOMELAB_CONFIG'] = source.path;
  return source.path;
}

/** Installs the configuration this process runs with as the machine's copy,
 * so launchers and scheduled jobs (which get no environment) use the same one,
 * and records what it wrote. Returns whether the copy changed.
 */
export function installConfig(home = homedir()): boolean {
  const previous = join(home, '.config/dev-fleet/fleet.json');
  if (!existsSync(installedPath(home)) && existsSync(previous)) {
    mkdirSync(dirname(installedPath(home)), { recursive: true, mode: 0o700 });
    renameSync(previous, installedPath(home));
    const previousRecord = `${previous}.sha256`;
    if (existsSync(previousRecord)) renameSync(previousRecord, recordPath(home));
  }
  const body = installedDefinition(fleet);
  const changed = writePrivate(installedPath(home), body);
  writePrivate(recordPath(home), `${digest(body)}\n`);
  return changed;
}

const digest = (text: string): string =>
  createHash('sha256').update(text).digest('hex');

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** A configuration as converge would install it, whatever wrote the text:
 * two texts that say the same render the same. Null for one that is not a
 * fleet configuration.
 */
function rendered(text: string | null): string | null {
  if (text === null) return null;
  try {
    return installedDefinition(parseDefinition(JSON.parse(text)));
  } catch {
    return null;
  }
}

/** The path of this machine's installed copy when it holds an edit the next
 * install would lose, or null. It holds none when it is still what converge
 * last wrote (its record says so), when it says what this run would install,
 * or when it says what the fleet state records as last applied: a copy
 * written before the record existed, or by a revision that keeps none, is
 * not an edit. Reads only.
 */
export function editedInstalledCopy(
  env = process.env,
  home = homedir()
): string | null {
  const path = installedPath(home);
  // A machine that reads its configuration from the copy loses nothing.
  if (definitionSource(env, home).kind === 'installed') return null;
  const copy = readText(path);
  if (copy === null) return null;
  if (readText(recordPath(home))?.trim() === digest(copy)) return null;
  const says = rendered(copy);
  if (says === installedDefinition(fleet)) return null;
  const applied = rendered(stateDefinition(stateRoot(env, home)));
  return says !== null && says === applied ? null : path;
}

/** What the operator does about an edited copy at `path`: how to keep the
 * edit, for the way this process found its configuration, and how to discard
 * it. Names paths and commands only, never what the files hold.
 */
export function editedCopyRemedy(
  path: string,
  env = process.env,
  home = homedir()
): string {
  const source = definitionSource(env, home);
  const kept =
    source.kind === 'file' &&
    source.path !== definitionPath(stateRoot(env, home))
      ? `this run reads the configuration from ${source.path}. To keep the edit, make the same change in ${source.path}. Then, or to discard the edit, delete the copy (rm ${path}) and run converge again`
      : `the configuration is kept in the fleet state. To keep the edit, run homelab state --import ${path} and then converge again. To discard it, delete the copy (rm ${path}) and run converge again`;
  return `The copy of the fleet configuration on this manager (${path}) was edited since converge last wrote it, and a sync would replace it, so nothing was changed. That file is a copy converge installs for launchers and scheduled jobs; ${kept}: it installs the copy anew.`;
}

/** How a remedy names fleet.json: the file itself, for the way this process
 * found its configuration. A project's file, or the one HOMELAB_CONFIG
 * names, by its path; a configuration kept in the fleet state by the commands
 * that change it; and on a machine that holds only the copy converge
 * installs, where the file is instead. Every remedy that tells the operator
 * to declare something uses this, so none sends them to the copy.
 */
export function fleetJson(env = process.env, home = homedir()): string {
  const source = definitionSource(env, home);
  const stored = definitionPath(stateRoot(env, home));
  if (source.kind === 'file' && source.path !== stored)
    return `fleet.json (${source.path})`;
  if (source.kind === 'installed')
    return `fleet.json (the one in the project the fleet is synced from, on the manager; not ${source.path}, the copy converge installs from it)`;
  return `fleet.json (kept in the fleet state: ${STATE_EDIT})`;
}

/** Changing a configuration that is kept in the fleet state. */
const STATE_EDIT =
  'homelab state --export > fleet.json, edit that file, then homelab state --import fleet.json';

function read(path: string): FleetDefinition {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new FleetUsageError(
      `The fleet configuration at ${path} is not readable JSON.`
    );
  }
  // A project's fleet.json may name generated worker records beside it.
  return parseDefinition(expandRecords(value, dirname(path)));
}

function load(): FleetDefinition {
  const path = configPath();
  if (!existsSync(path))
    throw new FleetUsageError(
      `No fleet configuration. Run homelab from the project that holds your fleet.json (homelab state --example prints one to start from), or name the file with HOMELAB_CONFIG. A manager whose bucket already holds one restores it with homelab state --init. Looked at ${path}.`
    );
  return read(path);
}

/** Where the configuration says the fleet state is kept, read from the file
 * each time: null when it names no bucket, or when this machine has no
 * configuration yet.
 */
export function declaredState(
  env = process.env,
  home = homedir()
): BucketLocation | null {
  const path = configPath(env, home);
  return existsSync(path) ? (read(path).state ?? null) : null;
}

let loaded: FleetDefinition | undefined;
const current = (): FleetDefinition => (loaded ??= load());

/** Forgets the configuration read so far; the next use reads it again. For
 * a command that has just replaced the fleet state under itself.
 */
export function reloadFleet(): void {
  loaded = undefined;
}

/** This fleet's own configuration: its machines, endpoints, accounts and source
 * repository. Fleet code never names any of them; it reads them here, and this
 * is the only module that loads the file. It is read on first use, so a
 * command that needs no configuration runs on a machine that has none yet.
 */
export const fleet: FleetDefinition = new Proxy({} as FleetDefinition, {
  get: (_, key) => Reflect.get(current(), key),
  has: (_, key) => Reflect.has(current(), key),
  ownKeys: () => Reflect.ownKeys(current()),
  getOwnPropertyDescriptor: (_, key) =>
    Reflect.getOwnPropertyDescriptor(current(), key),
});

/** Reads one of this fleet's secrets for this node. Tools run from the pinned
 * toolchain, whatever PATH the caller (T3, launchd, systemd) started with.
 */
export const secret: SecretsProvider = Object.assign(
  (name: SecretName, node?: string) =>
    secretsProvider(fleet.secrets, { run: pinned })(name, node),
  { login: () => secretsProvider(fleet.secrets, { run: pinned }).login() }
);

/** The same, through an injected runner (converge phases and their tests). */
export const secretVia = (run: Runner): SecretsProvider =>
  secretsProvider(fleet.secrets, {
    run: async (argv) => {
      const result = await run(argv, { timeoutMs: 20_000 });
      return result.ok ? result.stdout : null;
    },
  });

const pinned: SecretCommand = (argv) =>
  new Promise((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 20_000,
      env: { ...process.env, PATH: pinnedPath() },
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      if (output.length < 65_536) output += chunk.toString('utf8');
    });
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? output : null));
  });

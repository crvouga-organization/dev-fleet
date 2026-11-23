/** Persistent shims make the same tool commands work in interactive shells and agents. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

export function appendOnce(path: string, block: string): void {
  const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (current.includes(block.trim())) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${current}\n${block}\n`);
}

export function miseDataDir(
  platform = process.platform,
  env = process.env,
  home = homedir()
): string {
  const fallback =
    platform === 'win32'
      ? env['LOCALAPPDATA'] || join(home, 'AppData', 'Local')
      : join(home, '.local', 'share');
  return env['MISE_DATA_DIR'] || join(env['XDG_DATA_HOME'] || fallback, 'mise');
}

function persistWindowsPath(bin: string, shims: string): void {
  const script =
    "$paths = @($env:WORKSPACE_TOOL_SHIMS, $env:WORKSPACE_TOOL_BIN); $old = [Environment]::GetEnvironmentVariable('Path', 'User'); $new = (($paths + ($old -split ';') | Where-Object { $_ } | Select-Object -Unique) -join ';'); [Environment]::SetEnvironmentVariable('Path', $new, 'User')";
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-Command', script],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        WORKSPACE_TOOL_BIN: bin,
        WORKSPACE_TOOL_SHIMS: shims,
      },
    }
  );
  if (result.status !== 0)
    throw new Error(
      'Could not persist the user PATH. See docs/machine-setup.md.'
    );
}

/** Where a worker's agent commands are, when it has them: a link to
 * `agents/bin` of the applied revision, made by the worker's own converge
 * (src/agents/commands.ts). A machine without the link (the manager, a
 * development machine) has no such directory and its shells skip it.
 */
export const agentCommands = (home = homedir()): string =>
  join(home, '.local', 'share', 'personal', 'fleet', 'agent-commands');

export function configurePosixShellPath(
  bin: string,
  shims: string,
  home = homedir(),
  zdotdir = process.env['ZDOTDIR'] || home
): void {
  const agents = agentCommands(home);
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const paths = quote(`${shims}:${bin}`);
  const legacy = `# dev-fleet toolchain\nexport PATH=${paths}:"$PATH"`;
  const block = `# dev-fleet toolchain\ncase ":$PATH:" in\n  *${quote(`:${shims}:${bin}:`)}*) ;;\n  *) export PATH=${paths}:"$PATH" ;;\nesac`;
  const targets = new Set([
    join(home, '.profile'),
    ...['.bash_profile', '.bash_login']
      .map((name) => join(home, name))
      .filter(existsSync),
    join(home, '.bashrc'),
    join(zdotdir, '.zshenv'),
    join(zdotdir, '.zshrc'),
  ]);
  // Version managers and vendor installers (nvm, a native Claude installer's
  // ~/.local/bin) prepend their own directories later in these files; the
  // last line puts the pinned shims back in front, so every shell and the
  // apps that inherit its PATH (T3) run the locked tool versions.
  // Guarded like the block above so nested shells do not grow PATH.
  const unguarded = `${TAIL_MARKER}\nexport PATH=${quote(shims)}:"$PATH"\n`;
  // On a worker the agent commands come before the shims: `claude` is then
  // the fleet's launcher, through the CLI proxy, and the pinned CLI behind
  // it. Like the shims they are set twice: at the top, which a shell that is
  // not interactive reaches before a startup file returns early, and last.
  const agentsFirst = (marker: string) =>
    `${marker}\nif [ -d ${quote(agents)} ]; then\n  case "$PATH" in\n    ${quote(agents)}:*) ;;\n    *) export PATH=${quote(agents)}:"$PATH" ;;\n  esac\nfi\n`;
  const head = `${block}\n${agentsFirst(AGENTS_MARKER)}`;
  const shimsOnly = `${TAIL_MARKER}\ncase "$PATH" in\n  ${quote(shims)}:*) ;;\n  *) export PATH=${quote(shims)}:"$PATH" ;;\nesac\n`;
  // The shims count as first when only the agent commands precede them.
  const tail = `${TAIL_MARKER}\ncase "$PATH" in\n  ${quote(shims)}:*|${quote(agents)}:${quote(shims)}:*) ;;\n  *) export PATH=${quote(shims)}:"$PATH" ;;\nesac\n${agentsFirst(AGENTS_TAIL_MARKER)}`;
  for (const path of targets) {
    const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
    // What this and every earlier release wrote, wherever it stands.
    const body = [
      head,
      `${block}\n`,
      legacy,
      tail,
      shimsOnly,
      unguarded,
    ].reduce((text, earlier) => text.split(earlier).join(''), current);
    const next = `${head}${body.replace(/\n*$/, '\n')}${tail}`;
    if (next === current) continue;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, next);
  }
}

const TAIL_MARKER = '# pinned tool shims first (dev-fleet, keep this last)';
const AGENTS_MARKER = "# a worker's agent commands (dev-fleet)";
const AGENTS_TAIL_MARKER =
  "# a worker's agent commands before them (dev-fleet, keep this last)";

export function configureShellPath(): void {
  const bin = join(homedir(), '.local', 'bin');
  const shims = process.env['MISE_SHIMS_DIR'] || join(miseDataDir(), 'shims');
  if (process.platform === 'win32') {
    persistWindowsPath(bin, shims);
    return;
  }
  configurePosixShellPath(bin, shims);
  const fishQuote = (value: string) =>
    `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
  appendOnce(
    join(homedir(), '.config/fish/config.fish'),
    `# dev-fleet toolchain\nfish_add_path --prepend ${fishQuote(shims)} ${fishQuote(bin)}`
  );
}

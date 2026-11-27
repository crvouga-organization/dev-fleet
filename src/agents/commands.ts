import { readdirSync } from 'node:fs';
import { lstat, readlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { agentCommands } from '../../bootstrap/shell-path';
import { PACKAGE_ROOT } from '../package-info';
import { runAnsible } from '../platform/ansible';
import { stablePath } from '../platform/t3-policy';
import type { Check, CommandResult, Runner } from '../types';

/** The agent commands of a worker. On a worker `claude`, `codex` and the
 * others are the fleet's launchers (`agents/bin`), which sign in through the
 * CLI proxy: the proxy holds the provider accounts, and a worker holds none.
 * So whatever starts an agent by its name there, a person in a terminal or
 * an app over SSH, uses the proxy's accounts.
 *
 * One link does it: `agent-commands`, beside the applied revision, points at
 * that revision's `agents/bin` through `current`, so it follows every sync
 * and rollback without being written again. Every shell has it first on its
 * PATH (bootstrap/shell-path.ts). The manager gets no link: its shells keep
 * the pinned CLIs. The link is made by a play (ansible/agents/commands.yml);
 * this decides whether it is played and measures the result.
 */

/** Runs the commands play with the link and its target. */
export type CommandsPlay = (variables: {
  agent_commands_link: string;
  agent_commands_target: string;
}) => Promise<CommandResult>;

/** `scratch` is where the variables file is kept while the play runs (the
 * fleet's private run directory by default).
 */
export function commandsPlay(run: Runner, scratch?: string): CommandsPlay {
  const directory = join(PACKAGE_ROOT, 'ansible', 'agents');
  return (variables) =>
    runAnsible(
      run,
      join(directory, 'commands.yml'),
      {
        cwd: directory,
        input: JSON.stringify(variables),
        timeoutMs: 90_000,
      },
      scratch
    );
}

/** Where the link is and what it holds, for the checkout this run applies:
 * nothing for a checkout the fleet does not own.
 */
function link(
  root: string,
  home: string
): { path: string; target: string } | null {
  const current = stablePath(root);
  const path = agentCommands(home);
  return current !== root && dirname(current) === dirname(path)
    ? { path, target: join(relative(dirname(path), current), 'agents', 'bin') }
    : null;
}

/** `agent:commands`: the worker's agent commands are the fleet's launchers. */
export async function linkAgentCommands(
  root: string,
  play: CommandsPlay,
  home = homedir()
): Promise<Check> {
  const id = 'agent:commands';
  const wanted = link(root, home);
  if (!wanted)
    return {
      id,
      status: 'skip',
      summary:
        'Not a checkout fleet-sync owns: the agent commands of this machine are left as they are.',
    };
  const held = () => readlink(wanted.path).catch(() => null);
  if ((await held()) !== wanted.target) {
    const found = await lstat(wanted.path).catch(() => null);
    if (found && !found.isSymbolicLink())
      return {
        id,
        status: 'fail',
        summary: 'AGENT_COMMANDS_CONFLICT',
        remedy: {
          action: `${wanted.path} is not the link fleet-sync makes. Move it away on this worker, then run converge.`,
        },
      };
    const played = await play({
      agent_commands_link: wanted.path,
      agent_commands_target: wanted.target,
    });
    if (!played.ok || (await held()) !== wanted.target)
      return {
        id,
        status: 'fail',
        summary: 'AGENT_COMMANDS_NOT_LINKED',
        remedy: {
          action:
            'The agent commands play (ansible/agents/commands.yml) did not make the link on this worker; its output is not reported. Run converge again.',
        },
      };
  }
  return {
    id,
    status: 'pass',
    summary:
      "This worker's agent commands are the fleet's launchers, through the CLI proxy.",
  };
}

/** The node a launcher runs as when nothing names it: the one whose agent
 * profiles this machine holds. T3 names the node itself; a command started
 * from a shell cannot. More than one, or none, is no answer.
 */
export function renderedNode(root: string): string {
  let nodes: string[];
  try {
    nodes = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== 'backups')
      .map((entry) => entry.name);
  } catch {
    return '';
  }
  return nodes.length === 1 ? nodes[0]! : '';
}

import { homedir } from 'node:os';
import { join, posix } from 'node:path';
import type { Check, CommandResult, FleetNode, Runner } from '../types';
import type { Ide, WorkerContext } from './ide';
import type { MachineDefinition } from '../definition';
import { record } from '../config';
import { fleet } from '../fleet-config';
import { declaredConnection } from '../ssh-connection';
import { NATIVE_AGENTS } from '../agents/native-verify';

/** super.engineering, the second supported IDE. It is a desktop app on the
 * manager only: a worker is one of its remote workspaces, reached over the
 * manager's own SSH, where the app installs and updates its helper itself.
 * homelab installs nothing of it. On the manager it asks the app, through
 * the app's CLI, for one remote workspace per worker; of a worker it measures
 * what such a workspace needs. The app starts an agent by its plain command,
 * which on a worker is the fleet's launcher: the sign-in is the CLI proxy's.
 */

/** Where the app keeps its data, and its CLI, under the home directory. */
const APP_HOME = '.super.engineering';

/** What a remote workspace needs on the host, besides a coding agent. */
const HOST_COMMANDS = ['git', 'flock'];
const AGENT_COMMANDS = NATIVE_AGENTS.map((agent) => agent.binary);

/** Prints each command the session finds and where, one a line. The app
 * starts agents from a session like this one: no terminal, no login shell.
 */
const PROBE = `for c in ${[...HOST_COMMANDS, ...AGENT_COMMANDS].join(' ')}; do p=$(command -v "$c" 2>/dev/null) && printf '%s=%s\\n' "$c" "$p"; done; true`;

/** A worker's agent commands are the fleet's launchers, which sign in
 * through the CLI proxy (src/agents/commands.ts): the directory they are
 * found in, under any home directory.
 */
const LAUNCHERS = '/.local/share/personal/fleet/agent-commands/';

const INSTALL =
  'Install super.engineering on the manager (https://super.engineering/download) and start it once, then run converge.';
const START = 'Start super.engineering on the manager, then run converge.';

/** What the scenarios replace: the home directory and the declared workers. */
export interface SuperInputs {
  home?: string;
  projects?: readonly string[];
  workers?: readonly MachineDefinition[];
}

/** The SSH destination the app is given for a worker: its alias, which the
 * manager's own SSH configuration resolves, or the declared user and tailnet
 * name of a worker that has none.
 */
export function sshTarget(
  node: Pick<FleetNode, 'id' | 'ssh'>,
  workers: readonly MachineDefinition[]
): string {
  const declared = declaredConnection(
    workers.find((worker) => worker.id === node.id)
  );
  return declared && declared.network.tailscaleName === node.ssh
    ? `${declared.network.user}@${node.ssh}`
    : node.ssh;
}

type Answer =
  | { response: Record<string, unknown> }
  /** The app's CLI is not on this machine. */
  | { absent: true }
  /** Why the app refused, as its own code (`unavailable`, `not_found`,
   * `feature_disabled`, …), or `unreadable` when it answered something else. */
  | { refused: string };

const CODE = /^[a-z][a-z0-9_]{0,63}$/;

function parse(result: CommandResult): Answer {
  if (result.reason === 'missing') return { absent: true };
  for (const text of [result.stdout, result.stderr]) {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      continue;
    }
    if (!record(value)) continue;
    const error = value['error'];
    if (record(error)) {
      const code = error['code'];
      return {
        refused:
          typeof code === 'string' && CODE.test(code) ? code : 'unreadable',
      };
    }
    if (result.ok)
      return {
        response: record(value['response']) ? value['response'] : value,
      };
  }
  return { refused: result.reason === 'timeout' ? 'timeout' : 'unreadable' };
}

/** Why the app could not be asked, as a warning of the check `id`. */
function unanswered(
  id: string,
  answer: Exclude<Answer, { response: unknown }>
): Check {
  if ('absent' in answer)
    return {
      id,
      status: 'warn',
      summary: 'SUPER_NOT_INSTALLED',
      remedy: { action: INSTALL },
    };
  if (answer.refused === 'unavailable')
    return {
      id,
      status: 'warn',
      summary: 'SUPER_NOT_RUNNING',
      remedy: { action: START },
    };
  if (answer.refused === 'feature_disabled')
    return {
      id,
      status: 'warn',
      summary: 'SUPER_REMOTE_WORKSPACES_OFF',
      remedy: {
        action:
          'In super.engineering on the manager, open Settings → Experimental and enable Remote workspaces, then run converge.',
      },
    };
  return {
    id,
    status: 'warn',
    summary: 'SUPER_REFUSED',
    remedy: {
      action: `super.engineering on the manager answered ${answer.refused}. Update the app, start it again, then run converge.`,
    },
  };
}

const ask = async (
  run: Runner,
  home: string | undefined,
  ...args: string[]
): Promise<Answer> =>
  parse(
    await run(
      [join(home ?? homedir(), APP_HOME, 'bin', 'se'), ...args, '--json'],
      { timeoutMs: 30_000 }
    )
  );

const workspaceCheck = 'super:workspace';
interface Workspace {
  id: string;
  target: string;
  projects: string[];
}

export async function removeSuperWorkspace(
  run: Runner,
  owned: string,
  home?: string
): Promise<Check> {
  const result = await ask(
    run,
    home,
    'workspace',
    'delete',
    owned,
    '--confirm'
  );
  if (
    'response' in result ||
    ('refused' in result && result.refused === 'not_found')
  )
    return {
      id: workspaceCheck,
      status: 'pass',
      summary: 'The fleet-created workspace was removed.',
    };
  return unanswered(workspaceCheck, result);
}

/** The app groups worktrees into projects and sections. Only a primary
 * worktree names the project directory itself. */
function projectRoots(rows: unknown): string[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row: unknown) => {
    if (!record(row)) return [];
    if (row['is_primary'] === true && typeof row['path'] === 'string')
      return [row['path']];
    return projectRoots(row['items']);
  });
}

async function discover(
  run: Runner,
  home?: string
): Promise<{ entries: Workspace[] } | { problem: Check }> {
  const list = await ask(run, home, 'workspace', 'list');
  if (!('response' in list))
    return { problem: unanswered(workspaceCheck, list) };
  const rows = list.response['workspaces'];
  const invalid = {
    problem: unanswered(workspaceCheck, { refused: 'unreadable' }),
  };
  if (!Array.isArray(rows)) return invalid;
  const entries = [];
  for (const row of rows) {
    if (!record(row) || typeof row['id'] !== 'string') return invalid;
    const got = await ask(run, home, 'workspace', 'get', row['id']);
    if (!('response' in got))
      return { problem: unanswered(workspaceCheck, got) };
    const w = got.response['workspace'];
    if (!record(w) || typeof w['type'] !== 'string') return invalid;
    if (w['type'] !== 'remote') continue;
    if (typeof w['ssh_target'] !== 'string') return invalid;
    const projects = projectRoots(row['sections']);
    entries.push({ id: row['id'], target: w['ssh_target'], projects });
  }
  return { entries };
}

async function matchWorkspace(
  entries: Workspace[],
  target: string,
  context: WorkerContext,
  home?: string
): Promise<{ workspace: Workspace | undefined } | { problem: Check }> {
  const { run, ownedWorkspace } = context;
  const owned = entries.find((w) => w.id === ownedWorkspace);
  if (owned && owned.target !== target) {
    const removed = await removeSuperWorkspace(run, owned.id, home);
    if (removed.status !== 'pass') return { problem: removed };
  }
  const matches = entries.filter((w) => w.target === target);
  const existing = matches.find((w) => w.id === ownedWorkspace) ?? matches[0];
  if (ownedWorkspace && existing && existing.id !== ownedWorkspace)
    await context.rememberWorkspace?.(null);
  return { workspace: existing };
}

export async function previewSuperWorkspaces(
  nodes: readonly FleetNode[],
  workers: readonly MachineDefinition[],
  run: Runner,
  home?: string
): Promise<Check[]> {
  if (!nodes.length) return [];
  const result = await discover(run, home);
  if ('problem' in result) return [result.problem];
  return nodes
    .filter(
      (node) =>
        !result.entries.some((w) => w.target === sshTarget(node, workers))
    )
    .map((node) => ({
      id: workspaceCheck,
      status: 'skip',
      summary: `Planned: create a super.engineering workspace for worker ${node.id}.`,
    }));
}

export function superIde(inputs: SuperInputs = {}): Ide {
  const workers = () => inputs.workers ?? fleet.workers;
  /** `super:app`: the app on the manager answers its CLI. */
  const app = async (run: Runner): Promise<Check> => {
    const id = 'super:app';
    const answer = await ask(run, inputs.home, 'status');
    return 'response' in answer
      ? {
          id,
          status: 'pass',
          summary: 'super.engineering on the manager answers its CLI.',
        }
      : unanswered(id, answer);
  };

  /** `super:ssh`: the SSH session the app opens reaches the worker and finds
   * what a remote workspace runs there. It is the manager's plain `ssh`,
   * with the operator's configuration and none of the fleet's options,
   * because that is what the app uses.
   */
  const host = async (
    node: FleetNode,
    target: string,
    run: Runner
  ): Promise<Check> => {
    const id = 'super:ssh';
    const result = await run(
      [
        'ssh',
        '-T',
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=10',
        target,
        PROBE,
      ],
      { timeoutMs: 30_000 }
    );
    if (!result.ok)
      return {
        id,
        status: 'warn',
        summary: 'SUPER_SSH_UNREACHABLE',
        remedy: {
          action: `super.engineering connects with the manager's own SSH configuration, and "ssh ${target}" does not reach worker ${node.id} without a prompt. Add an alias for it to ~/.ssh/config on the manager (HostName, User, Port, IdentityFile), accept its host key once, and name the alias as the worker's ssh in fleet.json.`,
        },
      };
    const found = new Map<string, string>();
    for (const line of result.stdout.split('\n')) {
      const [, command, path] = /^([a-z-]+)=(\/.*)$/.exec(line.trim()) ?? [];
      if (command && path) found.set(command, path);
    }
    const missing = HOST_COMMANDS.filter((command) => !found.has(command));
    if (missing.length)
      return {
        id,
        status: 'warn',
        summary: 'SUPER_HOST_INCOMPLETE',
        remedy: {
          action: `Worker ${node.id} has no ${missing.join(' or ')} in an SSH session without a terminal. Run converge for that worker: the baseline installs both.`,
        },
      };
    const agents = AGENT_COMMANDS.filter((command) => found.has(command));
    if (!agents.length)
      return {
        id,
        status: 'warn',
        summary: 'SUPER_AGENTS_NOT_FOUND',
        remedy: {
          action: `An SSH session without a terminal finds none of ${AGENT_COMMANDS.join(', ')} on worker ${node.id}, so super.engineering can start no agent there. Run converge for that worker: it installs the pinned agents and puts them on that session's PATH.`,
        },
      };
    const own = agents.filter(
      (command) => !found.get(command)!.includes(LAUNCHERS)
    );
    if (own.length)
      return {
        id,
        status: 'warn',
        summary: 'SUPER_AGENTS_NOT_PROXIED',
        remedy: {
          action: `On worker ${node.id} an SSH session without a terminal starts ${own.join(', ')} as the plain CLI, with a sign-in of its own, not through the CLI proxy. Run converge for that worker: it puts the fleet's launchers first on that session's PATH.`,
        },
      };
    return {
      id,
      status: 'pass',
      summary: `super.engineering's SSH session reaches worker ${node.id} and starts ${agents.join(', ')} through the CLI proxy.`,
    };
  };

  const create = async (
    nodeId: string,
    target: string,
    context: WorkerContext
  ): Promise<{ workspace: Workspace } | { problem: Check }> => {
    const created = await ask(
      context.run,
      inputs.home,
      'workspace',
      'create',
      nodeId,
      '--type',
      'remote',
      '--ssh-target',
      target
    );
    if (!('response' in created))
      return { problem: unanswered(workspaceCheck, created) };
    const w = created.response['workspace'];
    if (
      !record(w) ||
      typeof w['id'] !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(w['id'])
    )
      return { problem: unanswered(workspaceCheck, { refused: 'unreadable' }) };
    await context.rememberWorkspace?.(w['id']);
    return { workspace: { id: w['id'], target, projects: [] } };
  };
  const addProjects = async (
    existing: Workspace,
    run: Runner
  ): Promise<Check | undefined> => {
    const projects = inputs.projects ?? fleet.super?.projects ?? [];
    if (!projects.length) return;
    const remote = await run(
      [
        'ssh',
        '-T',
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=10',
        existing.target,
        'printf "%s" "$HOME"',
      ],
      { timeoutMs: 30_000 }
    );
    if (
      !remote.ok ||
      !posix.isAbsolute(remote.stdout) ||
      remote.stdout.includes('\n')
    )
      return unanswered(workspaceCheck, { refused: 'remote_home_unavailable' });
    for (const relative of projects) {
      const path = posix.join(remote.stdout, relative);
      if (existing.projects.includes(path)) continue;
      const added = await ask(
        run,
        inputs.home,
        'workspace',
        'add',
        existing.id,
        '--remote-project',
        path
      );
      if (!('response' in added)) return unanswered(workspaceCheck, added);
    }
    return undefined;
  };

  /** `super:workspace`: the app holds a remote workspace whose SSH target
   * is this worker, created here when it does not. A workspace is told by
   * its target alone: its name is the operator's to change.
   */
  const workspace = async (
    node: FleetNode,
    target: string,
    context: WorkerContext
  ): Promise<Check> => {
    const { run } = context;
    const id = workspaceCheck;
    const result = await discover(run, inputs.home);
    if ('problem' in result) return result.problem;
    const matched = await matchWorkspace(
      result.entries,
      target,
      context,
      inputs.home
    );
    if ('problem' in matched) return matched.problem;
    let existing = matched.workspace;
    if (!existing) {
      const result = await create(node.id, target, context);
      if ('problem' in result) return result.problem;
      existing = result.workspace;
    }
    return (
      (await addProjects(existing, run)) ?? {
        id,
        status: 'pass',
        summary: `super.engineering on the manager holds the SSH workspace of worker ${node.id}.`,
      }
    );
  };

  return {
    id: 'super',
    // The app keeps nothing on a machine that homelab declares.
    settings: async () => [],
    manager: async (context) => [await app(context.run)],
    async worker(node, context) {
      const target = sshTarget(node, workers());
      const reached = await host(node, target, context.run);
      // A workspace the app cannot reach only asks the operator for a key.
      return reached.summary === 'SUPER_SSH_UNREACHABLE'
        ? [reached]
        : [reached, await workspace(node, target, context)];
    },
  };
}

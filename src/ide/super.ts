import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Check, CommandResult, FleetNode, Runner } from '../types';
import type { Ide } from './ide';
import type { MachineDefinition } from '../definition';
import { record } from '../config';
import { fleet } from '../fleet-config';
import { declaredConnection } from '../ssh-connection';
import { NATIVE_AGENTS } from '../agents/native-verify';

/** super.engineering, the second supported IDE. It is a desktop app on the
 * manager only: a worker is one of its remote workspaces, reached over the
 * manager's own SSH, where the app installs and updates its helper itself.
 * dev-fleet installs nothing of it. On the manager it asks the app, through
 * the app's CLI, for one remote workspace per worker; of a worker it measures
 * what such a workspace needs.
 */

/** Where the app keeps its data, and its CLI, under the home directory. */
const APP_HOME = '.super.engineering';

/** What a remote workspace needs on the host, besides a coding agent. */
const HOST_COMMANDS = ['git', 'flock'];
const AGENT_COMMANDS = NATIVE_AGENTS.map((agent) => agent.binary);

/** Prints each command the session finds, one a line. The app starts agents
 * from a session like this one: no terminal, no login shell.
 */
const PROBE = `for c in ${[...HOST_COMMANDS, ...AGENT_COMMANDS].join(' ')}; do command -v "$c" >/dev/null 2>&1 && printf '%s\\n' "$c"; done; true`;

const INSTALL =
  'Install super.engineering on the manager (https://super.engineering/download) and start it once, then run fleet-sync.';
const START = 'Start super.engineering on the manager, then run fleet-sync.';

/** What the scenarios replace: the home directory and the declared workers. */
export interface SuperInputs {
  home?: string;
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
          'In super.engineering on the manager, open Settings → Experimental and enable Remote workspaces, then run fleet-sync.',
      },
    };
  return {
    id,
    status: 'warn',
    summary: 'SUPER_REFUSED',
    remedy: {
      action: `super.engineering on the manager answered ${answer.refused}. Update the app, start it again, then run fleet-sync.`,
    },
  };
}

export function superIde(inputs: SuperInputs = {}): Ide {
  const cli = () => join(inputs.home ?? homedir(), APP_HOME, 'bin', 'se');
  const workers = () => inputs.workers ?? fleet.workers;
  const ask = async (run: Runner, ...args: string[]): Promise<Answer> =>
    parse(await run([cli(), ...args, '--json'], { timeoutMs: 30_000 }));

  /** `super:app`: the app on the manager answers its CLI. */
  const app = async (run: Runner): Promise<Check> => {
    const id = 'super:app';
    const answer = await ask(run, 'status');
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
    const found = new Set(result.stdout.split('\n').map((line) => line.trim()));
    const missing = HOST_COMMANDS.filter((command) => !found.has(command));
    if (missing.length)
      return {
        id,
        status: 'warn',
        summary: 'SUPER_HOST_INCOMPLETE',
        remedy: {
          action: `Worker ${node.id} has no ${missing.join(' or ')} in an SSH session without a terminal. Run fleet-sync for that worker: the baseline installs both.`,
        },
      };
    const agents = AGENT_COMMANDS.filter((command) => found.has(command));
    if (!agents.length)
      return {
        id,
        status: 'warn',
        summary: 'SUPER_AGENTS_NOT_FOUND',
        remedy: {
          action: `An SSH session without a terminal finds none of ${AGENT_COMMANDS.join(', ')} on worker ${node.id}, so super.engineering can start no agent there. Run fleet-sync for that worker: it installs the pinned agents and puts them on that session's PATH.`,
        },
      };
    return {
      id,
      status: 'pass',
      summary: `super.engineering's SSH session reaches worker ${node.id} and finds ${agents.join(', ')}.`,
    };
  };

  /** `super:workspace`: the app holds a remote workspace whose SSH target
   * is this worker, created here when it does not. A workspace is told by
   * its target alone: its name is the operator's to change.
   */
  const workspace = async (
    node: FleetNode,
    target: string,
    run: Runner
  ): Promise<Check> => {
    const id = 'super:workspace';
    const list = await ask(run, 'workspace', 'list');
    if (!('response' in list)) return unanswered(id, list);
    const listed = list.response['workspaces'];
    for (const entry of Array.isArray(listed) ? listed : []) {
      if (!record(entry) || typeof entry['id'] !== 'string') continue;
      const got = await ask(run, 'workspace', 'get', entry['id']);
      const held = 'response' in got ? got.response['workspace'] : undefined;
      if (
        record(held) &&
        held['type'] === 'remote' &&
        held['ssh_target'] === target
      )
        return {
          id,
          status: 'pass',
          summary: `super.engineering on the manager holds the SSH workspace of worker ${node.id}.`,
        };
    }
    const created = await ask(
      run,
      'workspace',
      'create',
      node.id,
      '--type',
      'remote',
      '--ssh-target',
      target
    );
    return 'response' in created
      ? {
          id,
          status: 'pass',
          summary: `super.engineering on the manager was given the SSH workspace of worker ${node.id}.`,
        }
      : unanswered(id, created);
  };

  return {
    id: 'super',
    // The app keeps nothing on a machine that dev-fleet declares.
    settings: async () => [],
    manager: async (context) => [await app(context.run)],
    async worker(node, context) {
      const target = sshTarget(node, workers());
      const reached = await host(node, target, context.run);
      // A workspace the app cannot reach only asks the operator for a key.
      return reached.summary === 'SUPER_SSH_UNREACHABLE'
        ? [reached]
        : [reached, await workspace(node, target, context.run)];
    },
  };
}

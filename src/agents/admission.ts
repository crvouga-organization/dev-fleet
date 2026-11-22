import { readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import policy from '../../ansible/ubuntu/policy.json';
import { declaredFromKernel } from '../agent-session-limit';

/** The scope T3 starts an agent in, and the slice it owns for them. */
const SCOPE = /^t3code-[\w-]+\.scope$/;
const OWNED_SLICE = /^app-t3code-agents-[0-9a-f]+\.slice$/;

export const REFUSED_EXIT_CODE =
  policy.resourceSafety.agentSessionLimit.refusedExitCode;

export interface Admission {
  /** Agent scopes in the slice, this launcher's own included. */
  running: number;
  limit: number;
}

/** Whether this launcher was started above the worker's limit on agent
 * sessions: it reads the limit the kernel holds on the slice it was started
 * in and counts the scopes there. Undefined wherever no limit applies: off
 * Linux, outside a scope T3 started (its version and capability probes run
 * in T3's own unit), or with no limit held.
 *
 * T3 starts an agent with `systemd-run --user --scope` and reports only how
 * it ended, so the launcher is the one place a refusal can say why.
 */
export function admission(
  read: {
    file: (path: string) => string;
    directory: (path: string) => string[];
  } = {
    file: (path) => readFileSync(path, 'utf8'),
    directory: (path) => readdirSync(path),
  },
  mount = '/sys/fs/cgroup'
): Admission | undefined {
  try {
    const own = /^0::(\/.*)$/m.exec(read.file('/proc/self/cgroup'))?.[1];
    if (own === undefined || !SCOPE.test(basename(own))) return undefined;
    const slice = dirname(own);
    if (!OWNED_SLICE.test(basename(slice))) return undefined;
    const limit = declaredFromKernel(
      read.file(join(mount, slice, 'cgroup.max.descendants'))
    );
    if (limit === undefined) return undefined;
    return {
      limit,
      running: read
        .directory(join(mount, slice))
        .filter((name) => SCOPE.test(name)).length,
    };
  } catch {
    // An unreadable cgroup tree is no reason to refuse an agent.
    return undefined;
  }
}

/** What a refused launcher prints: the limit, and both ways out. */
export function refusal({ running, limit }: Admission): string | undefined {
  if (running <= limit) return undefined;
  return `AGENT_SESSION_REFUSED: this worker already runs ${running - 1} agent sessions and its limit is ${limit} (agentSessionLimit in the fleet configuration), so this one was not started. End a session that is no longer needed and send the message again, or raise agentSessionLimit in fleet.json and run devfleet fleet-sync.`;
}

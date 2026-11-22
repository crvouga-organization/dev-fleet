import policy from '../ansible/ubuntu/policy.json';

/** The opt-in limit on the agent sessions a worker runs at once
 * (`agentSessionLimit` in the fleet configuration: fleet-wide under `worker`,
 * or a worker's own). It is a number someone chose for their workers, never
 * derived from the estimated size of a session, and never below one: a
 * limit that refuses every session has no way back from inside T3.
 *
 * `tasks/agent-session-limit.yml` declares it and `worker:agent-sessions`
 * measures it. Two things refuse, and the first is the readable one:
 *
 * - a fleet launcher, started in a scope above the limit, ends with
 *   `AGENT_SESSION_REFUSED` (src/agents/admission.ts);
 * - the kernel refuses a scope `reserve` above the limit, for an agent T3
 *   starts without a fleet launcher. T3 shows that as a provider that
 *   exited with code 1 before it started.
 */
export const SESSION_LIMIT_MAXIMUM = 512;
export const SESSION_LIMIT_EXPECTED = `a whole number of agent sessions from 1 to ${SESSION_LIMIT_MAXIMUM}`;

export function validSessionLimit(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= SESSION_LIMIT_MAXIMUM
  );
}

/** The limit declared for one worker, or undefined when none is. */
export function agentSessionLimit(
  definition: {
    worker?: { agentSessionLimit?: number };
    workers: { id: string; agentSessionLimit?: number }[];
  },
  node: string
): number | undefined {
  return (
    definition.workers.find((entry) => entry.id === node)?.agentSessionLimit ??
    definition.worker?.agentSessionLimit
  );
}

/** What the kernel holds for a declared limit: the scopes it lets the slice
 * T3 owns have. The reserve is what lets a launcher start, count and refuse. */
export function kernelSessionLimit(limit: number): number {
  return limit + policy.resourceSafety.agentSessionLimit.reserve;
}

/** The declared limit behind a value read from the kernel, or undefined for
 * "max", an unreadable value or one too low to be a limit of ours. */
export function declaredFromKernel(value: string): number | undefined {
  const held = /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN;
  const limit = held - policy.resourceSafety.agentSessionLimit.reserve;
  return Number.isInteger(limit) && limit >= 1 ? limit : undefined;
}

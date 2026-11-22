import { join } from 'node:path';
import { clockCheck } from './clock';
import { healthChecks, parseProbe } from './machine-health';
import type { Check, Runner } from './types';
import policy from '../ansible/ubuntu/policy.json';
import { supportedSessions } from './worker-sizing';
import { fleet } from './fleet-config';
import { agentSessionLimit, kernelSessionLimit } from './agent-session-limit';
import type { HealthSample } from './machine-health';

export async function workerCapacity(
  root: string,
  node: string,
  run: Runner,
  /** The manager's clock in seconds since the epoch, when it sent one. */
  reference?: number,
  /** The limit on agent sessions declared for this worker, when one is. */
  limit: number | undefined = agentSessionLimit(fleet, node)
): Promise<Check[]> {
  const result = await run(['sh', join(root, 'ansible/net/remote-probe.sh')], {
    timeoutMs: 10_000,
  });
  const sample = parseProbe(result.stdout);
  if (
    !result.ok ||
    sample.ncpu === undefined ||
    sample.load === undefined ||
    sample.memFreePct === undefined ||
    sample.diskMb === undefined
  )
    return [
      {
        id: 'worker:capacity',
        status: 'fail',
        summary: 'Required CPU, memory and disk evidence is unavailable.',
      },
    ];
  return [
    ...healthChecks(sample, node).map((check) => ({
      id: `worker:capacity:${check.id}`,
      status: check.severity,
      summary: check.detail,
      ...(check.fix ? { remedy: { action: check.fix } } : {}),
    })),
    ...(sample.memTotalMb === undefined
      ? []
      : [sessionsCheck(sample.memTotalMb, sample, limit)]),
    clockCheck(
      'worker:clock',
      sample,
      reference === undefined || sample.epoch === undefined
        ? undefined
        : sample.epoch - reference
    ),
  ];
}

const SESSIONS_EXHAUSTED = 'AGENTS_OVER_CAPACITY';
const LIMIT_UNENFORCED = 'AGENT_SESSION_LIMIT_UNENFORCED';

/** What the probe measured of a worker's agent sessions. */
export type SessionSample = Pick<
  HealthSample,
  | 'agentSessions'
  | 'agentScopes'
  | 'agentLimitHeld'
  | 'agentLimitUnit'
  | 'agentPeaks'
  | 'agentPeakMedianMb'
  | 'agentPeakMaxMb'
>;

/** The estimate of a session's size against the agents running now: the
 * median and the largest of their memory peaks, how far the estimate is from
 * the median and how many sessions the worker would support at it. Empty
 * while no agent runs. */
function measured(memoryMiB: number, sample: SessionSample): string {
  const { agentPeaks, agentPeakMedianMb, agentPeakMaxMb } = sample;
  if (!agentPeaks || agentPeakMedianMb === undefined) return '';
  const each = policy.sizing.agentSessionMiB + policy.sizing.agentBuildMiB;
  const drift = each - agentPeakMedianMb;
  return ` Measured: the ${agentPeaks} running now peaked at a median of ${agentPeakMedianMb} MiB and at most ${agentPeakMaxMb ?? agentPeakMedianMb} MiB each; the estimate is ${Math.abs(drift)} MiB ${drift >= 0 ? 'above' : 'below'} that median, at which this worker would support ${supportedSessions(memoryMiB, Math.max(1, agentPeakMedianMb))}.`;
}

/** Why a declared limit is not what the worker holds, or undefined when it
 * is: its unit runs with that limit, and no slice T3 owns holds another. */
function unenforced(limit: number, sample: SessionSample): string | undefined {
  const held = kernelSessionLimit(limit);
  if (sample.agentLimitUnit === undefined)
    return 'whether its unit runs could not be read';
  if (sample.agentLimitUnit === 0) return 'its unit is not running';
  if (sample.agentLimitUnit !== held)
    return `its unit holds ${sample.agentLimitUnit} scopes, not the ${held} that limit needs`;
  if (sample.agentLimitHeld !== undefined && sample.agentLimitHeld !== held)
    return `the kernel holds ${sample.agentLimitHeld} scopes on the slice T3 starts agents in, not ${held}`;
  if (
    sample.agentLimitHeld === undefined &&
    sample.agentScopes !== undefined &&
    sample.agentScopes > 0
  )
    return 'the kernel holds no limit on the slice T3 starts agents in';
  return undefined;
}

/** How many agent sessions this worker's memory policy supports, how many
 * run, and whether anything refuses the next one.
 *
 * The size of a session is an estimate (`sizing.agentSessionMiB`), so more
 * sessions than it supports only warns, and the check holds the estimate
 * against the peaks of the agents running now. That number is a
 * recommendation: T3's administrator policy has no limit on sessions. What
 * refuses a session is the opt-in `agentSessionLimit` of the fleet
 * configuration (src/agent-session-limit.ts); a declared limit the worker
 * does not hold fails. What is always enforced is memory
 * (docs/ubuntu-sync.md, Memory safety), which stops the largest agent once
 * the others are squeezed.
 */
export function sessionsCheck(
  memoryMiB: number,
  sample: SessionSample = {},
  limit?: number
): Check {
  const running = sample.agentSessions;
  const supported = supportedSessions(memoryMiB);
  const each = policy.sizing.agentSessionMiB + policy.sizing.agentBuildMiB;
  const now = running === undefined ? 'an unknown number' : String(running);
  const over = running !== undefined && running > supported;
  const fault = limit === undefined ? undefined : unenforced(limit, sample);
  const counted = sample.agentScopes ?? 0;
  const admission =
    limit === undefined
      ? over
        ? ' Nothing refuses a session above that number.'
        : ''
      : fault !== undefined
        ? ''
        : ` The worker refuses a session above its declared limit of ${limit}; ${counted} count toward it.${counted >= limit ? ' It is at that limit: the next session is refused, which T3 shows as a provider that exited before it started.' : ''}`;
  const facts = `${now} agent sessions running; the memory policy supports ${supported} at once on ${memoryMiB} MiB (an estimated ${each} MiB each).${admission}${measured(memoryMiB, sample)}`;
  if (limit !== undefined && fault !== undefined)
    return {
      id: 'worker:agent-sessions',
      status: 'fail',
      summary: `${LIMIT_UNENFORCED}: the declared limit of ${limit} agent sessions is not held on this worker: ${fault}. ${facts}`,
      remedy: {
        action:
          'Run devfleet fleet-sync: it declares the unit that holds the limit in the worker’s user manager. Until then the worker refuses no session. To run without a limit, remove agentSessionLimit from fleet.json and sync.',
      },
    };
  return {
    id: 'worker:agent-sessions',
    status: over ? 'warn' : 'pass',
    summary: `${over ? `${SESSIONS_EXHAUSTED}: ` : ''}${facts}`,
    ...(over
      ? {
          remedy: {
            action:
              limit === undefined
                ? 'More agent sessions run than the memory policy supports. The number is a recommendation, not an admission limit: T3 Code has no limit on the sessions it starts, so the worker accepts the next one too. Each session is still capped, so the largest may be stopped under pressure. Finish some, move work to a worker with more memory, or declare agentSessionLimit in fleet.json to have the worker refuse sessions above a number you choose.'
                : `More agent sessions run than the memory policy supports, and the declared limit of ${limit} admits them. Each session is still capped, so the largest may be stopped under pressure. Finish some, move work to a worker with more memory, or lower agentSessionLimit in fleet.json.`,
          },
        }
      : {}),
  };
}

import { join } from 'node:path';
import { clockCheck } from './clock';
import { healthChecks, parseProbe } from './machine-health';
import type { Check, Runner } from './types';
import policy from '../ansible/ubuntu/policy.json';
import { agentMemoryMiB, supportedSessions } from './worker-sizing';
import { fleet } from './fleet-config';
import { agentSessionLimit, kernelSessionLimit } from './agent-session-limit';
import type { HealthSample } from './machine-health';

export async function workerCapacity(
  root: string,
  node: string,
  run: Runner,
  /** The manager's clock in seconds since the epoch, when it sent one. */
  reference?: number
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
      : [
          sessionsCheck(
            sample.memTotalMb,
            sample,
            agentSessionLimit(fleet, node)
          ),
        ]),
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
const CAPACITY_CODE = {
  measurement: SESSIONS_EXHAUSTED,
  projection: 'AGENT_PEAK_PROJECTION',
  estimate: SESSIONS_EXHAUSTED,
};
const LIMIT_INACTIVE = 'AGENT_SESSION_LIMIT_INACTIVE';

/** What the probe measured of a worker's agent sessions. */
export type SessionSample = Pick<
  HealthSample,
  | 'agentSessions'
  | 'agentShared'
  | 'agentScopes'
  | 'agentLimitHeld'
  | 'agentLimitUnit'
  | 'agentPeaks'
  | 'agentPeakMedianMb'
  | 'agentPeakMaxMb'
  | 'agentPeakSumMb'
  | 'agentsReachedMb'
>;

/** The estimate of a session's size against the agents running now: the
 * median and the largest of their memory peaks, those peaks added up against
 * the memory the policy leaves agents, how far the estimate is from the
 * median and how many sessions the worker would support at it. Empty while
 * no agent runs. */
function measured(memoryMiB: number, sample: SessionSample): string {
  const { agentPeaks, agentPeakMedianMb, agentPeakMaxMb } = sample;
  if (!agentPeaks || agentPeakMedianMb === undefined) return reached(sample);
  const each = policy.sizing.agentSessionMiB + policy.sizing.agentBuildMiB;
  const drift = each - agentPeakMedianMb;
  const together =
    sample.agentPeakSumMb === undefined
      ? ''
      : `, ${sample.agentPeakSumMb} MiB added up, of the ${agentMemoryMiB(memoryMiB)} MiB the memory policy leaves agents`;
  return ` Measured: the ${agentPeaks} running now peaked at a median of ${agentPeakMedianMb} MiB and at most ${agentPeakMaxMb ?? agentPeakMedianMb} MiB each${together}; the estimate is ${Math.abs(drift)} MiB ${drift >= 0 ? 'above' : 'below'} that median, at which this worker would support ${supportedSessions(memoryMiB, Math.max(1, agentPeakMedianMb))}.${reached(sample)}`;
}

/** The most everything T3 started took at one moment, where the kernel
 * kept it: the one number that holds the sessions that ended. */
function reached({ agentsReachedMb }: SessionSample): string {
  return agentsReachedMb === undefined
    ? ''
    : ` Everything T3 Code started on this worker, sessions that ended among it, took at most ${agentsReachedMb} MiB at one moment.`;
}

/** Prefer the kernel's simultaneous slice peak. Older probes can only
 * project the sum of separate peaks or estimate capacity by session count. */
function capacity(
  memoryMiB: number,
  sample: SessionSample
): { over: boolean; by: 'measurement' | 'projection' | 'estimate' } {
  if (sample.agentsReachedMb !== undefined)
    return {
      over: sample.agentsReachedMb > agentMemoryMiB(memoryMiB),
      by: 'measurement',
    };
  if (sample.agentPeakSumMb !== undefined)
    return {
      over: sample.agentPeakSumMb > agentMemoryMiB(memoryMiB),
      by: 'projection',
    };
  const running = sample.agentSessions;
  return {
    over: running !== undefined && running > supportedSessions(memoryMiB),
    by: 'estimate',
  };
}

/** More sessions than the estimate supports that fit by measurement: said,
 * so the two numbers of one summary do not read as a contradiction. */
function fits(memoryMiB: number, sample: SessionSample): string {
  const running = sample.agentSessions ?? 0;
  const { over, by } = capacity(memoryMiB, sample);
  return by !== 'estimate' && !over && running > supportedSessions(memoryMiB)
    ? ' More run than the estimate supports, and that does not warn: what they took fits.'
    : '';
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

/** What was counted, in the words of what it is.
 *
 * T3 Code starts one process for each session of most agents, and one for
 * all the sessions of Codex and of OpenCode. The cgroup tree shows processes,
 * so the shared ones are named as that and no number of sessions is made up
 * for them. A probe that prints no `agentshared` is an older one, which also
 * counted each terminal and preview browser.
 */
function counted(sample: SessionSample): string {
  const { agentSessions: running, agentShared: shared } = sample;
  if (running === undefined)
    return 'an unknown number of agent sessions running';
  if (shared === undefined)
    return `${running} agent sessions running, as counted by an older capacity probe: each open terminal and preview browser is among them, and all the sessions of Codex or of OpenCode are one`;
  if (shared === 0) return `${running} agent sessions running`;
  return `${running} agent processes running: ${running - shared} agent sessions, and ${shared} that Codex or OpenCode serves all its sessions from, however many those are`;
}

/** How many agent sessions this worker's memory policy supports, how many
 * run, and whether anything refuses the next one.
 *
 * What runs is counted in processes (see `counted`): a terminal or a preview
 * browser is not one, and a process Codex or OpenCode shares among its
 * sessions is one.
 *
 * The size of a session is an estimate (`sizing.agentSessionMiB`), so it
 * does not decide the warning where the kernel measured the agents
 * (`capacity`): the check warns when what they took does not fit, and says
 * how far the estimate is from them. That number is a
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
  const supported = supportedSessions(memoryMiB);
  const each = policy.sizing.agentSessionMiB + policy.sizing.agentBuildMiB;
  const { over, by } = capacity(memoryMiB, sample);
  const fault = limit === undefined ? undefined : unenforced(limit, sample);
  const facts = `${counted(sample)}; the memory policy supports ${supported} at once on ${memoryMiB} MiB (an estimated ${each} MiB each).${fault === undefined ? admitted(limit, over, sample.agentScopes ?? 0) : ''}${measured(memoryMiB, sample)}${fits(memoryMiB, sample)}`;
  if (fault !== undefined)
    return {
      id: 'worker:agent-sessions',
      status: 'fail',
      summary: `${LIMIT_INACTIVE}: the declared limit of ${limit} agent sessions is not held on this worker: ${fault}. ${facts}`,
      remedy: {
        action:
          'Run devfleet fleet-sync: it declares the unit that holds the limit in the worker’s user manager. Until then the worker refuses no session. To run without a limit, remove agentSessionLimit from fleet.json and sync.',
      },
    };
  const exceeded = limit !== undefined && (sample.agentScopes ?? 0) > limit;
  if (exceeded)
    return {
      id: 'worker:agent-sessions',
      status: 'warn',
      summary: `AGENT_SESSION_LIMIT_EXCEEDED: ${facts}`,
      remedy: {
        action:
          'Inspect the scopes counted toward the declared session limit and finish excess sessions.',
      },
    };
  return {
    id: 'worker:agent-sessions',
    status: over ? 'warn' : 'pass',
    summary: over ? `${CAPACITY_CODE[by]}: ${facts}` : facts,
    ...(over ? { remedy: { action: overRemedy(limit, by) } } : {}),
  };
}

/** What refuses the next session: nothing, or the declared limit. */
function admitted(
  limit: number | undefined,
  over: boolean,
  counted: number
): string {
  if (limit === undefined)
    return over ? ' Nothing refuses a session above that number.' : '';
  return ` The worker refuses a session above its declared limit of ${limit}; ${counted} count toward it.${counted >= limit ? ' It is at that limit: the next session is refused, which T3 shows as a provider that exited before it started.' : ''}`;
}

function overRemedy(
  limit: number | undefined,
  by: 'measurement' | 'projection' | 'estimate'
): string {
  const found =
    by === 'measurement'
      ? 'The kernel measured concurrent agent memory above budget'
      : by === 'projection'
        ? 'The separate peaks would exceed the budget if they coincided. Inspect the aggregate memory peak before changing capacity'
        : 'More agent sessions run than the memory policy supports';
  if (by === 'projection') return found + '.';
  return limit === undefined
    ? `${found}. The number is a recommendation, not an admission limit: T3 Code has no limit on the sessions it starts, so the worker accepts the next one too. Each session is still capped, so the largest may be stopped under pressure. Finish some, move work to a worker with more memory, or declare agentSessionLimit in fleet.json to have the worker refuse sessions above a number you choose.`
    : `${found}, and the declared limit of ${limit} admits them. Each session is still capped, so the largest may be stopped under pressure. Finish some, move work to a worker with more memory, or lower agentSessionLimit in fleet.json.`;
}

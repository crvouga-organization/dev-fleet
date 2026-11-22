import type { Check } from '../types';

/** A node that took at least this long has its slowest steps listed. */
export const SLOW_NODE_MS = 60_000;

/** One step of a node, by how long it took. */
export interface SlowStep {
  /** The check that stands for the step. */
  id: string;
  durationMs: number;
  /** How many other checks the step produced in that time. */
  others: number;
}

/** Checks one step produced: they follow each other and carry the step's
 * duration.
 */
function steps(checks: Check[]): Check[][] {
  const groups: Check[][] = [];
  for (const check of checks) {
    const last = groups.at(-1);
    if (
      last &&
      check.phaseDurationMs !== undefined &&
      last[0]!.phaseDurationMs === check.phaseDurationMs
    )
      last.push(check);
    else groups.push([check]);
  }
  return groups;
}

/** A step, named by the check that explains its time: the one measured on
 * its own that took at least half of it, else its first check.
 */
function stepOf(group: Check[]): SlowStep | null {
  const whole = group[0]!.phaseDurationMs;
  const own = group
    .filter((check) => check.durationMs !== undefined)
    .sort((a, b) => b.durationMs! - a.durationMs!)[0];
  if (own && (whole === undefined || own.durationMs! * 2 >= whole))
    return { id: own.id, durationMs: own.durationMs!, others: 0 };
  return whole === undefined
    ? null
    : { id: group[0]!.id, durationMs: whole, others: group.length - 1 };
}

/** The steps a node spent the most time in, slowest first: at most `limit`,
 * and none under a second.
 */
export function slowest(checks: Check[], limit = 3): SlowStep[] {
  return steps(checks)
    .map(stepOf)
    .filter(
      (step): step is SlowStep => step !== null && step.durationMs >= 1000
    )
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, limit);
}

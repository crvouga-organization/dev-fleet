import managerPolicy from '../../ansible/macos/policy.json';
import { loadEnrollment } from '../state/enrollment';
import { readHistory, type History } from '../state/history';
import type { Enrollment } from '../machine/state';
import type { Check } from '../types';
import { fleet } from '../fleet-config';
import { readParked } from '../state/workers';
import type { TailnetComputer } from '../tailscale';
import type { FleetNode, NodeReport, Runner } from '../types';
import { fleetUsage, usageSummary, type WorkerUsage } from '../worker-activity';
import { parkedCheck, parkedOnline } from '../worker-parking';

/** The workers fleet-status contacts: every one that is not parked. */
export function activeNodes(nodes: FleetNode[]): FleetNode[] {
  const parked = readParked();
  return nodes.filter((node) => !parked[node.id]);
}

function reportOf(reports: NodeReport[], id: string): NodeReport {
  const worker = fleet.workers.find((entry) => entry.id === id);
  const found = reports.find(
    (entry) =>
      entry.node === id ||
      (worker?.network && entry.node === worker.network.tailscaleName)
  );
  if (found) return found;
  const added: NodeReport = { node: id, checks: [] };
  reports.push(added);
  return added;
}

function appliedSummary(
  revision: string | undefined,
  appliedAt: string | undefined,
  approved: string,
  now: Date
) {
  const details = [
    `Applied ${revision ?? 'unknown'} at ${appliedAt ?? 'unknown'}.`,
    `Approved ${approved}.`,
  ];
  const hours =
    appliedAt === undefined
      ? null
      : Math.max(
          0,
          Math.floor((now.getTime() - Date.parse(appliedAt)) / 3600000)
        );
  if (hours !== null) details.push(`Last applied ${hours} hours ago.`);
  return { hours, details };
}

export function convergenceCheck(
  id: string,
  enrollment: Enrollment,
  history: History,
  now: Date
): Check {
  const revision = enrollment.workers?.[id];
  const recent = [...history.runs].reverse();
  const last = recent.find((run) => run.workers?.[id]);
  const receipt = history.lastApplied?.[id];
  const appliedAt =
    receipt && receipt.revision === revision ? receipt.at : undefined;
  const failure = last && last.workers![id]!.failed;
  const behind = revision !== enrollment.approvedRevision;
  const { details, hours } = appliedSummary(
    revision,
    appliedAt,
    enrollment.approvedRevision,
    now
  );
  if (failure)
    details.push(`Last failure at ${last!.finishedAt} in ${failure}.`);
  const stale =
    Boolean(failure) ||
    (behind &&
      (hours === null ||
        hours >= managerPolicy.fleetSync.convergenceWarnHours));
  return {
    id: 'worker:convergence',
    ...(stale
      ? {
          status: 'warn',
          summary: ['WORKER_NOT_CONVERGED', details.join(' ')].join(': '),
          remedy: {
            action: `Run homelab converge --node ${id} and inspect the failed check.`,
          },
        }
      : { status: behind ? 'skip' : 'pass', summary: details.join(' ') }),
  };
}

/** Adds to fleet-status what it says about each worker beyond its health:
 * parked workers as parked (and a warning when one is online anyway), and
 * for every active worker it reaches its uptime, agent turns, last agent
 * activity and `worker:idle`. Returns the `workers` of the JSON output and
 * its `usage` summary.
 */
export async function appendUsage(
  reports: NodeReport[],
  nodes: FleetNode[],
  {
    run,
    computers = [],
    now = new Date(),
  }: { run: Runner; computers?: TailnetComputer[]; now?: Date }
): Promise<{ workers: WorkerUsage[]; usage: ReturnType<typeof usageSummary> }> {
  const parked = readParked();
  for (const worker of fleet.workers) {
    const at = parked[worker.id];
    if (!at) continue;
    const report = reportOf(reports, worker.id);
    report.checks.push(parkedCheck(worker.id, at, now));
    const online = parkedOnline(
      worker.id,
      worker.network?.tailscaleName,
      computers
    );
    if (online) report.checks.push(online);
  }
  const enrollment = await loadEnrollment(null);
  if (enrollment) {
    const history = readHistory();
    for (const worker of fleet.workers)
      if (!parked[worker.id])
        reportOf(reports, worker.id).checks.push(
          convergenceCheck(worker.id, enrollment, history, now)
        );
  }
  const { workers, checks } = await fleetUsage(fleet, {
    nodes: nodes.filter((node) => !parked[node.id]),
    parked,
    run,
    now,
  });
  for (const [id, check] of checks) reportOf(reports, id).checks.push(check);
  return { workers, usage: usageSummary(workers) };
}

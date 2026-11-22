import { parseConfig } from './config';
import { sshTarget, type FleetDefinition } from './definition';
import { FleetUsageError } from './errors';
import { fleetJson } from './fleet-config';
import type { FleetConfig } from './types';

/** Kept apart from `definition.ts`, which `fleet-config` reads: the refusal
 * names fleet.json the way this process found it.
 */

/** Local v1 roster supplies paths/requirements only for explicitly enrolled workers. */
export function enrolledRoster(
  definition: FleetDefinition,
  overrides: unknown
): FleetConfig {
  const roster = parseConfig(overrides);
  for (const node of roster.nodes) {
    const declared = definition.workers.find((entry) => entry.id === node.id);
    if (!declared)
      throw new FleetUsageError(
        `Roster contains a node that is not a declared worker. Add the worker to ${fleetJson()} before rollout; the manager is never a roster node.`
      );
    if (sshTarget(declared) !== node.ssh)
      throw new FleetUsageError(
        'Fleet SSH assignment conflicts with the local roster. Review the migration; discovery cannot overwrite explicit assignments.'
      );
  }
  return {
    ...roster,
    nodes: roster.nodes.map((node) => ({
      ...node,
      required: [
        ...new Set([
          ...node.required,
          ...(definition.worker?.requiredCapabilities ?? []),
        ]),
      ],
    })),
  };
}

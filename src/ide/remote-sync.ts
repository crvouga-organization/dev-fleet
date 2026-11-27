import type { FleetDefinition } from '../definition';
import { idesOf } from './definition';
import type { Check, FleetNode, Runner } from '../types';
import {
  meshMembers,
  meshOf,
  ORCA,
  PARADEV,
  type RemoteIdeSpec,
} from './remote-mesh';

const REMOTE: Record<string, RemoteIdeSpec> = { orca: ORCA, paradev: PARADEV };

/** The remote IDEs the fleet enables, measured once the workers exist:
 * every machine registers every other machine.
 */
export async function remoteMeshChecks(
  definition: FleetDefinition,
  nodes: readonly FleetNode[],
  run: Runner,
  apply: boolean
): Promise<Check[]> {
  const enabled = idesOf(definition).flatMap((id) =>
    REMOTE[id] ? [REMOTE[id]] : []
  );
  if (!enabled.length) return [];
  const fleet = meshMembers(definition.manager, definition.workers, nodes);
  const checks: Check[] = [];
  for (const spec of enabled)
    checks.push(
      ...(await meshOf({
        spec,
        manager: fleet.manager,
        workers: fleet.workers,
        run,
        apply,
      }))
    );
  return checks;
}

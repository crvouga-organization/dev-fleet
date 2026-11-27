import { diagnostic } from '../diagnostics';
import { installedDefinition } from '../definition';
import { fleet, fleetJson } from '../fleet-config';
import { prepareSource } from '../machine/source';
import { managerFailure } from '../manager-failure';
import type { ManagerReport } from '../manager-sync';
import { trackedScript } from '../remote-bootstrap';
import type { Runner } from '../types';
import {
  editedWorkerCopies,
  type EditedWorkerCopy,
} from '../worker-configuration-copy';
import { workersToConverge } from './fleet-sync-mise';

/** The report of a run that a worker's edited copy stops before anything is
 * changed, if one does. Each worker's bootstrap refuses to replace a copy of
 * the configuration that was edited there, but it runs after the manager,
 * the fleet state and the workers before it have changed. So every worker
 * this run is about to converge is asked first what its bootstrap would
 * decide for the copy this run sends: the question is the text of that
 * bootstrap, read from the revision like the script the run sends. A worker
 * that does not answer does not stop the run. Null when the revision or its
 * script cannot be read: the run then stops for that reason by itself.
 */
export async function workerCopyRefusal(
  request: { revision: string; node?: string[] },
  sources: { root: string; roster: string; checkout: string },
  run: Runner
): Promise<ManagerReport | null> {
  const workers = await workersToConverge(request, sources.roster);
  if (workers.length === 0) return null;
  const source = await prepareSource(
    sources.root,
    request.revision,
    run,
    sources.checkout
  );
  const script = source
    ? await trackedScript(
        source,
        request.revision,
        'bootstrap/fleet-remote-bootstrap.sh',
        run
      )
    : null;
  if (!script) return null;
  const edited = await editedWorkerCopies(
    { script, configuration: installedDefinition(fleet) },
    workers,
    run
  );
  return edited.length ? refusal(request.revision, edited) : null;
}

/** Nothing was changed: every worker is accounted for, and the ones with an
 * edited copy carry the check their own bootstrap would have reported.
 */
function refusal(revision: string, edited: EditedWorkerCopy[]): ManagerReport {
  const names = edited.map(({ node }) => node).join(', ');
  const report = managerFailure(
    fleet,
    revision,
    'FLEET_CONFIGURATION_COPY_CHANGED',
    `Nothing was changed: the copy of the fleet configuration (~/.config/homelab/fleet.json) on ${names} was edited there since fleet-sync last wrote it, and a sync would replace it. A worker takes its configuration from the manager: to keep the edit, make the same change in ${fleetJson()}. Then, or to discard the edit, delete the copy on ${edited.length === 1 ? 'that worker' : 'each of those workers'} (rm ~/.config/homelab/fleet.json) and run converge again.`
  );
  for (const { node, check } of edited) {
    const entry = report.nodes.find((candidate) => candidate.node === node);
    if (!entry) continue;
    entry.reachability = 'online';
    entry.checks = [check];
    entry.diagnostics = [diagnostic(node, check)];
  }
  return report;
}

import type { Enrollment } from '../machine/state';
import { replicaCheck } from '../state/check';
import { loadEnrollment, storeEnrollment } from '../state/enrollment';
import { adoptEarlier } from '../state/legacy';
import { databasePath, stateRoot } from '../state/paths';
import { readDocument, writeDocument } from '../state/store';
import { readHistory } from '../state/history';
import { blocksPromotion } from '../manager-sync';
import {
  claimLease,
  refuseHeldLease,
  pending,
  push,
  type Standing,
  type StateContext,
} from '../state/sync';
import type { RevisionSelection } from '../revision-selection';
import type { Check } from '../types';

/** What one converge run records in the fleet state: the revision it was
 * approved for and the configuration it runs with, then what it applied, then
 * an upload so the bucket holds all of it.
 */
export interface RunRecord {
  /** Before any machine changes: this revision is the approved one. */
  approve(): void;
  /** Once the result is known. The check says whether the bucket holds it.
   * `applied` is the revision each worker that converged now holds: it is
   * kept even when the fleet as a whole is not ready, and it is all a run
   * scoped with --node records.
   */
  settle(ready: boolean, applied?: Record<string, string>): Promise<Check>;
  /** For a run that stopped before its result: its approval is still uploaded. */
  abandon(): Promise<void>;
}

export function runRecord(
  previous: Enrollment | null,
  revision: string,
  state: {
    context: StateContext;
    standing: Standing;
    env?: NodeJS.ProcessEnv;
    /** The configuration this run reads from a project's fleet.json. Stored
     * so that a run started anywhere else (the schedule, a hand-off from a
     * worker, a replacement manager) uses the one last applied.
     */
    definition?: string;
    /** A run scoped with --node covers only the workers it selected: it
     * records their revisions, never one applied for the whole fleet.
     */
    scoped?: boolean;
    /** What selected the revision. Recorded when this run makes it the
     * approved one: a run that approves the same revision again did not
     * change it, so what is recorded stands.
     */
    selection?: RevisionSelection;
    now?: Date;
  }
): RunRecord {
  const env = state.env ?? process.env;
  const approval: Enrollment = {
    ...previous,
    version: 1,
    id: 'manager',
    approvedRevision: revision,
    ...(state.selection && previous?.approvedRevision !== revision
      ? {
          selectedBy: {
            ...state.selection,
            at: (state.now ?? new Date()).toISOString(),
          },
        }
      : {}),
  };
  let settled = false;
  /** Uploads only what this run changed; otherwise the bucket stands as it
   * did when the run started.
   */
  const publish = (): Promise<Standing> =>
    pending(state.context)
      ? push(state.context)
      : Promise.resolve(state.standing);
  return {
    approve: () => {
      refuseHeldLease(state.context);
      storeEnrollment(approval, env);
      if (state.definition !== undefined) {
        adoptEarlier(env);
        writeDocument(
          databasePath(stateRoot(env)),
          'definition',
          state.definition
        );
      }
      claimLease(state.context);
    },
    async settle(ready, applied = {}) {
      settled = true;
      const converged = ready && state.scoped !== true;
      if (converged || Object.keys(applied).length) {
        // What was recorded since the approval stands: the run itself
        // retires a worker whose record was removed, and another command
        // may have. Only what this run decided is written over it.
        const stored = (await loadEnrollment(null, env)) ?? approval;
        storeEnrollment(
          {
            ...stored,
            ...(Object.keys(applied).length
              ? { workers: { ...stored.workers, ...applied } }
              : {}),
            ...(converged
              ? {
                  appliedRevision: revision,
                  ...(previous?.appliedRevision &&
                  previous.appliedRevision !== revision
                    ? { previousRevision: previous.appliedRevision }
                    : {}),
                }
              : {}),
          },
          env
        );
      }
      // The fleet converged either way: a bucket problem is reported, not fatal.
      return replicaCheck(await publish().catch(() => 'unreachable' as const), {
        advisory: true,
      });
    },
    async abandon() {
      if (!settled) await publish().catch(() => undefined);
    },
  };
}

/** Whether the run before this one already rolled this revision out to these
 * workers, with this configuration. Such a revision is not new to the fleet,
 * so no worker has to prove it before the others: they converge at once.
 *
 * The last run in the history was of this revision, it reached every one of
 * these workers (none was held back behind a failed canary), at least one
 * took it, and the configuration is the one that run stored. A worker that
 * took the revision and failed a check of its own (an account, a provider)
 * still took it. Anything that cannot be read answers no: the canary goes
 * first.
 */
export function rolledOutBefore(
  revision: string,
  workers: string[],
  /** This run's configuration; undefined when it runs with the stored one. */
  definition?: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  try {
    const last = readHistory(env).runs.at(-1);
    if (!last || last.revision !== revision || !last.workers) return false;
    if (
      definition !== undefined &&
      readDocument(databasePath(stateRoot(env)), 'definition') !== definition
    )
      return false;
    const results = workers.map((id) => last.workers![id]);
    const took = (result: (typeof results)[number]): boolean =>
      result !== undefined &&
      (result.applied === revision ||
        (result.failed !== undefined &&
          !blocksPromotion({
            id: result.failed,
            status: 'fail',
            summary: '',
          })));
    return (
      results.length > 0 &&
      results.every(
        (result) =>
          result !== undefined && result.failed !== 'rollout:promotion'
      ) &&
      results.some(took)
    );
  } catch {
    return false;
  }
}

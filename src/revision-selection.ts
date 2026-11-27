import { record } from './config';

/** What chose the revision a fleet-sync run converges to. */
export const SELECTORS = [
  'package',
  'revision',
  'rollback',
  'schedule',
  'checkout',
  'approved',
] as const;
export type Selector = (typeof SELECTORS)[number];

/** What selected a run's revision, as the fleet state, the report and the
 * history keep it: fixed words and a worker's fleet id only. Never an
 * account, a host name, a command line or anything read from the
 * environment of the run.
 */
export interface RevisionSelection {
  by: Selector;
  /** The run was handed to the manager by this worker (its fleet id), or by
   * a machine the fleet does not declare (null).
   */
  handOff?: { worker: string | null };
  /** The run was given --allow-unmerged: its revision did not have to be on
   * the default branch of the source repository.
   */
  allowUnmerged?: true;
}

/** How a run tells the run it starts (from the fleet-owned checkout, or on
 * the manager after a hand-off) what selected its revision. That run is the
 * revision's own code, which may be older than any flag, and it is always
 * given `--revision`, which says nothing about who chose it. The value names
 * the revision it is about, so it says nothing about any other run.
 */
export const SELECTED_BY_ENV = 'HOMELAB_SELECTED_BY';

const WORKER = /^[a-z][a-z0-9-]{0,62}$/;
const TOLD = new RegExp(
  `^([a-f0-9]{40}):(${SELECTORS.join('|')})(@([a-z][a-z0-9-]{0,62})?)?(\\+unmerged)?$`
);

const selector = (value: unknown): value is Selector =>
  (SELECTORS as readonly unknown[]).includes(value);

/** `REVISION:checkout`, `REVISION:checkout@worker-one`, `REVISION:checkout@`
 * for a machine the fleet does not declare, each with `+unmerged` when the
 * run was given --allow-unmerged.
 */
export function encodeSelection(
  revision: string,
  selection: RevisionSelection
): string {
  const from = selection.handOff ? `@${selection.handOff.worker ?? ''}` : '';
  return `${revision}:${selection.by}${from}${selection.allowUnmerged ? '+unmerged' : ''}`;
}

/** Null for anything but the words `encodeSelection` writes about this
 * revision.
 */
export function decodeSelection(
  text: string | undefined,
  revision: string
): RevisionSelection | null {
  const told = TOLD.exec(text ?? '');
  if (!told || told[1] !== revision) return null;
  return {
    by: told[2] as Selector,
    ...(told[3] !== undefined ? { handOff: { worker: told[4] ?? null } } : {}),
    ...(told[5] ? { allowUnmerged: true as const } : {}),
  };
}

/** A selection read back from the fleet state or a report, or null. */
export function parseSelection(value: unknown): RevisionSelection | null {
  if (!record(value) || !selector(value['by'])) return null;
  const handOff = value['handOff'];
  if (handOff !== undefined) {
    if (!record(handOff)) return null;
    const worker = handOff['worker'];
    if (worker !== null && (typeof worker !== 'string' || !WORKER.test(worker)))
      return null;
  }
  return {
    by: value['by'],
    ...(record(handOff)
      ? { handOff: { worker: handOff['worker'] as string | null } }
      : {}),
    ...(value['allowUnmerged'] === true ? { allowUnmerged: true } : {}),
  };
}

const WORDS: Record<Selector, string> = {
  package: 'the installed homelab package',
  revision: '--revision',
  rollback: '--rollback',
  schedule: "the manager's schedule",
  checkout: 'the HEAD of the checkout fleet-sync was started in',
  approved: 'the revision already approved',
};

/** One line for people: `--revision, handed off from worker-one (--allow-unmerged)`. */
export function selectionText(selection: RevisionSelection): string {
  const from = selection.handOff
    ? `, handed off from ${selection.handOff.worker ?? 'a machine the fleet does not declare'}`
    : '';
  return `${WORDS[selection.by]}${from}${selection.allowUnmerged ? ' (--allow-unmerged)' : ''}`;
}

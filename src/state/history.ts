import { record } from '../config';
import { parseSelection, type RevisionSelection } from '../revision-selection';
import { databasePath, stateRoot } from './paths';
import { readDocument, writeDocument } from './store';

/** Who started a fleet-sync run: a person (or an agent) at the manager, or
 * the manager's own schedule.
 */
export type Trigger = 'operator' | 'schedule';

/** One fleet-sync run, as the history keeps it: codes and node names only,
 * never a remedy, a path or anything a subprocess printed.
 */
export interface SyncRun {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  trigger: Trigger;
  revision: string | null;
  /** What selected the revision. Older histories omit it. */
  selectedBy?: RevisionSelection;
  ok: boolean;
  exitCode: number;
  /** The IDs of the checks that failed, once each. */
  failing: string[];
  /** The machines that were not ready when the run ended. */
  notReady: string[];
  /** Evidence for workers actually attempted by this run. Older histories omit it. */
  workers?: Record<string, { applied?: string; failed?: string }>;
}

/** The schedule the manager was last told to keep. */
export interface ScheduleRecord {
  enabled: boolean;
  intervalSeconds: number;
  changedAt: string;
}

export interface History {
  version: 1;
  schedule?: ScheduleRecord;
  runs: SyncRun[];
  lastApplied?: Record<string, { revision: string; at: string }>;
}

/** The history is capped twice: by age and by count, so the document stays
 * far below the fleet state's limit on one document.
 */
export const HISTORY_DAYS = 90;
export const HISTORY_RUNS = 500;

const DAY_MS = 86_400_000;

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function validWorkerEvidence(value: unknown): boolean {
  if (value === undefined) return true;
  return (
    record(value) &&
    Object.values(value).every(
      (entry) =>
        record(entry) &&
        ((typeof entry['applied'] === 'string' &&
          /^[a-f0-9]{40}$/.test(entry['applied']) &&
          entry['failed'] === undefined) ||
          (typeof entry['failed'] === 'string' &&
            /^[a-zA-Z0-9:._-]{1,200}$/.test(entry['failed']) &&
            entry['applied'] === undefined))
    )
  );
}

function syncRun(value: unknown): value is SyncRun {
  return (
    record(value) &&
    typeof value['startedAt'] === 'string' &&
    typeof value['finishedAt'] === 'string' &&
    typeof value['durationMs'] === 'number' &&
    ['operator', 'schedule'].includes(String(value['trigger'])) &&
    (value['revision'] === null || typeof value['revision'] === 'string') &&
    typeof value['ok'] === 'boolean' &&
    typeof value['exitCode'] === 'number' &&
    strings(value['failing']) &&
    strings(value['notReady']) &&
    validWorkerEvidence(value['workers'])
  );
}

/** A run whose selection is not in words this version knows keeps the rest. */
function knownSelection(run: SyncRun): SyncRun {
  const { selectedBy, ...rest } = run;
  const selection = parseSelection(selectedBy);
  return selection ? { ...rest, selectedBy: selection } : rest;
}

function appliedTimes(value: unknown): NonNullable<History['lastApplied']> {
  const result: NonNullable<History['lastApplied']> = {};
  if (!record(value)) return result;
  for (const [id, entry] of Object.entries(value)) {
    if (
      record(entry) &&
      typeof entry['revision'] === 'string' &&
      /^[a-f0-9]{40}$/.test(entry['revision']) &&
      typeof entry['at'] === 'string' &&
      Number.isFinite(Date.parse(entry['at']))
    )
      result[id] = { revision: entry['revision'], at: entry['at'] };
  }
  return result;
}

function scheduleRecord(value: unknown): value is ScheduleRecord {
  return (
    record(value) &&
    typeof value['enabled'] === 'boolean' &&
    typeof value['intervalSeconds'] === 'number' &&
    typeof value['changedAt'] === 'string'
  );
}

/** A document that cannot be read is an empty history: it only ever
 * describes the past, and the next run starts it again.
 */
export function parseHistory(text: string | null): History {
  let value: unknown = null;
  try {
    value = text === null ? null : JSON.parse(text);
  } catch {
    value = null;
  }
  if (!record(value) || value['version'] !== 1) return { version: 1, runs: [] };
  return {
    version: 1,
    ...(scheduleRecord(value['schedule'])
      ? { schedule: value['schedule'] }
      : {}),
    ...(value['lastApplied']
      ? { lastApplied: appliedTimes(value['lastApplied']) }
      : {}),
    runs: Array.isArray(value['runs'])
      ? value['runs'].filter(syncRun).map(knownSelection)
      : [],
  };
}

export function readHistory(env = process.env): History {
  return parseHistory(readDocument(databasePath(stateRoot(env)), 'history'));
}

function writeHistory(history: History, env: NodeJS.ProcessEnv): void {
  writeDocument(
    databasePath(stateRoot(env)),
    'history',
    JSON.stringify(history) + '\n'
  );
}

/** Keeps the runs of the last HISTORY_DAYS days, and at most HISTORY_RUNS. */
export function capped(runs: SyncRun[], now: Date): SyncRun[] {
  const oldest = now.getTime() - HISTORY_DAYS * DAY_MS;
  return runs
    .filter((run) => Date.parse(run.finishedAt) >= oldest)
    .slice(-HISTORY_RUNS);
}

export function appendRun(
  run: SyncRun,
  env = process.env,
  now = new Date()
): History {
  const history = readHistory(env);
  const lastApplied = { ...history.lastApplied };
  for (const [id, evidence] of Object.entries(run.workers ?? {}))
    if (evidence.applied)
      lastApplied[id] = { revision: evidence.applied, at: run.finishedAt };
  const next = {
    ...history,
    ...(Object.keys(lastApplied).length ? { lastApplied } : {}),
    runs: capped([...history.runs, run], now),
  };
  writeHistory(next, env);
  return next;
}

export function recordSchedule(
  schedule: ScheduleRecord,
  env = process.env
): void {
  writeHistory({ ...readHistory(env), schedule }, env);
}

const checks = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(record) : [];

function workerResults(nodes: Record<string, unknown>[]) {
  const workers: NonNullable<SyncRun['workers']> = {};
  for (const node of nodes) {
    const id = node['node'];
    if (node['role'] !== 'worker' || typeof id !== 'string') continue;
    const failed = checks(node['checks']).find(
      (check) => check['status'] === 'fail' && check['required'] !== false
    )?.['id'];
    const applied = node['appliedRevision'];
    if (typeof failed === 'string' && /^[a-zA-Z0-9:._-]+$/.test(failed))
      workers[id] = { failed };
    else if (typeof applied === 'string' && /^[a-f0-9]{40}$/.test(applied))
      workers[id] = { applied };
  }
  return workers;
}

/** What a fleet-sync report says about one run. */
export function summarizeRun(
  data: unknown,
  timing: { startedAt: Date; finishedAt: Date },
  trigger: Trigger,
  exitCode: number
): SyncRun {
  const report = record(data) ? data : {};
  const nodes = checks(report['nodes']);
  const failing = new Set<string>();
  for (const check of [
    ...checks(report['checks']),
    ...nodes.flatMap((node) => checks(node['checks'])),
  ])
    if (check['status'] === 'fail' && typeof check['id'] === 'string')
      failing.add(check['id']);
  const notReady = nodes
    .filter((node) =>
      checks(node['checks']).some((check) => check['status'] === 'fail')
    )
    .map((node) => node['node'])
    .filter((node): node is string => typeof node === 'string');
  const workers = workerResults(nodes);
  const selection = parseSelection(report['selectedBy']);
  return {
    startedAt: timing.startedAt.toISOString(),
    finishedAt: timing.finishedAt.toISOString(),
    durationMs: timing.finishedAt.getTime() - timing.startedAt.getTime(),
    trigger,
    revision:
      typeof report['desiredRevision'] === 'string'
        ? report['desiredRevision']
        : null,
    ...(selection ? { selectedBy: selection } : {}),
    ok: exitCode === 0 && report['ok'] !== false,
    exitCode,
    ...(Object.keys(workers).length ? { workers } : {}),
    failing: [...failing].sort(),
    notReady: [...new Set(notReady)].sort(),
  };
}

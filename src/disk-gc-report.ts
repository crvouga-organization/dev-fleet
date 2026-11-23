import type { Check, Runner } from './types';

/** What the disk GC (ansible/ubuntu/disk-gc.py --report) leaves after a run:
 * when it finished, what it reclaimed by category, and what the agent
 * worktrees, the package stores and the tool installs hold on disk.
 */
export interface DiskGcReport {
  finished: number;
  disposable: boolean;
  reclaimedMiB: number;
  categoriesMiB: Record<string, number>;
  worktreesMiB: number;
  storesMiB: number;
  toolsMiB: number;
  hardlinkedPercent: number;
  /** Whether every package store is on the filesystem of the worktrees;
   * null when there is no store or no worktree root yet. */
  sameFilesystem: boolean | null;
}

const number = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** The report at `path`, or null when there is none or it is not one the
 * collector wrote. Only its numbers are kept; nothing else is reported.
 */
export async function readDiskGcReport(
  run: Runner,
  path: string
): Promise<DiskGcReport | null> {
  const result = await run(['cat', path], { timeoutMs: 10_000 });
  if (!result.ok) return null;
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || value['version'] !== 1)
    return null;
  const categories =
    typeof value['categoriesMiB'] === 'object' &&
    value['categoriesMiB'] !== null
      ? Object.fromEntries(
          Object.entries(value['categoriesMiB'] as Record<string, unknown>)
            .filter(([name, mib]) => /^[a-z_]{1,32}$/.test(name) && number(mib))
            .map(([name, mib]) => [name, mib as number])
        )
      : {};
  const fields = [
    'finished',
    'reclaimedMiB',
    'worktreesMiB',
    'storesMiB',
    'toolsMiB',
    'hardlinkedPercent',
  ] as const;
  if (!fields.every((field) => number(value[field]))) return null;
  const same = value['sameFilesystem'];
  return {
    finished: value['finished'] as number,
    disposable: value['disposable'] === true,
    reclaimedMiB: value['reclaimedMiB'] as number,
    categoriesMiB: categories,
    worktreesMiB: value['worktreesMiB'] as number,
    storesMiB: value['storesMiB'] as number,
    toolsMiB: value['toolsMiB'] as number,
    hardlinkedPercent: value['hardlinkedPercent'] as number,
    sameFilesystem: typeof same === 'boolean' ? same : null,
  };
}

const gib = (mib: number): string => `${(mib / 1024).toFixed(1)} GiB`;

/** One line for fleet-status: the last run, what it reclaimed by category,
 * and what the worktrees, package stores and tool installs hold. */
export function describeDiskGc(report: DiskGcReport, now: number): string {
  const minutes = Math.max(0, Math.round((now - report.finished) / 60));
  const categories = Object.entries(report.categoriesMiB)
    .filter(([, mib]) => mib > 0)
    .map(([name, mib]) => `${name.replaceAll('_', ' ')} ${mib}`)
    .join(', ');
  return [
    `The disk GC${report.disposable ? ' (disposable storage)' : ''} last ran ${minutes} min ago and reclaimed ${report.reclaimedMiB} MiB${categories ? ` (${categories})` : ''}`,
    `worktrees hold ${gib(report.worktreesMiB)}, package stores ${gib(report.storesMiB)}, tool installs ${gib(report.toolsMiB)}; ${report.hardlinkedPercent}% of the worktrees' and stores' bytes are hardlinked.`,
  ].join('; ');
}

export const STORE_FILESYSTEM_REMEDY =
  'Hardlinks cannot cross filesystems, so every install copies its packages instead of linking them from the shared store. Keep the package stores (~/.local/share/pnpm/store, ~/.bun/install/cache) on the filesystem of the agent worktrees (~/.t3/worktrees): move whichever is mounted elsewhere, or unset an override of pnpm_config_store_dir or BUN_INSTALL_CACHE_DIR.';

/** What a node's report says, as the check `id`: a store on another
 * filesystem than the worktrees warns, since nothing is linked then. */
export function diskGcReportCheck(
  id: string,
  report: DiskGcReport,
  now: number
): Check {
  const summary = describeDiskGc(report, now);
  return report.sameFilesystem === false
    ? {
        id,
        status: 'warn',
        summary: `PACKAGE_STORE_OTHER_FILESYSTEM ${summary}`,
        remedy: { action: STORE_FILESYSTEM_REMEDY },
      }
    : { id, status: 'pass', summary };
}

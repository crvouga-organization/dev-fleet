import { homedir } from 'node:os';
import { join } from 'node:path';
import { fleet } from '../fleet-config';
import { readParked } from '../state/workers';
import { sshArgs } from '../ssh';
import type { FleetNode, Runner } from '../types';
import { loadRoster } from './roster';

/** How a run that was given --allow-mise-downgrade tells the run it starts
 * (from the fleet-owned checkout, or on the manager after a hand-off). That
 * run is the revision's own code, which may be older than the flag, so the
 * flag is never forwarded to it. The value is the revision it is about, so
 * it says nothing about any other run.
 */
export const ALLOW_MISE_DOWNGRADE_ENV = 'DEVFLEET_MISE_DOWNGRADE_ALLOWED';

/** A toolchain bootstrap that names this flag keeps a newer mise unless it
 * is given the flag. One that does not is from before that rule and installs
 * exactly the mise its revision pins.
 */
const KEEPS_NEWER_MISE = '--allow-mise-downgrade';

/** Where the toolchain bootstrap installs mise, under the home directory. */
const MISE = '.local/bin/mise';

const BOOTSTRAP = 'bootstrap/bootstrap.sh';

/** Whether this run may replace mise with the older one its revision pins:
 * it was given --allow-mise-downgrade, or the run that started it was.
 */
export function allowsMiseDowngrade(
  options: { allowMiseDowngrade?: boolean },
  revision: string | undefined,
  env = process.env
): boolean {
  return (
    options.allowMiseDowngrade === true ||
    (revision !== undefined && env[ALLOW_MISE_DOWNGRADE_ENV] === revision)
  );
}

/** The mise a revision pins, read from its own files: `min_version` in its
 * mise.toml, or the release its bootstrap names itself (revisions from
 * before the pin moved to mise.toml). Null when neither says.
 */
export function pinnedMise(files: {
  bootstrap: string;
  mise: string | null;
}): string | null {
  const pinned =
    /^min_version = "(\d+(?:\.\d+){1,3})"$/m.exec(files.mise ?? '') ??
    /^MISE_VERSION=["']?(\d+(?:\.\d+){1,3})["']?$/m.exec(files.bootstrap);
  return pinned ? pinned[1]! : null;
}

/** Whether release `installed` is newer than release `pinned`, number by
 * number, as the toolchain bootstrap compares them.
 */
export function newerMise(installed: string, pinned: string): boolean {
  const numbers = (release: string) => release.split('.').map(Number);
  const [left, right] = [numbers(installed), numbers(pinned)];
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

/** The release `mise --version` printed, or null. */
function release(stdout: string): string | null {
  return /^(\d+(?:\.\d+){1,3})(?:\s|$)/.exec(stdout.trim())?.[1] ?? null;
}

/** Run on the manager before a handed-off revision's own run script, after
 * the ancestry guard: the same question `miseDowngrade` asks, about the
 * manager's mise, answered from the manager's own copy of the source
 * repository. A hand-off cannot measure the workers. `$1` is the revision.
 */
export const miseGuard = (exit: number): string =>
  [
    'source="$HOME/.local/share/personal/fleet/manager/source"',
    `installed=$("$HOME/${MISE}" --version 2>/dev/null | awk '{print $1}')`,
    '[ -n "$installed" ] || exit 0',
    'git -C "$source" cat-file -e "$1^{commit}" 2>/dev/null || git -C "$source" fetch --quiet --no-tags origin "$1" >/dev/null 2>&1 || exit 0',
    `bootstrap=$(git -C "$source" show "$1:${BOOTSTRAP}" 2>/dev/null) || exit 0`,
    `case "$bootstrap" in *${KEEPS_NEWER_MISE}*) exit 0;; esac`,
    'pin=$(git -C "$source" show "$1:mise.toml" 2>/dev/null | sed -n \'s/^min_version = "\\([0-9.]*\\)"$/\\1/p\' | head -n 1)',
    '[ -n "$pin" ] || pin=$(printf \'%s\\n\' "$bootstrap" | sed -n \'s/^MISE_VERSION=\\([0-9.]*\\)$/\\1/p\' | head -n 1)',
    `[ -n "$pin" ] || exit ${exit}`,
    '[ "$installed" != "$pin" ] || exit 0',
    'newest=$(printf \'%s\\n%s\\n\' "$pin" "$installed" | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)',
    `[ "$newest" != "$installed" ] || exit ${exit}`,
  ].join('\n');

/** The machines whose mise a revision's bootstrap would replace with an
 * older one.
 */
export interface MiseDowngrade {
  /** The mise the revision pins; null when its files do not say. */
  pinned: string | null;
  /** Fleet ids and the release each machine runs now. */
  machines: { node: string; installed: string }[];
}

export interface MeasuredMachines {
  /** The manager's fleet id. */
  manager: string;
  /** The manager's home directory. */
  home?: string | undefined;
  /** The workers the run is about to converge. */
  workers: Pick<FleetNode, 'id' | 'ssh'>[];
}

/** What a revision's own bootstrap would do to mise on the machines a run is
 * about to converge, asked before that bootstrap runs anywhere. Null when it
 * would replace no newer mise: its bootstrap keeps a newer one, or no
 * machine runs one. Read from the revision's own files in `source`, a
 * repository that holds it; a revision that cannot be read there is not
 * judged (the run stops for that reason by itself). A worker that does not
 * answer is not measured: it cannot be converged either.
 */
export async function miseDowngrade(
  target: { revision: string; source: string },
  machines: MeasuredMachines,
  run: Runner
): Promise<MiseDowngrade | null> {
  const show = async (path: string): Promise<string | null> => {
    const shown = await run(['git', 'show', `${target.revision}:${path}`], {
      cwd: target.source,
    });
    return shown.ok ? shown.stdout : null;
  };
  const bootstrap = await show(BOOTSTRAP);
  if (bootstrap === null || bootstrap.includes(KEEPS_NEWER_MISE)) return null;
  const pinned = pinnedMise({ bootstrap, mise: await show('mise.toml') });
  const measured = await Promise.all([
    run([join(machines.home ?? homedir(), MISE), '--version'], {
      timeoutMs: 20_000,
    }).then((result) => ({ node: machines.manager, result })),
    ...machines.workers.map((worker) =>
      run([...sshArgs(worker), `"$HOME/${MISE}" --version 2>/dev/null`], {
        timeoutMs: 20_000,
      }).then((result) => ({ node: worker.id, result }))
    ),
  ]);
  const replaced = measured.flatMap(({ node, result }) => {
    const installed = result.ok ? release(result.stdout) : null;
    return installed && (pinned === null || newerMise(installed, pinned))
      ? [{ node, installed }]
      : [];
  });
  return replaced.length ? { pinned, machines: replaced } : null;
}

/** The workers a run is about to converge: the enrolled ones the request
 * selects, without the parked. None when the roster cannot be read; the run
 * then stops for that reason by itself.
 */
export async function workersToConverge(
  options: { node?: string[] },
  roster: string
): Promise<FleetNode[]> {
  try {
    const declared = new Set(fleet.workers.map((worker) => worker.id));
    const parked = readParked();
    const only = options.node ?? [];
    return (await loadRoster(roster)).nodes.filter(
      (node) =>
        declared.has(node.id) &&
        !parked[node.id] &&
        (only.length === 0 || only.includes(node.id))
    );
  } catch {
    return [];
  }
}

/** What the refusal says: which machines, which releases, and the two ways
 * on.
 */
export function miseDowngradeRemedy(
  revision: string,
  { pinned, machines }: MiseDowngrade
): string {
  const running = machines
    .map(({ node, installed }) => `${node} (${installed})`)
    .join(', ');
  const pins = pinned
    ? `pins mise ${pinned}`
    : 'pins a mise its files do not name';
  return `Nothing was changed: revision ${revision} ${pins}, and its toolchain bootstrap is from before the rule that keeps a newer mise, so it would replace the newer one on ${running}. Every checkout on those machines whose mise.toml asks for a newer mise would then stop working. Converge to a revision whose bootstrap keeps a newer mise (any release since that rule), or pass --allow-mise-downgrade to install the older mise on purpose.`;
}

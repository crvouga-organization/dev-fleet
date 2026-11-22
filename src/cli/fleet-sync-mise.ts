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

/** What a worker without a mise answers when asked for its release. */
const NO_MISE = 'none';

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

/** The flag that makes fleet-sync answer the question and change nothing.
 * A devfleet from before the flag refuses it, which is how the guard of a
 * hand-off tells that the manager's installed one cannot answer.
 */
export const MEASURE_MISE_FLAG = '--measure-mise';

/** Run on the manager before a handed-off revision's own run script, after
 * the ancestry guard. A revision whose bootstrap keeps a newer mise passes
 * at once: read from the manager's own copy of the source repository, which
 * fetches the revision when it is not there. For any other, the shell
 * compares the manager's own mise with the pin (`downgrade`), then asks the
 * manager's installed devfleet (the code the manager runs now, not the
 * revision's) the question `miseDowngrade` answers, about the manager and
 * every worker the request selects. Its refusal is printed and ends the
 * hand-off; an installed devfleet that cannot answer (none, or one from
 * before the question) ends it with `unmeasured`, never with a pass. `$1` is
 * the revision; what follows it is given to the installed devfleet (--node,
 * --json).
 */
export const miseGuard = (exit: {
  downgrade: number;
  unmeasured: number;
}): string =>
  [
    'revision=$1; shift',
    'source="$HOME/.local/share/personal/fleet/manager/source"',
    'git -C "$source" cat-file -e "$revision^{commit}" 2>/dev/null || git -C "$source" fetch --quiet --no-tags origin "$revision" >/dev/null 2>&1 || exit 0',
    `bootstrap=$(git -C "$source" show "$revision:${BOOTSTRAP}" 2>/dev/null) || exit 0`,
    `case "$bootstrap" in *${KEEPS_NEWER_MISE}*) exit 0;; esac`,
    `installed=$("$HOME/${MISE}" --version 2>/dev/null | awk '{print $1}')`,
    'if [ -n "$installed" ]; then',
    '  pin=$(git -C "$source" show "$revision:mise.toml" 2>/dev/null | sed -n \'s/^min_version = "\\([0-9.]*\\)"$/\\1/p\' | head -n 1)',
    '  [ -n "$pin" ] || pin=$(printf \'%s\\n\' "$bootstrap" | sed -n \'s/^MISE_VERSION=\\([0-9.]*\\)$/\\1/p\' | head -n 1)',
    `  [ -n "$pin" ] || exit ${exit.downgrade}`,
    '  newest=$(printf \'%s\\n%s\\n\' "$pin" "$installed" | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)',
    `  [ "$installed" = "$pin" ] || [ "$newest" != "$installed" ] || exit ${exit.downgrade}`,
    'fi',
    `answer=$(devfleet fleet-sync ${MEASURE_MISE_FLAG} --revision "$revision" "$@" 2>/dev/null) && exit 0`,
    `case "$answer" in *FLEET_MISE_*) printf '%s\\n' "$answer"; exit 1;; esac`,
    `exit ${exit.unmeasured}`,
  ].join('\n');

/** The machines whose mise a revision's bootstrap would replace with an
 * older one.
 */
export interface MiseDowngrade {
  /** The mise the revision pins; null when its files do not say. */
  pinned: string | null;
  /** Fleet ids and the release each machine runs now. */
  machines: { node: string; installed: string }[];
  /** The workers that did not say which mise they run. */
  unmeasured: string[];
}

export interface MeasuredMachines {
  /** The manager's fleet id. */
  manager: string;
  /** The manager's home directory. */
  home?: string | undefined;
  /** The workers the run is about to converge. */
  workers: Pick<FleetNode, 'id' | 'ssh'>[];
}

/** What a worker is asked over SSH: the release of its mise, or `none`
 * where it has no mise to replace. Anything else is no answer.
 */
const WORKER_MISE = `if [ -x "$HOME/${MISE}" ]; then "$HOME/${MISE}" --version 2>/dev/null; else echo ${NO_MISE}; fi`;

/** What a revision's own bootstrap would do to mise on the machines a run is
 * about to converge, asked before that bootstrap runs anywhere. Null when it
 * would replace no newer mise: its bootstrap keeps a newer one, or every
 * machine answered and none runs one. Read from the revision's own files in
 * `source`, a repository that holds it; a revision that cannot be read there
 * is not judged (the run stops for that reason by itself). A worker that
 * does not answer is `unmeasured`: it may wake before the revision's own
 * code reaches it, and nothing else would stand between that bootstrap and
 * its mise.
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
  const [manager, ...workers] = await Promise.all([
    run([join(machines.home ?? homedir(), MISE), '--version'], {
      timeoutMs: 20_000,
    }).then((result) => ({
      node: machines.manager,
      installed: result.ok ? release(result.stdout) : null,
      answered: true,
    })),
    ...machines.workers.map((worker) =>
      run([...sshArgs(worker), WORKER_MISE], { timeoutMs: 20_000 }).then(
        (result) => {
          const installed = result.ok ? release(result.stdout) : null;
          return {
            node: worker.id,
            installed,
            answered:
              installed !== null ||
              (result.ok && result.stdout.trim() === NO_MISE),
          };
        }
      )
    ),
  ]);
  const replaced = [manager!, ...workers].flatMap(({ node, installed }) =>
    installed && (pinned === null || newerMise(installed, pinned))
      ? [{ node, installed }]
      : []
  );
  const unmeasured = workers
    .filter((worker) => !worker.answered)
    .map((worker) => worker.node);
  return replaced.length || unmeasured.length
    ? { pinned, machines: replaced, unmeasured }
    : null;
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

/** The code of the refusal: a machine's newer mise would be replaced, or no
 * machine is known to run one and a worker did not say.
 */
export function miseRefusalCode(
  found: MiseDowngrade
): 'FLEET_MISE_DOWNGRADE' | 'FLEET_MISE_UNMEASURED' {
  return found.machines.length
    ? 'FLEET_MISE_DOWNGRADE'
    : 'FLEET_MISE_UNMEASURED';
}

/** What the refusal says: which machines, which releases, which workers did
 * not answer, and the ways on.
 */
export function miseDowngradeRemedy(
  revision: string,
  { pinned, machines, unmeasured }: MiseDowngrade
): string {
  const running = machines
    .map(({ node, installed }) => `${node} (${installed})`)
    .join(', ');
  const pins = pinned
    ? `pins mise ${pinned}`
    : 'pins a mise its files do not name';
  const silent = unmeasured.join(', ');
  const start = `Nothing was changed: revision ${revision} ${pins}, and its toolchain bootstrap is from before the rule that keeps a newer mise`;
  const later =
    'Converge to a revision whose bootstrap keeps a newer mise (any release since that rule)';
  if (!machines.length)
    return `${start}, so it would replace a newer one, and ${silent} did not say which mise it runs: a worker that does not answer now may answer when that bootstrap reaches it. Every checkout there whose mise.toml asks for a newer mise would then stop working. ${later}; or bring ${silent} back and run this again, park it (devfleet fleet-node-park), or name the other workers with --node; or pass --allow-mise-downgrade to install the older mise on purpose.`;
  const also = unmeasured.length
    ? ` ${silent} did not say which mise it runs, and is not known to be safe either.`
    : '';
  return `${start}, so it would replace the newer one on ${running}. Every checkout on those machines whose mise.toml asks for a newer mise would then stop working.${also} ${later}, or pass --allow-mise-downgrade to install the older mise on purpose.`;
}

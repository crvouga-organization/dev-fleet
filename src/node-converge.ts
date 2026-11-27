import { runLockedCommand as runCommand } from './runner';
import { isRevision } from './machine/state';
import { convergeLinux } from './node-converge-linux';
import { T3_RESTART_MODES } from './platform/t3-service';
import type { Check } from './types';

/** Internal remote entry, run on a worker only. The manager owns the operation
 * lock and source selection; this installs no pull daemon or timer. Never
 * prints child output. Workers are Linux.
 */
async function main(): Promise<Check[]> {
  const [node, revision, t3Restart = 'restart-busy'] = process.argv.slice(2);
  if (
    !node ||
    !/^[a-z][a-z0-9-]{0,62}$/.test(node) ||
    !isRevision(revision) ||
    !(T3_RESTART_MODES as readonly string[]).includes(t3Restart)
  )
    throw new Error();
  const root = process.cwd();
  const head = await runCommand(['git', 'rev-parse', 'HEAD']);
  if (!head.ok || head.stdout.trim() !== revision) throw new Error();
  const encoded = await Bun.stdin.text();
  if (process.platform === 'linux')
    return convergeLinux(
      root,
      {
        node,
        revision,
        restartBusy: t3Restart === 'restart-busy',
        ...(encoded
          ? { clientSettings: Buffer.from(encoded, 'base64').toString('utf8') }
          : {}),
      },
      runCommand
    );
  return [
    {
      id: 'platform:unsupported',
      status: 'fail',
      summary: 'PLATFORM_UNSUPPORTED',
      remedy: {
        action:
          'Workers run an Ubuntu release docs/support-matrix.md lists. The macOS manager converges itself locally in converge.',
      },
    },
  ];
}
if (import.meta.main) {
  const checks = await main().catch((): Check[] => [
    {
      id: 'configuration:operation',
      status: 'fail',
      summary: 'REMOTE_CONFIGURATION_INCOMPLETE',
    },
  ]);
  process.stdout.write(JSON.stringify({ version: 1, checks }));
}

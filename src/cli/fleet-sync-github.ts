import { spawnSync } from 'node:child_process';
import type { FleetDefinition } from '../definition';
import { remote, type TerminalRunner } from './fleet-sync-vault';
import type { Check, FleetNode, Runner } from '../types';

/** GitHub's device flow runs on the enrolled worker. Its OAuth credential
 * stays in that worker's gh store. Only the device approval reaches the
 * operator's terminal. A stored fleet token still takes precedence on sync.
 */
export async function authorizeWorkerGithub(
  node: FleetNode,
  policy: { login: string; scopes: string[] },
  run: Runner,
  attach: TerminalRunner = (args) =>
    spawnSync(args[0]!, args.slice(1), { stdio: 'inherit' }).status === 0
): Promise<boolean> {
  const { login, scopes } = policy;
  const gh = ['env', '-u', 'GH_TOKEN', '-u', 'GITHUB_TOKEN', 'gh'];
  const principal = () =>
    run(remote(node, [...gh, 'api', 'user', '--jq', '.login']), {
      timeoutMs: 30_000,
    });
  // Preserve any existing login, including a different active account.
  const before = await principal();
  if (before.ok) return before.stdout.trim() === login;
  const status = await run(
    remote(node, [...gh, 'auth', 'status', '--hostname', 'github.com']),
    { timeoutMs: 30_000 }
  );
  if (
    status.ok ||
    !/not logged into any GitHub hosts/i.test(status.stderr + status.stdout)
  )
    return false;
  process.stderr.write(
    `[${node.id}] Authorize GitHub as ${login} for this worker in the browser.\n`
  );
  const args = [
    ...gh,
    'auth',
    'login',
    '--hostname',
    'github.com',
    '--git-protocol',
    'https',
    '--web',
  ];
  if (scopes.length) args.push('--scopes', scopes.join(','));
  if (!attach(remote(node, args, '-t'))) return false;
  const after = await principal();
  return after.ok && after.stdout.trim() === login;
}

/** Start device authorization only for the specific missing-token check.
 * Retry normal convergence after approval so every affected check is measured.
 */
export async function recoverGithub(
  node: FleetNode,
  checks: Check[],
  definition: FleetDefinition,
  context: { interactiveAuthorization: boolean; stop: () => void; run: Runner }
): Promise<boolean> {
  if (!context.interactiveAuthorization || !definition.worker?.githubLogin)
    return false;
  if (
    !checks.some(
      (check) =>
        check.id === 'github:sync' &&
        check.status === 'fail' &&
        check.summary === 'GITHUB_TOKEN_MISSING'
    )
  )
    return false;
  context.stop();
  return authorizeWorkerGithub(
    node,
    {
      login: definition.worker.githubLogin,
      scopes: definition.github?.scopes ?? [],
    },
    context.run
  );
}

import type { Check } from './types';

/** What a check says instead of its own code when the secret it needs could
 * not be read because this machine is not logged in to its secrets provider
 * (`secretsLogin` in src/secrets.ts). The fault has one owner; a check that
 * only needed the secret names it, and keeps its own code for a secret that
 * is really absent.
 */
export const SECRET_READ_BLOCKED = 'SECRET_READ_BLOCKED';

/** The check that owns the manager's login to the secrets provider. */
export const MANAGER_SECRETS_LOGIN = 'manager:vault-renewal';

/** The blocked form of a check, with the status it has when its secret is
 * unavailable: blocked never looks better than the fault it stands for, and
 * the owner fails the run.
 */
export function blockedBySecretsLogin(
  id: string,
  status: Exclude<Check['status'], 'pass' | 'not-applicable'>,
  owner: string = MANAGER_SECRETS_LOGIN
): Check {
  return {
    id,
    status,
    summary: `${SECRET_READ_BLOCKED} by ${owner}`,
    remedy: {
      action: `Not a fault of its own: it needs a secret, and this machine is not logged in to the secrets provider. Fix ${owner} (one login, named in its remedy), then run devfleet fleet-sync; nothing else about this check needs doing.`,
    },
  };
}

/** Whether a thrown code is the blocked one (`hubAccess` refuses with it). */
export const blockedCode = (error: unknown): boolean =>
  error instanceof Error && error.message === SECRET_READ_BLOCKED;

import type { SecretsLogin, SecretsProvider } from './secrets';
import type { Check } from './types';

/** What a check says instead of its own code when the secret it needs could
 * not be read because this machine cannot read from its secrets provider
 * (`secretsLogin` in src/secrets.ts): it is not logged in, or the provider
 * does not answer. The fault has one owner; a check that only needed the
 * secret names it, and keeps its own code for a secret that is really absent.
 */
export const SECRET_READ_BLOCKED = 'SECRET_READ_BLOCKED';

/** The check that owns the manager's login to the secrets provider. */
export const MANAGER_SECRETS_LOGIN = 'manager:vault-renewal';

/** The check that owns a worker's own login: every worker keeps a session
 * of its own, measured where it runs (src/worker-access-checks.ts).
 */
export const WORKER_SECRETS_LOGIN = 'worker:vault-renewal';

/** The check that owns the login of the machine a check ran on. */
export const secretsLoginOwner = (role: 'manager' | 'worker'): string =>
  role === 'manager' ? MANAGER_SECRETS_LOGIN : WORKER_SECRETS_LOGIN;

/** Why a read is blocked: every answer of `secretsLogin` but `held`. */
export type SecretsFault = Exclude<SecretsLogin, 'held'>;

/** What stands between this machine and its secrets, in a remedy. The owner
 * says what to do about it; a provider that does not answer is not repaired
 * by a login.
 */
const FAULTS: Record<SecretsFault | 'either', string> = {
  // A caller that was only told the read is blocked (`blockedCode`).
  either:
    'this machine cannot read from the secrets provider. Fix OWNER (its remedy says whether that is a login or a provider that does not answer)',
  required:
    'this machine is not logged in to the secrets provider. Fix OWNER (one login, named in its remedy)',
  unreachable:
    'the secrets provider does not answer this machine. Fix OWNER (its remedy says what to look at; logging in again does not help)',
};

/** The blocked form of a check, with the status it has when its secret is
 * unavailable: blocked never looks better than the fault it stands for, and
 * the owner fails the run.
 */
export function blockedBySecretsLogin(
  id: string,
  status: Exclude<Check['status'], 'pass' | 'not-applicable'>,
  fault?: SecretsFault,
  owner: string = MANAGER_SECRETS_LOGIN
): Check {
  return {
    id,
    status,
    summary: `${SECRET_READ_BLOCKED} by ${owner}`,
    remedy: {
      action: `Not a fault of its own: it needs a secret, and ${FAULTS[fault ?? 'either'].replace('OWNER', owner)}, then run homelab fleet-sync; nothing else about this check needs doing.`,
    },
  };
}

/** The same for a command that refuses instead of reporting a check. */
export function blockedRefusal(fault?: SecretsFault): string {
  const { summary, remedy } = blockedBySecretsLogin('', 'fail', fault);
  return `${summary}: ${remedy!.action}`;
}

/** A check that got no secret, by what it would say were the secret absent. */
type Unread = Check & {
  status: Exclude<Check['status'], 'pass' | 'not-applicable'>;
};

/** The one answer of a check that got no secret. It hands over the provider
 * it read from and what it says when the secret is absent: it keeps that
 * when the provider can be read, and is otherwise blocked by the check that
 * owns the login of the machine it ran on (the manager's, unless it says a
 * worker's), with the status it had. Every reader answers through here
 * (`features/rules/secret-readers.feature`), so a lapsed login or a provider
 * out of reach is one root cause and not one fault per secret.
 */
export async function unreadSecret(
  secrets: Pick<SecretsProvider, 'login'>,
  absent: Unread,
  owner: string = MANAGER_SECRETS_LOGIN
): Promise<Check> {
  const fault = await secretsFault(secrets);
  return fault
    ? blockedBySecretsLogin(absent.id, absent.status, fault, owner)
    : absent;
}

/** The same for a reader that refuses with a code instead of a check. */
export async function unreadSecretCode<Code extends string>(
  secrets: Pick<SecretsProvider, 'login'>,
  absent: Code
): Promise<Code | typeof SECRET_READ_BLOCKED> {
  return (await secretsFault(secrets)) ? SECRET_READ_BLOCKED : absent;
}

/** What blocks reads from a provider, or null when it can be read. */
export async function secretsFault(
  secrets: Pick<SecretsProvider, 'login'>
): Promise<SecretsFault | null> {
  const login = await secrets.login();
  return login === 'held' ? null : login;
}

/** Whether a thrown code is the blocked one (`hubAccess` refuses with it). */
export const blockedCode = (error: unknown): boolean =>
  error instanceof Error && error.message === SECRET_READ_BLOCKED;

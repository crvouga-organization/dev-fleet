import type {
  SecretName,
  SecretsLogin,
  SecretsProvider,
} from '../../src/secrets';

/** Stands in for a fleet's secrets provider: what it holds, and whether this
 * machine can read from it at all. One it cannot read gives no secret,
 * whatever it holds.
 */
export function standInSecrets(
  holds: (name: SecretName, node?: string) => string | null | undefined,
  login: () => SecretsLogin = () => 'held'
): SecretsProvider {
  return Object.assign(
    async (name: SecretName, node?: string) =>
      login() === 'held' ? (holds(name, node) ?? null) : null,
    { login: async () => login() }
  );
}

/** How a scenario says the manager cannot read its secrets, in every area. */
export const SECRETS_FAULT =
  /^the manager (is not logged in to|cannot reach) its secrets provider$/;

export const secretsFault = (words: string): SecretsLogin =>
  words === 'cannot reach' ? 'unreachable' : 'required';

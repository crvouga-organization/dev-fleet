import { FleetUsageError } from '../errors';
import { canonical, hash, object, read } from './files';

export type Change = {
  id: string;
  action: 'create' | 'update' | 'delete' | 'unchanged' | 'conflict';
};
export type T3Paths = { settings: string; state: string };

export async function planT3(paths: T3Paths, desired: Record<string, unknown>) {
  const raw = await read(paths.settings);
  const stateRaw = await read(paths.state);
  const settings = object(raw);
  const current = object(JSON.stringify(settings['providerInstances'] ?? {}));
  const owned = readOwnership(stateRaw, paths.settings);
  const next = { ...current };
  const changes: Change[] = [];
  for (const [id, instance] of Object.entries(desired)) {
    const exists = Object.hasOwn(current, id);
    const action = actionFor(exists, owned.includes(id), current[id], instance);
    changes.push({ id, action });
    if (action !== 'conflict') next[id] = instance;
  }
  const retired = owned.filter((id) => !Object.hasOwn(desired, id));
  for (const id of retired) {
    changes.push({
      id,
      action: Object.hasOwn(current, id) ? 'delete' : 'unchanged',
    });
    delete next[id];
  }
  const kept = withoutPreferences(settings, retired);
  const settingsChanged =
    canonical(next) !== canonical(current) || kept !== settings;
  const state = ownership(paths.settings, Object.keys(desired));
  return {
    raw,
    stateRaw,
    settings: settingsChanged ? { ...kept, providerInstances: next } : settings,
    state,
    settingsChanged,
    stateChanged: canonical(object(stateRaw)) !== canonical(state),
    changes,
    planHash: hash(
      canonical({ target: paths.settings, raw, stateRaw, desired })
    ),
  };
}

/** An instance the fleet removes takes what T3 was told to show for it
 * along (src/t3/models.ts writes that for an account's instance).
 */
function withoutPreferences(
  settings: Record<string, unknown>,
  ids: string[]
): Record<string, unknown> {
  const preferences = settings['providerModelPreferences'];
  if (
    !preferences ||
    typeof preferences !== 'object' ||
    Array.isArray(preferences) ||
    !ids.some((id) => Object.hasOwn(preferences, id))
  )
    return settings;
  return {
    ...settings,
    providerModelPreferences: Object.fromEntries(
      Object.entries(preferences).filter(([id]) => !ids.includes(id))
    ),
  };
}

export function ownership(target: string, ids: string[]) {
  return { version: 1, target, instances: [...ids].sort() };
}

export function readOwnership(raw: string | null, target: string): string[] {
  if (raw === null) return [];
  const state = object(raw);
  const ids = state['instances'];
  if (
    state['version'] !== 1 ||
    state['target'] !== target ||
    !Array.isArray(ids) ||
    ids.some(
      (id) =>
        typeof id !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(id)
    ) ||
    new Set(ids).size !== ids.length
  )
    throw new FleetUsageError(
      'Invalid T3 ownership state; restore its backup before reconciliation.'
    );
  return ids as string[];
}

function actionFor(
  exists: boolean,
  owned: boolean,
  current: unknown,
  desired: unknown
): Change['action'] {
  if (exists && !owned) return 'conflict';
  if (!exists) return 'create';
  return canonical(current) === canonical(desired) ? 'unchanged' : 'update';
}

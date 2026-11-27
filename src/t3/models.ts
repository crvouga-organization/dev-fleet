import { homedir } from 'node:os';
import proxyTemplate from '../../cliproxy/config.template.yaml';
import { join, resolve } from 'node:path';
import type { Check } from '../types';
import { fleet, fleetJson } from '../fleet-config';
import {
  accountDriver,
  accountInstanceId,
  proxyAccounts,
  type Roster,
} from './accounts';
import { preferredModels, type Account } from '../agents/accounts';
import { canonical, object, read, write } from './files';

/** T3's own setting for what an instance's model picker shows: models it
 * hides and the order of the rest. T3 opens an instance on its catalogue's
 * default model, or on the first model shown when that one is hidden.
 */
const PREFERENCES = 'providerModelPreferences';
type Preference = { hiddenModels: string[]; modelOrder: string[] };

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const preference = (value: unknown): Preference => ({
  hiddenModels: strings(record(value)['hiddenModels']),
  modelOrder: strings(record(value)['modelOrder']),
});

/** The models T3 keeps for a driver (userdata/model-manifest.json). Null when
 * it has no list for the driver: it asks the tool itself.
 */
function catalogueOf(
  manifest: Record<string, unknown>,
  driver: string
): string[] | null {
  const models = record(record(manifest['manifest'])['currentModels'])[driver];
  return Array.isArray(models) ? strings(models) : null;
}

/** Antigravity also discovers models from its live ACP session. Its native
 * IDs can appear in the picker before T3 adds them to the static manifest.
 * The proxy template names the native IDs that homelab routes as aliases.
 */
const antigravityAliases = (
  proxyTemplate as {
    oauth: { 'model-alias': { antigravity: { alias: string }[] } };
  }
).oauth['model-alias'].antigravity.map(({ alias }) => alias);

function preferenceCatalogue(
  manifest: Record<string, unknown>,
  driver: string
) {
  const catalogue = catalogueOf(manifest, driver);
  return driver === 'antigravity'
    ? [...new Set([...(catalogue ?? []), ...antigravityAliases])]
    : catalogue;
}

/** The custom models an instance adds. T3 always shows them. */
function customOf(instance: unknown): string[] {
  const models = record(record(instance)['config'])['customModels'];
  return Array.isArray(models)
    ? models.flatMap((model: unknown) =>
        typeof model === 'string'
          ? [model]
          : typeof record(model)['slug'] === 'string'
            ? [record(model)['slug'] as string]
            : []
      )
    : [];
}

/** The managed instance of each account that T3 holds on this machine. */
function managed(accounts: Account[], settings: Record<string, unknown>) {
  const instances = record(settings['providerInstances']);
  return accounts.flatMap((account) => {
    const driver = accountDriver(account.tool);
    const id = accountInstanceId(account);
    return driver && Object.hasOwn(instances, id)
      ? [{ account, driver, id, instance: instances[id] }]
      : [];
  });
}

/** What each account's instance should show: a catalogue model is hidden
 * exactly when the account does not serve it, and an instance that hides one
 * lists the preferred defaults its account serves first, so T3 opens it on
 * the first of them when its own default is hidden. Everything else (other
 * instances, hidden models outside the catalogue, the order of the rest) is
 * the machine's own and is kept.
 */
function planPreferences(
  accounts: Account[],
  settings: Record<string, unknown>,
  manifest: Record<string, unknown>
) {
  const next = { ...record(settings[PREFERENCES]) };
  const changes = new Set<string>();
  for (const { account, driver, id } of managed(accounts, settings)) {
    const catalogue = preferenceCatalogue(manifest, driver);
    if (!catalogue) continue;
    const current = preference(next[id]);
    const unserved = catalogue.filter(
      (model) => !account.models.includes(model)
    );
    const hide = unserved.filter(
      (model) => !current.hiddenModels.includes(model)
    );
    const show = current.hiddenModels.filter(
      (model) => catalogue.includes(model) && account.models.includes(model)
    );
    const first = unserved.length
      ? preferredModels(account.tool).filter((model) =>
          account.models.includes(model)
        )
      : [];
    const modelOrder = [
      ...first,
      ...current.modelOrder.filter((model) => !first.includes(model)),
    ];
    const reordered = canonical(modelOrder) !== canonical(current.modelOrder);
    for (const model of hide) changes.add(`${account.tool}: hide ${model}`);
    for (const model of show) changes.add(`${account.tool}: show ${model}`);
    if (reordered)
      changes.add(`${account.tool}: list ${first.join(', ')} first`);
    if (hide.length || show.length || reordered)
      next[id] = {
        ...record(next[id]),
        hiddenModels: [
          ...current.hiddenModels.filter((model) => !show.includes(model)),
          ...hide,
        ],
        modelOrder,
      };
  }
  return { preferences: next, changes };
}

export interface ModelsOptions {
  t3Home: string;
  roster: Roster;
  required?: Record<string, string[]>;
  /** Write what each account's instance shows (fleet-sync); without it the
   * check only measures, and says what a sync would change.
   */
  apply?: boolean;
  /** Tries before a settings file T3 keeps rewriting is reported busy. */
  attempts?: number;
  pause?: () => Promise<void>;
  /** Runs between the read and the write: where T3 may write too. */
  beforeWrite?: () => Promise<void>;
}

/** Reads what the check needs and, with `apply`, writes what each account's
 * instance shows. T3 writes the same file and offers no compare-and-swap, so
 * a write happens only when the file is still what was read; otherwise the
 * plan is made again, a bounded number of times. Null when T3 kept writing.
 */
async function reconcile(options: ModelsOptions) {
  const path = join(options.t3Home, 'userdata/settings.json');
  const pause =
    options.pause ?? (() => new Promise((done) => setTimeout(done, 500)));
  const accounts = await options.roster();
  const manifest = object(
    await read(join(options.t3Home, 'userdata/model-manifest.json'))
  );
  for (let attempt = 1; ; attempt++) {
    const raw = await read(path);
    const settings = object(raw);
    const plan = planPreferences(accounts, settings, manifest);
    // Measured as a sync leaves it: what a sync would hide is pending, not
    // a model T3 wrongly shows.
    const result = {
      accounts,
      manifest,
      changes: plan.changes,
      settings: { ...settings, [PREFERENCES]: plan.preferences },
    };
    if (!options.apply || !plan.changes.size) return result;
    await options.beforeWrite?.();
    if ((await read(path)) === raw) {
      await write(path, JSON.stringify(result.settings, null, 2) + '\n');
      return result;
    }
    if (attempt >= (options.attempts ?? 3)) return null;
    await pause();
  }
}

/** `t3:models`: every account instance the fleet manages shows only models
 * the proxy serves for its account, opens on one of them, and every required
 * model is both served and shown. Accounts of one tool may be entitled to
 * different models: that is settled by hiding, per instance, what its account
 * does not serve, and is no fault. A report names tools and models, never an
 * account.
 */
export async function modelsCheck(options: ModelsOptions): Promise<Check> {
  const warn = (summary: string, action: string): Check => ({
    id: 't3:models',
    status: 'warn',
    summary,
    remedy: { action },
  });
  let result;
  try {
    result = await reconcile(options);
  } catch {
    return warn(
      'T3_MODELS_UNVERIFIED',
      'The proxy’s model list or T3’s settings could not be read on this machine. Check that the CLI proxy answers and T3 has started once, then run converge.'
    );
  }
  if (!result)
    return warn(
      'T3_SETTINGS_BUSY',
      'T3 kept rewriting its settings while homelab hid the models an account does not serve. Run converge again; nothing was overwritten.'
    );
  const problems = mismatches(result, options.required ?? {});
  if (problems.size)
    return warn(
      'T3_MODELS_MISMATCH',
      `${[...problems].sort().join('; ')}. Serve the model on the CLI proxy, or stop asking for it: remove it from t3.requiredModels in ${fleetJson()}, choose another default in T3, or remove the custom model. A model the proxy does not serve for an account fails when it is chosen in T3.`
    );
  if (result.changes.size && !options.apply)
    return warn(
      'T3_MODELS_PENDING',
      `fleet-sync would change what T3 shows for an account’s instance, so that it shows only the models the proxy serves for that account: ${[...result.changes].sort().join('; ')}.`
    );
  return {
    id: 't3:models',
    status: 'pass',
    summary:
      'Every model T3 shows for a managed account is one the proxy serves for it, and every required model is shown.',
  };
}

/** What `converge --only accounts` applies beside the instances: an
 * account that was just added shows only what it serves at once.
 */
export const accountModels = (): Promise<Check> => {
  const required = fleet.t3?.requiredModels;
  return modelsCheck({
    t3Home: resolve(process.env['T3CODE_HOME'] ?? join(homedir(), '.t3')),
    roster: proxyAccounts,
    ...(required ? { required } : {}),
    apply: true,
  });
};

/** T3's own choices of a model to start with. */
const SELECTIONS = {
  defaultModelSelection: 'default',
  fallbackModelSelection: 'fallback',
};

/** What is wrong with the models of each managed account instance. */
function mismatches(
  {
    accounts,
    settings,
    manifest,
  }: {
    accounts: Account[];
    settings: Record<string, unknown>;
    manifest: Record<string, unknown>;
  },
  required: Record<string, string[]>
): Set<string> {
  const problems: string[] = [];
  const preferences = record(settings[PREFERENCES]);
  for (const { account, driver, id, instance } of managed(accounts, settings)) {
    const catalogue = catalogueOf(manifest, driver);
    const custom = customOf(instance);
    const hidden = preference(preferences[id]).hiddenModels;
    // Null when T3 has no list for the driver: it asks the tool itself.
    const shown =
      catalogue || custom.length
        ? [
            ...(catalogue ?? []).filter((model) => !hidden.includes(model)),
            ...custom,
          ]
        : null;
    problems.push(
      ...[
        ...shownProblems(account, shown),
        ...defaultProblems(account, id, settings),
        ...requiredProblems(account, shown, required[account.tool] ?? []),
      ].map((problem) => `${account.tool}: ${problem}`)
    );
  }
  return new Set(problems);
}

/** A model the instance shows that its account does not serve. */
function shownProblems(account: Account, shown: string[] | null): string[] {
  if (!shown) return [];
  const problems = shown
    .filter((model) => !account.models.includes(model))
    .map((model) => `T3 offers ${model}, which the proxy does not serve`);
  if (problems.length === shown.length)
    problems.push(
      'T3 offers no model the proxy serves for an account, so its instance has no default that works'
    );
  return problems;
}

/** A model the instance starts on that its account does not serve, and an
 * account whose default is not one of the preferred ones.
 */
function defaultProblems(
  account: Account,
  id: string,
  settings: Record<string, unknown>
): string[] {
  const preferred = preferredModels(account.tool);
  const problems = preferred.some((model) => account.models.includes(model))
    ? []
    : [
        `an account serves none of the preferred defaults (${preferred.join(', ')}) and defaults to ${account.models[0]}; ask for a model it serves to be added to them, with an issue in homelab’s tracker (homelab --help names it)`,
      ];
  for (const [key, name] of Object.entries(SELECTIONS)) {
    const selection = record(settings[key]);
    const model = selection['model'];
    if (
      selection['instanceId'] === id &&
      typeof model === 'string' &&
      !account.models.includes(model)
    )
      problems.push(`T3’s ${name} model ${model} is not served by the proxy`);
  }
  return problems;
}

/** A required model the proxy does not serve, or T3 does not show. */
function requiredProblems(
  account: Account,
  shown: string[] | null,
  required: string[]
): string[] {
  return required.flatMap((model) =>
    !account.models.includes(model)
      ? [`the proxy does not serve the required ${model}`]
      : shown && !shown.includes(model)
        ? [`T3 does not offer the required ${model}`]
        : []
  );
}

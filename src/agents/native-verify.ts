import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentPlatform } from '../platform';
import { agentRoot, render } from './render';
import { select } from './registry';
import type { Check, Runner } from '../types';
import { pinnedPath } from './toolchain';
import { registry } from './registry';
import type { Account } from './accounts';
import { accountSlug } from './accounts';
import {
  accountSessionChecks,
  namesCondition,
  printedClears,
  sessionResult,
  type Instance,
  type SessionOutcome,
  type SessionResult,
} from '../accounts/sessions';
import {
  cacheKey,
  cachedCheck,
  lastFailure,
  sourceKey,
  type VerifyCache,
} from './verify-cache';

const PROMPT = 'Reply with exactly: OK';

/** Every agent T3 offers on every node, launched exactly as T3 launches it:
 * through the tracked wrapper that injects the shared credential. `pin` names
 * the mise.toml tool whose locked version the installed binary must report.
 */
export const NATIVE_AGENTS = [
  {
    name: 'claude',
    binary: 'claude',
    pin: 'claude',
    wrapper: 'claude-proxy.ts',
    // T3's binaryPath: the Claude Agent SDK runs a `.ts` path with node.
    launcher: 'claude-proxy',
    args: ['-p', PROMPT],
  },
  {
    name: 'codex',
    binary: 'codex',
    pin: 'codex',
    wrapper: 'codex-proxy.ts',
    launcher: 'codex-proxy.ts',
    args: ['exec', '--skip-git-repo-check', PROMPT],
  },
  {
    name: 'grok',
    binary: 'grok',
    pin: 'http:grok',
    wrapper: 'grok-proxy.ts',
    launcher: 'grok-proxy.ts',
    args: ['-p', PROMPT],
  },
  {
    name: 'antigravity',
    binary: 'antigravity',
    pin: 'http:antigravity',
    wrapper: 'antigravity-proxy.ts',
    launcher: 'bin/agy',
    args: [
      '-p',
      PROMPT,
      '--model',
      'Gemini 3.8 Flash (High)',
      '--print-timeout',
      '90s',
    ],
  },
  {
    name: 'muse',
    binary: 'opencode',
    pin: 'aqua:anomalyco/opencode',
    wrapper: 'opencode-proxy.ts',
    launcher: 'opencode-proxy.ts',
    args: ['run', '--model', 'personal_proxy/devin/muse-wonder-1-0', PROMPT],
  },
] as const;

type Agent = (typeof NATIVE_AGENTS)[number];

export const ADDITIONAL_PROVIDER_CLIS = ['gemini', 'copilot'] as const;

/** The user service T3 runs as on a worker, and so the environment every
 * agent it starts inherits.
 */
export const T3_SERVICE = 't3code-desktop.service';

/** How a session is launched: by the sync, through Bun on the pinned PATH,
 * or exactly as the T3 service starts it, with that service's environment
 * and nothing of the sync's.
 */
type Launch =
  | { kind: 'sync'; env: Record<string, string> }
  | { kind: 'service'; env: Record<string, string> }
  | { kind: 'incomplete' };

/** Variables an agent session or a launcher sets for the tool it starts:
 * the account and node it is pinned to, the proxy key and base URL, the
 * tool's own home and configuration. A sync started inside an agent session
 * inherits them; none of them may reach a launch, or every session would be
 * pinned to the calling session's account and tool.
 */
const LAUNCHER_PREFIXES = [
  'WS_AGENT_',
  'CLIPROXY_',
  'ANTHROPIC_',
  'CLAUDE_CODE_',
  'CODEX_',
  'OPENCODE_',
  'GROK_',
  'GEMINI_',
  'GOOGLE_GEMINI_',
  'GOOGLE_GENAI_',
  'AGY_',
  'OPENAI_',
  'XAI_',
];
const LAUNCHER_NAMES = new Set(['CLAUDECODE', 'DISABLE_AUTOUPDATER']);

/** What the sync launches an agent tool with, wherever the sync was started:
 * the environment it inherited without any launcher variable, and the pinned
 * tools first on PATH. Launched with this alone (`isolatedEnv`), never on top
 * of the sync's own environment.
 */
export function syncLaunchEnvironment(
  inherited: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(inherited))
    if (
      value !== undefined &&
      !LAUNCHER_NAMES.has(name) &&
      !LAUNCHER_PREFIXES.some((prefix) => name.startsWith(prefix))
    )
      env[name] = value;
  env['PATH'] = pinnedPath(inherited);
  return env;
}

/** Same versions everywhere (from the shared mise.lock) and a working signed-in
 * session through each T3 launcher. Agents run concurrently and are bounded.
 * With `t3Service` (a Linux worker), sessions run in the environment of the
 * T3 user service, where T3 itself starts them, not in the sync's.
 */
export async function verifyNativeAgents(
  node: string,
  workspace: string,
  run: Runner,
  options: {
    /** Proxy routes already found out of quota; their sessions are not run. */
    outOfQuota?: Set<string>;
    cache?: VerifyCache;
    t3Service?: boolean;
    /** The proxy's accounts and what this node offers. Every cached result
     * is keyed on the roster version and the client key's version, so any
     * account change or key rotation re-verifies at once.
     */
    accounts?: AccountContext;
    /** Where the agent profiles are rendered; this user's by default. */
    profiles?: string;
    /** The environment the sync was started in; its own by default. */
    inherited?: NodeJS.ProcessEnv;
  } = {}
): Promise<Check[]> {
  const { outOfQuota = new Set<string>(), cache = {} } = options;
  const profiles =
    options.profiles ?? agentRoot(homedir(), currentPlatform().name);
  const pins = parsePins(await readFile(join(workspace, 'mise.toml'), 'utf8'));
  const sync = syncLaunchEnvironment(options.inherited);
  const environment = options.t3Service
    ? await serviceLaunch(run, sync)
    : { launch: { kind: 'sync', env: sync } as Launch, checks: [] };
  const { launch } = environment;
  const cwd = await mkdtemp(join(tmpdir(), 'fleet-agents-'));
  try {
    const keys = new Map<string, string>();
    const results = await Promise.all(
      NATIVE_AGENTS.map(async (agent) => {
        const key = cacheKey(
          node,
          agent,
          pins[agent.pin] ?? '',
          registry,
          launch.kind,
          await sourceKey(workspace, launcherSources(workspace, agent)),
          options.accounts?.rosterVersion ?? '',
          options.accounts?.keyVersion ?? '',
          await configurationKey(profiles, node, agent.binary)
        );
        keys.set(agent.binary, key);
        return [
          await versionCheck(agent, pins[agent.pin], run, sync),
          outOfQuota.has(agent.name)
            ? quotaPass(agent)
            : launch.kind === 'incomplete'
              ? incompleteSession(agent)
              : await cachedCheck(
                  `agent-${node}-${agent.name}`,
                  key,
                  () =>
                    sessionCheck(agent, { node, workspace, cwd, launch }, run),
                  cache
                ),
        ];
      })
    );
    const accounts =
      options.accounts && launch.kind !== 'incomplete'
        ? await accountSessionChecks(
            options.accounts.live,
            options.accounts.exposed,
            (instance) =>
              accountSession(instance, options.accounts!, {
                node,
                workspace,
                cwd,
                launch,
                cache,
                run,
                launcherKey: keys.get(instance.tool)!,
              })
          )
        : [];
    const extraVersions = await Promise.all(
      ADDITIONAL_PROVIDER_CLIS.map((binary) =>
        versionCheck(
          { name: binary, binary, pin: binary },
          pins[binary],
          run,
          sync
        )
      )
    );
    return [
      ...environment.checks,
      ...results.flat(),
      ...extraVersions,
      ...accounts,
    ];
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

export interface AccountContext {
  live: Account[];
  exposed: Instance[];
  rosterVersion: string;
  keyVersion: string;
  /** Asks the proxy what holds one account back, after its session timed
   * out (`proxyVerdict`). Without it a timed-out session stays `timed-out`.
   */
  consult?: (account: Account) => Promise<SessionOutcome>;
  /** The clock a cooldown a session printed is read against. */
  now?: () => number;
}

/** How a per-account instance is launched: its tool's launcher, pinned to
 * the account as T3 pins it. The proxy is asked when a session ran into the
 * deadline without a word.
 */
export const ACCOUNT_LAUNCH: Record<
  string,
  { wrapper: string; launcher: string; args: string[] }
> = {
  claude: {
    wrapper: 'claude-proxy.ts',
    launcher: 'claude-proxy',
    args: ['-p', PROMPT],
  },
  codex: {
    wrapper: 'codex-proxy.ts',
    launcher: 'codex-proxy.ts',
    args: ['exec', '--skip-git-repo-check', PROMPT],
  },
  antigravity: {
    wrapper: 'antigravity-proxy.ts',
    launcher: 'bin/agy',
    args: [
      '-p',
      PROMPT,
      '--model',
      'Gemini 3.8 Flash (High)',
      '--print-timeout',
      '90s',
    ],
  },
};

/** How long a session that did not pass is taken as found, before it is
 * run again: back-to-back syncs do not pay for the same dead session twice.
 * Any change to the roster, the client key or the profile runs it at once.
 */
export const SESSION_FAILURE_REUSE_MS = 10 * 60 * 1000;

/** A session's deadline, and the one of a session that ran into it or found
 * its account cooling down the last time: long enough to answer, short
 * enough not to hold a sync up again.
 */
export const SESSION_DEADLINE_MS = 150_000;
export const SESSION_RETRY_DEADLINE_MS = 30_000;

interface SessionContext {
  node: string;
  workspace: string;
  cwd: string;
  launch: Exclude<Launch, { kind: 'incomplete' }>;
  cache: VerifyCache;
  run: Runner;
  launcherKey: string;
}

/** An outcome as the cache keeps it: `cooling-down 2027-01-15T09:30:00Z`. */
const kept = ({ result, clears }: SessionOutcome): string =>
  clears ? `${result} ${clears}` : result;

function outcomeOf(summary: string): SessionOutcome {
  const [result, clears] = summary.split(' ');
  return { result: result as SessionResult, ...(clears ? { clears } : {}) };
}

/** One account's session, at the least cost that still proves it.
 *
 * - A pass is reused for six hours.
 * - What a session found when it did not pass is taken as found for ten
 *   minutes, and says so.
 * - Before a session is launched the proxy is asked for the account's model:
 *   an account it holds back, wants verified or refuses is reported at once,
 *   with no session. OpenCode would retry such an account quietly until the
 *   deadline.
 * - A session ends as soon as what it printed names a condition of its
 *   account: OpenCode prints a refused request within a second, then retries
 *   it quietly until the deadline.
 * - A session that ran into its deadline or found its account cooling down
 *   the last time gets a short one.
 */
function accountLaunch(instance: Instance, live: Account[]) {
  const spec = ACCOUNT_LAUNCH[instance.tool];
  const neon =
    instance.tool === 'antigravity' &&
    live.some(
      (account) =>
        account.tool === instance.tool &&
        account.email === instance.account &&
        account.models.includes('gemini-4-neon')
    );
  return neon && spec
    ? {
        ...spec,
        args: spec.args.map((arg) =>
          arg === 'Gemini 3.8 Flash (High)' ? 'Gemini 4 Neon (High)' : arg
        ),
      }
    : spec;
}

async function accountSession(
  instance: Instance,
  accounts: AccountContext,
  context: SessionContext
): Promise<SessionOutcome> {
  const spec = accountLaunch(instance, accounts.live);
  if (!spec) return { result: 'failed' };
  const name = `account-${context.node}-${instance.tool}-${accountSlug(instance.account)}`;
  const key = cacheKey(
    context.node,
    instance,
    spec,
    accounts.rosterVersion,
    accounts.keyVersion,
    context.launcherKey
  );
  const last = await lastFailure(name, key, context.cache);
  if (last && last.ageMs < SESSION_FAILURE_REUSE_MS)
    return {
      ...outcomeOf(last.check.summary),
      foundMinutesAgo: Math.round(last.ageMs / 60_000),
    };
  const hung =
    last !== null &&
    ['timed-out', 'cooling-down'].includes(
      outcomeOf(last.check.summary).result
    );
  let found: SessionOutcome | undefined;
  const check = await cachedCheck(
    name,
    key,
    async () => {
      found = await runSession(instance, spec, accounts, {
        ...context,
        timeoutMs: hung ? SESSION_RETRY_DEADLINE_MS : SESSION_DEADLINE_MS,
      });
      // A pass is read back as one; anything else as what was found.
      return {
        id: 'account-session',
        status: found.result === 'ok' ? 'pass' : 'fail',
        summary: kept(found),
      };
    },
    { ...context.cache, keepFailure: true }
  );
  if (check.status === 'pass') return { result: 'ok' };
  return found ?? outcomeOf(check.summary);
}

/** Asks the proxy, then launches the session unless the proxy already said
 * what holds the account back. `timed-out` from the proxy means it named
 * nothing: the account answered, or nothing said why it does not.
 */
async function runSession(
  instance: Instance,
  spec: (typeof ACCOUNT_LAUNCH)[string],
  accounts: AccountContext,
  context: SessionContext & { timeoutMs: number }
): Promise<SessionOutcome> {
  const live = accounts.live.find(
    (account) =>
      account.tool === instance.tool && account.email === instance.account
  );
  const consult = async (): Promise<SessionOutcome> =>
    live && accounts.consult ? accounts.consult(live) : { result: 'timed-out' };
  const before = await consult();
  if (before.result !== 'timed-out') return before;
  const agents = join(context.workspace, 'agents');
  const service = context.launch.kind === 'service';
  const result = await context.run(
    service
      ? [join(agents, spec.launcher), ...spec.args]
      : ['bun', join(agents, spec.wrapper), ...spec.args],
    {
      cwd: context.cwd,
      env: {
        ...context.launch.env,
        WS_AGENT_NODE: context.node,
        WS_AGENT_ACCOUNT: instance.account,
      },
      isolatedEnv: true,
      input: '',
      timeoutMs: context.timeoutMs,
      // A refusal, a limit or a demand to verify is printed long before the
      // session would end; nothing after it changes what it says.
      stopWhen: namesCondition,
    }
  );
  const output = result.stdout + result.stderr;
  const said = sessionResult(result.ok, output, result.reason === 'timeout');
  // A session that ran into its deadline printed nothing telling. The
  // proxy is asked again: the session may have used another model of the
  // account than the one asked for before, and found that one held back.
  if (said === 'timed-out') return consult();
  const clears =
    said === 'cooling-down'
      ? printedClears(output, (accounts.now ?? Date.now)())
      : undefined;
  return { result: said, ...(clears ? { clears } : {}) };
}

/** Reads `tool = "x"` and `"tool" = { version = "x", ... }` pins. */
export function parsePins(source: string): Record<string, string> {
  const pins: Record<string, string> = {};
  const pattern =
    /^"?([A-Za-z0-9:@/._-]+)"?\s*=\s*(?:"([^"]+)"|\{[^\n]*?\bversion\s*=\s*"([^"]+)")/gm;
  for (const match of source.matchAll(pattern))
    pins[match[1]!] = (match[2] ?? match[3])!;
  return pins;
}

/** Self-healing: a binary that drifted from the lock (a vendor self-updater
 * rewrote it) is reinstalled from the locked artifact, then checked again.
 */
async function versionCheck(
  agent: { name: string; binary: string; pin: string },
  pin: string | undefined,
  run: Runner,
  env: Record<string, string>
): Promise<Check> {
  const observe = async () => {
    const result = await run([agent.binary, '--version'], {
      env,
      isolatedEnv: true,
      timeoutMs: 30_000,
    });
    return result.ok
      ? /(?:^|[\s/])v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)(?=\.?(?:[\s)]|$))/m.exec(
          result.stdout
        )?.[1]
      : undefined;
  };
  let observed = await observe();
  if (observed !== pin && pin) {
    await run(
      ['mise', 'install', '--locked', '--force', `${agent.pin}@${pin}`],
      {
        timeoutMs: 600_000,
      }
    );
    observed = await observe();
  }
  const ok = Boolean(pin) && observed === pin;
  return {
    id: `agent:${agent.name}:version`,
    status: ok ? 'pass' : 'fail',
    summary: ok
      ? `${agent.binary} ${pin} matches the shared toolchain lock.`
      : 'AGENT_VERSION_MISMATCH',
    ...(ok
      ? {}
      : {
          remedy: {
            action: `Expected ${pin ?? 'unknown'}, observed ${observed ?? 'unavailable'}. Every node runs the ${agent.binary} pinned in mise.toml/mise.lock; reinstalling it from the lock failed. Inspect mise install --locked ${agent.pin} on this node; never install it with a vendor self-updater.`,
          },
        }),
  };
}

/** Quota is the account's, not the node's: no warning (as for providers). */
function quotaPass(agent: Agent): Check {
  return {
    id: `agent:${agent.name}:session`,
    status: 'pass',
    summary: `The shared ${agent.name} account is rate limited or out of quota; its session is checked again once it recovers.`,
  };
}

async function sessionCheck(
  agent: Agent,
  context: {
    node: string;
    workspace: string;
    cwd: string;
    launch: Exclude<Launch, { kind: 'incomplete' }>;
  },
  run: Runner
): Promise<Check> {
  const agents = join(context.workspace, 'agents');
  const command =
    context.launch.kind === 'service'
      ? [join(agents, agent.launcher), ...agent.args]
      : ['bun', join(agents, agent.wrapper), ...agent.args];
  const env = { ...context.launch.env, WS_AGENT_NODE: context.node };
  const launch = () =>
    run(command, {
      cwd: context.cwd,
      env,
      isolatedEnv: true,
      input: '',
      timeoutMs: 150_000,
    });
  const expected = /\bOK\b/;
  let result = await launch();
  // One retry: a CLI's first launch on a node may still be initializing.
  if (!(result.ok && expected.test(result.stdout))) result = await launch();
  const ok = result.ok && expected.test(result.stdout);
  return {
    id: `agent:${agent.name}:session`,
    status: ok ? 'pass' : 'fail',
    summary: ok
      ? `${agent.name} runs signed in through its T3 launcher with the shared account.`
      : sessionFailure(result.stderr + result.stdout),
    ...(ok ? {} : { remedy: { action: sessionRemedy(agent) } }),
  };
}

/** The environment of the T3 user service: what its user manager holds
 * (PATH included) and what the unit adds. Every launcher starts with
 * `#!/usr/bin/env bun` or runs `bun`, so that PATH must find Bun.
 */
async function serviceLaunch(
  run: Runner,
  sync: Record<string, string>
): Promise<{ launch: Launch; checks: Check[] }> {
  const manager = await run(['systemctl', '--user', 'show-environment'], {
    timeoutMs: 15_000,
  });
  const unit = await run(
    [
      'systemctl',
      '--user',
      'show',
      T3_SERVICE,
      '--property=Environment',
      '--value',
    ],
    { timeoutMs: 15_000 }
  );
  if (!manager.ok || !unit.ok)
    return {
      launch: { kind: 'sync', env: sync },
      checks: [
        environmentCheck(
          'warn',
          'AGENT_SERVICE_ENVIRONMENT_UNVERIFIED',
          'The environment of the T3 service could not be read, so sessions were launched from the sync instead. Inspect the user service manager of this worker: systemctl --user show-environment.'
        ),
      ],
    };
  const env = {
    ...parseAssignments(manager.stdout.split('\n')),
    ...parseAssignments(words(unit.stdout)),
  };
  const bun = await run(['/bin/sh', '-c', 'command -v bun'], {
    env,
    isolatedEnv: true,
    timeoutMs: 15_000,
  });
  if (!bun.ok)
    return {
      launch: { kind: 'incomplete' },
      checks: [
        environmentCheck(
          'fail',
          'AGENT_SERVICE_ENVIRONMENT_INCOMPLETE',
          INCOMPLETE_REMEDY
        ),
      ],
    };
  return {
    launch: { kind: 'service', env },
    checks: [
      environmentCheck(
        'pass',
        'The T3 service environment finds Bun; every session was launched with it alone.'
      ),
    ],
  };
}

const INCOMPLETE_REMEDY = `The PATH of ${T3_SERVICE} does not find Bun, so T3 cannot start any agent launcher even though they work from a shell. Put the pinned shims on the PATH of the user service manager through the baseline (never by hand), then run converge.`;

function environmentCheck(
  status: Check['status'],
  summary: string,
  remedy?: string
): Check {
  return {
    id: 'agent:service-environment',
    status,
    summary,
    ...(remedy ? { remedy: { action: remedy } } : {}),
  };
}

function incompleteSession(agent: Agent): Check {
  return {
    id: `agent:${agent.name}:session`,
    status: 'fail',
    summary: 'AGENT_SERVICE_ENVIRONMENT_INCOMPLETE',
    remedy: { action: INCOMPLETE_REMEDY },
  };
}

/** `KEY=value` lines or words; a value systemd quoted loses its quotes. */
function parseAssignments(entries: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of entries) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(entry.trim());
    if (match) env[match[1]!] = unquote(match[2]!);
  }
  return env;
}

/** `systemctl show -p Environment` separates assignments with spaces and
 * double-quotes one that holds a space.
 */
function words(line: string): string[] {
  return line.trim().match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
}

function unquote(value: string): string {
  return value.replace(/"([^"]*)"/g, '$1').replace(/^\$'(.*)'$/s, '$1');
}

/** A stable code only; raw CLI output is never reported. */
function sessionFailure(output: string): string {
  if (/missing or out of date/.test(output)) return 'AGENT_PROFILE_STALE';
  if (/Required secret unavailable/.test(output))
    return 'AGENT_VAULT_UNAVAILABLE';
  if (/model_not_found|unknown provider for model/.test(output))
    return 'AGENT_MODEL_UNSERVED';
  return 'AGENT_SESSION_UNVERIFIED';
}

function sessionRemedy(agent: Agent): string {
  if (agent.name === 'antigravity')
    return 'Antigravity sends its own catalog model ids; the proxy serves them through declared aliases that converge applies on the manager (see proxy:config-pending). Pick Gemini 3.8 Flash in T3: the default Pro model is not served by the shared accounts.';
  return `Run the ${agent.name} launcher on this node to inspect it: WS_AGENT_NODE=<node> bun agents/${agent.wrapper}. Check this node's Vault session and the shared proxy.`;
}

/** The launcher and profile code a session depends on. */
/** Digest of the agent's proxy profile as it is on this machine: the files
 * its session reads. A profile rendered again, edited or removed changes it,
 * so the session is proven again at once. Empty for a tool with no profile.
 */
export async function configurationKey(
  profiles: string,
  node: string,
  tool: string
): Promise<string> {
  try {
    const selection = select(node, tool, 'proxy');
    const directory = join(profiles, node, tool, 'proxy');
    return await sourceKey(
      directory,
      Object.keys(render(selection)).map((name) => join(directory, name))
    );
  } catch {
    return '';
  }
}

function launcherSources(workspace: string, agent: Agent): string[] {
  const agents = join(workspace, 'agents');
  const lib = join(workspace, 'src/agents');
  return [
    ...new Set([join(agents, agent.wrapper), join(agents, agent.launcher)]),
    join(agents, 'managed-proxy.ts'),
    ...[
      'native-verify.ts',
      'admission.ts',
      'account-relay.ts',
      'accounts.ts',
      'commands.ts',
      'converge.ts',
      'registry.ts',
      'launch.ts',
      'render.ts',
      'secrets.ts',
      'toolchain.ts',
    ].map((name) => join(lib, name)),
  ];
}

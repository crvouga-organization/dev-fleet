/** T3 binaryPath adapter. This file remains in Git; no generated executable copies. */
import { homedir } from 'node:os';
import { currentPlatform } from '../src/platform';
import { agentRoot } from '../src/agents/render';
import { select } from '../src/agents/registry';
import { plan } from '../src/agents/converge';
import { launchProfile } from '../src/agents/launch';
import { AgentConfigurationError } from '../src/agents/errors';
import { pinnedPath } from '../src/agents/toolchain';
import { REFUSED_EXIT_CODE, admission, refusal } from '../src/agents/admission';

const SYNC_HINT =
  'Run devfleet fleet-sync from a terminal to repair this machine.';

export function managedUpdateRemedy(tool: string, args: string[]) {
  const command = args[0];
  if (
    ((tool === 'grok' || tool === 'claude') && command === 'update') ||
    (tool === 'opencode' && command === 'upgrade')
  )
    return 'Provider versions come from the pinned dev-fleet release. Update the project dependency and run devfleet fleet-sync.';
  return undefined;
}

export async function runManagedProxy(
  tool: 'codex' | 'opencode' | 'claude' | 'grok' | 'antigravity'
): Promise<void> {
  const args = process.argv.slice(2);
  const update = managedUpdateRemedy(tool, args);
  if (update) {
    process.stderr.write(update + '\n');
    process.exitCode = 1;
    return;
  }
  // Version probes need no credentials; answering them lets T3 report the real
  // launch error instead of "unable to determine version".
  if (args.length === 1 && ['--version', '-v'].includes(args[0]!)) {
    process.exitCode = await Bun.spawn([tool, ...args], {
      env: { ...process.env, PATH: pinnedPath() },
      stdio: ['inherit', 'inherit', 'inherit'],
    }).exited;
    return;
  }
  // Above the worker's declared limit on agent sessions, say so and stop:
  // T3 reports only that the provider exited, with this in its server log.
  const waiting = admission();
  const refused = waiting && refusal(waiting);
  if (refused) {
    process.stderr.write(refused + '\n');
    process.exitCode = REFUSED_EXIT_CODE;
    return;
  }
  try {
    const selection = select(process.env['WS_AGENT_NODE'] ?? '', tool, 'proxy');
    const root = agentRoot(homedir(), currentPlatform().name);
    const result = await plan({ root, selection, revision: 'unverified' });
    if (result.files.some((file) => file.state === 'conflict')) {
      process.stderr.write(
        `Review the modified ${tool} proxy profile. To back it up and replace it, run bun src/agents/cli.ts --yes agents apply --node ${selection.node} --tool ${tool} --profile proxy --adopt from the fleet-owned checkout on this machine.\n`
      );
      process.exitCode = 1;
      return;
    }
    if (
      !result.previous ||
      result.previous.fingerprint !== result.fingerprint ||
      result.files.some((file) => file.state !== 'unchanged')
    )
      throw new AgentConfigurationError(
        `The ${tool} proxy profile for node ${selection.node} is missing or out of date.`
      );
    // T3 sets WS_AGENT_ACCOUNT on a provider that is pinned to one account.
    process.exitCode = await launchProfile(
      root,
      selection,
      args,
      process.env['WS_AGENT_ACCOUNT'] || undefined
    );
  } catch (error) {
    // Configuration errors carry curated, secret-free messages; others do not.
    const reason =
      error instanceof AgentConfigurationError
        ? error.message
        : 'Managed provider proxy unavailable.';
    process.stderr.write(`${reason} ${SYNC_HINT}\n`);
    process.exitCode = 1;
  }
}

export type Status = 'pass' | 'warn' | 'fail' | 'skip' | 'not-applicable';
export type Capability =
  | 'github'
  | 'vault'
  | 't3'
  | 'vscode'
  | 'toolchain'
  | 'codex'
  | 'claude'
  | 'services'
  | 'workstation'
  | 'worker';

export interface FleetNode {
  id: string;
  ssh: string;
  workspace: string;
  tailscaleId?: string;
  t3EnvironmentId?: string;
  bootstrapViaSsh?: boolean;
  runtime?: string;
  required: Capability[];
}

export interface FleetConfig {
  version: 1;
  nodes: FleetNode[];
}

export interface Check {
  /** Explicitly out-of-scope checks do not affect required readiness. */
  required?: boolean;
  /** Measured enclosing phase duration; omitted when not observed. */
  phaseDurationMs?: number;
  /** How long this check itself took, where it was measured apart from its
   * phase. */
  durationMs?: number;
  /** Set when nothing was run for this check: its result was taken from the
   * verify cache, or its playbook was skipped on an unchanged receipt. */
  reused?: 'verify-cache' | 'receipt';
  id: string;
  status: Status;
  summary: string;
  remedy?: { action: string; command?: string };
}

/** Only a required failure blocks readiness. Warnings (conditions outside the
 * fleet, such as a provider quota) and skips (not observable here) are shown
 * but never fail a run. A not-applicable check (the summary says why: a
 * virtual machine has no firmware power setting) never fails, not even under
 * --strict.
 */
export function blocking(check: Check): boolean {
  return check.status === 'fail' && check.required !== false;
}

export interface Fingerprint {
  head: string | null;
  files: Record<string, string | null>;
}

export interface Snapshot {
  version: 1;
  platform: string;
  fingerprint: Fingerprint;
  checks: Check[];
}

export interface NodeReport {
  node: string;
  checks: Check[];
  snapshot?: Snapshot;
}

export interface Report {
  version: 1;
  command: string;
  ok: boolean;
  generatedAt: string;
  nodes: NodeReport[];
  summary: Record<Status, number>;
}

export interface CommandOptions {
  /** Internal remote worker: keep the already-held operation lock on fd 9. */
  preserveOperationLock?: boolean;
  cwd?: string;
  input?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Run with `env` alone instead of on top of this process's environment:
   * for a launch that must see only what a service would.
   */
  isolatedEnv?: boolean;
  /** Ends the command as soon as what it printed so far (stdout, then
   * stderr) satisfies this: for a session whose result is decided by a line
   * it prints long before it would exit. It ends `stopped`, not ok.
   */
  stopWhen?: (output: string) => boolean;
}

export interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  reason: 'exit' | 'missing' | 'timeout' | 'overflow' | 'stopped';
}

export type Runner = (
  command: string[],
  options?: CommandOptions
) => Promise<CommandResult>;

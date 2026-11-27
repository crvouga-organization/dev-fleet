import { createHash } from 'node:crypto';
import { record } from './config';
import { cleanCheck, validCheck } from './protocol';
import { shellQuote, sshArgs } from './ssh';
import type { Check, FleetNode, Runner } from './types';

/** What a worker's bootstrap refuses an edited copy with, and the step of
 * the bootstrap that refuses it.
 */
const CODE = 'FLEET_CONFIGURATION_COPY_CHANGED';
const PHASE = 'configuration-install';

/** The lines of the remote bootstrap script that decide whether a worker's
 * copy of the configuration may be replaced, and the ones that report a
 * refusal, between the markers the script keeps around them. They only read
 * and print.
 */
const REGIONS = [
  'failure-report',
  'prior-operation',
  'configuration-copy-decision',
] as const;

function region(script: string, name: string): string | null {
  const begin = script.indexOf(`# ${name}: begin`);
  const end = script.indexOf(`# ${name}: end`);
  return begin >= 0 && end > begin ? script.slice(begin, end) : null;
}

/** The question a manager asks a worker before it changes anything: what the
 * configuration-install step of `script`, the remote bootstrap of the
 * revision this run converges to, would decide for a copy whose SHA-256 is
 * the question's one argument. It is that script's own text, so the question
 * and the bootstrap cannot disagree: the lines that read the operation
 * before this one, the rule itself, and the report of a refusal, run without
 * the lines that write. Read-only. Prints the bootstrap's own evidence of
 * the refusal, or `copy=replaceable`. Null for a script that does not mark
 * those lines: the bootstrap then answers for itself, when it runs.
 */
export function copyQuestion(script: string): string | null {
  const [report, prior, decision] = REGIONS.map((name) => region(script, name));
  if (!report || !prior || !decision) return null;
  return [
    'set -u',
    'root="$HOME/.local/share/personal/fleet"',
    'config_dir="$HOME/.config/homelab"',
    'sent=$1',
    `phase=${PHASE}`,
    `failure_code=${CODE}`,
    report,
    prior,
    decision,
    "if copy_edited; then fail; else printf 'copy=replaceable\\n'; fi",
  ].join('\n');
}

/** The SHA-256 of the copy a run sends: the configuration as the bootstrap
 * writes it.
 */
export function sentDigest(configuration: string): string {
  return createHash('sha256').update(configuration).digest('hex');
}

/** The refusal in a worker's answer, if it is one: exactly the one check the
 * bootstrap reports for an edited copy, validated like any evidence. Any
 * other answer, raw output included, says nothing and is never reported.
 */
export function copyRefused(stdout: string): Check | null {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!record(value) || value['version'] !== 1) return null;
  const checks = value['checks'];
  if (!Array.isArray(checks) || checks.length !== 1) return null;
  const check: unknown = checks[0];
  return validCheck(check) &&
    check.id === `bootstrap:${PHASE}` &&
    check.status === 'fail' &&
    check.summary === CODE
    ? cleanCheck(check)
    : null;
}

/** A worker whose copy of the configuration the bootstrap would refuse to
 * replace, and the bootstrap's own check for it.
 */
export interface EditedWorkerCopy {
  node: string;
  check: Check;
}

/** Asks every worker, at once and over the usual verified SSH, whether its
 * bootstrap would refuse to replace its copy of the configuration with the
 * one this run sends. A worker that does not answer, or answers anything
 * else, is not judged: it does not hold the run back, and its bootstrap
 * still refuses an edited copy when it gets there.
 */
export async function editedWorkerCopies(
  sent: { script: string; configuration: string },
  workers: Pick<FleetNode, 'id' | 'ssh'>[],
  run: Runner
): Promise<EditedWorkerCopy[]> {
  const question = copyQuestion(sent.script);
  if (!question || workers.length === 0) return [];
  const command = [
    'sh',
    '-c',
    question,
    'fleet-configuration-copy',
    sentDigest(sent.configuration),
  ]
    .map(shellQuote)
    .join(' ');
  const answers = await Promise.all(
    workers.map(async (worker) => {
      const result = await run([...sshArgs(worker), command], {
        timeoutMs: 20_000,
      });
      const check = result.ok ? copyRefused(result.stdout) : null;
      return check ? [{ node: worker.id, check }] : [];
    })
  );
  return answers.flat();
}

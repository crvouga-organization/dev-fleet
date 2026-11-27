/** One open issue per tier and job. A failure or a cancellation updates it,
 * a success closes it, and a skip leaves it: a skipped job did not pass. */
export function issueTitle(tier: string, job: string): string {
  return `CI failure: ${tier} / ${job}`;
}

export function queueAction(result: string): 'upsert' | 'close' | 'leave' {
  if (result === 'failure' || result === 'cancelled') return 'upsert';
  if (result === 'success') return 'close';
  return 'leave';
}

export function issueBody(input: {
  tier: string;
  job: string;
  result: string;
  sha: string;
  url: string;
}): string {
  return [
    `Tier: ${input.tier}`,
    `Job: ${input.job}`,
    `Result: ${input.result}`,
    `Commit: ${input.sha}`,
    `Run: ${input.url}`,
  ].join('\n');
}

interface Listed {
  number: number;
  title: string;
}

export function readResults(raw: string): Record<string, string> {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('RESULTS is not a job map.');
  const results: Record<string, string> = {};
  for (const [job, value] of Object.entries(parsed))
    results[job] = resultOf(job, value);
  if (Object.keys(results).length === 0)
    throw new Error('RESULTS names no job.');
  return results;
}

function resultOf(job: string, value: unknown): string {
  if (!value || typeof value !== 'object' || !('result' in value))
    throw new Error(`RESULTS has no result for ${job}.`);
  const result = value.result;
  if (typeof result !== 'string')
    throw new Error(`RESULTS has no result for ${job}.`);
  return result;
}

function gh(args: string[]): { ok: boolean; stdout: string } {
  try {
    const result = Bun.spawnSync(['gh', ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return {
      ok: result.exitCode === 0,
      stdout: new TextDecoder().decode(result.stdout),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'gh failed';
    process.stderr.write(`${message}\n`);
    return { ok: false, stdout: '' };
  }
}

function findOpen(title: string): { ok: boolean; number?: number } {
  const listed = gh([
    'issue',
    'list',
    '--state',
    'open',
    '--limit',
    '20',
    '--json',
    'number,title',
    '--search',
    `${title} in:title`,
  ]);
  if (!listed.ok) return { ok: false };
  try {
    const issues = JSON.parse(listed.stdout) as Listed[];
    const found = issues.find((issue) => issue.title === title);
    return found ? { ok: true, number: found.number } : { ok: true };
  } catch {
    return { ok: false };
  }
}

function upsertIssue(title: string, body: string): boolean {
  const found = findOpen(title);
  if (!found.ok) return false;
  if (found.number !== undefined)
    return gh(['issue', 'comment', String(found.number), '--body', body]).ok;
  gh(['label', 'create', 'ci-failure', '--color', 'B60205', '--force']);
  const created = gh([
    'issue',
    'create',
    '--title',
    title,
    '--body',
    body,
    '--label',
    'ci-failure',
  ]);
  if (created.ok) return true;
  return gh(['issue', 'create', '--title', title, '--body', body]).ok;
}

function closeIssue(title: string, body: string): boolean {
  const found = findOpen(title);
  if (!found.ok) return false;
  if (found.number === undefined) return true;
  return gh([
    'issue',
    'close',
    String(found.number),
    '--reason',
    'completed',
    '--comment',
    body,
  ]).ok;
}

function apply(tier: string, job: string, result: string): boolean {
  const action = queueAction(result);
  if (action === 'leave') return true;
  const title = issueTitle(tier, job);
  const body = issueBody({
    tier,
    job,
    result,
    sha: process.env['HEAD_SHA'] ?? '',
    url: process.env['RUN_URL'] ?? '',
  });
  if (action === 'close') return closeIssue(title, body);
  return upsertIssue(title, body);
}

function main(): number {
  const tier = process.env['TIER'];
  const raw = process.env['RESULTS'];
  if (!tier || !raw) {
    process.stderr.write('TIER and RESULTS are required.\n');
    return 1;
  }
  let results: Record<string, string>;
  try {
    results = readResults(raw);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'RESULTS is malformed.';
    process.stderr.write(`${message}\n`);
    return 1;
  }
  let failed = false;
  for (const [job, result] of Object.entries(results))
    if (!apply(tier, job, result)) failed = true;
  if (failed)
    process.stderr.write(
      'The failure queue could not be updated. A fork token cannot open issues.\n'
    );
  return 0;
}

if (import.meta.main) process.exit(main());

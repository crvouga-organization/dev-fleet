/** Disposable guest test entry; never installed as a production service. */
import { userInfo } from 'node:os';
import { readFileSync } from 'node:fs';
import { verifyUbuntuBoot } from '../../../src/platform/ubuntu-verify';
import { runAnsible } from '../../../src/platform/ansible';
import { runCommand } from '../../../src/runner';
import { effectiveExposure, parseExposure } from '../../../src/exposure';
import { exposureCheck } from '../../../src/worker-exposure';
if (process.argv[2] === 'agent') {
  const result = await runAnsible(runCommand, 'agent.yml', {
    cwd: process.cwd(),
    input: readFileSync(0, 'utf8'),
    timeoutMs: 300_000,
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.ok ? 0 : 1;
} else if (process.argv[2] === 'exposure') {
  // worker:exposure under the policy on standard input. The test reads the
  // result, so a failing check is not a failed command.
  const declared = parseExposure(JSON.parse(readFileSync(0, 'utf8')));
  if (declared === null) throw new Error('Not an exposure policy.');
  const check = await exposureCheck(
    {
      policy: effectiveExposure(undefined, declared),
      sshPort: 22,
      t3Port: 3773,
    },
    runCommand
  );
  process.stdout.write(JSON.stringify({ check }) + '\n');
} else {
  const checks = await verifyUbuntuBoot(userInfo().username, runCommand);
  process.stdout.write(JSON.stringify({ checks }) + '\n');
  process.exitCode = checks.every((check) => check.status === 'pass') ? 0 : 1;
}

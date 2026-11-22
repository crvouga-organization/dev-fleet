/** Stand-in for a fleet launcher (agents/managed-proxy.ts) on the session
 * box: it asks the same question before it starts an agent, with the same
 * function, and then only waits. The real launcher needs a signed-in proxy
 * profile, which a disposable machine does not have. */
import { appendFileSync, readFileSync } from 'node:fs';
import {
  REFUSED_EXIT_CODE,
  admission,
  refusal,
} from '../../../../src/agents/admission';

const waiting = admission();
const refused = waiting && refusal(waiting);
if (refused) {
  process.stderr.write(refused + '\n');
  process.exit(REFUSED_EXIT_CODE);
}
// Count the agents T3 started in a scope, not its version and model probes.
if (/\/t3code-[\w-]+\.scope$/m.test(readFileSync('/proc/self/cgroup', 'utf8')))
  appendFileSync('/var/tmp/session-box/fleet', '1\n');
setInterval(() => {}, 60_000);

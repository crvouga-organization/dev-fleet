import type { PackagePlaybook } from './platform/ansible';
import type { Check, FleetNode } from './types';
import { playbookAddress } from './worker-reboot';

/** The worker's converge stopped because its Tailscale is older than the
 * pin, which a converge never upgrades (ansible/ubuntu/tailscale.yml).
 */
export function tailscaleUpgradePending(checks: Check[]): boolean {
  return checks.some(
    (check) =>
      check.id === 'tailscale:configuration' &&
      check.summary === 'TAILSCALE_UPGRADE_PENDING'
  );
}

const FAILED = (action: string): Check => ({
  id: 'worker:tailscale-upgrade',
  status: 'fail',
  summary: 'WORKER_TAILSCALE_UPGRADE_FAILED',
  remedy: { action },
});

/** Upgrades Tailscale on one worker to its pin through
 * ansible/ubuntu/tailscale-upgrade.yml, run from the manager: the worker's
 * own Tailscale play of the approved revision runs in a detached unit, and
 * the play waits until the worker answers again and the unit has ended. The
 * converge that follows measures the result. The play's output is never
 * reported.
 */
export async function upgradeTailscale(
  node: FleetNode,
  revision: string,
  playbook: PackagePlaybook
): Promise<Check> {
  const address = playbookAddress(node);
  if (!address)
    return FAILED(
      'The roster names no workspace under the account home, so Tailscale was not upgraded. Rerun fleet-sync --maintenance-reboot once the worker is enrolled.'
    );
  const result = await playbook(
    'ubuntu/tailscale-upgrade.yml',
    { ...address, revision },
    // The play waits up to 600 seconds for the worker and 600 for the unit.
    1_500_000
  );
  if (result.ok)
    return {
      id: 'worker:tailscale-upgrade',
      status: 'pass',
      summary:
        'Tailscale was upgraded to its pin in a detached unit; the worker answered again and was converged once more.',
    };
  return FAILED(
    'The upgrade did not complete, or the worker did not answer within 10 minutes. Read journalctl -u homelab-tailscale-upgrade on the worker, then rerun fleet-sync --maintenance-reboot.'
  );
}

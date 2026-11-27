import type { Check } from './types';

/** The codes ansible/ubuntu/tailscale.yml stops on in its own assertions,
 * with what the operator does about each. The play's output is read for
 * these codes only, never reported.
 */
const PLAY_STOPS: Record<string, string> = {
  TAILSCALE_UPGRADE_PENDING:
    'Tailscale on this worker is older than its pin, and a converge never upgrades an active VPN. Run homelab fleet-sync --maintenance-reboot: it upgrades Tailscale to the pin in a detached unit on the worker and waits for the worker to answer again.',
  TAILSCALE_SOURCE_OWNER_CONFLICT:
    'Another file under /etc/apt/sources.list.d names the Tailscale repository. Keep one signed source, at /etc/apt/sources.list.d/tailscale.list, then run homelab fleet-sync.',
};

const PASSED =
  'Pinned native Tailscale service is enabled, running and authenticated; manager reachability remains separate.';

/** The tailscale:configuration check from one run of the play: the code it
 * stopped on, with its remedy; when it stopped on none of its own,
 * TAILSCALE_SETUP_OR_LOGIN_REQUIRED only while the node is not logged in
 * (`running` asks it), and TAILSCALE_CONFIGURATION_INCOMPLETE otherwise.
 */
export async function tailscaleConfiguration(
  play: { ok: boolean; stdout: string },
  running: () => Promise<boolean>
): Promise<Check> {
  const id = 'tailscale:configuration';
  if (play.ok) return { id, status: 'pass', summary: PASSED };
  const code = Object.keys(PLAY_STOPS).find((name) =>
    play.stdout.includes(name)
  );
  if (code)
    return {
      id,
      status: 'fail',
      summary: code,
      remedy: { action: PLAY_STOPS[code]! },
    };
  if (!(await running().catch(() => false)))
    return {
      id,
      status: 'fail',
      summary: 'TAILSCALE_SETUP_OR_LOGIN_REQUIRED',
      remedy: {
        action:
          'The worker is not logged in to the tailnet. Declare tailnet in fleet.json so fleet-sync enrols it with a single-use key, or sign it in on the worker (sudo tailscale up), then run homelab fleet-sync.',
      },
    };
  return {
    id,
    status: 'fail',
    summary: 'TAILSCALE_CONFIGURATION_INCOMPLETE',
    remedy: {
      action:
        'The worker is logged in and running, but the Tailscale play stopped before its end without a code of its own (a package source or the daemon). Run homelab fleet-sync again; when it repeats, apply ansible/ubuntu/tailscale.yml of the approved revision on the worker to see the task that stops.',
    },
  };
}

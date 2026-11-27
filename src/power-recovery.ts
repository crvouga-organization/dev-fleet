import policy from '../ansible/ubuntu/policy.json';
import { record } from './config';
import type { Check, Runner } from './types';

/** The value the firmware is set to, including one written and waiting for
 * the next boot: fwupd reports that as BiosSettingTargetValue. */
function firmwareValue(setting: Record<string, unknown>): string {
  const pending = setting['BiosSettingTargetValue'];
  return String(
    typeof pending === 'string' && pending
      ? pending
      : (setting['BiosSettingCurrentValue'] ?? setting['CurrentValue'] ?? '')
  );
}

/** Only recognize named firmware settings; an enabled OS service is not proof of AC recovery. */
export async function powerRecoveryCheck(run: Runner): Promise<Check> {
  const result = await run(
    ['sudo', '-n', 'fwupdmgr', 'get-bios-settings', '--json'],
    { timeoutMs: 15_000 }
  );
  try {
    const data: unknown = JSON.parse(result.stdout);
    const settings =
      record(data) && Array.isArray(data['BiosSettings'])
        ? data['BiosSettings']
        : [];
    const observed = settings.find(
      (item) =>
        record(item) &&
        policy.powerLossRecovery.settings.includes(String(item['Name']))
    );
    if (result.ok && record(observed)) {
      const value = firmwareValue(observed);
      const enabled = policy.powerLossRecovery.values.includes(value);
      return {
        id: 'worker:power-loss-recovery',
        status: enabled ? 'pass' : 'fail',
        summary: enabled
          ? 'Firmware reports an enabled restore-after-AC-loss setting; a real power-loss test remains distinct from configuration evidence.'
          : 'POWER_LOSS_RECOVERY_UNSET',
        ...(!enabled
          ? {
              remedy: {
                action:
                  'Run homelab converge: it sets the recognized restore-after-AC-loss firmware setting. The firmware applies it at the next boot.',
              },
            }
          : {}),
      };
    }
  } catch {
    /* Firmware output may contain hardware identifiers; never expose it. */
  }
  return {
    id: 'worker:power-loss-recovery',
    status: 'skip',
    summary:
      'Automatic power-on after AC loss is not observable through a supported firmware adapter on this machine.',
    remedy: {
      action:
        'Enable and test restore-on-AC-power in the firmware or VM host during initial enrollment. An OS unit cannot power on a switched-off machine.',
    },
  };
}

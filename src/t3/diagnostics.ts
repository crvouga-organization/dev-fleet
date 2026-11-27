import type { Check } from '../types';

/** Fixed diagnostic only: upstream errors can contain credentials. */
export class T3DiagnosticError extends Error {
  readonly check: Check = {
    id: 't3:account-roster',
    status: 'fail',
    summary: 'T3_ACCOUNT_ROSTER_UNAVAILABLE',
    remedy: {
      action:
        'Run homelab fleet-accounts on this machine to verify proxy access and the proxy-client-key secret, then retry homelab t3-apply --dry-run. Existing providers were preserved.',
    },
  };

  constructor() {
    super('T3_ACCOUNT_ROSTER_UNAVAILABLE');
  }
}

export async function diagnoseT3<T>(
  stage: 'deployment' | 'definition' | 'reconciliation',
  action: () => Promise<T>
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof T3DiagnosticError) throw error;
    const failure = new T3DiagnosticError();
    Object.assign(failure.check, { id: 't3:reconciliation' });
    failure.check.summary = 'T3_RECONCILIATION_UNAVAILABLE';
    failure.check.remedy = {
      action:
        stage === 'deployment'
          ? 'Inspect the local node receipt and its file permissions; restore the receipt before retrying homelab t3-status.'
          : stage === 'definition'
            ? 'Verify the installed release contains agents/t3.json and can read it. Reinstall the pinned package and retry homelab t3-status.'
            : 'Inspect T3 settings and personal-managed.json locally for invalid JSON, symlinks or file permissions. Restore a valid backup, check for another T3 operation, then retry homelab t3-apply --dry-run. Do not share file contents.',
    };
    failure.message = failure.check.summary;
    throw failure;
  }
}

import type { Runner } from '../types';

export const KEYCHAIN_REMEDY =
  'From the worker, trigger the signed-in manager’s fleet-sync LaunchAgent over verified SSH as described in docs/ubuntu-sync.md under Manager keychain. Run converge from the manager desktop to use a different revision or options.';

// Ask Security.framework for the active gh item with UI forbidden. Only the
// OSStatus crosses the subprocess boundary, including on a successful read.
const QUERY = `import Foundation
import Security
let query: [String: Any] = [
  kSecClass as String: kSecClassGenericPassword,
  kSecAttrService as String: "gh:github.com",
  kSecAttrAccount as String: "",
  kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail,
  kSecReturnData as String: true
]
var item: CFTypeRef?
print(SecItemCopyMatching(query as CFDictionary, &item))
`;

export async function inaccessibleGithubKeychain(
  run: Runner,
  remoteMac = process.platform === 'darwin' &&
    Boolean(process.env['SSH_CONNECTION'])
): Promise<boolean> {
  if (!remoteMac) return false;
  const result = await run(['/usr/bin/swift', '-'], {
    input: QUERY,
    timeoutMs: 30_000,
  });
  // errSecInteractionNotAllowed. An absent item or a probe failure gives
  // no evidence that access was denied.
  return result.ok && result.stdout.trim() === '-25308';
}

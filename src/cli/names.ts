/** The public command for each historical registration name.
 * The key is what the code registered before this surface; the value is
 * what an operator types. A trailing `[args...]` is not part of the name.
 */
const PUBLIC: Record<string, string> = {
  'fleet-status': 'check',
  'fleet-watch': 'notify',
  'fleet-discover': 'tailnet',
  'fleet-sync': 'converge',
  'fleet-state': 'state',
  'fleet-report': 'history',
  'fleet-restore': 'recover',
  'fleet-validate': 'check-config',
  'fleet-manifest': 'measure',
  'fleet-node-sync': 'converge-local',
  'fleet-repair': 'repair',
  'fleet-nodes': 'workers',
  'fleet-node-add': 'enroll',
  'fleet-accounts': 'accounts',
  'fleet-github-verify': 'check-github',
  'fleet-node-replace': 'replace',
  'fleet-node-seed': 'provision',
  'fleet-node-park': 'park',
  'fleet-node-resume': 'resume',
  'fleet-node-retire': 'retire',
  't3-status': 't3',
  't3-apply': 't3-reconcile',
  't3-cleanup': 't3-remove',
  cliproxy: 'proxy',
};

/** What an operator types for a historical command word. */
export function publicCommand(name: string): string {
  return PUBLIC[name] ?? name;
}

/** Commander accepts the public name and the historical one.
 * A trailing `[args...]` stays on the name; the alias is the command word only.
 */
export function commandNames(legacy: string): {
  name: string;
  aliases: string[];
} {
  const [word, ...rest] = legacy.split(' ');
  const published = publicCommand(word ?? legacy);
  const name = [published, ...rest].join(' ');
  return {
    name,
    aliases: published === word ? [] : [word ?? legacy],
  };
}

import { record } from '../config';
import type { FleetDefinition } from '../definition';
import { sshArgs, shellQuote } from '../ssh';
import { discoverTailnet, type TailnetComputer } from '../tailscale';
import { packagePlaybook } from '../platform/ansible';
import type { Check, FleetNode, Runner } from '../types';

const identityPath = '/.well-known/t3/environment';
const renewalWindow = 7 * 86400000;
const t3 =
  't3="$(command -v t3 || ls -d "$HOME"/.local/share/personal/tools/t3-*/t3 2>/dev/null | sort -V | tail -n 1)" && exec "$t3" ';
type Member = {
  name: string;
  node?: FleetNode;
  url: string;
  identity: string;
  links: unknown[];
};

function command(node: FleetNode | undefined, args: string[]): string[] {
  const script =
    args[0] === 't3'
      ? t3 + args.slice(1).map(shellQuote).join(' ')
      : args.map(shellQuote).join(' ');
  return node ? [...sshArgs(node), script] : ['sh', '-c', script];
}

async function json(run: Runner, cmd: string[]) {
  const result = await run(cmd, { timeoutMs: 30000 });
  try {
    return result.ok ? (JSON.parse(result.stdout) as unknown) : null;
  } catch {
    return null;
  }
}

export function meshGrant(
  links: unknown[],
  identity: string,
  now: number
): string {
  const grant = links.find(
    (entry) => record(entry) && entry['environmentId'] === identity
  );
  if (!record(grant)) return 'missing';
  if (grant['access'] !== 'full-access') return 'incorrect access';
  const expiry =
    typeof grant['expiresAt'] === 'string'
      ? Date.parse(grant['expiresAt'])
      : NaN;
  if (!Number.isFinite(expiry) || expiry <= now + renewalWindow)
    return 'renewal due';
  return grant['status'] === 'reachable' ? 'verified' : 'unreachable';
}

function validIdentity(id: unknown, node?: FleetNode): id is string {
  return (
    typeof id === 'string' &&
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id) &&
    (!node?.t3EnvironmentId || node.t3EnvironmentId === id)
  );
}

function localWorkerOrigin(def: FleetDefinition, id: string): string {
  const worker = def.workers.find((entry) => entry.id === id);
  return 'http://127.0.0.1:' + (worker?.network?.t3Port ?? 3773);
}

async function measureMember(
  def: FleetDefinition,
  computers: TailnetComputer[],
  node: FleetNode | undefined,
  run: Runner
): Promise<Member | null> {
  const name = node?.id ?? def.manager.id;
  const peer = computers.find((entry) =>
    node ? entry.id === node.tailscaleId : entry.self
  );
  if (!peer?.online || !/^[a-z0-9.-]+\.ts\.net$/.test(peer.dns)) return null;
  const url = 'https://' + peer.dns;
  const local = node ? localWorkerOrigin(def, name) : url;
  const identity = await json(
    run,
    command(node, ['curl', '-fsS', '--max-time', '5', local + identityPath])
  );
  const links = await json(
    run,
    command(node, ['t3', 'environment', 'list', '--json'])
  );
  if (
    !record(identity) ||
    !validIdentity(identity['environmentId'], node) ||
    !Array.isArray(links)
  )
    return null;
  return {
    name,
    ...(node ? { node } : {}),
    identity: identity['environmentId'],
    url,
    links,
  };
}

async function directedGrant(
  source: Member,
  target: Member,
  run: Runner,
  apply: boolean
): Promise<Check> {
  let state = meshGrant(source.links, target.identity, Date.now());
  if (apply && state !== 'verified' && state !== 'unreachable') {
    const address = await json(
      run,
      command(source.node, [
        'curl',
        '-fsS',
        '--max-time',
        '5',
        target.url + identityPath,
      ])
    );
    if (record(address) && address['environmentId'] === target.identity) {
      const applied = await packagePlaybook(run)(
        'ubuntu/t3-mesh.yml',
        {
          mint_command: command(target.node, [
            't3',
            'auth',
            'pairing',
            'create',
            '--json',
            '--ttl',
            '5m',
            '--label',
            'dev-fleet mesh',
          ]),
          unlink_command: command(source.node, [
            't3',
            'environment',
            'unlink',
            target.identity,
          ]),
          link_command: command(source.node, [
            't3',
            'environment',
            'link',
            '--from',
            '-',
            '--access',
            'full-access',
          ]),
          replace_grant: state !== 'missing',
          target_url: target.url,
        },
        120000
      );
      const after = await json(
        run,
        command(source.node, ['t3', 'environment', 'list', '--json'])
      );
      state =
        applied.ok && Array.isArray(after)
          ? meshGrant(after, target.identity, Date.now())
          : 'update failed';
    } else state = 'destination identity unverified';
  }
  return {
    id: 't3:mesh-link',
    status: state === 'verified' ? 'pass' : 'fail',
    summary: source.name + ' to ' + target.name + ': ' + state + '.',
  };
}
export async function meshChecks(
  def: FleetDefinition,
  nodes: FleetNode[],
  run: Runner,
  apply: boolean
): Promise<Check[]> {
  if (!def.t3?.meshAccess || !nodes.length) return [];
  const tailnet = await discoverTailnet(run);
  const checks: Check[] = [];
  const members: Member[] = [];
  for (const node of [undefined, ...nodes]) {
    const member = await measureMember(def, tailnet.computers, node, run);
    if (member) members.push(member);
    else
      checks.push({
        id: 't3:mesh-member',
        status: 'fail',
        summary:
          (node?.id ?? def.manager.id) +
          ' is unreachable or its enrolled identity could not be verified.',
      });
  }
  if (new Set(members.map((m) => m.identity)).size !== members.length)
    return [
      ...checks,
      {
        id: 't3:mesh-member',
        status: 'fail',
        summary:
          'Two enrolled machines reported the same T3 environment identity.',
      },
    ];
  for (const source of members)
    for (const target of members) {
      if (source === target) continue;
      checks.push(await directedGrant(source, target, run, apply));
    }
  return checks;
}

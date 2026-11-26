import {
  ADDITIONAL_PROVIDER_CLIS,
  NATIVE_AGENTS,
} from './agents/native-verify';
import type { FleetDefinition } from './definition';
import { idesOf } from './ide/definition';
import type { ManagerNode, ManagerReport } from './manager-sync';
import policy from '../ansible/ubuntu/policy.json';

export function measureParity(
  definition: FleetDefinition,
  report: ManagerReport
) {
  const nodes = [definition.manager, ...definition.workers].map(({ id }) => {
    const entry = report.nodes.find((node) => node.node === id);
    return {
      node: id,
      pending: entry
        ? pendingVersions(definition, entry, report.desiredRevision)
        : ['rollout'],
    };
  });
  return {
    revision: report.desiredRevision,
    complete: nodes.every((node) => !node.pending.length),
    nodes,
  };
}

export function pendingVersions(
  definition: FleetDefinition,
  entry: ManagerNode,
  revision: string | null
) {
  if (!revision || entry.reachability !== 'online') return ['rollout'];
  const manager = entry.node === definition.manager.id;
  const required = new Set([
    'tool:mise',
    'tool:bun',
    'tool:node',
    'beszel:version',
    'beszel:connection',
    'beszel:freshness',
    'beszel:agent-version',
    ...[
      ...NATIVE_AGENTS.map((agent) => agent.name),
      ...ADDITIONAL_PROVIDER_CLIS,
    ].map((name) => 'agent:' + name + ':version'),
    ...(idesOf(definition).includes('t3')
      ? [
          't3:version',
          't3:running-version',
          ...(manager ? ['t3:desktop-installed'] : []),
        ]
      : []),
    ...(manager
      ? []
      : [...Object.keys(policy.packages), 'tailscale'].map(
          (name) => 'worker:package:' + name
        )),
    ...entry.checks
      .filter(
        (check) => check.id.startsWith('tool:') || check.id === 'auth:toolchain'
      )
      .map((check) => check.id),
  ]);
  if (entry.appliedRevision !== revision) required.add('rollout');
  return [...required].filter((id) => {
    const observations = entry.checks.filter((check) => check.id === id);
    return (
      !observations.length ||
      observations.some(
        (check) => check.status !== 'pass' && check.status !== 'not-applicable'
      )
    );
  });
}

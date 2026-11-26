import { expect } from 'bun:test';
import { fleet } from '../../../src/fleet-config';
import type { Runner } from '../../../src/types';
import { succeeded } from '../../support/commands';
import { meshGrant, meshChecks } from '../../../src/t3/mesh';
import { ide } from './world';

ide.When(
  /^the source lists a "([^"]+)" grant to "([^"]+)" that is "([^"]+)" for (-?\d+) more days$/,
  (
    world,
    access: string,
    environmentId: string,
    status: string,
    days: string
  ) => {
    world.result = [
      {
        access,
        environmentId,
        status,
        expiresAt: new Date(Number(days) * 86400000).toISOString(),
      },
    ];
  }
);
ide.Then(
  'its mesh grant to {string} is {string}',
  (world, target: string, assessment: string) => {
    expect(meshGrant(world.result as unknown[], target, 0)).toBe(assessment);
  }
);

ide.When(
  'the mesh has {int} enrolled environments with {int} offline and full-access grants between all reachable members',
  async (world, count: number, offline: number) => {
    const names = Array.from({ length: count }, (_, i) =>
      i ? 'worker-' + i : fleet.manager.id
    );
    const ids = names.map(
      (_, i) => '00000000-0000-0000-0000-' + String(i).padStart(12, '0')
    );
    const peers = names.map((name, i) => ({
      ID: name,
      HostName: name,
      DNSName: name + '.example.ts.net',
      OS: i ? 'linux' : 'macOS',
      Online: i < count - offline,
      TailscaleIPs: ['100.64.0.' + (i + 1)],
    }));
    const nodes = names.slice(1).map((id) => ({
      id,
      ssh: id,
      tailscaleId: id,
      workspace: '/tmp/example',
      required: [],
    }));
    const run: Runner = async (cmd) => {
      if (cmd[0] === 'tailscale')
        return succeeded(
          JSON.stringify({
            BackendState: 'Running',
            Self: peers[0],
            Peer: Object.fromEntries(peers.slice(1).map((p) => [p.ID, p])),
          })
        );
      const source = cmd[0] === 'ssh' ? names.indexOf(cmd.at(-2)!) : 0;
      if (cmd.at(-1)!.includes('curl'))
        return succeeded(JSON.stringify({ environmentId: ids[source] }));
      if (cmd.at(-1)!.includes("'list'"))
        return succeeded(
          JSON.stringify(
            ids
              .filter((id) => id !== ids[source])
              .map((environmentId) => ({
                environmentId,
                status: 'reachable',
                access: 'full-access',
                expiresAt: '2099-01-01',
              }))
          )
        );
      throw new Error('A healthy grant should require only measurement.');
    };
    world.checks = await meshChecks(
      { ...fleet, t3: { meshAccess: 'full-access' } },
      nodes,
      run,
      true
    );
  }
);
ide.Then(
  'it verifies {int} directed grants and reports {int} unreachable members',
  (world, links: number, offline: number) => {
    expect(
      world.checks.filter((c) => c.id === 't3:mesh-link' && c.status === 'pass')
    ).toHaveLength(links);
    expect(
      world.checks.filter(
        (c) => c.id === 't3:mesh-member' && c.status === 'fail'
      )
    ).toHaveLength(offline);
  }
);

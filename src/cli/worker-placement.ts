import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomInt } from 'node:crypto';
import { PACKAGE_ROOT } from '../package-info';
import { parseProbe } from '../machine-health';
import { sshArgs } from '../ssh';
import { mapBounded } from '../report';
import type { FleetNode, Runner } from '../types';

export async function workerPlacement(
  nodes: FleetNode[],
  run: Runner,
  now = Date.now,
  choose = randomInt
) {
  const probe = await readFile(
    join(PACKAGE_ROOT, 'ansible/net/remote-probe.sh'),
    'utf8'
  );
  const candidates = await mapBounded(nodes, async (node) => {
    const result = await run([...sshArgs(node), 'sh -s -- placement'], {
      input: probe,
      timeoutMs: 15000,
    });
    const sample = parseProbe(result.ok ? result.stdout : '');
    const { ncpu, load, cpuPressure, runnable, epoch, memFreePct } = sample;
    const base = { node: node.id, environmentId: node.t3EnvironmentId };
    if (
      !ncpu ||
      load === undefined ||
      memFreePct === undefined ||
      runnable === undefined ||
      cpuPressure === undefined ||
      epoch === undefined ||
      Math.abs(now() / 1000 - epoch) > 30
    )
      return { ...base, slots: 0, reason: 'telemetry unavailable or stale' };
    if (!node.t3EnvironmentId || sample.t3Ready !== 1)
      return { ...base, slots: 0, reason: 'T3 environment unavailable' };
    const slots = spareSlots(
      { ncpu, load, runnable, memFreePct, cpuPressure },
      sample
    );
    return {
      ...base,
      slots,
      reason: slots ? 'available' : 'capacity exhausted',
      load,
      runnable,
      cpuPressure,
      memFreePct,
    };
  });
  const total = candidates.reduce((sum, c) => sum + c.slots, 0);
  // Weight independent simultaneous starts by spare capacity. Admission belongs to T3.
  let draw = total ? choose(total) : 0;
  const selected = candidates.find((c) => (draw -= c.slots) < 0);
  return {
    version: 1,
    decision: selected ? 'prefer' : 'queue',
    node: selected?.node ?? null,
    environmentId: selected?.environmentId ?? null,
    candidates,
  };
}

function spareSlots(
  {
    ncpu,
    load,
    runnable,
    memFreePct,
    cpuPressure,
  }: Record<
    'ncpu' | 'load' | 'runnable' | 'memFreePct' | 'cpuPressure',
    number
  >,
  sample: ReturnType<typeof parseProbe>
) {
  const { agentLimitHeld, agentScopes } = sample;
  return Math.max(
    0,
    Math.min(
      Math.floor(ncpu - Math.max(load, runnable)),
      Math.floor(((memFreePct - 10) * (sample.memTotalMb ?? 0)) / 100 / 1024),
      cpuPressure >= 20 ? 0 : ncpu,
      agentLimitHeld === undefined
        ? ncpu
        : agentLimitHeld - (agentScopes ?? agentLimitHeld)
    )
  );
}

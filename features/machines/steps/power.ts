import { expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import policy from '../../../ansible/ubuntu/policy.json';
import { machines, type MachinesWorld } from './world';

const { When, Then } = machines;

interface PowerTask {
  name?: string;
  when?: string;
  ansible?: Record<string, unknown>;
}
const tasks = new WeakMap<MachinesWorld, PowerTask[]>();

const KEYWORDS = new Set([
  'name',
  'when',
  'register',
  'changed_when',
  'failed_when',
  'check_mode',
  'args',
  'environment',
  'loop',
  'tags',
  'become',
  'vars',
]);

When('the power tasks are read', (world) => {
  const document = parse(
    readFileSync(
      join(import.meta.dir, '../../../ansible/ubuntu/tasks/power.yml'),
      'utf8'
    )
  ) as Record<string, unknown>[];
  tasks.set(
    world,
    document.map((task) => ({
      ...(typeof task['name'] === 'string' ? { name: task['name'] } : {}),
      ...(typeof task['when'] === 'string' ? { when: task['when'] } : {}),
      ansible: Object.fromEntries(
        Object.entries(task).filter(([key]) => !KEYWORDS.has(key))
      ),
    }))
  );
});

const of = (world: MachinesWorld): PowerTask[] => {
  const found = tasks.get(world);
  if (!found) throw new Error('The scenario has not read the power tasks.');
  return found;
};

const argvOf = (task: PowerTask | undefined): unknown[] => {
  const module = Object.values(task?.ansible ?? {})[0];
  const argv =
    module && typeof module === 'object' && 'argv' in module
      ? module.argv
      : undefined;
  return Array.isArray(argv) ? argv : [];
};

Then('the firmware is read only when the machine is physical', (world) => {
  const read = of(world).find((task) =>
    String(task.name).startsWith('Read the firmware')
  );
  expect(read?.when).toContain('virtualization_role');
  expect(read?.when).toContain('guest');
});

Then(
  'the setting written is one powerLossRecovery names, at a value it names',
  (world) => {
    const write = of(world).find((task) =>
      String(task.name).startsWith('Write the restore')
    );
    const argv = argvOf(write);
    expect(argv[0]).toBe('fwupdmgr');
    expect(argv[1]).toBe('set-bios-setting');
    const selector = of(world).find((task) =>
      String(task.name).startsWith('Select the restore')
    );
    const script = String(argvOf(selector).at(-1) ?? '');
    expect(script).toContain('POWER_LOSS_SETTINGS');
    expect(script).toContain('POWER_LOSS_VALUES');
    expect(policy.powerLossRecovery.settings.length).toBeGreaterThan(0);
    expect(policy.powerLossRecovery.values.length).toBeGreaterThan(0);
  }
);

Then(
  'the write is skipped when no recognized setting offers such a value',
  (world) => {
    const write = of(world).find((task) =>
      String(task.name).startsWith('Write the restore')
    );
    expect(write?.when).toContain('power_loss_selection');
  }
);

Then('the write asks fwupd not to reboot', (world) => {
  const write = of(world).find((task) =>
    String(task.name).startsWith('Write the restore')
  );
  expect(argvOf(write)).toContain('--no-reboot-check');
});

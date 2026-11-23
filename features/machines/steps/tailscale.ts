import { expect } from 'bun:test';
import { tailscaleConfiguration } from '../../../src/tailscale-configuration';
import { machines } from './world';

/** tailscale:configuration from how ansible/ubuntu/tailscale.yml ended and
 * what `tailscale status` answers, both from memory.
 */
const { Given, When, Then } = machines;

Given('the Tailscale play completes', (world) => {
  world.tailscalePlay = { ok: true, stdout: '' };
});

Given(
  'the Tailscale play stops, printing {string}',
  (world, output: string) => {
    world.tailscalePlay = { ok: false, stdout: output };
  }
);

Given(
  /^the worker is (logged in and running|not logged in) on the tailnet$/,
  (world, state: string) => {
    world.tailscaleRunning = state === 'logged in and running';
  }
);

When('the Tailscale configuration of the worker is measured', async (world) => {
  world.checks = [
    await tailscaleConfiguration(world.tailscalePlay, () => {
      world.tailscaleAsked = true;
      return Promise.resolve(world.tailscaleRunning);
    }),
  ];
});

Then('the worker was not asked whether it is logged in', (world) => {
  expect(world.tailscaleAsked).toBe(false);
});

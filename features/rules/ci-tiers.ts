import { expect } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import ubuntu from '../../ansible/ubuntu/policy.json';
import {
  decideTier,
  jobs,
  planTier,
  type Plan,
} from '../../.github/scripts/affected';
import { issueTitle, queueAction } from '../../.github/scripts/ci-issues';
import type { DataTable } from '../support/gherkin';
import { rules, type RulesWorld } from './steps';

const { When, Then } = rules;
const root = resolve(import.meta.dir, '../..');
const plans = new WeakMap<RulesWorld, Plan>();
const plan = (world: RulesWorld): Plan => {
  const found = plans.get(world);
  if (!found) throw new Error('No tier was planned in this scenario.');
  return found;
};

const RUNNER: Record<string, string> = {
  amd64: 'ubuntu-latest',
  arm64: 'ubuntu-24.04-arm',
};

const TIERED = [
  'check',
  'state',
  'workflows',
  'ansible',
  'manager',
  'fresh-box',
  'agent-box',
  'proxy-box',
];

const CEILING = "${{ needs.affected.outputs.tier == 'pr' && 8 || 12 }}";

When('the pull request tier is planned for:', (world, table: DataTable) => {
  plans.set(world, planTier('pr', table.list()));
});

When('the pull request tier is planned for nothing', (world) => {
  plans.set(world, planTier('pr', []));
});

When('the release tier is planned', (world) => {
  plans.set(world, planTier('release', []));
});

When('the nightly tier is planned', (world) => {
  plans.set(world, planTier('nightly', []));
});

Then('the plan runs {string}', (world, name: string) => {
  expect(flag(plan(world), name)).toBe(true);
});

Then('the plan skips {string}', (world, name: string) => {
  expect(flag(plan(world), name)).toBe(false);
});

Then('the plan runs no feature', (world) => {
  expect(plan(world).features).toEqual([]);
});

Then('the plan runs the {string} feature', (world, name: string) => {
  expect(plan(world).features).toEqual([`features/${name}`]);
});

Then('the plan runs every feature', (world) => {
  expect(plan(world).features_all).toBe(true);
  expect(plan(world).features.length).toBeGreaterThan(0);
});

Then("the plan's fresh matrix is exactly:", (world, table: DataTable) => {
  expect(plan(world).freshMatrix).toEqual(
    table.hashes().map((row) => ({
      release: row['release'] ?? '',
      architecture: row['architecture'] ?? '',
      runner: row['runner'] ?? '',
      feature: row['feature'] ?? '',
    }))
  );
});

Then(
  "the plan's fresh matrix is every release, architecture and feature of {string}",
  (world, directory: string) => {
    const features = readdirSync(resolve(root, directory))
      .filter((name) => name.endsWith('.feature'))
      .map((name) => name.slice(0, -'.feature'.length))
      .sort();
    const expected = ubuntu.releases.flatMap((release) =>
      release.architectures.flatMap((architecture) =>
        features.map((feature) => ({
          release: release.release,
          architecture,
          runner: runnerFor(architecture),
          feature,
        }))
      )
    );
    expect(plan(world).freshMatrix).toEqual(expected);
    expect(expected.length).toBeGreaterThan(1);
  }
);

Then('the plan lists the affected job and each job it runs', (world) => {
  const selected = plan(world);
  const listed = jobs(selected);
  expect(listed[0]).toBe('affected');
  expect(listed.includes('check')).toBe(selected.check);
  expect(listed.includes('fresh-box')).toBe(selected.fresh);
  expect(listed.includes('agent-box')).toBe(selected.agent);
  expect(listed.includes('manager')).toBe(selected.manager);
});

Then(
  '{string} of {string} on {string} is the {string} tier',
  (_world, event: string, ref: string, branch: string, tier: string) => {
    const decided: string = decideTier(event, ref, branch);
    expect(decided).toBe(tier);
  }
);

Then(
  'a {string} result is {string}',
  (_world, result: string, action: string) => {
    const decided: string = queueAction(result);
    expect(decided).toBe(action);
  }
);

Then(
  'the issue for tier {string} and job {string} is titled {string}',
  (_world, tier: string, job: string, title: string) => {
    expect(issueTitle(tier, job)).toBe(title);
  }
);

Then(
  'its {string} job runs when the affected job selects {string}',
  (world, name: string, output: string) => {
    const entry = jobOf(world, name);
    expect(entry.if).toBe(`needs.affected.outputs.${output} == 'true'`);
    expect([entry.needs ?? []].flat()).toContain('affected');
  }
);

Then(
  'its {string} job takes its matrix from the affected job',
  (world, name: string) => {
    expect(String(jobOf(world, name).strategy?.matrix?.include)).toContain(
      'needs.affected.outputs.fresh_matrix'
    );
  }
);

Then(
  'the {string} workflow does not run on {string}',
  async (world, name: string, event: string) => {
    world.workflow = await workflowNamed(name);
    expect(Object.keys(world.workflow.on)).not.toContain(event);
  }
);

Then('each tiered job times out at the tier ceiling', (world) => {
  for (const name of TIERED)
    expect(String(jobOf(world, name)['timeout-minutes'])).toBe(CEILING);
});

Then(
  'its {string} job times out after {int} minutes',
  (world, name: string, minutes: number) => {
    expect(jobOf(world, name)['timeout-minutes']).toBe(minutes);
  }
);

function flag(selected: Plan, name: string): boolean {
  const flags: Record<string, boolean> = {
    check: selected.check,
    state: selected.state,
    workflows: selected.workflows,
    ansible: selected.ansible,
    manager: selected.manager,
    manager_tests: selected.manager_tests,
    manager_playbook: selected.manager_playbook,
    fresh: selected.fresh,
    agent: selected.agent,
    proxy: selected.proxy,
    cliproxy: selected.cliproxy,
    features_all: selected.features_all,
  };
  const value = flags[name];
  if (value === undefined) throw new Error(`No plan flag ${name}.`);
  return value;
}

function runnerFor(architecture: string): string {
  const runner = RUNNER[architecture];
  if (!runner) throw new Error(`No runner for ${architecture}.`);
  return runner;
}

interface JobShape {
  if?: string;
  needs?: string | string[];
  'timeout-minutes'?: unknown;
  strategy?: { matrix?: { include?: unknown } };
}

function jobOf(world: RulesWorld, name: string): JobShape {
  const found = world.workflow?.jobs[name] as JobShape | undefined;
  if (!found) throw new Error(`The workflow has no ${name} job.`);
  return found;
}

async function workflowNamed(
  name: string
): Promise<NonNullable<RulesWorld['workflow']>> {
  for await (const path of new Bun.Glob('.github/workflows/*.yml').scan(root)) {
    const parsed = parse(readFileSync(resolve(root, path), 'utf8')) as {
      name?: string;
    };
    if (parsed.name === name && existsSync(resolve(root, path)))
      return parsed as NonNullable<RulesWorld['workflow']>;
  }
  throw new Error(`No workflow is named ${name}.`);
}

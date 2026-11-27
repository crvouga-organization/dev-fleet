/** Which CI tier a run is, and which jobs that tier runs for a diff.
 * The workflow calls this once and every other job reads the outputs.
 * An unknown path fails safe to the full feature suite, never to the
 * nightly fresh-worker matrix. */
import {
  appendFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { isAbsolute, join, relative, dirname } from 'node:path';
import ubuntu from '../../ansible/ubuntu/policy.json';

const root = join(import.meta.dir, '../..');

export type Tier = 'pr' | 'release' | 'nightly';

export interface FreshCell {
  release: string;
  architecture: string;
  runner: string;
  feature: string;
}

export interface Plan {
  tier: Tier;
  check: boolean;
  state: boolean;
  workflows: boolean;
  ansible: boolean;
  manager: boolean;
  manager_tests: boolean;
  manager_playbook: boolean;
  fresh: boolean;
  agent: boolean;
  proxy: boolean;
  cliproxy: boolean;
  features_all: boolean;
  /** `features/<dir>`, the directories `bun test` runs. */
  features: string[];
  freshMatrix: FreshCell[];
}

const RUNNER: Record<string, string> = {
  amd64: 'ubuntu-latest',
  arm64: 'ubuntu-24.04-arm',
};

const ALL_FEATURES = new Set([
  'package.json',
  'bun.lock',
  'tsconfig.json',
  'eslint.config.js',
  'mise.toml',
]);

const FORCE_FULL = new Set([
  '.github/workflows/ci.yml',
  '.github/workflows/nightly.yml',
  '.github/scripts/affected.ts',
  '.github/scripts/ci-issues.ts',
]);

const FRESH_FILE = new Set([
  'bootstrap/fleet-remote-bootstrap.sh',
  'bootstrap/bootstrap.sh',
  'src/remote-bootstrap.ts',
  'src/remote-entry.ts',
  'src/node-converge.ts',
  'src/node-converge-linux.ts',
  'src/node-converge-shared.ts',
  'src/sync.ts',
  'src/manager-sync.ts',
  'src/remote-operation.ts',
  'src/remote-lock.ts',
  'mise.toml',
  'mise.lock',
]);

const JOB_FLAGS = [
  ['check', 'check'],
  ['state', 'state'],
  ['workflows', 'workflows'],
  ['ansible', 'ansible'],
  ['manager', 'manager'],
  ['fresh', 'fresh-box'],
  ['agent', 'agent-box'],
  ['proxy', 'proxy-box'],
] as const;

export function decideTier(
  event: string,
  refName: string,
  defaultBranch: string
): Tier {
  if (event === 'schedule') return 'nightly';
  if (event === 'push') return 'release';
  if (event === 'workflow_dispatch' && refName === defaultBranch)
    return 'release';
  return 'pr';
}

export function jobs(plan: Plan): string[] {
  const names = ['affected'];
  for (const [flag, name] of JOB_FLAGS) if (plan[flag]) names.push(name);
  return names;
}

export function planTier(tier: Tier, changed: readonly string[]): Plan {
  if (tier === 'release') return releasePlan();
  if (tier === 'nightly') return nightlyPlan();
  return prPlan(changed);
}

function runnerFor(architecture: string): string {
  const runner = RUNNER[architecture];
  if (!runner) throw new Error(`No runner for ${architecture}.`);
  return runner;
}

function freshFeatures(): string[] {
  return readdirSync(join(root, 'features/fresh-box'))
    .filter((name) => name.endsWith('.feature'))
    .map((name) => name.slice(0, -'.feature'.length))
    .sort();
}

function cells(
  releases: readonly { release: string; architectures: readonly string[] }[],
  features: readonly string[]
): FreshCell[] {
  const rows: FreshCell[] = [];
  for (const release of releases)
    for (const architecture of release.architectures)
      for (const feature of features)
        rows.push({
          release: release.release,
          architecture,
          runner: runnerFor(architecture),
          feature,
        });
  return rows;
}

function newestRelease(): {
  release: string;
  architectures: readonly string[];
} {
  const release = ubuntu.releases[0];
  if (!release) throw new Error('The Ubuntu policy accepts no release.');
  return release;
}

function prCells(): FreshCell[] {
  return cells([newestRelease()], ['fresh-box']).filter(
    (cell) => cell.architecture === 'amd64'
  );
}

function releaseCells(): FreshCell[] {
  return cells([newestRelease()], ['fresh-box']);
}

function nightlyCells(): FreshCell[] {
  return cells(ubuntu.releases, freshFeatures());
}

function everyFeature(): string[] {
  return featureDirs().map((name) => `features/${name}`);
}

function fullPr(): Plan {
  return {
    tier: 'pr',
    check: true,
    state: true,
    workflows: true,
    ansible: true,
    manager: true,
    manager_tests: true,
    manager_playbook: true,
    fresh: true,
    agent: false,
    proxy: true,
    cliproxy: true,
    features_all: true,
    features: everyFeature(),
    freshMatrix: prCells(),
  };
}

function releasePlan(): Plan {
  return {
    tier: 'release',
    check: true,
    state: true,
    workflows: true,
    ansible: true,
    manager: true,
    manager_tests: true,
    manager_playbook: true,
    fresh: true,
    agent: true,
    proxy: true,
    cliproxy: true,
    features_all: true,
    features: everyFeature(),
    freshMatrix: releaseCells(),
  };
}

function nightlyPlan(): Plan {
  return {
    tier: 'nightly',
    check: false,
    state: false,
    workflows: false,
    ansible: false,
    manager: false,
    manager_tests: false,
    manager_playbook: false,
    fresh: true,
    agent: true,
    proxy: false,
    cliproxy: false,
    features_all: false,
    features: [],
    freshMatrix: nightlyCells(),
  };
}

interface Selection {
  fresh: boolean;
  managerPlaybook: boolean;
  managerTests: boolean;
  state: boolean;
  workflows: boolean;
  ansible: boolean;
  proxy: boolean;
  cliproxy: boolean;
  features: Set<string>;
  featuresAll: boolean;
  unknown: boolean;
}

function blank(): Selection {
  return {
    fresh: false,
    managerPlaybook: false,
    managerTests: false,
    state: false,
    workflows: false,
    ansible: false,
    proxy: false,
    cliproxy: false,
    features: new Set(),
    featuresAll: false,
    unknown: false,
  };
}

function forcesFull(path: string): boolean {
  return FORCE_FULL.has(path) || path.startsWith('.github/actions/');
}

function affectsFresh(path: string): boolean {
  return (
    FRESH_FILE.has(path) ||
    path.startsWith('features/fresh-box/') ||
    path.startsWith('ansible/ubuntu/')
  );
}

function affectsManagerPlaybook(path: string): boolean {
  return (
    path.startsWith('ansible/macos/') || path === 'ansible/ubuntu/disk-gc.py'
  );
}

function cliproxyCode(path: string): boolean {
  return (
    path.startsWith('cliproxy/') &&
    !path.startsWith('cliproxy/docs/') &&
    !path.endsWith('.md')
  );
}

function isDocumentation(path: string): boolean {
  return (
    path === 'LICENSE' ||
    path === 'README.md' ||
    path.startsWith('docs/') ||
    path.endsWith('.md')
  );
}

function isClassified(path: string): boolean {
  return (
    affectsFresh(path) ||
    affectsManagerPlaybook(path) ||
    path.startsWith('src/state/') ||
    path.startsWith('.github/') ||
    ansiblePath(path) ||
    proxyPath(path)
  );
}

function prPlan(changed: readonly string[]): Plan {
  if (changed.length === 0 || changed.some(forcesFull)) return fullPr();
  const selection = blank();
  const index = featureClosures();
  for (const path of changed) note(path, selection, index);
  return planFrom(selection);
}

function planFrom(selection: Selection): Plan {
  // Unknown paths run every feature. State and the macOS features follow the
  // features that were selected, including that full set.
  if (selection.unknown) selection.featuresAll = true;
  const names = selection.featuresAll
    ? featureDirs()
    : [...selection.features].sort();
  if (names.includes('machines') || names.includes('ide'))
    selection.managerTests = true;
  if (names.includes('state')) selection.state = true;
  const manager = selection.managerTests || selection.managerPlaybook;
  return {
    tier: 'pr',
    check: true,
    state: selection.state,
    workflows: selection.workflows,
    ansible: selection.ansible,
    manager,
    manager_tests: selection.managerTests,
    manager_playbook: selection.managerPlaybook,
    fresh: selection.fresh,
    agent: false,
    proxy: selection.proxy,
    cliproxy: selection.cliproxy,
    features_all: selection.featuresAll,
    features: names.map((name) => `features/${name}`),
    freshMatrix: selection.fresh ? prCells() : [],
  };
}

function note(
  path: string,
  selection: Selection,
  index: Map<string, Set<string>>
): void {
  const owners = covers(path, index);
  for (const owner of owners) selection.features.add(owner);
  applyPaths(path, selection);
  if (!isKnown(path, owners)) selection.unknown = true;
}

function applyPaths(path: string, selection: Selection): void {
  if (affectsFresh(path)) selection.fresh = true;
  if (affectsManagerPlaybook(path)) selection.managerPlaybook = true;
  if (path.startsWith('ansible/macos/')) selection.managerTests = true;
  if (path.startsWith('src/state/')) selection.state = true;
  if (path.startsWith('.github/')) selection.workflows = true;
  if (ansiblePath(path)) selection.ansible = true;
  if (proxyPath(path)) selection.proxy = true;
  if (cliproxyCode(path)) selection.cliproxy = true;
  if (ALL_FEATURES.has(path)) selection.featuresAll = true;
}

function ansiblePath(path: string): boolean {
  return path.startsWith('ansible/') || path === '.ansible-lint.yml';
}

function proxyPath(path: string): boolean {
  return path.startsWith('features/accounts/') || cliproxyCode(path);
}

function isKnown(path: string, owners: readonly string[]): boolean {
  return (
    owners.length > 0 ||
    isDocumentation(path) ||
    ALL_FEATURES.has(path) ||
    forcesFull(path) ||
    isClassified(path)
  );
}

function covers(path: string, index: Map<string, Set<string>>): string[] {
  const names = new Set<string>();
  const direct = /^features\/([^/]+)\//.exec(path);
  if (direct?.[1] && featureDirs().includes(direct[1])) names.add(direct[1]);
  for (const [name, files] of index) if (owns(files, path)) names.add(name);
  return [...names];
}

function owns(files: Set<string>, path: string): boolean {
  if (files.has(path)) return true;
  for (const file of files) if (path.startsWith(`${file}/`)) return true;
  return false;
}

let directories: string[] | undefined;
function featureDirs(): string[] {
  directories ??= readdirSync(join(root, 'features'), { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        existsSync(join(root, 'features', entry.name, 'features.test.ts'))
    )
    .map((entry) => entry.name)
    .sort();
  return directories;
}

let closures: Map<string, Set<string>> | undefined;
function featureClosures(): Map<string, Set<string>> {
  if (closures) return closures;
  const built = new Map<string, Set<string>>();
  for (const name of featureDirs()) {
    const files = new Set<string>();
    follow(`features/${name}/features.test.ts`, files);
    built.set(name, files);
  }
  closures = built;
  return built;
}

const FROM = /from\s+['"](\.[^'"]+)['"]/g;
const SIDE = /(?:^|\n)\s*import\s+['"](\.[^'"]+)['"]/g;
const DYNAMIC = /import\(\s*['"](\.[^'"]+)['"]\s*\)/g;
const LITERAL = /['"]([^'"\n]{1,180})['"]/g;

function follow(file: string, files: Set<string>): void {
  if (files.has(file)) return;
  files.add(file);
  if (!/\.(ts|tsx|js|mjs|cjs)$/.test(file)) return;
  const text = readText(file);
  if (text === undefined) return;
  for (const spec of specifiers(text)) {
    const resolved = resolveSpecifier(file, spec);
    if (resolved) follow(resolved, files);
  }
  for (const literal of quoted(text)) addLiteral(file, literal, files);
}

function readText(file: string): string | undefined {
  try {
    return readFileSync(join(root, file), 'utf8');
  } catch {
    return undefined;
  }
}

function specifiers(text: string): string[] {
  const found = new Set<string>();
  for (const pattern of [FROM, SIDE, DYNAMIC]) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const spec = match[1];
      if (spec) found.add(spec);
    }
  }
  return [...found];
}

function quoted(text: string): string[] {
  LITERAL.lastIndex = 0;
  return [...text.matchAll(LITERAL)].flatMap((match) =>
    match[1] ? [match[1]] : []
  );
}

function addLiteral(from: string, literal: string, files: Set<string>): void {
  if (literal.startsWith('.')) {
    const resolved = resolveSpecifier(from, literal);
    if (resolved) follow(resolved, files);
    return;
  }
  const normalized = repoPath(literal);
  if (!normalized) return;
  const absolute = join(root, normalized);
  if (!existsSync(absolute)) return;
  if (statSync(absolute).isFile() && /\.(ts|tsx|js)$/.test(normalized))
    follow(normalized, files);
  else files.add(normalized);
}

function repoPath(literal: string): string | undefined {
  if (
    !literal.includes('/') ||
    /[\s*]/.test(literal) ||
    literal.includes('node_modules') ||
    literal.startsWith('http:') ||
    literal.startsWith('https:') ||
    literal.startsWith('git')
  )
    return undefined;
  const rel = relative(root, join(root, literal));
  if (rel.startsWith('..') || isAbsolute(rel)) return undefined;
  return rel;
}

function resolveSpecifier(from: string, spec: string): string | undefined {
  if (!spec.startsWith('.')) return undefined;
  const base = join(root, dirname(from), spec);
  const rel = relative(root, base);
  if (rel.startsWith('..') || isAbsolute(rel)) return undefined;
  for (const candidate of candidates(base)) {
    if (existsSync(candidate) && statSync(candidate).isFile())
      return relative(root, candidate);
  }
  return undefined;
}

function candidates(base: string): string[] {
  return [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.json`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
    join(base, 'index.js'),
  ];
}

function changedPaths(): string[] {
  const file = process.env['CHANGED'];
  if (!file) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function requestedTier(): Tier {
  const requested = process.argv[2];
  if (requested === 'pr' || requested === 'release' || requested === 'nightly')
    return requested;
  if (requested !== undefined) {
    process.stderr.write(`Unknown tier ${requested}\n`);
    process.exit(1);
  }
  return decideTier(
    process.env['GITHUB_EVENT_NAME'] ?? 'pull_request',
    process.env['GITHUB_REF_NAME'] ?? '',
    process.env['DEFAULT_BRANCH'] ?? 'main'
  );
}

/** An empty matrix fails the workflow. A skipped fresh job still needs one row. */
function matrixFor(plan: Plan): FreshCell[] {
  if (plan.freshMatrix.length > 0) return plan.freshMatrix;
  return [
    {
      release: 'none',
      architecture: 'amd64',
      runner: 'ubuntu-latest',
      feature: 'skipped',
    },
  ];
}

function emit(plan: Plan): void {
  const lines = [
    `tier=${plan.tier}`,
    `check=${plan.check}`,
    `state=${plan.state}`,
    `workflows=${plan.workflows}`,
    `ansible=${plan.ansible}`,
    `manager=${plan.manager}`,
    `manager_tests=${plan.manager_tests}`,
    `manager_playbook=${plan.manager_playbook}`,
    `fresh=${plan.fresh}`,
    `agent=${plan.agent}`,
    `proxy=${plan.proxy}`,
    `cliproxy=${plan.cliproxy}`,
    `features_all=${plan.features_all}`,
    `features=${plan.features.join(' ')}`,
    `fresh_matrix=${JSON.stringify(matrixFor(plan))}`,
    '',
  ];
  const text = lines.join('\n');
  const target = process.env['GITHUB_OUTPUT'];
  if (target) appendFileSync(target, text);
  else process.stdout.write(text);
}

if (import.meta.main) emit(planTier(requestedTier(), changedPaths()));

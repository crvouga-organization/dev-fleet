import type { Release } from './program';

const SAFETY = [
  'No arguments prints help, including on a TTY. --json returns this document. The menu requires --interactive; --json and --non-interactive never prompt.',
  'Diagnostics, onboarding instructions, schema, catalogs, scripts and repair previews are read-only.',
  'converge, converge-local, t3-reconcile and t3-remove apply by invocation; --dry-run previews. t3-reconcile --import ID explicitly adopts ownership. --json never implies a dry run. enroll and repair require --apply --yes.',
  'state alone is read-only; --init, --import, --push and --restore each act on invocation. Bucket credentials come from HOMELAB_BUCKET_ACCESS_KEY_ID and HOMELAB_BUCKET_SECRET_ACCESS_KEY or a terminal prompt, never from arguments.',
  'Do not copy credentials, forward SSH agents, bypass host keys, provision infrastructure or execute unreviewed remedies.',
  'A healthy manager does not prove another machine can connect to it. Run check from each intended manager.',
  'repair executes only allowlisted owner actions, then reruns diagnostics. Native logins, host trust and resource permissions remain explicit operator steps. Pass the reviewed planHash as --plan-hash to reject a changed plan.',
  'Shared provider keys are fetched through each machine’s existing Vault authorization by workstation tooling. Never copy machine-local login caches.',
  'Use exact npm versions for automation. The application never self-updates.',
];

const EXAMPLES = [
  'homelab converge-local',
  'homelab check',
  'homelab state --json',
  'homelab t3',
  'homelab check --local --workspace /path/to/personal --json',
  'homelab check --json --strict --timeout 120000',
  'homelab check --tailnet --json',
  'homelab check --workers --json',
  'homelab enroll --id dev-linux --ssh dev-linux --path /home/dev/workspace --require github,t3,toolchain --json',
  'homelab enroll --id dev-linux --ssh dev-linux --path /home/dev/workspace --apply --yes --json',
  'homelab check --node dev-linux --json',
  'homelab repair --list --json',
  'homelab repair --json',
  'homelab repair --local --repair workspace --json',
  'homelab repair --local --repair workspace --plan-hash <reviewed-sha256> --apply --yes --json',
];

/** For an agent working in another project, which is every project that uses
 * homelab: a change to homelab is asked for, never made in place.
 */
function support(release: Release) {
  return {
    issues: release.issues ?? null,
    report:
      'A defect in homelab, or something it cannot do yet, is raised as an issue in the homelab repository: one issue per bug or feature request, after searching the open ones. From any other project that is the only way to change homelab. Tell the operator what is blocked and link the issue.',
    never:
      'Do not edit the installed package, a checkout converge owns or a file homelab manages on a machine: the next install or converge replaces each of them. Do not clone homelab to patch it, vendor a modified copy, or hide the defect behind a workaround in the project that holds fleet.json.',
    include:
      'homelab --version, the command and its flags, the error code or the failing check IDs from --json, what happened and what was expected.',
    withhold:
      'The issue tracker is public. Leave out credentials, the fleet configuration, hostnames, accounts, domains, tailnet names, paths under a home directory and raw subprocess output.',
  };
}

export function agentGuide(release: Release) {
  return {
    version: 1,
    name: 'homelab',
    release: release.version,
    releasedAt: release.releasedAt,
    invocation: 'homelab <command> --json --non-interactive',
    discovery: 'homelab commands --json',
    setup:
      'Setting up a fleet from a project: llms.txt and docs/consumer-setup.md in this package (node_modules/@crvouga/homelab/), also at https://github.com/crvouga/homelab/blob/main/docs/consumer-setup.md',
    defaultCommand: 'help',
    help: 'homelab <command> --help',
    interactive:
      'homelab --interactive (explicit opt-in; TTY required, disabled in CI)',
    groups: {
      'fleet-*':
        'Developer computers: check, tailnet, converge, state, history, converge-local, repair, workers, enroll',
      t3: 'Declared T3 provider instances: t3, t3-reconcile, t3-remove',
      proxy: 'The CLI proxy service on the manager; arguments are forwarded',
    },
    configuration: {
      workspace:
        'The published package itself. Run from a checkout (development): --workspace PATH, PERSONAL_WORKSPACE, then the homelab checkout the command is started in',
      roster:
        '--config PATH, PERSONAL_FLEET_CONFIG, closest ancestor .fleet.local.json, then the roster in the fleet state',
      definition:
        'HOMELAB_CONFIG, then the closest fleet.json in the working directory or above it (the operator’s project), then the configuration converge last applied from the fleet state (the homelab CLI on the manager), then the copy converge installed at ~/.config/homelab/fleet.json. Never edit that copy: converge replaces it, and refuses with FLEET_CONFIGURATION_COPY_CHANGED when it was edited by hand',
      state:
        'HOMELAB_STATE or ~/.local/share/homelab/state: a local copy of the roster, the approved revision and the configuration last applied. The bucket named under "state" in the fleet configuration is the source of truth; its credentials are passed in HOMELAB_BUCKET_ACCESS_KEY_ID and HOMELAB_BUCKET_SECRET_ACCESS_KEY, or saved by homelab state --init in ~/.config/homelab/bucket.json for unattended runs. homelab state --json compares the copies',
      revision:
        'The commit the published package names (homelab --version). converge converges every machine to it; --revision SHA selects another',
    },
    output: {
      stdout:
        'Public diagnostics emit one versioned JSON document with --json. proxy retains its owner output contract; native agent launch commands stream native output.',
      exitCodes: {
        '0': 'Success or preview',
        '1': 'Failed check or operation; strict also rejects warnings/skips',
        '2': 'Invalid usage or configuration',
        '130': 'Cancelled',
      },
      errors:
        'schema/output/error.schema.json: {version:1,ok:false,code,error}; raw subprocess output and exception details are withheld',
      reports:
        'These outputs have a JSON schema in this package; parse by it and by its version. Diagnostic reports of check, state and repair (whose report names its command repair): schema/output/report.schema.json, version 1. converge: schema/output/fleet-sync.schema.json, version 3 (a --dry-run adds plan). converge --schedule: schema/output/fleet-sync-schedule.schema.json, version 2. state --example and --export: schema/output/fleet-state-definition.schema.json, version 1. history: schema/output/fleet-report.schema.json, version 1. Any other --json document carries its version, and command and ok where it reports an outcome, but has no published schema yet.',
      checks:
        'schema/check-ids.json (schema/check-ids.schema.json), generated from the code, lists every check ID: meaning, what a passing check means; severity, required (a failure blocks readiness unless the run marks the check out of scope) or advisory (a warning or not required, never blocking); repair, {recipe} the repair recipe that repairs it or {manual} why only a person can. A * stands for a name taken at run time (a node, a tool, an account). Each failing check also carries its own remedy.',
      statuses: ['pass', 'warn', 'fail', 'skip', 'not-applicable'],
      coverage:
        'Default check tests the manager and all configured workers. --local tests only this manager; --tailnet and --workers cover Tailscale computers. A missing roster fails explicitly. T3/VS Code end-to-end checks remain manual.',
    },
    safety: SAFETY,
    support: support(release),
    toolchain:
      'On a fleet machine the global mise configuration belongs to homelab: converge publishes it, and check fails tool:global-mise-config when anything replaced it. A project pins its own tools in a project mise.toml (mise install --locked in its checkout) and never publishes a global one.',
    library:
      'None. The package is the homelab command: it declares no main or exports, and nothing under src/ is a supported import; any release may change it. Ask for a command in an issue instead.',
    fleetSync: {
      command: 'homelab converge',
      preview: 'homelab converge --dry-run --json',
      approval:
        'Applies on invocation without a prompt; --dry-run previews and changes no machine: on the manager it only checks the release out into homelab’s cache and installs the Bun it pins, never the toolchain, the global mise configuration or shell profiles',
      scope:
        'Whole enrolled Ubuntu fleet over verified SSH; --node filters diagnostics/rollout',
      state:
        'The approved and applied revision are kept in the fleet state and uploaded to its bucket after every run; the report carries the state:replica check',
      revision:
        'The fleet moves only to a revision on the default branch of the source repository, which every release is; any other is refused with FLEET_REVISION_UNMERGED before anything changes. --allow-unmerged converges to one on purpose: use it only when the person who owns the fleet asked for that revision. The report says what selected the revision (selectedBy). A revision whose own toolchain bootstrap would replace a newer mise with the older one it pins (a rollback to an earlier release) is refused with FLEET_MISE_DOWNGRADE before anything changes, and with FLEET_MISE_UNMEASURED when the mise of a worker could not be measured (follow its remedy); --allow-mise-downgrade lets it, and breaks every checkout on those machines that needs the newer mise: use it only when the person who owns the fleet asked for that.',
      readiness:
        'Full Ubuntu acceptance is incomplete and fails closed; do not override it or claim deployment success.',
    },
    reconciliation: {
      plan: 'homelab t3-reconcile --dry-run --json',
      apply: 'homelab t3-reconcile --plan-hash HASH',
      cleanup: 'homelab t3-remove --dry-run',
      import: 'homelab t3-reconcile --import ID',
      ownership:
        'Only declared or explicitly imported T3 instances. Pairing, credentials, threads and unrelated settings are preserved.',
      concurrency:
        'Exclusive personal lock with optimistic external T3 file updates; avoid concurrent Settings edits.',
    },
    examples: EXAMPLES,
  };
}

# homelab

Keeps a set of development machines in sync: one **manager** and many
**workers**. One command, `sync`, brings every machine to the same
pinned tools, the same coding agents signed in through one proxy, the same
uptime policy and the same monitoring. Adding or removing a machine is one
entry in `fleet.json`.

Status: extracted from a working three-machine fleet and in daily use there.
It has not yet been set up from nothing by a second person; expect rough edges
and read [what is assumed](#what-it-assumes) first.

## How you use it

You do not clone this repository. homelab is a command you install, and your
fleet is a small project of your own:

```
my-fleet/               your repository
  fleet.json            your machines, your services, the bucket that holds the state
  package.json          pins the `homelab` version every machine runs
```

You run `homelab` from inside that project and pass it the credentials of a
storage bucket you own. Nothing else has to be kept:

| What                                                                                    | Where it lives                                                     |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| The fleet configuration                                                                 | `fleet.json`, in your repository                                   |
| The version of homelab                                                                  | The `@crvouga/homelab` dependency in your `package.json`           |
| The fleet state: the enrolled workers, the approved revision, the configuration applied | Your bucket (any S3-compatible service)                            |
| Secrets                                                                                 | The provider `fleet.json` names (`vault`, `sops`, `file` or `env`) |
| The source, checkouts, tools and reports homelab puts on a machine                      | A cache: delete it and `sync` rebuilds it                          |

The CLI proxy and the monitoring hub on the manager still keep data of their
own; [known limits](#known-limits) says what is lost with the manager.

## What it assumes

homelab is opinionated. These are part of it, not options:

- The **manager** is a macOS machine. You run `sync` on it, and it hosts
  the shared services (the CLI proxy and the monitoring hub) in Docker Desktop.
- **Workers** are Ubuntu 26.04 or 24.04 machines reached over SSH. They are stateless:
  everything on them is rebuilt from Git and your secrets.
  [What a worker must offer](docs/worker-requirements.md) is one page: image,
  architecture, size, access, first-boot data and network. The
  [support matrix](docs/support-matrix.md) lists every platform and what
  happens to it.
- The fleet state is kept in an **S3-compatible bucket** you own.
- Machines reach each other over **Tailscale**.
- Coding agents (Claude Code, Codex, Grok, OpenCode, Antigravity) run through
  **CLIProxyAPI** on the manager, and **T3 Code** lists one provider per
  account signed in on the proxy.
- Machine policy is **Ansible** (`ansible/`), tool versions are **mise** pins
  (`mise.toml`, `mise.lock`), monitoring is **Beszel**.

What homelab puts on a machine is written in tracked files and pinned to a
version or digest. [What is declared, and where](docs/declared.md) lists it,
and what is not pinned yet.

What it does not assume is anything about you: no account, hostname, domain,
tailnet or repository is written in this code. They live in your `fleet.json`.

## Quickstart

Setting it up with a coding agent? Point it at
[`llms.txt`](llms.txt) or straight at
[Set up a fleet from your own project](docs/consumer-setup.md): the whole
procedure in one pass, including what the agent must ask you for and the
first sync only you can run. Both ship in the package, under
`node_modules/@crvouga/homelab/`.

On the manager you need macOS with Git, Node 22 or newer, Docker Desktop and
Tailscale signed in. You also need an empty private bucket on any
S3-compatible service (AWS S3, Cloudflare R2, Backblaze B2, MinIO) and an
access key that can read and write it.

```sh
mkdir my-fleet && cd my-fleet && git init
npm init -y
npm install --save-dev --save-exact @crvouga/homelab

npx @crvouga/homelab state --example > fleet.json
$EDITOR fleet.json                   # your machines, and your bucket under "state"

export HOMELAB_BUCKET_ACCESS_KEY_ID=…
export HOMELAB_BUCKET_SECRET_ACCESS_KEY=…
npx @crvouga/homelab converge --dry-run    # preview
npx @crvouga/homelab converge              # apply
```

Commit `fleet.json`, `package.json` and the lockfile. Keep the two credentials
out of Git: pass them from wherever you keep secrets (a password manager's
`run` command, a git-ignored `.env`, your shell). They are read from the
environment and never taken from arguments.

`sync` converges the manager first, then every worker over SSH. It
fetches the commit your `homelab` version was published from, sends it and
your configuration to each machine, installs the pinned toolchain, applies the
Ansible policy and verifies the result. It prints one table and writes a full
JSON report. Use `--fail-on-warning` for unattended acceptance.
It exits with status 1 if warnings remain, including a warning from uploading
the fleet state. The JSON report records the warning count and acceptance
beside the deployment result. Skipped checks are counted separately.

The first run on a machine installs everything, mise included, so
Git is the only tool it needs beforehand.

`--dry-run` changes no machine. It first brings the manager's copy of the
fleet state up to the bucket (never uploading), then prints, and adds to
`--json` as `plan`, what a sync would change: the revision, each tool pin that
moves, and what restarts because of it (a T3 restart ends its running agent
turns). On the manager it checks the release out into
homelab's cache and installs the Bun that release pins beside any others, so
that it can run; it never installs the toolchain, publishes the global mise
configuration, edits shell profiles or touches a worker.

`homelab` finds the closest `fleet.json` in the directory you run it from or
above it. `HOMELAB_CONFIG` names a file elsewhere.

The CLI runs on [Bun](https://bun.sh), which the package brings as a
dependency. If your package manager does not run dependency install scripts,
allow Bun's or install Bun yourself; the CLI uses the one on `PATH`.

For a new remote T3 turn, clients can run `homelab check --placement --json`.
Pass eligible worker IDs with `--node`, including only the pinned worker when
the caller chose an environment. The reply names a preferred environment or
says to queue, and gives the measurements behind each decision. Concurrent
callers sample in proportion to available capacity. T3 must perform admission
when it starts a turn and retry placement if another start took the last slot.

## The version

Every release of `@crvouga/homelab` is published from one commit and names
it. The version in your `package.json` is therefore the revision of every
machine in the fleet:

```sh
npx homelab --version               # 1.4.0 (commit 3f2a…)
npm install --save-dev --save-exact @crvouga/homelab@latest
npx @crvouga/homelab converge              # the fleet moves to that release
```

One worker, the canary, proves a new revision before the others receive it:
the first reachable worker, or the one `canary` in `fleet.json` (or
`--canary`) names when it is reachable. An offline worker never holds the
others back.

During a full sync, a worker's T3 restarts immediately when a new release,
policy or desktop preference requires it. A restart ends running agent turns.
Existing commands that pass `--restart-busy` continue to work.

Each sync snapshots the manager's T3 desktop preferences, including notification
mode, snapshot sounds, appearance and shortcuts, from
`userdata/client-settings.json` in its T3 home. The fleet state keeps a copy
for manager recovery. Workers receive the complete document, so changing or
removing a preference on the manager reaches them on the next sync. A fresh
manager with no saved preferences uses T3's defaults. Full sync also copies
custom keybindings with their T3 migration history and published themes with
their background images. Removing them on the manager removes them on workers.
The pinned T3 CLI validates the themes before the fleet saves or installs them.

To go back, run `npx @crvouga/homelab converge --rollback` on the manager: it
converges every machine to the revision applied before the approved one, which
the fleet state records: after an upgrade whose canary failed, that is the
revision the fleet still runs. A rollback covers what a revision declares: the
checkout, the pinned tools and T3 Code. System packages roll forward only
(apt never downgrades them), so a release that moved one keeps it. Installing
an older version and running `sync` does the same for any earlier
release.

The fleet moves only to a revision on the default branch of the source
repository, which every release is. `sync` asks the manager's own copy
of that repository, whatever selected the revision (the package, `--revision`,
`--rollback`, the schedule, a checkout, a hand-off from a worker), and refuses
any other with `FLEET_REVISION_UNMERGED` before anything changes.
`--allow-unmerged` converges to such a revision on purpose. The report, the
fleet state and `watch` say what selected the approved revision.

mise's own pin (`min_version`) is a minimum. A machine that runs a newer mise
than a revision pins keeps it, after a rollback too: replacing it would break
every checkout on the machine whose pin is newer. `status` reports that
as the warning `TOOLCHAIN_DOWNGRADE` of `tool:mise`, and
`converge --allow-mise-downgrade` installs the older one on purpose, on
every machine it converges. Each revision runs its own bootstrap, and one from
before this rule installs exactly the mise it pins. So `sync` reads the
pin from the revision's own files and measures the mise of the manager and of
each worker it is about to converge before that bootstrap runs anywhere: a
revision that would replace a newer mise is refused with
`FLEET_MISE_DOWNGRADE`, after a `--rollback` to an earlier release too, unless
`--allow-mise-downgrade` asks for it. A worker that does not say which mise it
runs is not let through unmeasured: the run is refused with
`FLEET_MISE_UNMEASURED` until it answers, is parked or is left out with
`--node`. Started on a worker, the same question is asked of the homelab
installed on the manager (`converge --measure-mise`, which only answers)
before the revision's own run script starts there; a manager whose installed
homelab is from before that question refuses such a revision rather than
passing it.

## Your project's own tools

On a fleet machine the global mise configuration (`~/.config/mise/config.toml`
and its `mise.lock`) belongs to homelab: `sync` publishes it with the
fleet's pinned tools and the agent worktree roots mise must trust. A project
pins its own tools in its own `mise.toml` and installs them with
`mise install --locked` in its checkout. On a fleet machine mise installs a
project's tools only from the project's `mise.lock` (run `mise lock` after
changing a pin); a tool the lock does not name is refused. A project never
publishes a global configuration. If anything replaces homelab's, `status` fails the check
`tool:global-mise-config` until the next `sync`.

## Using it from code

homelab has no library API. The package is the `homelab` command: it
declares no `main` or `exports`, and nothing under `src/`, `bootstrap/` or
`ansible/` is a supported import. Any release, a patch included, may change
them, and some modules read the fleet configuration as soon as they are
imported. If your project needs something homelab does, ask for a command in
an [issue](#bugs-and-feature-requests).

## State

Your bucket is the source of truth for everything Git does not hold: the
roster of enrolled workers, the approved revision, and the configuration
`sync` last applied. It is one SQLite database that
[Litestream](https://litestream.io) replicates to the bucket. `fleet.json`
says where the bucket is and the command is passed its credentials:

```json
"state": {
  "bucket": "my-fleet-state",
  "endpoint": "https://ACCOUNT.r2.cloudflarestorage.com",
  "region": "auto"
}
```

```sh
npx @crvouga/homelab state             # where the state is, and how it stands with the bucket
```

The copy on the manager is disposable: the roster and the approved revision
come back from the bucket, and the machine is rebuilt from Git.
[Replacing the manager](docs/manager-recovery.md) is the runbook for a new or
lost manager.

Some runs are started by a machine rather than by you: a worker that hands
`sync` to the manager, for example. They get no environment, so save the
credentials on the manager once (in `~/.config/homelab/bucket.json`,
readable by you alone):

```sh
npx @crvouga/homelab state --init
```

Without a bucket everything still works from the local copy, and `sync`
warns that the manager holds the only one. [docs/state.md](docs/state.md)
explains how replication stays correct, how to move an existing fleet to a
project, and which state is not in the bucket yet.

## Provider accounts

Provider accounts live only on the CLI proxy. `npx @crvouga/homelab accounts`
lists them with their state; `--add`, `--relogin` and `--remove` change one
and propagate the result to every node, and `converge --only accounts`
propagates them without a full sync.
[docs/accounts.md](docs/accounts.md) explains how.

A worker holds no provider sign-in of its own. T3 starts each agent through a
launcher that signs in on the proxy, and so does everything else on a worker:
there `claude`, `codex`, `opencode`, `grok` and `antigravity` are the fleet's
launchers (`agents/bin`), ahead of the pinned CLIs on the `PATH` of every
shell. A person in a terminal on a worker, or an app that starts an agent over
SSH, therefore uses the proxy's accounts, picked by the fleet's selection
policy. The pinned CLI itself is still there, behind the launcher, as
`~/.local/share/mise/shims/claude`. The manager is your own machine: its
commands stay the pinned CLIs with whatever sign-in you gave them.

## Add or remove a machine

1. Set up SSH from the manager to the new Ubuntu box (a non-root user with
   sudo) and join it to your tailnet.
2. Add it under `workers` in your `fleet.json` and commit:

   ```json
   {
     "id": "worker-three",
     "ssh": "worker-three",
     "os": "linux",
     "network": {
       "tailscaleName": "worker-three.tail0a1b2c.ts.net",
       "sshPort": 22,
       "user": "dev",
       "t3Port": 3773
     }
   }
   ```

   A worker may add `"features": { "preset": "editing" }` for a rented
   machine that only edits code: no Docker, and T3 as a headless server with
   no desktop. `containers` and `session` set each one; fleet-wide defaults go
   under `worker.features`. The [worker contract](docs/worker-contract.md)
   says what each feature installs and the minimum size of a worker.
   `"agentSessionLimit": 12`, on a worker or under `worker`, has the worker
   refuse agent sessions above that number; without it nothing is refused
   ([a limit on agent sessions](docs/worker-contract.md#a-limit-on-agent-sessions)).

3. Run `sync`. A machine that has only an SSH server and an account
   with sudo is enough: every pull request proves that against a bare
   Ubuntu machine, over SSH
   ([`fresh-box.feature`](features/fresh-box/fresh-box.feature)).

A new machine can also join by itself: `npx @crvouga/homelab provision --id ID
--output seed.yaml --apply --yes` writes cloud-init user data (or an Ubuntu
autoinstall file with `--autoinstall`) holding the worker account with your
manager's key, the privilege rule, a host key the manager pins at once and the
pinned Tailscale with a short-lived single-use auth key from your secrets
provider (`tailnet-auth-key`). Boot a stock Ubuntu image with it, then add the
worker with `enroll` and run `sync`.

`npx @crvouga/homelab measure --id ID` measures what a worker is made of
(packages, active tools, always-on services) with a digest that is the same
for two workers built from the same revision; its check `worker:manifest`
names every difference from the declared pins and, with `--reference` (the
`--json` manifest of a fresh build), from that build.

Remove a machine with `npx @crvouga/homelab retire --id ID --apply --yes`
(it revokes the worker's Vault token, forgets its host key and roster entry
and leaves a tombstone in the fleet state), then delete its entry and run
`sync`. To put a fresh machine in place of a worker under the same id,
run `npx @crvouga/homelab replace --id ID --host-key "TYPE BASE64" --apply
--yes` and then `converge --node ID`; the manager's T3 pairs with the new
machine's T3 by itself, with no code to copy. A run scoped with `--node` records only the
revision of the workers it covered; the fleet's applied revision moves with a
full `sync`.

## Configuration

Your `fleet.json` is validated by
[`schema/fleet.schema.json`](schema/fleet.schema.json), which the installed
package carries: `state --example` prints a complete example that points
`$schema` at it, so an editor checks the file as you type.
[`examples/fleet.json`](examples/fleet.json) is the same example.
`homelab check-config` checks the file without contacting anything and
names the first field that breaks a rule (`{code, path, expected, actual}`);
`--ansible` also renders the Ansible inventory and syntax-checks every
playbook with the pinned Ansible.

Edit the `fleet.json` of your project, never the copy `sync` installs
at `~/.config/homelab/fleet.json` for launchers and scheduled jobs:
`sync` replaces that copy, and refuses to run
(`FLEET_CONFIGURATION_COPY_CHANGED`) rather than lose an edit made to it by
hand, on the manager or on a worker it is about to converge, before anything
is changed. [docs/state.md](docs/state.md#day-to-day) says how to keep or discard
one.

| Block      | What it declares                                                    |
| ---------- | ------------------------------------------------------------------- |
| `source`   | The Git repository nodes accept code from (this one, or your fork)  |
| `state`    | The bucket that holds the fleet state; never its credentials        |
| `secrets`  | Where secrets are kept: `env`, `file`, `sops` or `vault`            |
| `manager`  | The one macOS manager                                               |
| `workers`  | The Ubuntu workers                                                  |
| `services` | The proxy's public origin and the monitoring dashboard and accounts |
| `worker`   | Policy every worker must meet                                       |
| `ides`     | The IDEs the fleet runs; `["t3"]` when absent                       |
| `t3`       | T3 settings every machine holds (`profile`) and `requiredModels`    |

### Supported IDEs

Every supported IDE is reached through one interface (`src/ide/ide.ts`): its
settings on each machine, the manager's own copy (pinned version and policy)
and what the manager measures of each worker. Enabling one is `ides` in
`fleet.json`.

| IDE               | `ides`    | Manager                                             | Workers                                         |
| ----------------- | --------- | --------------------------------------------------- | ----------------------------------------------- |
| T3 Code           | `t3`      | Pinned CLI and signed desktop, updates off          | Pinned desktop app, locked policy, pairing      |
| super.engineering | `super`   | Your own install; one SSH workspace per worker      | Reached over SSH; nothing installed by homelab  |
| Orca              | `orca`    | Your own install; every worker as an SSH host       | Each worker lists the others; nothing installed |
| Paradev           | `paradev` | Your own install, signed in; `hosts add` per worker | Each worker adds every other machine over SSH   |

On the macOS manager, sync stages the checksum-pinned T3 desktop under
`~/Applications/homelab/`. Its installed signature and version appear as
`t3:desktop-installed`. The separate `t3:version` check measures the running
app. When a single running T3 desktop needs replacing, sync restarts it from the verified bundle and checks the running release.

`"ides": ["t3", "super"]` adds [super.engineering](https://super.engineering)
beside T3 Code. It is a desktop app on the manager that works on another
machine through a
[remote SSH workspace](https://super.engineering/docs/remote-workspaces/):
the checkout, Git, terminals and coding agents stay on the worker. You install
and start the app on the manager and enable Remote workspaces under Settings →
Experimental; it updates itself. Every `converge` then asks the app, through
its own CLI, for a remote workspace for each worker that has none, named after
the worker and pointed at the SSH alias `fleet.json` gives it, and measures
that the manager's own SSH finds Git, `flock` and the fleet's coding agents
there (`super:ssh`, `super:workspace`). The app connects with your SSH
configuration, so a worker needs an `ssh` alias that works from a terminal on
the manager. The `super:*` checks only warn, so an app that is closed never
fails a sync.

To add projects to every worker’s workspace, set `"super": {"projects":
["src/app", "src/tools"]}` in `fleet.json`. Paths are relative to the worker
account’s home. A dry run lists workspaces to create. The fleet records the ID
of each workspace it creates so retirement or an SSH alias change can remove
that grouping. Previously existing workspaces stay under their owner’s control.

An agent the app starts on a worker signs in through the CLI proxy, with no
sign-in on the worker: the app starts an agent by its plain command, and on a
worker that command is the fleet's launcher (see
[Provider accounts](#provider-accounts)). `super:ssh` warns
(`SUPER_AGENTS_NOT_PROXIED`) about a worker where it is still the plain CLI,
until the next `converge` of that worker. Workspaces on the manager itself
start the manager's own CLIs, which homelab leaves as they are.

What it does not do yet: homelab never removes a workspace, so delete a
retired worker's in the app. Projects are yours to add to a workspace, and the
app installs and updates its helper on the worker itself.

`"ides": ["t3", "orca"]` adds [Orca](https://www.onorca.dev/docs/ssh) beside
T3 Code. Orca has no command that adds an SSH target: you add each worker
under Settings → SSH, using the SSH alias `fleet.json` gives it. Every
`converge` then reads `orca host list` on the manager and on each worker,
and warns (`ORCA_SSH_TARGET_MISSING`, `orca:host`) for a machine that is not
listed. On Linux the CLI is `orca-ide`, because GNOME owns `orca`. The
`orca:*` checks only warn.

`"ides": ["t3", "paradev"]` adds [Paradev](https://docs.paradev.com/remote-access)
(formerly Superset). You install it and sign in (`paradev auth login`, or
`SUPERSET_API_KEY`) on the manager. Every `converge` then starts the host
(`paradev start --daemon --auto-update`) and runs `paradev hosts add` from
the manager to each worker and from each worker to every other machine,
named after the node. `hosts add` installs the CLI on that machine, signs it
in with a new key sent over SSH, and repairs a later run. A key it prints
never reaches a report. On Linux, lingering keeps the host after logout;
the remedy names `loginctl enable-linger` and converge does not run it.
Retirement runs `paradev hosts remove`. The `paradev:*` checks only warn.

Under `t3.profile`, `fleet.json` names top-level T3 settings every machine
holds the same, such as tool servers. A setting not named there stays the
machine's own, and one edited on a machine since `sync` last wrote it
is reported as `T3_PROFILE_CONFLICT` by the check `t3:profile`, never
overwritten.

Accounts of one tool are not entitled to the same models. On each per-account
instance `sync` hides the models of T3's catalogue that its account does
not serve and lists the preferred default it serves first, so the instance
shows, and opens on, a model that works. Which catalogue models are hidden
there is the fleet's: one hidden by hand is shown again while its account
serves it. Until a sync, the check `t3:models` says what it would change
(`T3_MODELS_PENDING`). It reports as `T3_MODELS_MISMATCH` only what cannot
work: a custom model or a T3 default the proxy does not serve, an account that
serves none of its tool's preferred defaults, and a model in
`t3.requiredModels` that is missing.

Secrets are asked for by purpose (`proxy-client-key`,
`monitoring-account-password`, `monitoring-tunnel-token`,
`proxy-tunnel-token`); see [`src/secrets.ts`](src/secrets.ts).

`sync` records the configuration it applies in the fleet state, so a
run started outside your project uses the one last applied.
`state --export` prints it.

To run your own fork, publish it as your own package and name its repository
under `source`: the commit a package names must be reachable there.

## Bugs and feature requests

A defect in homelab, or something it cannot do yet, is raised as an
[issue](https://github.com/crvouga/homelab/issues). From your project that
is the only way to change homelab, for you and for the coding agents working
there. Do not patch the installed package, a checkout `sync` put on a
machine or a file it manages: the next install or `sync` replaces them.

The tool says so itself: `homelab --help` names the issue tracker, and the
agent contract (`homelab commands --json`, under `agent.support`) carries the
rule, what an issue should include and what it must leave out. Agents only
read it if your project sends them there, so put this in the `AGENTS.md` of
the project that holds your `fleet.json`:

```md
The fleet is managed with homelab (`npx homelab`, pinned in package.json).
Read `npx homelab commands --json` before using it. Never edit homelab
itself: not node_modules, not a clone, not what it installs on a machine. A
bug in `homelab` or a feature it lacks is a GitHub issue at
https://github.com/crvouga/homelab/issues; tell me what is blocked and link
it. Issues are public: no credentials, hostnames, accounts, domains or
fleet.json contents.
```

## Known limits

- Each worker's own login and renewal, and the proxy's backup and recovery,
  are implemented for the **`vault`** secrets provider only. With `env`, `file`
  or `sops` the fleet's three shared secrets are read, but those two features
  are not available yet.
- The bucket holds the fleet's own state. The CLI proxy keeps its separate
  encrypted backup (`vault` only), and the monitoring hub's database is not
  replicated: `sync` recreates its accounts and systems, but metric
  history is lost with the manager. See
  [what is not in the bucket yet](docs/state.md#what-is-not-in-the-bucket-yet).
- Caches and units on machines still use the historical `personal` prefix
  (`~/.local/share/personal/fleet`, `/etc/personal-fleet`, unit names). It
  works, and renaming it needs a migration.
- The CLI proxy's installed code is a Git worktree of the manager's copy of
  the source repository (`~/.local/share/personal/fleet/manager/source`).
  `sync` fetches that copy again when it is deleted, but the proxy then
  needs `homelab proxy install` once more.
- The manager is a Mac host. There is no container image of the manager.
- `converge --schedule enable --apply --yes` (unattended runs every 30
  minutes) is installed by that command on the manager, not yet by the
  manager's playbook, and its interval is not yet part of `fleet.json`.
  `converge --schedule status` lists its last runs, and `status` fails
  `manager:schedule` when it has not converged the fleet for two intervals.
- Not everything on a machine is pinned. [What is declared, and
  where](docs/declared.md) lists what is and what is not: most of a worker's
  own packages, the manager's applications and every login are outside it.
- The reference documents under `docs/` were written for the fleet this came
  from and are being revised.

## Repository layout

| Path         | What                                                                    |
| ------------ | ----------------------------------------------------------------------- |
| `src/`       | Inventory, orchestration, verification, the report; `src/cli` CLI       |
| `src/state/` | The fleet state database and its replication to the bucket              |
| `ansible/`   | Machine policy: `ubuntu/`, `macos/`, `monitoring/`                      |
| `agents/`    | Agent launchers T3 runs, and their registry                             |
| `cliproxy/`  | The CLIProxyAPI service: install, audit, backup, model health           |
| `bootstrap/` | Toolchain bootstrap and the manager and worker entry scripts            |
| `schema/`    | JSON schemas for `fleet.json`, the roster and command output; check IDs |
| `examples/`  | A complete example configuration                                        |
| `features/`  | What homelab does, as Gherkin features: the tests                       |
| `bin/`       | The entry point of the published package                                |

## Develop

Working on homelab itself is the only reason to clone it:

```sh
git clone https://github.com/crvouga/homelab.git && cd homelab
bash bootstrap/bootstrap.sh
bun install --frozen-lockfile
bun run check
./homelab check --local      # the CLI, from this checkout
```

Run from a checkout, `sync` converges the fleet to the checkout's `HEAD`
commit (never to uncommitted files). The checkout's `origin` must be the
repository `fleet.json` names under `source`, and a `HEAD` that is not on its
default branch needs `--allow-unmerged`. Every merge to `main` publishes a release;
see [releasing](docs/releasing.md).

What homelab does is specified in Gherkin, under
[`features/`](features/README.md): a `.feature` file states a rule in plain
words and the steps beside it check it. There are no other TypeScript tests.
`bun run check` runs formatting, typecheck, lint, every feature and the proxy
package's Python tests. Features run against `examples/fleet.json` and never
contact a real machine.

Checks run in three tiers ([`ci.yml`](.github/workflows/ci.yml),
[`nightly.yml`](.github/workflows/nightly.yml)):

| Tier         | When                                             | Goal       | What runs                                                                                                                                                                                                              |
| ------------ | ------------------------------------------------ | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pull request | A pull request, or a dispatch off `main`         | 5 minutes  | Format, typecheck, lint and the features the diff affects. Fleet state, workflows, playbooks, the manager, one fresh worker and the proxy run only when the diff reaches them. The monitoring agent does not run here. |
| Release      | A push to `main`, or a dispatch on `main`        | 10 minutes | The full feature suite, fleet state, workflows, playbooks, the manager on macOS, the monitoring agent, and a fresh worker of the newest Ubuntu on amd64 and arm64.                                                     |
| Nightly      | 07:17 UTC, or a dispatch of the Nightly workflow | 45 minutes | Every accepted Ubuntu release and architecture, both fresh-worker features, and the monitoring agent.                                                                                                                  |

The minutes are a goal. A job that runs past its goal is not cancelled, and
the run fails only when a job fails. A pull request aims at five minutes, a
release at ten and a night at forty-five.

A pull request that changes the bootstrap runs one fresh worker: the newest
Ubuntu, amd64, and the single-machine feature. The night runs the other
release, arm64 and the multi-machine feature. A job the diff does not affect
is skipped.

| Check                 | What it proves                                                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Check                 | Format, typecheck, lint, the features the diff affects, and the proxy package when it changes                                      |
| Fleet state           | The pinned Litestream replicates the fleet state to a directory and to an S3 API, and a second manager restores it                 |
| Fresh worker over SSH | A new Ubuntu machine with only an SSH server and sudo is bootstrapped by the production code over real SSH                         |
| Workflows             | The workflow files pass `actionlint`                                                                                               |
| Playbooks             | Every playbook passes `ansible-lint` (production profile) and `--syntax-check`, and every pinned package is in the pinned snapshot |
| Manager on macOS      | The macOS features, and the manager playbook converged, then re-run and checked with no change                                     |
| Monitoring agent      | The agent playbook applied on a machine running systemd, and the pinned T3 server's session limit                                  |

The ruleset of `main` requires one check, **Required checks**, which passes
when every job passed or was skipped, and fails when one failed. A job that
is added, renamed or split is required from the pull request that does it.
A failed job opens or updates one issue, `CI failure: <tier> / <job>`, and
the next green run of that same job and tier closes it. The publish workflow
still runs the Ubuntu VM and the tailnet test after the release tier; those
are not part of the ten-minute limit.

A pull request needs nobody attending
([`pull-requests.feature`](features/rules/pull-requests.feature)):

- A pull request from a branch of this repository is squash-merged as soon as
  **Required checks** passes ([`auto-merge.yml`](.github/workflows/auto-merge.yml)).
  A draft is left alone until it is marked ready; a fork's is left to a person.
- The merge is checked again on `main` and then released. A merge made with
  the workflow's own token starts no workflow, so
  [`catch-up.yml`](.github/workflows/catch-up.yml) starts CI on `main` when
  the newest commit there has no run (each time a pull request opens, and
  once a day), and that run starts the release when it passes.

Some scenarios need something a laptop may not have, and are skipped there:

```sh
HOMELAB_TEST_FRESH_BOX=1 bun test features/fresh-box     # Docker; tests the HEAD commit
mise install litestream
HOMELAB_TEST_S3=http://127.0.0.1:5000 bun test features/state
bun ansible/ubuntu/tests/run-vm.ts baseline   # Linux amd64 with KVM; the Ubuntu VM workflow
```

## License

MIT. See [LICENSE](LICENSE).

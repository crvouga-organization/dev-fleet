> This document was written for the fleet homelab was extracted from. Paths and
> commands were updated; some statements still describe that fleet and are being
> revised. The README is authoritative, and what a machine must offer to be a
> worker is listed only in [worker requirements](worker-requirements.md).

# Declarative remote workers

The public `homelab` CLI owns two primary operations:

```sh
homelab converge
homelab check --workers
```

The manager needs Node/npm, Git, SSH, Tailscale, and its own authorized T3 link.
What each worker must offer beforehand is listed once, in
[worker requirements](worker-requirements.md). Standard Ubuntu cloud-image users
already commonly have noninteractive sudo; otherwise establish the repository's
`authorize-sudo.sh` policy once during administrator enrollment. An image that
lets only root in (many rented servers) needs no hands either: when the
account `workers[].network.user` names cannot log in yet, or the SSH alias
logs in as root, `sync` creates that account once over the root login
(`ansible/ubuntu/worker-account.yml`: the key root was reached with and the
fleet's sudo rule) and continues as it. The developer toolchain never runs as
root, and the SSH policy turns root login off afterwards. Routine commands
never ask for or store an SSH/sudo password. Unknown host keys, a different device
identity, or missing privilege stop with a named action rather than bypassing trust.

Convergence binds one reviewed revision and worker membership. It transfers only
committed Git objects over SSH, bootstraps missing prerequisites, installs the
locked minimal tool profile and frozen dependencies, and applies Fleet's
Ansible policy. Developer checkouts and dirty work stay intact. A published CLI
uses its source provenance; a source project action explicitly selects checkout
HEAD. Private rosters contain connection paths and identities, not weaker policy.

| Requirement                        | Declaration and enforcement                                                                                                                                                                                                                                                   |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One consistent dependency set      | `mise.toml` worker profile, `mise.lock`, Ubuntu snapshot/package pins; exact versions and deployed input hashes checked live                                                                                                                                                  |
| Common service access              | Canonical required capabilities; declared GitHub account, worker's own renewable Vault session, authenticated singleton gateway catalog                                                                                                                                       |
| One gateway host                   | The CLI proxy runs only on the manager; ownership/audit/recovery code rejects any install on a worker and missing singleton state                                                                                                                                             |
| T3 connected and persistent        | One pinned T3 process: the desktop app in the auto-login session, or on a headless worker the pinned server as a lingering user unit; enabled/active with restart policy, bounded recovery timer, private endpoint, manager link matched to SSH-observed environment identity |
| No idle sleep and session survival | systemd sleep masks, logind policy, designated-user lingering; running policy and boot timing checked, not inferred from files alone                                                                                                                                          |
| Recovery after power loss          | Required boot services and recovery timers; on a physical worker the recognized restore-after-AC-loss firmware setting is set when the firmware exposes it, and read back afterwards (not applicable on a virtual machine); macOS `autorestart` where supported               |
| Always-on services                 | `Restart=always` drop-ins for ssh, tailscaled, docker (with `containers`) and beszel-agent (launchd `KeepAlive` on macOS); health requires the running unit to report that policy                                                                                             |
| Central dashboard                  | Pinned Beszel hub on the manager, every worker enrolled with its own token; health verifies hub reachability, registration, connection and fresh samples                                                                                                                      |
| No routine password prompts        | Verified BatchMode SSH, `sudo -n`, source-owned NOPASSWD policy; missing initial authorization is a failure                                                                                                                                                                   |
| Keep service authorization alive   | Native service credentials stay per-node; Vault self-renewal timer and GitHub recovery from authorized Vault credentials; expiring T3 links are reported before expiry                                                                                                        |

## Worker features

What a worker is built with beyond the base is declared in `fleet.json`:
fleet-wide under `worker.features`, or for one worker under its own
`features`. Each block may name a `preset` first; its own fields override
it. A fleet that names no feature gets what every worker had before features
existed.

| Feature      | Values                | Default   | What it decides                                                                                                                                    |
| ------------ | --------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `containers` | `true`, `false`       | `true`    | Docker: the Ubuntu packages, `docker.service`, the developer's `docker` group membership, the `docker-cli` tool and the Docker step of the disk GC |
| `session`    | `desktop`, `headless` | `desktop` | How T3 runs: the desktop app in an auto-login graphical session, or the pinned server as a lingering user service with no display manager          |
| `preset`     | `editing`             | none      | `editing`: no containers, a headless session and only the base tools (it adds no tool profile)                                                     |

What each feature installs is listed once, under `features` in
`ansible/ubuntu/policy.json`. A worker without it installs none of it, and its
checks (`worker:package:*`, `worker:service:docker`, `worker:docker-run`,
`tool:docker-cli`) report **not applicable** with the reason. Turning
`containers` off on an existing worker removes what homelab installed for it:
the packages (not purged: images and volumes under `/var/lib/docker` stay
until a person deletes them), the restart drop-in and the developer's group
membership. `fleet-sync --dry-run` lists what each worker will lose (`plan`,
under `removals`), and `worker:features` reports what the run removed and
fails with `WORKER_FEATURE_REMOVAL_INCOMPLETE` while any of it remains. A
headless worker installs no desktop-only package but removes none: a desktop
the machine came with may depend on them.

## The class of a machine

The probe records each worker's class before anything is installed
(`platform:machine-class`): **physical**, **virtual** (systemd-detect-virt
names a hypervisor) or unsupported (a container or WSL2, refused by
`platform:environment`). A virtual machine has no lid, no battery and no
firmware its guest can read, and its provider restarts it after a power loss,
so `worker:power-loss-recovery` and `ubuntu:lid-policy` report **not
applicable**, with the reason and the worker's optional `powerRecoveryNote`
(for example "provider restarts instances"). The sleep masks are still
checked: a guest can be suspended by its own idle policy. On a physical
machine nothing changes. A not-applicable check is counted apart, shown with
its reason in text and in `--json`, and never fails a run, not even with
`--strict`.

## Size

The minimum size of a worker for the editing workload is stated in
[worker requirements](worker-requirements.md), from `sizing.minimumWorker` in
`ansible/ubuntu/policy.json`. The probe measures it before anything is
installed and refuses a smaller machine with `WORKER_SIZE_BELOW_MINIMUM`
(`platform:worker-size`); the baseline asserts the same before it installs a
package.

The disk homelab itself installs is measured on every pull request: the
fresh-box CI job converges a stock Ubuntu image of each accepted release on
amd64 and arm64, measures what each part takes, and fails when a part
outgrows its budget in `sizing.footprintMiB`
(`features/fresh-box/fresh-box.feature`). Measured on Ubuntu 26.04:

| Part                                         | amd64        | arm64        | Budget   |
| -------------------------------------------- | ------------ | ------------ | -------- |
| Base tools with the agent CLIs, and `go`     | 5184 MiB     | 4830 MiB     | 6144 MiB |
| The fleet's checkouts (up to four revisions) | 189 MiB each | 189 MiB each | 1024 MiB |
| Tool profile `web` (its tools)               |              | 135 MiB      | 256 MiB  |
| Tool profile `rust`                          |              | 1562 MiB     | 2048 MiB |
| Tool profile `jvm`                           | 437 MiB      | 303 MiB      | 640 MiB  |

What is not measured there, and stays an estimate: Ubuntu Server itself
(about 3 to 5 GiB), the system packages of the baseline, the headless
Chromium the `web` profile installs as packages, the swap file (half of
memory), and the engine and images of `containers`. The minimum adds those
to the measured parts with room for the disk floors below.

The disk and memory lines of the worker policy scale with the machine: each
is a share of the root filesystem or of memory between a lower and an upper
bound (`sizing.thresholds`), with higher disk warning and cleanup caps for large build disks.
The warning starts below 15% free (capped at 256 GiB); cleanup pressure starts
below 20% free (capped at 512 GiB). Small workers intentionally reserve more
space too: a 40 GiB disk now warns below 6 GiB and cleans below 8 GiB.
Configured fleet-watch targets receive disk warnings before they become failures.

| Line                               | Share         | Lower    | Upper      |
| ---------------------------------- | ------------- | -------- | ---------- |
| Swap file (created only when none) | 50% of memory | 1024 MiB | 8192 MiB   |
| Free disk the baseline keeps       | 5% of disk    | 2048 MiB | 4096 MiB   |
| Disk guard floor                   | 3% of disk    | 1024 MiB | 3072 MiB   |
| Disk GC pressure line              | 20% of disk   | 4096 MiB | 524288 MiB |
| `worker:capacity:disk` warns under | 15% of disk   | 3072 MiB | 262144 MiB |
| `worker:capacity:disk` fails under | 2% of disk    | 1024 MiB | 2048 MiB   |

`worker:agent-sessions` reports how many agent sessions run and how many the
memory policy supports while each runs a build. The estimate deducts the
system and T3 reserves, then budgets 512 MiB per session and 4096 MiB per
build. Both T3 worker units set the Node old-space limit to the build budget.
That budget is an estimate, and a generous one: it reserves a build for every
session at once. So it decides the `AGENTS_OVER_CAPACITY` warning only where
nothing was measured. The kernel’s aggregate peak measures what sessions used at the same moment,
including sessions that have since ended. When available, this decides
whether memory usage exceeded the budget. Without it, a sum of individual
peaks above budget gives the separate `AGENT_PEAK_PROJECTION` advisory.
The number of sessions is a recommendation, not an admission limit: T3 Code starts a
session whenever it is asked for one and its administrator policy has no limit
on them, so nothing refuses the next session and the check says so. What is
always enforced is memory: each agent and the agents together are capped, and
the largest is stopped under sustained pressure.

What runs is counted from the scopes T3 Code starts its agents in, which is
not always one for each session:

| Scope                                           | Counted as                                                                 |
| ----------------------------------------------- | -------------------------------------------------------------------------- |
| `t3code-claude-*` and every other agent         | One agent session                                                          |
| `t3code-codex-*`, `t3code-opencode-*`           | One process that serves every session of that agent, however many they are |
| `t3code-terminal-*`, `t3code-preview-browser-*` | Not counted: a terminal a person opened and a preview browser are no agent |

Nothing on a worker says how many sessions a shared Codex or OpenCode process
serves, so the check names those processes as what they are ("6 agent
processes running: 4 agent sessions, and 2 that Codex or OpenCode serves all
its sessions from") and compares the number of processes with the
recommendation. A worker that runs many Codex or OpenCode sessions therefore
runs more sessions than the check counts.

The estimate cannot be right for every worker, so the check holds it against
the agents running now: the median and the largest of their memory peaks (the
kernel's `memory.peak` of each agent scope), how far the estimate is from that
median and how many sessions the worker would support at it.

### A limit on agent sessions

`agentSessionLimit` is the opt-in for a worker that refuses sessions above a
number you choose: fleet-wide under `worker`, or on one worker, which replaces
the fleet-wide one. It is a whole number from 1; without it nothing is
installed and nothing is refused.

```json
"worker": { "agentSessionLimit": 12 }
```

What it counts is the scopes T3 Code starts agents in, in the slice it owns:
one for each Claude session, one shared by all the threads of Codex or of
OpenCode, and one for a preview browser, which the kernel cannot tell from an
agent. Terminals, the service OpenCode's sessions share, and the scope T3
probes with when it starts, are in another slice and are never refused. So
the number that counts toward a limit can differ from the number of agents
the check reports running. A T3 that restarts resumes the sessions
it ran, and those count like any other.

Neither T3 Code nor systemd can count those scopes, so the kernel does. The
user unit `personal-fleet-agent-session-limit.service` of the worker's own
user manager writes `cgroup.max.descendants` on that slice, two scopes above
the declared limit, and looks again every two seconds because the slice
exists only while an agent runs. Two things then refuse:

| Started                  | Refused by                             | What T3 shows                                                                                              |
| ------------------------ | -------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Through a fleet launcher | The launcher, above the limit          | The thread failed, "exited with code 75 before it started"; `AGENT_SESSION_REFUSED` in T3's server log     |
| With no fleet launcher   | The kernel, two scopes above the limit | The thread failed, "exited with code 1 before it started"; `Failed to create cgroup` in the user's journal |

T3 Code reports only how a provider ended, so the launcher is the one place a
refusal can say why; the text T3 shows is its own. `worker:agent-sessions`
says when a worker is at its limit, and fails with
`AGENT_SESSION_LIMIT_INACTIVE` when a declared limit is not held.

Ending a session admits the next one. To lift the limit at once on a worker,
stop the unit (`systemctl --user stop personal-fleet-agent-session-limit.service`):
it puts the kernel's limit back to `max` as it ends. To remove it, delete
`agentSessionLimit` and run `sync`.
`features/monitoring/agent-session-limit.feature` proves each of these
against the pinned T3 server on a disposable machine.

Projects can serialize heavy builds across their worktrees by running them
under the same user-owned lock, for example
`flock "$XDG_RUNTIME_DIR/project-build.lock" npm run build`.

## Package pins and security updates

A pin in `ansible/ubuntu/policy.json` is a **minimum**, never a hold. Ubuntu
keeps installing security updates by itself, and a worker is not turned red by
one:

- The Ubuntu baseline installs a pinned package from the snapshot only when it
  is absent or older than its pin, and never downgrades
  (`ansible/ubuntu/tasks/install.yml`; every pinned package, `systemd-oomd`
  included, goes through it).
- What Ubuntu installs unattended is declared in
  `/etc/apt/apt.conf.d/52personal-fleet-unattended-upgrades`: security updates
  only, no automatic reboot, no removals.
- `worker:package:NAME` passes at the pin, **warns** with
  `PACKAGE_NEWER_THAN_PIN` above it, and fails with `PACKAGE_BELOW_PIN` below
  it or when the package is missing. A warning does not block convergence or
  readiness; it says the pin can be raised when the snapshot moves.
- Tailscale follows the same rule: a newer Tailscale is kept; an older one
  stops with `TAILSCALE_UPGRADE_PENDING`, because upgrading an active VPN can
  drop SSH. `fleet-sync --maintenance-reboot` upgrades it to the pin in a
  detached unit and waits for the worker to answer again.

A package run cut off by a power loss is finished by the next sync: the
baseline waits for the APT lock, runs `dpkg --configure -a` once (bounded to
ten minutes) and audits again; only a database still inconsistent stops with
`APT_STATE_BROKEN`. When the cut-off run left one of the bootstrap's own
packages unconfigured (an upgrade of `python3` or `git`, say), the bootstrap
makes the same repair before it installs what it lacks, whoever started the
run, waiting up to two minutes for a package process that holds the lock;
only a database still inconsistent stops it with `DPKG_INTERRUPTED`.

Health does not mutate configuration, renew tokens, log in, install software, or
make billable inference requests. It audits the immutable desired worker deployment,
not an unrelated developer branch. Every declared worker must be enrolled and
reachable, unless it is parked (`homelab park`): a parked worker
is listed as parked and never contacted. Extra service hosts are listed as outside scope. Required failures,
warnings and unverified checks prevent a ready result; explicitly non-required
checks remain visible without inventing a pass.

The desired fleet contract is stronger than today's live acceptance. A real
power-loss test cannot be proved by the firmware reporting the setting:
`sync` sets a recognized restore-after-AC-loss setting when the
firmware exposes one, and `worker:power-loss-recovery` reads it back.
Firmware that exposes no such setting stays unverified. A virtual machine's
provider restarts it. A
still-running headless `t3code.service` needs a deliberate migration to the
desktop app; convergence preserves active work instead of killing it. External providers can
revoke authorization; renewal is not a substitute for an initially granted,
renewable node identity. Required expired/missing credentials remain failures,
never interactive password prompts or successful receipts.

Cloud resources, Vault roles/policies and secret values remain exclusively owned
by the OpenTofu roots. Worker configuration belongs to Fleet's Ansible policy and
mise. Runtime logins/renewal do not provision cloud resources. Existing SSH keys,
T3 pairing data, provider identities and the gateway's encrypted recovery state
are never cloned from another node.

The normal manager apply flow reports configuration application separately
from readiness and advances the applied-revision receipt only after required
acceptance succeeds. Read the remaining release gates in [ubuntu-sync.md](ubuntu-sync.md)
before treating any release as complete fleet certification.

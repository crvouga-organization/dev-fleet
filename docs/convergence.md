# What converges a machine, and what is not Ansible yet

The goal is one convergence engine: Ansible, on every platform, with the CLI
as an orchestrator that validates the fleet configuration, runs playbooks,
reads their results and reports checks. Today three mechanisms change a
machine: the playbooks under `ansible/`, the bootstrap scripts, and some
TypeScript. This page lists every step that is not an Ansible task yet, each
with the reason it is not, so the list can only shrink.
`features/rules/convergence.feature` fails when a file that changes a machine
is missing from it.

## Ansible

| Playbook                                   | Converges                                                                          |
| ------------------------------------------ | ---------------------------------------------------------------------------------- |
| `ansible/ubuntu/baseline.yml`              | A worker's packages, Docker, services, power, user, SSH, disk                      |
| `ansible/ubuntu/native-ssh.yml`            | Enroll and verify native SSH in both directions                                    |
| `ansible/ubuntu/t3-mesh.yml`               | Replace or create one declared full-access T3 grant                                |
| `ansible/ubuntu/screen-sharing.yml`        | Configure GNOME desktop sharing and publish its per-worker credential              |
| `ansible/ubuntu/retire-screen-sharing.yml` | Retire managed sharing before changing the firewall                                |
| `ansible/ubuntu/tailscale.yml`             | Tailscale on a worker                                                              |
| `ansible/ubuntu/t3-desktop.yml`            | The T3 desktop app on a desktop worker                                             |
| `ansible/ubuntu/t3-headless.yml`           | The T3 server as a lingering user service on a headless worker                     |
| `ansible/ubuntu/t3-policy.yml`             | T3's administrator policy                                                          |
| `ansible/ubuntu/t3-route.yml`              | T3's private tailnet route                                                         |
| `ansible/ubuntu/recovery.yml`              | Recovery of a stopped T3 desktop app or server                                     |
| `ansible/ubuntu/worker-account.yml`        | The declared account on an image that lets only root in, from the manager          |
| `ansible/ubuntu/reboot.yml`                | One worker's first-converge or maintenance reboot, from the manager                |
| `ansible/ubuntu/tailscale-upgrade.yml`     | One worker's maintenance upgrade of Tailscale to its pin, from the manager         |
| `ansible/monitoring/agent.yml`             | The Beszel agent on a worker                                                       |
| `ansible/monitoring/agent-darwin.yml`      | The Beszel agent on the manager                                                    |
| `ansible/monitoring/hub-darwin.yml`        | The Beszel hub and its tunnel on the manager                                       |
| `ansible/monitoring/hub-route-darwin.yml`  | The hub's private tailnet route                                                    |
| `ansible/macos/manager.yml`                | The manager's power settings, network time and fleet-watch job, unattended         |
| `ansible/macos/t3-desktop.yml`             | The verified manager desktop, staged alongside earlier releases                    |
| `ansible/macos/t3-policy.yml`              | T3's administrator policy on the manager                                           |
| `ansible/macos/manager-privilege.yml`      | The one administrator grant: sudoers, job log rotation and the T3 policy           |
| `ansible/macos/worker-host-key.yml`        | A worker's pinned SSH host key in the manager's known_hosts                        |
| `ansible/macos/vault-renew.yml`            | The launch agent that renews the manager's own Vault session                       |
| `ansible/github/git.yml`                   | The Git identity and GitHub credentials of every node                              |
| `ansible/t3/provider-keys.yml`             | Install and retire local T3 client-key slots for managed Antigravity providers     |
| `ansible/agents/agents.yml`                | Each agent CLI's dedicated profile, rendered from `ansible/agents/templates/`      |
| `ansible/agents/receipts.yml`              | Advance revision evidence for unchanged, verified profiles in one run              |
| `ansible/agents/commands.yml`              | The link that makes a worker's agent commands the fleet's launchers (`agents/bin`) |

Every playbook passes `ansible-lint` in the production profile, every command
in it says when it changes something and runs, or is skipped, in a dry run
(`features/rules/playbooks.feature`). The Beszel agent playbook is proven on a
systemd machine to report no change on a second run and in `--check`, and to
report drift, and only that drift (`features/monitoring/agent-lifecycle.feature`).

The fresh-box scenarios exercise the production SSH bootstrap, including interrupted
package, checkout and toolchain phases. An unchanged second apply compares the
installed Bun, Node and gh files. In the bootstrap VM, a headless worker receives
a Git signing identity. The test changes its Git author, runs the production
bootstrap again, and compares the T3 process start, public signing key, SSH host
key, Bun binary and baseline files across repair and the following apply.
The desktop VM also exercises graphical login, listener handoff and recovery.

## Not Ansible yet

| Step                                                                                    | Where                                                                                       | Why it is not a task yet                                                                                                    |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Install Git, curl, CA certificates, Python and Ansible                                  | `bootstrap/fleet-remote-bootstrap.sh`                                                       | It must run before Ansible exists on the machine; it is the minimal bootstrap                                               |
| Create the worker account, its host key, the privilege rule and Tailscale on first boot | `bootstrap/worker-seed.yaml` (written by `fleet-node-seed`)                                 | cloud-init runs it before the manager can reach the machine; fleet-sync converges everything else with Ansible afterwards   |
| Install mise and the pinned toolchain                                                   | `bootstrap/bootstrap.sh`, `bootstrap/setup.ts`                                              | mise must exist before any tool does, and `mise install --locked` already converges from a lock                             |
| Install a worker's subset of tools                                                      | `bootstrap/worker-tools.ts`, `bootstrap/worker-features.ts`                                 | It chooses which locked tools `mise install` gets; moving it means a toolchain role                                         |
| Publish the global mise configuration                                                   | `bootstrap/global-config.ts`                                                                | Derived from `mise.toml` and the agent worktree roots on every run; a `toolchain` role with a template would replace it     |
| `PATH` lines in shell profiles                                                          | `bootstrap/shell-path.ts`                                                                   | Edits files a person owns, guarded by markers; a `blockinfile` task would replace it                                        |
| The `devfleet` launcher link                                                            | `bootstrap/install-launcher.sh`                                                             | Points at the fleet-owned checkout of the revision, known only during the run                                               |
| The T3 server archive                                                                   | `bootstrap/native-t3.ts`                                                                    | Installed with the toolchain, checked against the digest in `mise.toml`; a `t3` role would replace it                       |
| The AWS CLI on Windows                                                                  | `bootstrap/native-aws.ts`                                                                   | Windows is not a fleet role                                                                                                 |
| Docker Desktop on the manager                                                           | `bootstrap/docker-desktop.sh`                                                               | A person installs and approves it on macOS; dev-fleet only measures it                                                      |
| Desktop sharing endpoint measurement                                                    | `bootstrap/rdp-probe.py`                                                                    | A read-only RDP negotiation verifies the worker certificate without starting a desktop session                              |
| A worker's service credentials from Vault                                               | `bootstrap/worker-github.ts`, `bootstrap/worker-auth.ts`                                    | A login belongs to a machine and a person; it is read from a session, never declared                                        |
| The manager's own convergence: proxy, profiles, hub, agent                              | `src/cli/fleet-sync-manager.ts`                                                             | Orchestrates the manager playbooks and the proxy's own installer; the proxy is not a playbook yet (`docs/declared.md`)      |
| Scheduled runs                                                                          | `src/cli/fleet-sync-schedule.ts`, `src/platform/launchd.ts`, `src/platform/systemd-user.ts` | Writes a launchd job or systemd timer from TypeScript; listed in `docs/declared.md` as a schedule that should be a playbook |

Worker safety units are installed when fleet-sync reaches the Ubuntu baseline. Run fleet-sync for a worker whose last apply failed. Fleet status reports its last applied revision, recorded time and failed check when that evidence is available.

## Still to do

Roles with a common interface (`baseline`, `toolchain`, `agents`, `t3`,
`network`, `monitoring`, `recovery`, `manager`), an inventory generated from
the fleet configuration, and `site.yml`, `manager.yml` and `workers.yml` that
bring a fresh manager and worker to ready with no other mutating step. Each
row of the table above moves into one of those roles.

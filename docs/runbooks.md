# Runbooks

One entry for every failure code dev-fleet reports: as a check's summary or
the code that opens it, at the start of a refusal, in a bootstrap phase, in
what a script on a machine says, in an Ansible message or in the error of a
workflow a fleet's repository calls. A few are warnings or notes rather than
failures; their entries say so. Each family says what its codes
mean, how to confirm one, the fix (a command or a `fleet-sync` that applies
the playbook that owns it) and when to escalate. A code whose fix needs a
person (a login, an approval, a choice) is marked **needs a person**.
`features/rules/runbooks.feature` fails when a code in the source has no
entry here, or a `devfleet` command quoted in the documents does not exist.
It reads a code by where it stands, never by the word it ends with. The CLI
proxy documents the codes of its own commands in
[its README](../cliproxy/README.md); the ones fleet-sync reports are here.

There are 485 codes; 100 need a person.

## Bootstrap of a new or returning worker

- **Meaning:** The remote bootstrap (`bootstrap/fleet-remote-bootstrap.sh`) stopped before node convergence. It reports the phase and the code, never its output.
- **Confirm:** Run `devfleet fleet-sync --dry-run` and read the `bootstrap:*` check of the worker; `ssh WORKER` and look under `~/.local/share/personal/fleet`.
- **Fix:** Follow the remedy the check prints, then run `devfleet fleet-sync`. The bootstrap resumes where it stopped.
- **Escalate:** A platform or architecture code means the machine must be reinstalled with a release [the support matrix](support-matrix.md) lists, on a machine of its own.

- `BOOTSTRAP_CAPACITY_UNVERIFIED`: bootstrap capacity unverified.
- `BOOTSTRAP_DISK_CAPACITY_REQUIRED`: bootstrap disk capacity required.
- `CONFIGURATION_INSTALL_FAILED`: configuration install failed.
- `FLEET_APPROVED_BOOTSTRAP_UNAVAILABLE`: fleet approved bootstrap unavailable.
- `FLEET_STATE_PATH_UNSAFE`: fleet state path unsafe.
- `PLATFORM_UNSUPPORTED`: platform unsupported. **Needs a person.**
- `REMOTE_BOOTSTRAP_EVIDENCE_INVALID`: remote bootstrap evidence invalid.
- `REMOTE_BOOTSTRAP_EXIT_FAILED`: remote bootstrap exit failed.
- `ROOT_DEVELOPMENT_USER_REJECTED`: root development user rejected.
- `UBUNTU_ARCHITECTURE_UNSUPPORTED`: ubuntu architecture unsupported. **Needs a person.**
- `WORKER_ENVIRONMENT_UNSUPPORTED`: worker environment unsupported: a container or WSL2. **Needs a person.**
- `POWER_LOSS_RECOVERY_UNSET`: the firmware exposes a recognized restore-after-AC-loss setting and it is not set to power on. `devfleet fleet-sync` sets it; the firmware applies it at the next boot, which `worker:reboot` reports. A virtual machine is restarted by its provider and the check does not apply.
- `REMOTE_BOOTSTRAP_INCOMPLETE`: the remote bootstrap ended in the phase the check names without a failure of its own: a command of that phase failed, or the run was cut off. No success receipt advanced. Check that no other operation still holds the worker (`FLEET_REMOTE_LOCKED`), then run `devfleet fleet-sync`.

## Ubuntu packages

- **Meaning:** A package transaction could not run or the package database is inconsistent.
- **Confirm:** `ssh WORKER sudo dpkg --audit` and `sudo apt-get -o Debug::NoLocking=1 check`.
- **Fix:** Let any running package process finish (it is never killed), free disk under `/var`, then run `devfleet fleet-sync`.
- **Escalate:** An interrupted package run is finished by the next `devfleet fleet-sync`: the bootstrap and the baseline each run `dpkg --configure -a` once, bounded. APT_STATE_BROKEN and DPKG_INTERRUPTED mean that repair did not clear `dpkg --audit`: a person repairs the packages it names.

- `APT_DISK_FULL`: apt disk full.
- `APT_DNS_UNAVAILABLE`: apt dns unavailable.
- `APT_LOCK_CONTENDED`: apt lock contended.
- `APT_REPOSITORY_UNAVAILABLE`: apt repository unavailable.
- `APT_STATE_BROKEN`: apt state broken. **Needs a person.**
- `DPKG_INTERRUPTED`: dpkg interrupted. **Needs a person.**
- `DISK_TARGET_UNMET`: the collector finished above its disk-use target. Inspect protected data and available capacity.
- `APT_UPDATE_TIMEOUT`: the worker reached the update deadline while refreshing package indexes. Check archive connectivity and contention before retrying.
- `APT_INSTALL_TIMEOUT`: the worker reached the install deadline while fetching or configuring bootstrap packages. Inspect dpkg and retry fleet-sync.
- `APT_UPDATE_FAILED`: `apt-get update` for the bootstrap packages failed, and not for a reason that has a code of its own (a held lock, a full disk, DNS, the archive, an interrupted dpkg). On the worker run `sudo apt-get update` to see the error, correct it, then run `devfleet fleet-sync`. **Needs a person.**
- `APT_INSTALL_FAILED`: the same for installing the bootstrap packages: install them by hand on the worker to see the error, then run `devfleet fleet-sync`. **Needs a person.**

## The fleet-owned checkout

- **Meaning:** The checkout of the revision on the machine holds changes fleet-sync did not make, or its bundle changed in transit.
- **Confirm:** `ssh WORKER git -C ~/.local/share/personal/fleet/revisions/REVISION status`.
- **Fix:** Remove that revisions directory and run `devfleet fleet-sync`; it is a cache.
- **Escalate:** A digest mismatch that repeats points at the SSH route.

- `SOURCE_CACHE_CHANGED`: source cache changed.
- `SOURCE_CHECKOUT_CONFLICT`: source checkout conflict.
- `SOURCE_DIGEST_MISMATCH`: source digest mismatch.
- `SOURCE_STATUS_FAILED`: source status failed.

## The pinned toolchain

- **Meaning:** mise, the pinned tools, the global mise configuration or the frozen dependencies did not converge.
- **Confirm:** Run `bun bootstrap/doctor.ts --json --worker` in the checkout on the machine, or read the `tool:*` checks of `devfleet fleet-status`.
- **Fix:** Run `devfleet fleet-sync`; it resumes. TOOLCHAIN_CONFIG_CONFLICT means another tool owns `~/.config/mise/config.toml`: move it away. TOOLCHAIN_DOWNGRADE (a warning of `tool:mise`) means the machine runs a newer mise than the revision pins: the bootstrap kept it, because `min_version` is a minimum and a checkout with a newer pin needs it. Nothing is to do after a rollback or beside such a checkout; to install the older pinned mise on purpose, run `devfleet fleet-sync --allow-mise-downgrade`, which asks the bootstrap of every machine it converges for that (for a revision from before the flag reached the bootstrap, run `bash bootstrap/bootstrap.sh --allow-mise-downgrade` in the revision's checkout on that machine, with `--tools-only` on the manager, `--worker --node ID` on a worker).
- **Escalate:** A tool that fails to download from its pinned artifact needs a new pin in `mise.toml` and `mise.lock` (an issue).

- `LAUNCHER_INSTALLATION_FAILED`: launcher installation failed.
- `TOOLCHAIN_AWS_FAILED`: toolchain aws failed.
- `TOOLCHAIN_CONFIG_CONFLICT`: toolchain config conflict.
- `TOOLCHAIN_CONVERGENCE_FAILED`: toolchain convergence failed.
- `TOOLCHAIN_DOWNGRADE`: the machine runs a newer mise than the revision pins, and it was kept.
- `TOOLCHAIN_FROZEN_DEPENDENCIES_FAILED`: toolchain frozen dependencies failed.
- `TOOLCHAIN_MISE_FAILED`: toolchain mise failed.
- `TOOLCHAIN_PATH_CONFIGURATION_FAILED`: toolchain path configuration failed.
- `TOOLCHAIN_T3_FAILED`: toolchain t3 failed.

## The Ubuntu baseline and its services

- **Meaning:** The Ansible baseline (`ansible/ubuntu/baseline.yml`) did not apply, or what it declares is not what the machine runs.
- **Confirm:** Read the `worker:*` and `ubuntu:*` checks of `devfleet fleet-status --workers`; on the worker, `systemctl status SERVICE`.
- **Fix:** Run `devfleet fleet-sync`, which applies the baseline in full when its effect no longer verifies.
- **Escalate:** Ownership conflicts (sudoers, SSH, Docker from another distribution) need a person to migrate the other owner first.

- `DISK_FREE_BELOW_FLOOR`: disk free below floor.
- `DISK_FREE_UNREADABLE`: disk free unreadable.
- `DOCKER_OWNER_CONFLICT`: docker owner conflict. **Needs a person.**
- `MEMORY_RESERVE_MISSING`: memory reserve missing.
- `RESOURCE_CAPACITY_REQUIRED`: resource capacity required.
- `OOMD_INACTIVE`: systemd-oomd has stopped.
- `PRESSURE_GUARD_INACTIVE`: the pressure guard has stopped.
- `DISK_GUARD_INACTIVE`: the disk guard has stopped.
- `DISK_GC_TIMER_MISSING`: the disk GC timer is missing, stopped or disabled.
- `DISK_GC_RUN_STALE`: the disk GC failed or its timer has not fired for two hours.
- `DISK_GC_NOT_REPORTED`: the disk GC has left no report (`resourceSafety.diskGcReport` in `ansible/ubuntu/policy.json`) since fleet-sync installed it, so `ubuntu:disk-gc` is skipped. It reports after its next run, within the hour; one that never does fails `DISK_GC_RUN_STALE`.
- `PACKAGE_STORE_OTHER_FILESYSTEM`: a package store (`~/.local/share/pnpm/store`, `~/.bun/install/cache`) is on another filesystem than the agent worktrees (`~/.t3/worktrees`), so every install copies its packages instead of linking them, and the disk fills faster. `ubuntu:disk-gc` and `manager:disk-gc` warn. Put the store and the worktrees on one filesystem, or unset an override of `pnpm_config_store_dir` or `BUN_INSTALL_CACHE_DIR`. **Needs a person.**
- `SERVICE_NOT_ENABLED`: service not enabled.
- `SERVICE_NOT_INSTALLED`: service not installed.
- `SERVICE_NOT_RUNNING`: service not running.
- `SERVICE_RESTART_POLICY`: service restart policy.
- `SSH_UNMANAGED_CONFIG_CONFLICT`: ssh unmanaged config conflict.
- `SUDOERS_OWNERSHIP_CONFLICT`: sudoers ownership conflict. **Needs a person.**
- `SUDO_AUTHORIZATION_REQUIRED`: sudo authorization required. **Needs a person.**
- `SWAP_CAPACITY_REQUIRED`: swap capacity required.
- `ZRAM_PRIORITY_MISMATCH`: verify dev-zram0.swap is active with priority above disk swap and reapply fleet-sync.
- `ZRAM_RECLAIM_MISMATCH`: reapply fleet-sync to restore the VM reclaim settings.
- `SWAP_MISSING`: swap missing.
- `TMP_QUOTA_EXHAUSTED`: tmp quota exhausted.
- `UBUNTU_BASELINE_INCOMPLETE`: ubuntu baseline incomplete.
- `UBUNTU_BASELINE_MISMATCH`: ubuntu baseline mismatch. **Needs a person.**
- `UBUNTU_LINGER_REQUIRED`: ubuntu linger required.
- `UBUNTU_MAINTENANCE_REBOOT_PENDING`: ubuntu maintenance reboot pending.
- `UBUNTU_SESSION_POLICY_PENDING`: ubuntu session policy pending.
- `UBUNTU_SLEEP_POLICY_DRIFT`: ubuntu sleep policy drift.
- `WORKER_RECOVERY_SCRIPT_MISSING`: worker recovery script missing.
- `WORKER_RECOVERY_SETUP_FAILED`: worker recovery setup failed.
- `WORKER_NOT_CONVERGED`: the last recorded worker apply failed or its receipt differs from the approved revision. Follow the reported check and rerun the worker sync.
- `WORKER_RECOVERY_TIMER_INACTIVE`: worker recovery timer inactive.
- `CLOCK_DRIFTING`: the clock is further from the manager's than the warning offset of `clock` in `ansible/ubuntu/policy.json`. The check names the offset. Enable the time service as the remedy says before it becomes CLOCK_SKEWED.
- `CLOCK_NOT_SYNCHRONISED`: the machine is not synchronised to a time source; it fails when no time service is enabled at all. Run `devfleet fleet-sync`, which enables the time service the baseline declares.
- `CLOCK_SKEWED`: the clock is further from the manager's than the failing offset. TLS, token validation, apt signatures and Vault logins fail with errors that never mention time. Enable the time service as the remedy says, then run `devfleet fleet-sync`.
- `CLOCK_UNOBSERVED`: the clock synchronisation could not be read, so the check is skipped. Nothing is known to be wrong.
- `INODES_EXHAUSTED`: the worker's file system has almost no free inodes: every new file fails although bytes are free. The hourly disk collector removes idle dependency trees and worktrees under pressure; delete them by hand when it has not.
- `PACKAGE_BELOW_PIN`: a package is missing or older than the version `ansible/ubuntu/policy.json` pins. Run `devfleet fleet-sync`, which installs the pinned version.
- `PACKAGE_NEWER_THAN_PIN`: an unattended security update moved a package past its pin. It is kept: a warning, never undone. The pin is raised in dev-fleet when the snapshot moves.
- `REBOOT_PENDING`: installed updates apply only after a reboot; it fails once the reboot has waited longer than `rebootPendingFailDays`. Reboot the worker when no agent turn is running, then confirm it with `devfleet fleet-status --workers`.
- `WORKER_MANIFEST_DRIFT`: something was installed, removed or changed on the worker outside fleet-sync; the check lists the differences. Rebuild the worker with `devfleet fleet-node-replace`, or ask for the change to be declared in dev-fleet. **Needs a person.**
- `WORKER_RECOVERY_LAST_RUN_FAILED`: the last run of `personal-worker-recovery.service` did not succeed; the check names its result. On the worker, `systemctl --user status personal-worker-recovery.service` and `journalctl --user -u personal-worker-recovery.service`, then run `devfleet fleet-sync`.
- `SSH_CONFIG_REJECTED`: `sshd -t` refused the complete SSH configuration with the fragments fleet-sync wrote. The previous fragments were restored and sshd was not reloaded, so the worker serves SSH as before. On the worker `sudo sshd -t` names the line; it is usually another fragment under `/etc/ssh/sshd_config.d` that a person corrects before `devfleet fleet-sync` is run again. **Needs a person.**

On workers, automatically named `systemd-run --user` services and scopes
share the T3 agents' memory budget. Under sustained I/O or memory pressure
the pressure guard can stop an agent or a transient build, including a job
still running in `app.slice` from before the policy was applied.
Inspect `journalctl -u personal-fleet-pressure-guard --since yesterday` for
the scope, memory usage and pressure at each decision. During a stall,
connect with `ssh -t WORKER bash --noprofile --norc` and inspect
`memory.current` on the T3 agent scopes. To stop a confirmed runaway,
write `1` to that agent scope’s `cgroup.kill`.

## Worker size and features

- **Meaning:** The machine is smaller than the minimum worker (`sizing.minimumWorker` in `ansible/ubuntu/policy.json`), more agent sessions run than its memory policy supports, its declared `features` in `fleet.json` are not ones dev-fleet knows, or something dev-fleet installed for a feature that is now off is still there.
- **Confirm:** `devfleet fleet-sync --dry-run` shows the `platform:worker-size` check of each worker and, under the plan, what turning a feature off removes; `devfleet fleet-status --workers` shows `worker:features` and `worker:agent-sessions`.
- **Fix:** Resize a machine below the minimum, then run `devfleet fleet-sync`; nothing was installed on it. For a feature removal, run `devfleet fleet-sync` again. For too many sessions, finish some or move work to a larger worker; to have the worker refuse sessions above a number you choose, declare `agentSessionLimit` in `fleet.json`.
- **Escalate:** A package another package depends on stays installed until a person removes that one.

- `AGENTS_OVER_CAPACITY`: the kernel measured a simultaneous agent-slice peak above the worker’s memory budget, or an older probe supplied only a session count above its estimated capacity. Inspect current memory pressure before moving sessions.
- `AGENT_PEAK_PROJECTION`: individual peaks would exceed the budget if repeated together. The probe has no simultaneous measurement. Inspect the enclosing slice’s memory peak before changing capacity.
- `AGENT_SESSION_LIMIT_EXCEEDED`: the number of scopes exceeds the declared session limit. Inspect the counted scopes and finish excess sessions.
- `AGENT_SESSION_LIMIT_INACTIVE`: agent session limit inactive: `fleet.json` declares `agentSessionLimit` for the worker and the worker does not hold it, so it refuses no session. The summary says which: the user unit `personal-fleet-agent-session-limit.service` is not running, runs with another number, or the kernel holds another limit (`cgroup.max.descendants`) on the slice T3 starts agents in. Run `devfleet fleet-sync`; on the worker, `systemctl --user status personal-fleet-agent-session-limit.service` shows why the unit stopped.
- `AGENT_SESSION_REFUSED`: agent session refused: a fleet launcher was started above the worker's `agentSessionLimit` and ended with code 75 without starting its agent. T3 shows the thread as failed with "exited with code 75 before it started"; the line is in T3's server log (`journalctl --user -u t3code-desktop.service`, or `t3code-headless.service`). End a session that is no longer needed and send the message again, or raise `agentSessionLimit` and run `devfleet fleet-sync`. An agent T3 starts with no fleet launcher is refused by the kernel two scopes higher, with no message: T3 shows "exited with code 1 before it started" and the user journal says `Failed to create cgroup … Resource temporarily unavailable`. To lift the limit at once on the worker: `systemctl --user stop personal-fleet-agent-session-limit.service`; to remove it, delete `agentSessionLimit` and sync.
- `WORKER_FEATURES_INVALID`: worker features invalid: the session is neither desktop nor headless.
- `WORKER_FEATURE_REMOVAL_INCOMPLETE`: worker feature removal incomplete: a Docker package or the docker group membership is still there with containers off.
- `WORKER_SIZE_BELOW_MINIMUM`: worker size below minimum: less memory, disk or CPUs than the minimum worker. **Needs a person.**

## Containers on a worker

- **Meaning:** `worker:docker-run` could not start the pinned container or build a one-line image as the worker user.
- **Confirm:** On the worker, as that user: `docker run --rm --network none --pull never IMAGE true`, with IMAGE from `dockerSmokeTest` in `ansible/ubuntu/policy.json`.
- **Fix:** Run `devfleet fleet-sync`: it starts the engine, adds the user to the docker group and caches the image. A session started earlier keeps its old groups: restart it.
- **Escalate:** A cgroup or runtime failure that survives a reboot is an issue.

- `DOCKER_BUILD_FAILED`: docker build failed.
- `DOCKER_DAEMON_UNREACHABLE`: docker daemon unreachable.
- `DOCKER_DISK_FULL`: docker disk full.
- `DOCKER_RUN_FAILED`: docker run failed.
- `DOCKER_RUN_TIMEOUT`: docker run timeout.
- `DOCKER_SMOKE_IMAGE_MISSING`: docker smoke image missing.
- `DOCKER_SOCKET_ACCESS_DENIED`: docker socket access denied.

## Exposure of a worker

- **Meaning:** Something on the worker is reachable from outside the tailnet, or could be: the fleet firewall (`ansible/ubuntu/tasks/firewall.yml`) is not loaded or kept SSH open, a service listens beyond loopback and the tailnet (`worker:exposure`), or the manager reached a fleet port on the worker's public address (`worker:public-reachability`). The exposure policy is `exposure` in `fleet.json` (fleet-wide under `worker`, per worker beside `network`).
- **Confirm:** On the worker: `sudo nft list table inet personal_fleet`, `sudo ss -H -l -n -t -u -p` and `sudo sshd -T | grep -E 'passwordauthentication|permitrootlogin'`. From the manager: `devfleet fleet-status --workers`.
- **Fix:** Run `devfleet fleet-sync`. It closes SSH beyond the tailnet only when the manager's session arrives over the tailnet: point the worker's SSH alias at its tailnet name first. Bind a service to `127.0.0.1` or the tailnet address, or declare its port in `publicPorts`. A service that cannot bind one address, such as a remote desktop, is declared in `tailnetOnlyPorts` instead: that opens nothing, and the next `devfleet fleet-sync` loads the rule that holds the port to loopback and the tailnet.
- **Escalate:** A firewall the tailnet path could not verify (the previous rules are back) needs `tailscale status` on the worker; a public SSH port is opened on purpose only with `publicSsh`, by a person.

- `FIREWALL_RULES_REJECTED`: firewall rules rejected by `nft --check`; the previous rules stay loaded.
- `FIREWALL_TAILNET_UNVERIFIED`: the tailnet path did not answer a new probe after the rules loaded; the previous rules were restored.
- `FIREWALL_UNMANAGED_CONFLICT`: `/etc/personal-fleet/firewall.nft` exists without the fleet's marker. **Needs a person.**
- `SSH_HARDENING_OVERRIDDEN`: `sshd -T` still allows passwords or root login: an earlier fragment or a Match block wins. **Needs a person.**
- `WORKER_AGENT_LISTENER_UNRESTRICTED`: a process an agent started (in its `t3code-<agent>-<id>.scope`), such as a development server, listens beyond loopback and the tailnet outside the allow-list. It is no fleet service and fleet-sync does not change it; it warns or fails by `otherListeners`. Have the agent bind it to `127.0.0.1` or stop it, or declare its port in `publicPorts`; it ends with the agent session.
- `WORKER_EXPOSURE_UNOBSERVED`: the addresses, sockets or firewall could not be read with `sudo -n`.
- `WORKER_FIREWALL_INACTIVE`: the fleet firewall is not loaded.
- `WORKER_LISTENER_UNRESTRICTED`: a socket listens beyond loopback and the tailnet outside the allow-list; the summary names the port and the owning unit. A fleet service fails; another warns or fails by `otherListeners`. What an agent started is reported as `WORKER_AGENT_LISTENER_UNRESTRICTED` instead.
- `WORKER_PUBLIC_PORT_UNRESTRICTED`: the manager connected to SSH, T3 or the monitoring port on the worker's public address.
- `WORKER_PUBLIC_SSH_UNDECLARED`: SSH is still open beyond the tailnet without `publicSsh`, because no session over the tailnet proved the manager's path. **Needs a person.**
- `WORKER_TAILNET_ONLY_RULE_MISSING`: a service listens on a port of `tailnetOnlyPorts`, but the loaded table has no `tailnet-only` rule that drops that port; the summary names the port and the owning unit. Run `devfleet fleet-sync`.

## Headless browser on a worker

- **Meaning:** `worker:browser` could not launch the pinned headless Chromium of the web tool profile.
- **Confirm:** On the worker run the headless shell under `/opt/personal-fleet/browser/` with `--headless --no-sandbox --dump-dom about:blank`.
- **Fix:** Run `devfleet fleet-sync`, which installs the pinned libraries and build (`ansible/ubuntu/tasks/browser.yml`).
- **Escalate:** A missing library the policy does not list is an issue: the list needs it.

- `BROWSER_LAUNCH_FAILED`: browser launch failed.
- `BROWSER_LAUNCH_TIMEOUT`: browser launch timeout.
- `BROWSER_LIBRARY_MISSING`: browser library missing.
- `BROWSER_NOT_INSTALLED`: browser not installed.

## Git identity and pushing

- **Meaning:** Commits on the node would carry the wrong author, would not be signed although `git.signing` is declared, or git cannot authenticate to GitHub on its own.
- **Confirm:** On the node, from `/`: `git config --show-origin --get-all user.name` (both per-user files, `~/.gitconfig` winning), and `printf "protocol=https\nhost=github.com\n\n" | GIT_TERMINAL_PROMPT=0 git credential fill >/dev/null`.
- **Fix:** Declare the `git` block in `fleet.json` and run `devfleet fleet-sync` (`ansible/github/git.yml`). Remove lines in `~/.gitconfig` that override it: `user.name`, `user.email`, or a GitHub credential helper other than `gh auth git-credential` (the one `gh auth setup-git` writes may stay). Do this before declaring the block: an override fails `git:configuration`, which stops the rollout at the canary.
- **Escalate:** GIT_REMOTE_REFUSED means the fleet account lost access to the declared repository: a person grants it. GitHub shows signed commits as verified only once a person adds each node's `~/.ssh/dev-fleet-git-signing.pub` to the account as a signing key.

- `GIT_CONFIGURATION_INCOMPLETE`: git configuration incomplete.
- `GIT_CREDENTIAL_HELPER_MISSING`: git credential helper missing.
- `GIT_IDENTITY_MISMATCH`: git identity mismatch.
- `GIT_IDENTITY_MISSING`: git identity missing.
- `GIT_IDENTITY_OVERRIDDEN`: git identity overridden.
- `GIT_IDENTITY_UNDECLARED`: git identity undeclared.
- `GIT_REMOTE_REFUSED`: git remote refused. **Needs a person.**
- `GIT_REMOTE_UNREACHABLE`: git remote unreachable.
- `GIT_SIGNING_FAILED`: git signing failed: the node's own key is missing or cannot sign without a prompt.
- `GIT_SIGNING_MISSING`: git signing missing.
- `GIT_SIGNING_OVERRIDDEN`: git signing overridden.
- `GITHUB_GIT_CREDENTIAL_MISSING`: git does not take its GitHub credential from `gh`, so a push asks for a password or fails. Declare the `git` block and run `devfleet fleet-sync`; on a manager with a personal login, `gh auth setup-git`.

## GitHub sign-in

- **Meaning:** A node is not signed in to GitHub from the stored `github-token`, or the token belongs to another login. See [GitHub on every node](github.md).
- **Confirm:** The `worker:github-sync` and `github:*` checks of `devfleet fleet-status --workers`; on the node, `gh auth status`.
- **Fix:** Put a valid token for `worker.githubLogin` in the store as `github-token`, then run `devfleet fleet-sync` (a worker also retries every ten minutes).
- **Escalate:** A missing login or a token issued for another account needs a person to declare the login or issue a new token.

- `GITHUB_LOGIN_MISMATCH`: github login mismatch. **Needs a person.**
- `GITHUB_LOGIN_UNDECLARED`: github login undeclared. **Needs a person.**
- `GITHUB_SIGN_IN_FAILED`: github sign in failed.
- `GITHUB_TOKEN_MISSING`: github token missing.
- `GITHUB_TOKEN_REJECTED`: github token rejected.
- `GITHUB_UNREACHABLE`: github unreachable.
- `COPILOT_TOKEN_UNSUPPORTED`: the node's GitHub token is of a kind Copilot CLI refuses (a classic personal access token). Store a fine-grained token with the Copilot Requests permission as `github-token` and run `devfleet fleet-sync`. **Needs a person.**
- `GITHUB_ORG_MEMBERSHIP_MISSING`: the fleet login is not an active member of an organisation the fleet declares; the check names it. Someone who administers the organisation adds the login. **Needs a person.**
- `GITHUB_PERMISSION_MISSING`: the token lacks a declared scope or cannot push to a declared repository; the check names each. Issue a token with them, store it as `github-token` and run `devfleet fleet-sync`. **Needs a person.**
- `GITHUB_RATE_LIMIT_LOW`: little of the login's hourly request limit is left; the check names what remains and when it resets. Wait for the reset, or give every node its own credential (`github.credential` set to `per-node`).
- `GITHUB_SCOPES_NOT_OBSERVABLE`: the token reports no scopes (a fine-grained token), so the declared scopes cannot be compared; the declared repositories were checked instead. A warning with nothing to fix.
- `GITHUB_SSO_AUTHORIZATION_REQUIRED`: an organisation requires single sign-on and the token is not authorised for it; the check names the organisation. Authorise the token in the GitHub settings (Configure SSO). **Needs a person.**
- `GITHUB_TOKEN_EXPIRING`: the stored token expires within days; the check names the instant. Issue a new token, store it as `github-token` and run `devfleet fleet-sync` before then: every node adopts it while the old one still works. **Needs a person.**
- `GITHUB_TOKEN_EXPIRING_SOON`: the same, earlier: a warning that leaves time to issue the next token. **Needs a person.**
- `GITHUB_TOKEN_STALE`: the node still signs requests with a token the store no longer holds. Run `devfleet fleet-sync`; a worker also adopts the stored token within ten minutes.
- `GITHUB_WORKFLOW_CLEANUP_FAILED`: the workflow probe passed but left a branch or pull request on the sandbox repository; the check names them. Close the pull request and delete the branch.
- `GITHUB_WORKFLOW_FAILED`: the workflow probe (clone the sandbox, push a branch, open a draft pull request, read its checks, comment) stopped at the step the check names. Follow the remedy of that step.
- `GITHUB_NOT_SIGNED_IN`: `gh` on the node is signed in to no account (`github:principal`). A worker is signed in by `devfleet fleet-sync` with the stored `github-token`. A manager with a personal login (`github.manager`) is signed in by a person with `gh auth login`: dev-fleet never replaces a personal login.
- `GITHUB_SYNC_UNREPORTED`: the sign-in job of the node (`bootstrap/worker-github.ts`) ended without a result `github:sync` can read. Run `devfleet fleet-sync` again; when it repeats, run the job on the node as the remedy says to see its result line.

## Tailscale

- **Meaning:** A machine is not on the tailnet as the fleet declares it.
- **Confirm:** `tailscale status` on the machine and `devfleet fleet-discover`.
- **Fix:** Sign the machine in (`sudo tailscale up` on a worker, the app on the manager), then run `devfleet fleet-sync`.
- **Escalate:** Logins and device approvals need a person.

- `TAILSCALE_DEVICE_REPLACED`: tailscale device replaced. **Needs a person.**
- `TAILSCALE_ENROLLMENT_REQUIRED`: tailscale enrollment required. **Needs a person.**
- `TAILSCALE_IDENTITY_CONFLICT`: tailscale identity conflict. **Needs a person.**
- `TAILSCALE_INTERACTIVE_AUTHORIZATION_REQUIRED`: tailscale interactive authorization required. **Needs a person.**
- `TAILSCALE_KEY_EXPIRY_UNOBSERVED`: tailscale key expiry unobserved.
- `TAILSCALE_LOGIN_REQUIRED`: tailscale login required. **Needs a person.**
- `TAILSCALE_NODE_MISSING`: tailscale node missing.
- `TAILSCALE_NODE_OFFLINE`: tailscale node offline.
- `TAILSCALE_SETUP_OR_LOGIN_REQUIRED`: the Tailscale play stopped on no code of its own and the worker is not logged in to the tailnet. Declare `tailnet` in `fleet.json` so `devfleet fleet-sync` enrols it with a single-use key, or sign it in (`sudo tailscale up`). **Needs a person.**
- `TAILSCALE_CONFIGURATION_INCOMPLETE`: the Tailscale play stopped on no code of its own while the worker is logged in and running: a package source or the daemon failed. Run `devfleet fleet-sync` again; when it repeats, apply `ansible/ubuntu/tailscale.yml` of the approved revision on the worker to see the task that stops.
- `TAILSCALE_SOURCE_OWNER_CONFLICT`: tailscale source owner conflict. **Needs a person.**
- `TAILSCALE_UPGRADE_PENDING`: Tailscale on the worker is older than its pin, and a converge never upgrades an active VPN because a restart of tailscaled can drop the SSH session. Run `devfleet fleet-sync --maintenance-reboot`: it upgrades Tailscale to the pin in a detached unit on the worker (`ansible/ubuntu/tailscale-upgrade.yml`), waits for the worker to answer again and converges it once more. **Needs a person.**
- `TAILSCALE_KEY_EXPIRES_SOON`: the node key of the machine expires in the days the check names, and the machine leaves the tailnet when it does. Disable key expiry for a worker in the Tailscale admin console or tag it; renew the manager's with `tailscale up --force-reauth`. **Needs a person.**
- `TAILSCALE_KEY_EXPIRED`: the node key of the machine has expired and the machine has left the tailnet. Renew the manager's with `tailscale up --force-reauth`; re-join a worker as [Tailscale key expiry](operations.md#tailscale-key-expiry) describes, then disable key expiry for it or tag it. **Needs a person.**

## A new worker with no hands on it

- **Meaning:** A machine created without a person (from a pipeline or infrastructure-as-code) could not be enrolled, joined to the tailnet, given its account or brought to ready in one run: its first boot is still running or failed, the tailnet control plane refused a key, the image lets only root in and the account could not be created, or its first-converge or maintenance reboot did not happen.
- **Confirm:** The `bootstrap:first-boot`, `tailscale:enrolment-key`, `worker:account` and `worker:reboot` checks of the report `devfleet fleet-sync --json` prints, or the `tailscale:device` check of `fleet-node-replace` and `fleet-node-retire` and the `tailscale:leftover` check of `devfleet fleet-status`, which ask the same control plane; on the worker, `cloud-init status --long`.
- **Fix:** FIRST_BOOT_PENDING and WORKER_REBOOT_BUSY clear on their own: run `devfleet fleet-sync` again later. A TAILNET code names what to fix in `tailnet` of `fleet.json` or in the secret `tailnet-admin`; then run `devfleet fleet-sync`.
- **Escalate:** A first boot that failed means the image or its user data is wrong: recreate the machine. A root login that cannot create the declared account needs a person on the machine (`useradd --create-home --shell /bin/bash --groups sudo USER`).

- `FIRST_BOOT_FAILED`: first boot failed: cloud-init ended in an error. **Needs a person.**
- `FIRST_BOOT_PENDING`: first boot pending: cloud-init still runs; retryable.
- `TAILNET_ADMIN_REQUIRED`: tailnet admin required: fleet.json declares tailnet without the secret. **Needs a person.**
- `TAILNET_CONTROL_DENIED`: tailnet control denied the tailnet-admin credential. **Needs a person.**
- `TAILNET_CONTROL_REJECTED`: tailnet control rejected the request (tag or user). **Needs a person.**
- `TAILNET_CONTROL_RESPONSE_INVALID`: tailnet control response invalid.
- `TAILNET_CONTROL_UNAVAILABLE`: tailnet control unavailable.
- `TAILNET_KEY_DELIVERY_FAILED`: tailnet key delivery failed.
- `TAILNET_KEY_INVALID`: tailnet key invalid.
- `WORKER_ACCOUNT_CREATION_FAILED`: worker account creation failed. **Needs a person.**
- `WORKER_ACCOUNT_ROOT_REQUIRED`: worker account root required. **Needs a person.**
- `WORKER_ACCOUNT_UNDECLARED`: worker account undeclared in workers[].network.user. **Needs a person.**
- `WORKER_REBOOT_BUSY`: worker reboot busy: an agent turn runs.
- `WORKER_REBOOT_FAILED`: worker reboot failed.
- `WORKER_TAILSCALE_UPGRADE_FAILED`: the Tailscale upgrade of a maintenance run did not complete, or the worker did not answer again within 10 minutes; the workers after it wait. Read `journalctl -u devfleet-tailscale-upgrade` on the worker, then run `devfleet fleet-sync --maintenance-reboot` again.

## T3 Code

- **Meaning:** The native T3 server or desktop app, its policy, its private route or its providers did not converge or verify.
- **Confirm:** `devfleet t3-status` and the `t3:*` checks of `devfleet fleet-status`.
- **Fix:** Run `devfleet fleet-sync`, then `devfleet t3-apply` for providers. A MIGRATION or MAINTENANCE code names a one-time step in its remedy.
- **Escalate:** Set `t3.pairOnEnrollment` to true in fleet.json to authorize first pairing during sync for enrolled workers. When omitted, interactive sync asks once for the worker and carries out the approved pairing. False keeps first pairing in T3 Settings (Connections). Relinking a previously recorded peer still requires an explicit replacement or manual pairing. A replaced worker is paired by `devfleet fleet-node-replace` or the next `devfleet fleet-sync` (`t3:link`).

- `MANAGER_T3_LINK_UNVERIFIED`: manager t3 link unverified.
- `T3_BASELINE_PREREQUISITES_REQUIRED`: t3 baseline prerequisites required.
- `T3_CACHE_DRIFT`: t3 cache drift.
- `T3_CHECKSUM_MISMATCH`: t3 checksum mismatch.
- `T3_DESKTOP_INSTALL_FAILED`: t3 desktop install failed.
- `T3_DESKTOP_HANDOFF_PENDING`: a desktop launched in the graphical session owns the listener. The timer checks for idle turns before handing it over to the managed service.
- `T3_HANDOFF`: the recovery log records the orderly stop of the idle application scope.
- `T3_LISTENER_OWNER_UNKNOWN`: inspect the listener on port 3773 and its user unit. Resolve the conflicting process before retrying. **Needs a person.**
- `T3_RECOVERY_IN_PROGRESS`: another recovery holds the lock. The next timer tick remeasures the service.
- `T3_DESKTOP_STOPPED`: t3 desktop stopped.
- `T3_DOWNLOAD_UNAVAILABLE`: t3 download unavailable.
- `T3_ENVIRONMENT_IDENTITY_CHANGED`: t3 environment identity changed.
- `T3_EXECUTABLE_FAILED`: t3 executable failed.
- `T3_EXECUTABLE_OWNER_CONFLICT`: t3 executable owner conflict. **Needs a person.**
- `T3_EXTRACTION_FAILED`: t3 extraction failed.
- `T3_INSTALLATION_DRIFT`: t3 installation drift.
- `T3_MANAGER_ENDPOINT_REJECTED`: t3 manager endpoint rejected.
- `T3_MANAGER_ENDPOINT_UNREACHABLE`: t3 manager endpoint unreachable.
- `T3_MANAGER_IDENTITY_UNVERIFIED`: t3 manager identity unverified.
- `T3_MANAGER_ORIGIN_UNRESTRICTED`: t3 manager origin unrestricted.
- `T3_MANAGER_ORIGIN_UNVERIFIED`: t3 manager origin unverified.
- `T3_MODELS_MISMATCH`: t3 models mismatch.
- `T3_MODELS_PENDING`: t3 models pending.
- `T3_MODELS_UNVERIFIED`: t3 models unverified.
- `T3_POLICY_OWNER_CONFLICT`: t3 policy owner conflict. **Needs a person.**
- `T3_POLICY_RESTART_FAILED`: t3 policy restart failed.
- `T3_POLICY_RESTART_PENDING`: the running T3 has not loaded the staged policy and its restart waits for agent turns to end; the remedy says how long it has waited and when its deadline falls. See `T3_RESTART_PENDING`.
- `T3_POLICY_STAGE_FAILED`: t3 policy stage failed.
- `T3_PRIVATE_IDENTITY_REQUIRED`: t3 private identity required.
- `T3_PRIVATE_ROUTE_CONFLICT`: t3 private route conflict.
- `T3_PRIVATE_ROUTE_REQUIRED`: t3 private route required.
- `T3_PRIVATE_ROUTE_UNVERIFIED`: t3 private route unverified.
- `T3_CLIENT_SETTINGS_UNVERIFIED`: check the manager’s T3 client-settings.json, fleet state availability and the worker desktop service, then rerun fleet-sync. A pending desktop restart is retried.
- `T3_DESKTOP_ACTIVATION_FAILED`: open the verified manager bundle named in the remedy and rerun fleet-sync.
- `T3_CUSTOMIZATIONS_CONFLICT`: inspect the ownership marker in the manager’s T3 userdata directory. Move an unrelated marker aside before recovering the saved snapshot.
- `T3_CUSTOMIZATIONS_INVALID`: check that keybindings are a JSON array, theme files are regular files listed by the pinned T3 CLI, and the encoded customization snapshot fits the 1 MiB fleet state document limit.
- `T3_CLIENT_SETTINGS_INVALID`: repair the manager’s client-settings.json so its settings are a JSON object.
- `T3_CLIENT_SETTINGS_TOO_LARGE`: the desktop preferences exceed the fleet state's 1 MiB document limit. Reduce the document on the manager and rerun fleet-sync.
- `T3_PROFILE_CONFLICT`: t3 profile conflict.
- `T3_PROFILE_PENDING`: t3 profile pending.
- `T3_PROFILE_RECORD_INVALID`: t3 profile record invalid.
- `T3_PROFILE_UNVERIFIED`: t3 profile unverified.
- `T3_PROVIDERS_PENDING`: t3 providers pending.
- `T3_RECONCILIATION_UNAVAILABLE`: a local reconciliation precondition failed. Follow the stage-specific remedy to inspect the receipt, installed definition or T3 settings and ownership record locally. Restore a valid backup or correct permissions, then retry `devfleet t3-apply --dry-run`. Never share raw file contents.
- `T3_ACCOUNT_ROSTER_UNAVAILABLE`: the proxy account roster could not be read. Run `devfleet fleet-accounts` on the affected machine to verify proxy access and the proxy-client-key secret, then retry `devfleet t3-apply --dry-run`. Existing providers are preserved. If access still fails, report this code without credentials.
- `T3_QUOTA_COVERAGE_MISSING`: the manager could not match a hub quota reading to each declared Antigravity account. Check its T3 usage-limit source and the account on the proxy.
- `T3_CLI_MISSING`: the provider check could not start the T3 CLI from PATH or its user installation. Restore the executable and rerun fleet-sync to verify the account sessions.
- `T3_ANTIGRAVITY_SESSION_UNVERIFIED`: T3 could not open an authenticated ACP session for the reported account positions. Check that T3 is running on this machine, refresh those instances in Settings > Providers, and compare their proxy account session checks before rerunning fleet-sync.
- `T3_PROVIDERS_UNVERIFIED`: provider reconciliation stopped before it could report a plan. The remedy is the authored cause (a stale plan, a held lock, or the credential playbook). An unexpected error stays out of the report, because it can carry a secret. Run `devfleet t3-apply --dry-run` on the machine.
- `T3_PROVIDER_CONFLICT`: t3 provider conflict.
- `T3_PROVIDER_NAMES_PENDING`: t3 provider names pending.
- `T3_PROVIDER_NAMES_UNVERIFIED`: t3 provider names unverified.
- `T3_RENDERER_LIMIT_UNVERIFIED`: check the delegated renderer cgroup after an idle desktop restart and recovery timer tick.
- `T3_RENDERERS_HIGH`: the desktop renderers exceed their memory budget. Reload the app when idle.
- `T3_PROTECTION_ESCAPED`: the T3 listener lacks its CPU, I/O or memory reserve; the summary names which (`cpu`, `io`, `memory`). Run fleet-sync: it declares the reserve for the unit T3 serves from and reloads the user manager, which applies it to the running T3 without a restart. `io` alone, while the user manager does not hand the io controller down (measured in its `cgroup.subtree_control`; its `cgroup.controllers` lists io as soon as the declaration is loaded), is not T3 leaving its unit and only warns: fleet-sync declares the controller, and the user manager takes it on its next start, so reboot the worker while it runs no agent turn (`devfleet fleet-sync --maintenance-reboot`, which reboots for it as for pending updates); restarting T3 does not change it.
- `T3_PROTECTION_UNOBSERVED`: no process of the worker user listens on the T3 port, so there is no reserve to measure: T3 is stopped or restarting. See `worker:t3-recovery` and `worker:t3-health`.
- `T3_RESTART_PENDING`: a restart of the worker's T3 (a new release, a staged policy, a return to loopback) waits for its agent turns to end. The remedy says how long it has waited and when its deadline falls: `personal-worker-recovery` applies it at the first check with no turn running, and `t3RestartMaxDeferralHours` after it was first deferred although turns run, which ends them. A failure means the deadline passed and the timer did not apply it: check `worker:service-recovery` and run `devfleet fleet-sync`. To restart at once, run `devfleet fleet-sync --restart-busy`.
- `T3_SERVER_INSTALL_FAILED`: t3 server install failed: the pinned server of a headless worker is missing from the toolchain, or `t3-headless.yml` did not apply.
- `T3_SERVER_STOPPED`: t3 server stopped: the lingering `t3code-headless.service` of a headless worker is not running.
- `T3_SETTINGS_BUSY`: t3 settings busy.
- `T3_VERSION_UNKNOWN`: a warning of `t3:version`: T3 on the machine the check names has not recorded the version it runs, so it cannot be compared with the pin. Start T3 there once, then run `devfleet fleet-sync`.
- `T3_VERSION_SKEW`: a warning of `t3:version`: T3 on the machine the check names runs another release than the fleet pins; the remedy names both. `devfleet fleet-sync` installs the pinned release on a worker and restarts T3. On the manager, fleet-sync switches a running desktop to the verified bundle.
- `T3_UPDATES_UNMANAGED`: a warning of `t3:updates`: the administrator policy of T3 on the manager does not turn its own updater off, so T3 may update itself away from the pinned release. Stage the fleet's policy once, as an administrator, with the command the remedy prints. **Needs a person.**
- `T3_RUNNING_VERSION_UNKNOWN`: `t3:running-version` could not read the version of the running server from its local API, or the release installed on the worker. Read `worker:t3-health`, then run `devfleet fleet-sync`, which reinstalls the pinned T3.
- `T3_RUNNING_VERSION_MISMATCH`: logged by `personal-worker-recovery` on the worker: T3 was restarted once for the installed release and still reports another version. It is not restarted again for that release and the run fails (`WORKER_RECOVERY_LAST_RUN_FAILED`). Run `devfleet fleet-sync`, which reinstalls the pinned T3.
- `T3_LEGACY_SERVER_RUNNING`: logged by `personal-worker-recovery`: the former server unit `t3code.service` is active or enabled and could not be stopped and disabled, so the run fails before it looks at T3. On the worker read `systemctl --user status t3code.service` and disable the unit by hand: one T3 runs per worker. **Needs a person.**
- `T3_NO_GRAPHICAL_SESSION`: logged by `personal-worker-recovery` on a desktop worker with a count: no graphical session is running, so the desktop app cannot run and the run fails. After three checks in a row the display manager is restarted so that auto-login starts a session, three times at most; after that the log says a person must log in at the worker.
- `T3_RESTART_DEADLINE`: not a failure. `personal-worker-recovery` logs it when a restart of T3 has waited `t3RestartMaxDeferralHours` (`ansible/ubuntu/policy.json`) and is applied although agent turns run: they end. `worker:t3-deadline-restarts` counts these of the last 24 hours as a warning. Nothing is left to repair: send the threads whose turn ended their next message.
- `T3_IDLE_UNKNOWN`: not a failure of its own. The idle check of `personal-worker-recovery` could not read the runs T3 records in its state database, and what it cannot read counts as busy: a pending restart keeps waiting (`T3_RESTART_PENDING`) until its deadline. Read `worker:t3-health` when it repeats.

## super.engineering

- **Meaning:** A fleet that lists `super` under `ides` runs super.engineering on the manager with every worker as one of its remote SSH workspaces. The app did not answer, or a worker is not ready to be one of its workspaces. These are warnings: they never fail a sync.
- **Confirm:** The `super:*` checks of `devfleet fleet-sync`. On the manager, `~/.super.engineering/bin/se status --json` and `~/.super.engineering/bin/se workspace list --json`; for a worker, `ssh -o BatchMode=yes ALIAS 'command -v git flock claude'` with the alias `fleet.json` names.
- **Fix:** Follow the remedy of the check, then run `devfleet fleet-sync`: it creates the workspace of every worker that has none.
- **Escalate:** When the app runs, remote workspaces are on, the worker answers that SSH command and the workspace is still not created.

- `SUPER_NOT_INSTALLED`: a warning of `super:app` or `super:workspace`: the app's CLI (`~/.super.engineering/bin/se`) is not on the manager. dev-fleet does not install the app: install it from <https://super.engineering/download>, start it once, then run `devfleet fleet-sync`. **Needs a person.**
- `SUPER_NOT_RUNNING`: a warning of `super:app` or `super:workspace`: the CLI is there and no running app answers it, as during a scheduled sync on a manager nobody is logged in to. Start super.engineering on the manager; the next `devfleet fleet-sync` creates the workspaces that are missing.
- `SUPER_REMOTE_WORKSPACES_OFF`: a warning of `super:workspace`: the app refused to create a remote workspace because the feature is off. In the app open Settings → Experimental and enable Remote workspaces, then run `devfleet fleet-sync`. **Needs a person.**
- `SUPER_REFUSED`: a warning of `super:app` or `super:workspace`: the app answered with an error dev-fleet does not know, or with something that is not its JSON; the remedy names the app's error code and nothing else of what it said. Update the app and start it again, then run `devfleet fleet-sync`; when it repeats, raise an issue with that code.
- `SUPER_SSH_UNREACHABLE`: a warning of `super:ssh`: the app connects with the manager's own SSH configuration, never with the options `fleet-sync` uses, and that plain `ssh` does not reach the worker without a prompt. A worker `fleet.json` declares without an `ssh` alias is the usual cause: its host key is pinned in the fleet state, which the operator's SSH does not read. Add an alias to `~/.ssh/config` on the manager, accept the host key once, name the alias as the worker's `ssh`, then run `devfleet fleet-sync`. No workspace is created until then. **Needs a person.**
- `SUPER_HOST_INCOMPLETE`: a warning of `super:ssh`: an SSH session without a terminal finds no `git` or no `flock` on the worker; the remedy names which. The app's helper cannot be installed without them. Run `devfleet fleet-sync --node ID`: the baseline installs both.
- `SUPER_AGENTS_NOT_FOUND`: a warning of `super:ssh`: an SSH session without a terminal finds none of the fleet's coding agents on the worker's `PATH`, so the app can start no agent there. Run `devfleet fleet-sync --node ID`, which installs the pinned agents and puts their shims on that session's `PATH`; confirm with the SSH command above.
- `SUPER_AGENTS_NOT_PROXIED`: a warning of `super:ssh`: on the worker an SSH session without a terminal starts the agents the remedy names as the plain pinned CLI, with a sign-in of its own or none, and not as the fleet's launcher through the CLI proxy. The worker has not been converged since its agent commands became launchers, or its shell profile no longer puts `~/.local/share/personal/fleet/agent-commands` first. Run `devfleet fleet-sync --node ID`; confirm with `ssh ALIAS 'command -v claude'`, which names that directory.

## Monitoring (Beszel)

- **Meaning:** The hub on the manager, an agent on a machine, an enrollment or the hub backups do not match what the fleet declares.
- **Confirm:** The `beszel:*` checks of `devfleet fleet-status --workers`; on the manager `docker compose ls` and the hub at `/_/`.
- **Fix:** Run `devfleet fleet-sync`, which converges the hub, its accounts, its backups and every agent. Hub data is never deleted.
- **Escalate:** BESZEL_HUB_UPGRADE_PENDING needs a verified backup and a planned upgrade by a person.

- `BESZEL_ACCOUNT_INVALID`: beszel account invalid.
- `BESZEL_ACCOUNT_REQUIRED`: beszel account required. **Needs a person.**
- `BESZEL_AGENT_CONNECTION_PENDING`: beszel agent connection pending.
- `BESZEL_AGENT_DISCONNECTED`: beszel agent disconnected.
- `BESZEL_AGENT_KEY_REJECTED`: beszel agent key rejected.
- `BESZEL_AGENT_LOG_UNAVAILABLE`: beszel agent log unavailable.
- `BESZEL_AGENT_TOKEN_REJECTED`: beszel agent token rejected.
- `BESZEL_API_UNAVAILABLE`: beszel api unavailable.
- `BESZEL_API_UNVERIFIED`: beszel api unverified.
- `BESZEL_AUTH_REQUIRED`: beszel auth required.
- `BESZEL_BACKUP_CONVERGENCE_FAILED`: beszel backup convergence failed.
- `BESZEL_BACKUP_NOT_CONVERGED`: beszel backup not converged.
- `BESZEL_BACKUP_OFFHOST_REQUIRED`: beszel backup offhost required.
- `BESZEL_BACKUP_STALE`: beszel backup stale.
- `BESZEL_BACKUP_UNSCHEDULED`: beszel backup unscheduled.
- `BESZEL_BACKUP_UNVERIFIED`: beszel backup unverified.
- `BESZEL_CREDENTIALS_REQUIRED`: beszel credentials required. **Needs a person.**
- `BESZEL_DISK_FULL`: beszel disk full.
- `BESZEL_DISK_UNVERIFIED`: beszel disk unverified.
- `BESZEL_DOCKER_DESKTOP_REQUIRED`: beszel docker desktop required.
- `BESZEL_ENROLLMENT_INCOMPLETE`: beszel enrollment incomplete.
- `BESZEL_HOST_CONFLICT`: beszel host conflict.
- `BESZEL_HUB_INSTALLATION_INCOMPLETE`: beszel hub installation incomplete.
- `BESZEL_HUB_MISMATCH`: beszel hub mismatch.
- `BESZEL_HUB_SELECTION_REQUIRED`: beszel hub selection required.
- `BESZEL_HUB_UNHEALTHY`: beszel hub unhealthy.
- `BESZEL_HUB_UNREACHABLE`: beszel hub unreachable.
- `BESZEL_AGENT_VERSION_PENDING`: the hub has yet to observe an agent running the target release. Run fleet-sync and check its next sample.
- `BESZEL_HUB_UPGRADE_PENDING`: beszel hub upgrade pending. **Needs a person.**
- `BESZEL_INPUT_INVALID`: beszel input invalid.
- `BESZEL_INPUT_LIMIT`: beszel input limit.
- `BESZEL_INSTALLATION_INCOMPLETE`: beszel installation incomplete.
- `BESZEL_LEGACY_DAEMON`: beszel legacy daemon.
- `BESZEL_METRICS_STALE`: beszel metrics stale.
- `BESZEL_NODE_INVALID`: beszel node invalid.
- `BESZEL_NODE_MISSING`: beszel node missing.
- `BESZEL_NODE_TAILNET_REQUIRED`: beszel node tailnet required.
- `BESZEL_NOT_ENROLLED`: beszel not enrolled.
- `BESZEL_NOT_HUB`: beszel not hub.
- `BESZEL_NOT_MANAGER`: beszel not manager.
- `BESZEL_OPERATION_INCOMPLETE`: beszel operation incomplete.
- `BESZEL_PRIVATE_ROUTE_CONFLICT`: beszel private route conflict.
- `BESZEL_PRIVATE_ROUTE_REQUIRED`: beszel private route required.
- `BESZEL_PRIVATE_ROUTE_UNVERIFIED`: beszel private route unverified.
- `BESZEL_PROTOCOL`: beszel protocol.
- `BESZEL_PUBLIC_ENDPOINT_OFFLINE`: beszel public endpoint offline.
- `BESZEL_REMOTE_EVIDENCE_INVALID`: beszel remote evidence invalid.
- `BESZEL_RESPONSE_LIMIT`: beszel response limit.
- `BESZEL_SERVICE_STOPPED`: beszel service stopped.
- `BESZEL_SOURCE_MISMATCH`: beszel source mismatch.
- `BESZEL_TAILSCALE_REQUIRED`: beszel tailscale required.
- `BESZEL_TOKEN_INVALID`: beszel token invalid.
- `BESZEL_TUNNEL_CREDENTIAL_UNAVAILABLE`: beszel tunnel credential unavailable. **Needs a person.**
- `BESZEL_VERSION_MISMATCH`: beszel version mismatch.
- `BESZEL_VIEWER_ROLE`: beszel viewer role.
- `BESZEL_VIEWER_UNPROVISIONED`: beszel viewer unprovisioned.
- `BESZEL_VIEWER_UNVERIFIED`: beszel viewer unverified.
- `BESZEL_DUPLICATE_NODE`: the hub holds more than one system with the worker's name, so registration fails and enrollment and `devfleet fleet-node-replace` refuse to pick one. Delete the extra systems in the dashboard and keep the one that has the worker's history, then run the command again. **Needs a person.**
- `BESZEL_DUPLICATE_FINGERPRINT`: the hub holds more than one fingerprint record for the worker's system, and enrollment refuses to pick one. Remove the extra record in the hub at `/_/`, then run `devfleet fleet-sync`. **Needs a person.**
- `BESZEL_HUB_UNAVAILABLE_TO_AGENT`: a warning read from the agent's own log: the private route answered the agent with 502, 503 or 504, so the hub behind it did not. Keep the manager awake with Docker Desktop running and run `devfleet fleet-sync` there; the agent reconnects by itself.
- `BESZEL_VERSION_OR_KEY`: enrollment asked the hub for its version and key, and the hub reports another version than `ansible/monitoring/lock.json` pins or no ed25519 key. Run `devfleet fleet-sync` on the manager, which converges the hub to the pinned release, before enrolling a worker.
- `BESZEL_PRIVATE_URL`: the address dev-fleet was given for the hub is not its private one: https, a name of the tailnet, port 8443 and nothing after it. No request was sent. Run `devfleet fleet-sync` on the manager so the private route is declared; when it repeats, it is an issue.
- `BESZEL_NODE_ID`: the hub was to be asked about a name that is not a machine id (a lowercase letter, then lowercase letters, digits and hyphens). No request was sent. Correct the id in `fleet.json` (`devfleet fleet-validate` names it).
- `BESZEL_API_PATH`: dev-fleet refused to send the hub a request outside its API. No request was sent and nothing on a machine fixes it: report it as an issue.
- `BESZEL_REVISION`: an agent was to be installed on a worker from something that is not a full commit of dev-fleet. Nothing was installed. Run `devfleet fleet-sync`, which selects the revision itself; when it repeats, it is an issue.

## Coding agents and providers

- **Meaning:** An agent CLI, its profile or a provider behind the CLI proxy did not answer as expected.
- **Confirm:** The `agent:*` and `provider:*` checks of `devfleet fleet-status`, and `devfleet cliproxy` on the manager.
- **Fix:** Run `devfleet fleet-sync`; a rate limit or upstream outage clears on its own.
- **Escalate:** PROVIDER_AUTH_REJECTED needs a person to sign the account in again on the proxy. AGENT_PROFILE_RENDER_MISMATCH is a defect of the release (a template of `ansible/agents/agents.yml` no longer renders what `src/agents/render.ts` specifies): report it to dev-fleet. No receipt vouches for what that play wrote, so later applies refuse the file until a person reviews it.

- `AGENT_COMMANDS_CONFLICT`: `agent:commands` on a worker: `~/.local/share/personal/fleet/agent-commands` exists and is not the link `fleet-sync` makes to the applied revision's launchers, so it was left untouched and the worker's `claude`, `codex` and the others are not the fleet's launchers. On the worker look at what is there, move it away, then run `devfleet fleet-sync --node ID`. **Needs a person.**
- `AGENT_COMMANDS_NOT_LINKED`: `agent:commands` on a worker: the play that makes that link (`ansible/agents/commands.yml`) failed, or the link is not there after it ran; its output is not reported. Run `devfleet fleet-sync --node ID` again; when it repeats, raise an issue.
- `AGENT_COMMANDS_REQUEST_INVALID`: the same play refused its variables: dev-fleet passes the link beside the applied revision and its fixed target, so this is a defect of the release. Raise an issue.
- `AGENT_SLICE_MISSING`: the user manager cannot load the T3 agent slice. Check the T3 release and run fleet-sync.
- `AGENT_LIMIT_OVERRIDDEN`: a higher-priority setting overrides an agent slice limit. Run fleet-sync and inspect the effective properties.
- `AGENT_MEMORY_LIMIT_MISSING`: agent memory limit missing.
- `AGENT_MODEL_UNSERVED`: agent model unserved.
- `AGENT_PROFILE_RENDER_MISMATCH`: agent profile render mismatch.
- `AGENT_PROFILE_REQUEST_INVALID`: agent profile request invalid.
- `AGENT_PROFILE_STALE`: agent profile stale.
- `AGENT_SERVICE_ENVIRONMENT_INCOMPLETE`: agent service environment incomplete.
- `AGENT_SERVICE_ENVIRONMENT_UNVERIFIED`: agent service environment unverified.
- `AGENT_SESSION_UNVERIFIED`: agent session unverified.
- `AGENT_VAULT_UNAVAILABLE`: agent vault unavailable.
- `AGENT_VERSION_MISMATCH`: agent version mismatch.
- `PROVIDER_AUTH_REJECTED`: provider auth rejected. **Needs a person.**
- `PROVIDER_EMPTY_RESPONSE`: provider empty response.
- `PROVIDER_MODEL_UNAVAILABLE`: provider model unavailable.
- `PROVIDER_NETWORK_UNVERIFIED`: provider network unverified.
- `PROVIDER_OUTPUT_UNVERIFIED`: provider output unverified.
- `PROVIDER_PROTOCOL_REJECTED`: provider protocol rejected.
- `PROVIDER_RATE_LIMITED`: provider rate limited.
- `PROVIDER_RESPONSE_INVALID`: provider response invalid.
- `PROVIDER_RESPONSE_LIMIT`: provider response limit.
- `PROVIDER_ROUTE_UNVERIFIED`: provider route unverified.
- `PROVIDER_STREAM_INCOMPLETE`: provider stream incomplete.
- `PROVIDER_TIMEOUT`: provider timeout.
- `PROVIDER_TOOL_ARGUMENTS_INVALID`: provider tool arguments invalid.
- `PROVIDER_TOOL_INVALID`: provider tool invalid.
- `PROVIDER_TOOL_MISSING`: provider tool missing.
- `PROVIDER_TOOL_RESULT_UNVERIFIED`: provider tool result unverified.
- `PROVIDER_UNATTENDED_CREDENTIAL_REQUIRED`: provider unattended credential required.
- `PROVIDER_UPSTREAM_UNAVAILABLE`: provider upstream unavailable.
- `PROXY_RECONCILE_UNVERIFIED`: proxy reconcile unverified.
- `UNATTENDED_PROXY_AUTHENTICATION_REQUIRED`: unattended proxy authentication required.
- `AUTH_NOT_SUPPORTED_ON_ROUTE`: not a failure. The service is reached through the CLI proxy on this fleet, so a login of its own on the machine is not applicable and is not checked; the summary says why.
- `PROVIDER_PROTOCOL_INCOMPATIBLE`: the gateway answered a verification request with 404, 405, 415 or 501: it does not serve the protocol the route uses. Retrying or signing in again changes nothing, and nothing on the machine fixes it: the route in `agents/registry.json` has to become one listed under Supported alternatives in `agents/setup.md`. From a fleet's own project that is an issue. **Needs a person.**

## Provider accounts

- **Meaning:** A change to a provider account on the CLI proxy (sign-in, removal, cooldown) did not complete, a node does not reach the proxy, or the session a node runs through one account's instance (`agent:<tool>:account-<n>:session`) did not answer. A session check names the tool and the account's index, never the account, and never repeats what a provider answered.
- **Confirm:** `devfleet fleet-accounts` lists every account by its index with its state, the models the proxy holds back and until when; `devfleet fleet-accounts --diff` compares this machine. The session checks are in `devfleet fleet-status`.
- **Fix:** Retry the change with `devfleet fleet-accounts`; see [Provider accounts](accounts.md). A cooldown clears on its own.
- **Escalate:** Signing an account in again needs a person, and so does a verification its provider asks for. A session that keeps failing or hanging on an account `devfleet fleet-accounts` calls usable is an issue.

- `ACCOUNT_CHANGE_FAILED`: account change failed.
- `AGENT_ACCOUNT_AUTH_REJECTED`: the session of one account was refused its credentials. `devfleet fleet-accounts` says whether the account needs a login; one that does is signed in again with `--relogin`, as [Provider accounts](accounts.md) describes. **Needs a person.**
- `AGENT_ACCOUNT_COOLING_DOWN`: a warning, never a failure. The provider limited the account, or the proxy holds its model back. The summary names when the cooldown clears when the proxy said so; `devfleet fleet-accounts` lists each model held back and `until`. It clears on its own and is checked again on the next status. Nothing to fix; add an account if every one of a provider cools down often.
- `AGENT_ACCOUNT_REMOVED`: the node still offers an instance for an account the proxy no longer holds. Run `devfleet fleet-sync --only accounts`, which propagates the roster to every node.
- `AGENT_ACCOUNT_SESSION_FAILED`: the session of one account did not answer, and nothing it printed named a limit, a verification or a refusal. Read the account's state with `devfleet fleet-accounts` and the `provider:*` checks of `devfleet fleet-status`; report it when the account is usable and the session still fails.
- `AGENT_ACCOUNT_SESSION_TIMED_OUT`: the session never ended, and the proxy named no cooldown and no refusal for the account. Not a sign-in failure: signing in again does not help. Read which models the proxy holds back with `devfleet fleet-accounts`, then run `devfleet fleet-status` again; report a session that keeps hanging.
- `AGENT_ACCOUNT_VERIFICATION_REQUIRED`: the provider wants the account verified before it serves requests. Sign in to the provider as that account (find it by its index in `devfleet fleet-accounts`) and complete the verification it asks for. Signing in again on the proxy does not replace it. **Needs a person.**
- `PROXY_UNREACHABLE`: the node got no answer from the CLI proxy, or the route answered and the proxy did not. Agents retry for about a minute and then report it. Check the node's tailnet, and the proxy on the manager with `devfleet cliproxy status`.

## Vault and credentials

- **Meaning:** A machine cannot read the secrets it needs with its own Vault session, or soon will not.
- **Confirm:** `vault token lookup` on the machine and the `worker:vault-renewal` or `manager:vault-renewal` check. In the lookup, `renewable`, `ttl`, `period`, `explicit_max_ttl` and `creation_time` say how long the login can last; on the manager `launchctl print gui/$(id -u)/dev.devfleet.vault-renew` shows the `last exit code` of the renewal job.
- **Fix:** Log the machine in once (`devfleet fleet-sync` asks on the manager); renewal is automatic afterwards, up to the maximum lifetime of the token. A Vault that does not answer a machine (`VAULT_UNREACHABLE`) is not repaired by a login or by a new worker token: restore the way to it, or unseal it.
- **Escalate:** A refused policy needs the Vault administrator. So does a login that ends too often: its maximum lifetime is set where the token is issued (the auth method, or the user or role in it).

- `SECRET_READ_BLOCKED`: secret read blocked: the check needed a secret its machine could not read, because the machine is not logged in to Vault or Vault does not answer it. It is not a fault of that check: fix the check its summary names, then run `devfleet fleet-sync`. On the manager that is `manager:vault-renewal`, which says `VAULT_LOGIN_REQUIRED` or `VAULT_UNREACHABLE`; on a worker it is `worker:vault-renewal`, which says `UNATTENDED_VAULT_IDENTITY_REQUIRED` or `VAULT_UNREACHABLE`. Every check that needs a secret answers this way: on the manager the hub's account, tunnel, viewer and backups, a notification target, the tailnet control plane's credential, the GitHub token and the proxy client key; on a worker the GitHub token (`worker:github-sync`, `github:sync`, `github:token-current`) and the proxy client key (`worker:proxy-authentication`, `provider:*:authentication`). **Needs a person.**
- `UNATTENDED_VAULT_IDENTITY_REQUIRED`: unattended vault identity required: Vault answers the worker, and the worker holds no session, or one that is not a renewable periodic token with enough lifetime left for the renewal timer. `devfleet fleet-sync` delivers the worker's issued token; `devfleet fleet-node-replace --id ID --apply --yes` issues a new one. A Vault that does not answer the worker is `VAULT_UNREACHABLE` instead.
- `VAULT_LOGIN_EXPIRY_PENDING`: vault login expiry pending: the manager's login ends within a day and renewal cannot extend it, because Vault renews a token only up to its maximum lifetime or the token is not renewable. Log the manager in again before then; see [Authentication](authentication.md#rotation-and-failure). **Needs a person.**
- `VAULT_LOGIN_REQUIRED`: vault login required. **Needs a person.**
- `VAULT_POLICY_PERMISSION_REQUIRED`: vault policy permission required. **Needs a person.**
- `VAULT_RENEWAL_FAILING`: vault renewal failing: the last run of the renewal job failed (a worker's `personal-worker-auth.service`, the manager's `dev.devfleet.vault-renew`), and the login lapses unless a renewal succeeds.
- `VAULT_RENEWAL_MISSING`: vault renewal missing: the manager's renewal job is not loaded. Run `devfleet fleet-sync` on the manager.
- `VAULT_RENEWAL_NOT_MANAGER`: vault renewal not manager.
- `VAULT_UNREACHABLE`: vault unreachable: the Vault session of the manager, or of a worker (`worker:vault-renewal` there, `auth:vault` in the sync that would have delivered its token), does not answer and neither does Vault's own status, which needs no login. Logging in again does not help, and neither does a new token for a worker: none is delivered. `vault status -address=ADDRESS` on that machine says which it is: no answer is the network between them (the tailnet, DNS, the address under `secrets` in the fleet configuration) or a Vault that is not running; `Sealed true` is a Vault to unseal. A login that was held is still held if Vault returns before it lapses. **Needs a person.**
- `VAULT_WORKER_POLICY_FAILED`: vault worker policy failed.
- `VAULT_WORKER_TOKEN_NOT_ISSUED`: Vault did not create the worker's own token (`auth:worker-token`), or its answer held none. Log the manager in to Vault with a token that may write policies, issue tokens and write the fleet mount, then run the command again. **Needs a person.**
- `VAULT_WORKER_TOKEN_NOT_STORED`: the worker's token was issued and could not be written to the worker's own document. The same login is missing: log the manager in with a token that may write the fleet mount, then run the command again, which issues and stores a new one. **Needs a person.**
- `VAULT_WORKER_TOKEN_NOT_REVOKED`: a retirement or replacement could not revoke the worker's token: the accessor kept beside it is not one, or Vault refused the revocation. The token still works. Log the manager in with a token that may revoke it, then run the command again. **Needs a person.**
- `VAULT_WORKER_TOKEN_SHARED`: a warning of `auth:vault-isolation`: the worker's token was read from the fleet's shared document, which every worker can read. `devfleet fleet-node-replace` issues it one of its own (the remedy prints the command and where it is kept); then remove the worker's field from the shared document. **Needs a person.**

## The fleet definition and a worker's lifecycle

- **Meaning:** `fleet.json` breaks a rule of the fleet definition, the pinned Ansible rejects the inventory it describes, or a seed, replacement or retirement could not change the host keys the manager trusts.
- **Confirm:** `devfleet fleet-validate` names the field that breaks a rule as `{code, path, expected, actual}`; `devfleet fleet-validate --ansible` also renders the inventory and syntax-checks every playbook.
- **Fix:** Correct the field the check names in `fleet.json`, then run the command again. For SSH_HOST_KEY_NOT_CHANGED run `devfleet fleet-validate --ansible`, then repeat `devfleet fleet-node-seed`, `devfleet fleet-node-replace` or `devfleet fleet-node-retire`.
- **Escalate:** An inventory the pinned Ansible rejects for a valid definition is an issue.

- `DEFINITION_INVALID`: definition invalid.
- `DEFINITION_INVENTORY_REJECTED`: definition inventory rejected.
- `DEFINITION_MISSING`: definition missing.
- `DEFINITION_UNREADABLE`: definition unreadable.
- `SSH_HOST_KEY_NOT_CHANGED`: ssh host key not changed.
- `DEFINITION_PLAYBOOK_SYNTAX`: the pinned Ansible cannot parse a playbook the installed dev-fleet package carries; `devfleet fleet-validate --ansible` names it. Nothing in `fleet.json` fixes it: report it as an issue.
- `DEFINITION_UNKNOWN`: `fleet.json`, or a worker record `workerRecords` returns, has a field the definition does not have; the check names it and the fields allowed there. Remove or rename it.
- `DEFINITION_DUPLICATE`: two machines of `fleet.json`, or two worker records, have the same id; the check names the second. Give every machine an id no other has.

## Parked, idle, replaced and retired workers

- **Meaning:** a worker could not be parked or resumed (agent turns under way, a declared `parking.stop` or `parking.start` command failed, the sync after a resume did not end ready), a worker whose record disappeared could not be retired, or the manager's T3 link to a replaced or retired worker could not be removed, or the manager's T3 could not pair with a replaced worker's new environment.
- **Confirm:** `devfleet fleet-status --workers` lists each worker as active or parked, with its uptime, agent turns and last agent activity; the report of `devfleet fleet-node-park`, `devfleet fleet-node-resume` or `devfleet fleet-sync` names the step that failed.
- **Fix:** For WORKER_BUSY wait for the turns to end, or repeat `devfleet fleet-node-park` with `--force`. For a failed hook, run the command `fleet.json` names under `parking` by hand with the worker ID, then repeat. For WORKER_RESUME_FAILED follow the sync report and run `devfleet fleet-sync --node ID`. For T3_LINK_UNLINK_FAILED remove the link in the manager's T3 (Settings, Connections). For T3_LINK_PAIRING_FAILED follow the remedy, which names why the link was refused (Linked environments off in the T3 policy, the manager's T3 not running, a worker T3 that did not mint a code), then run `devfleet fleet-sync --node ID`: it pairs a replaced worker until it is paired.
- **Escalate:** A record retirement that keeps failing at the same step: follow that step's own runbook.

- `T3_LINK_PAIRING_FAILED`: t3 link pairing failed: the manager's T3 could not pair with a replaced worker's new T3 environment. The pairing code never appears in a report.
- `T3_LINK_UNLINK_FAILED`: t3 link unlink failed.
- `WORKER_ACTIVITY_UNREADABLE`: worker activity unreadable. **Needs a person.**
- `WORKER_AUTO_PARK_REFUSED`: worker auto park refused.
- `WORKER_BUSY`: worker busy. **Needs a person.**
- `WORKER_RECORD_RETIREMENT_FAILED`: worker record retirement failed.
- `WORKER_RESUME_FAILED`: worker resume failed.
- `WORKER_START_HOOK_FAILED`: worker start hook failed.
- `WORKER_STOP_HOOK_FAILED`: worker stop hook failed.

## Fleet operations and the fleet state

- **Meaning:** fleet-sync could not plan, lock, reach a machine, promote a revision or keep the fleet state.
- **Confirm:** `devfleet fleet-state` for the state, `devfleet fleet-status` for machines, and the report `devfleet fleet-sync` writes.
- **Fix:** Follow the remedy; most clear by running `devfleet fleet-sync` again once the holder of a lock finishes.
- **Escalate:** FLEET_STATE_DIVERGED needs a person to choose which copy of the state to keep (docs/state.md). FLEET_CONFIGURATION_COPY_CHANGED needs a person to keep the edit (in `fleet.json`, or with the import the remedy prints) or to delete the copy. FLEET_REVISION_UNMERGED means the revision is not on the default branch of the source repository, so nothing was changed: merge it, or pass `--allow-unmerged` to converge the fleet to it on purpose. FLEET_REVISION_UNVERIFIED means the manager's own copy of the source repository could not be fetched to answer that: restore its network and Git access. FLEET_SOURCE_MISMATCH means that copy is a clone of another repository (one made before the fleet's source moved), which can never hold the revision, and the repository `source.repository` names could not be cloned to replace it: restore the manager's network and Git access to it, check the URL, and run `devfleet fleet-sync` again; the copy is replaced by itself. Do not pass `--allow-unmerged` for it: the revision may well be merged. FLEET_MISE_DOWNGRADE means the revision's own toolchain bootstrap is from before the rule that keeps a newer mise, and would replace the mise of the machines the remedy names with the older one the revision pins; nothing was changed. Every checkout on those machines whose `mise.toml` asks for a newer mise would stop working, so converge to a later revision instead, or pass `--allow-mise-downgrade` to `devfleet fleet-sync` to install the older one on purpose. The flag skips the refusal for any revision, but it reaches the bootstrap only of a revision that reads it: one from before the rule installs the older mise by itself, and one released after the rule and before the flag reached the bootstrap keeps the newer mise whatever it is told, so there the older mise is installed by hand, with `bash bootstrap/bootstrap.sh --allow-mise-downgrade` in the revision's checkout on each machine (`--tools-only` on the manager, `--worker --node ID` on a worker). FLEET_MISE_UNMEASURED means the same kind of revision was refused because a machine's mise could not be measured, and nothing was changed. When the remedy names workers, they did not answer over SSH: bring them back and run it again, park them (`devfleet fleet-node-park --id ID`), or name the others with `--node`. When it names the devfleet installed on the manager, the run was started on a worker and the manager's installed devfleet is from before `fleet-sync --measure-mise` (or the manager has none on its PATH): run `devfleet fleet-sync` on the manager itself once with a current release. `--allow-mise-downgrade` goes on without the measurement.

- `ANSIBLE_VARIABLE_LIMIT`: ansible variable limit.
- `CONTAINER_WATCHDOG_UNOBSERVED`: container watchdog unobserved.
- `FLEET_CONFIGURATION_COPY_CHANGED`: fleet configuration copy changed: `~/.config/dev-fleet/fleet.json` on the machine was edited by hand, and is not replaced until the edit is kept or discarded. **Needs a person.**
- `FLEET_CONNECTION_REQUIRED`: fleet connection required.
- `FLEET_MANAGER_ENROLLMENT_REQUIRED`: fleet manager enrollment required. **Needs a person.**
- `FLEET_MANAGER_LOCKED`: fleet manager locked.
- `FLEET_MANAGER_UNREACHABLE`: fleet manager unreachable.
- `FLEET_MISE_DOWNGRADE`: the revision's own bootstrap would replace a newer mise with the older one it pins.
- `FLEET_MISE_UNMEASURED`: the revision's own bootstrap would replace a newer mise, and a worker did not say which mise it runs, or the devfleet installed on the manager could not ask the workers.
- `FLEET_NOT_MANAGER`: fleet not manager.
- `FLEET_PLAN_STALE`: fleet plan stale.
- `FLEET_PROMOTION_BLOCKED`: fleet promotion blocked.
- `FLEET_REMOTE_LOCKED`: fleet remote locked.
- `FLEET_REMOTE_OPERATION_FAILED`: fleet remote operation failed.
- `FLEET_REVISION_REQUIRED`: fleet revision required.
- `FLEET_REVISION_UNMERGED`: the revision is not on the default branch of the source repository.
- `FLEET_REVISION_UNVERIFIED`: the source repository could not be asked whether its default branch holds the revision.
- `FLEET_ROLLBACK_UNAVAILABLE`: fleet rollback unavailable.
- `FLEET_SCHEDULE_PREVIEW`: fleet schedule preview.
- `FLEET_SOURCE_MISMATCH`: the manager's own copy of the source repository is a clone of another repository, and the declared one could not be cloned to replace it.
- `FLEET_SOURCE_UNAVAILABLE`: fleet source unavailable.
- `FLEET_STATE_DIVERGED`: fleet state diverged. **Needs a person.**
- `FLEET_VERIFICATION_MISSING`: fleet verification missing.
- `MANAGER_AGENT_PROFILES_FAILED`: manager agent profiles failed.
- `MANAGER_DISK_UNOBSERVED`: manager disk unobserved.
- `MANAGER_DOCKER_DESKTOP_DRIFT`: manager docker desktop drift.
- `MANAGER_DOCKER_DESKTOP_UNOBSERVED`: manager docker desktop unobserved.
- `MANAGER_RELEASE_UNOBSERVED`: manager release unobserved.
- `MANAGER_SLEEPS_ON_POWER`: manager sleeps on power.
- `MANAGER_UPDATES_UNOBSERVED`: manager updates unobserved.
- `REMOTE_CONFIGURATION_INCOMPLETE`: remote configuration incomplete.
- `REMOTE_PHASE_FAILED`: remote phase failed.
- `CONTAINER_RESTARTED_UNHEALTHY`: the container watchdog restarted a container of the manager that stayed unhealthy, within the last hour; the check names it. A warning: read the watchdog log and the container's logs for the cause.
- `CONTAINER_RESTART_STORM`: the watchdog reached its limit of restarts for a container within the last hour and stopped restarting it. Read the watchdog log and the container's logs, fix the cause, then `docker restart` the container.
- `FLEET_MANAGER_LEASE_HELD`: another manager holds the fleet state until the instant the message names. Nothing was changed. Run devfleet from that manager; to make this machine the manager once the other is gone, repeat with `--take-over` (see [Recovering the manager](manager-recovery.md)). **Needs a person.**
- `FLEET_STATE_NEWER_THAN_CLI`: a newer dev-fleet wrote the fleet state, and this one cannot read its schema version. Nothing was read or changed. Install the dev-fleet version the fleet runs, then run the command again.
- `MANAGER_BOOT_RECOVERY_INCOMPLETE`: after a power cut the manager would not come back by itself; the check names what is missing (restart after power loss, a user session, the container engine at login). Follow the remedy. A Mac with FileVault waits for a person at the disk password: that is a warning.
- `MANAGER_DISK_FULL`: the manager's data volume has less free space than `disk.failFreeMiB` of the macOS policy. Free space: `docker system prune` removes unused images and build cache.
- `MANAGER_DISK_LOW`: the same below `disk.warnFreeMiB`: a warning.
- `MANAGER_DOCKER_DISK_LARGE`: Docker Desktop holds more than `disk.dockerWarnGiB` on the manager: a warning. `docker system prune` removes unused images and build cache.
- `MANAGER_POWER_POLICY_DRIFT`: a power setting of the manager is not what the policy declares; the check names it. Give the manager its grant once, as an administrator, with the command the remedy prints; every `devfleet fleet-sync` then applies the policy. **Needs a person.**
- `MANAGER_RELEASE_UNSUPPORTED`: the manager runs an older macOS than the policy requires. Update it in System Settings, then run `devfleet fleet-sync`. **Needs a person.**
- `MANAGER_RESTART_PENDING`: a macOS update of the manager waits for a restart: a warning. Install it at a time no worker depends on the manager. **Needs a person.**
- `MANAGER_UPDATES_PENDING`: macOS updates are pending on the manager: a warning. Install them at a time no worker depends on the manager. **Needs a person.**

## The manager's own policy and scheduled jobs

- **Meaning:** `ansible/macos/manager.yml` did not pass its check-mode run or its apply, or something it declares (network time, the fleet-watch job, the rotation of the scheduled jobs' logs) is not in place.
- **Confirm:** The `manager:playbook`, `manager:clock`, `manager:watch` and `manager:job-logs` checks of `devfleet fleet-sync --dry-run`; on the manager, the check-mode run the remedy quotes.
- **Fix:** Run `devfleet fleet-sync`, which applies the playbook in check mode first, then for real. What needs root (power settings, reading network time, newsyslog) comes from the one grant: `ansible-playbook -e user=$(id -un) -K ansible/macos/manager-privilege.yml`, run again after an upgrade that changed it.
- **Escalate:** The grant needs an administrator's password, once.

- `MANAGER_CLOCK_UNOBSERVED`: manager clock unobserved: the grant that lets fleet-sync read network time is missing. **Needs a person.**
- `MANAGER_JOB_LOG_ROTATION_MISSING`: manager job log rotation missing: the newsyslog drop-in the grant installs is missing or outdated. **Needs a person.**
- `MANAGER_PLAYBOOK_CHECK_FAILED`: manager playbook check failed: nothing was applied.
- `MANAGER_PLAYBOOK_FAILED`: manager playbook failed.
- `MANAGER_WATCH_INTERVAL_INVALID`: manager watch interval invalid: `manager.schedule.watchMinutes` is outside 5 to 1440.
- `MANAGER_JOB_LOG_OVERSIZED`: logs of the scheduled jobs grew past twice the size newsyslog rotates them at, so it is not rotating them. Check that it runs with the command the remedy prints and read `/var/log/system.log` for its errors.
- `MANAGER_WATCH_FAILING`: the last run of the fleet-watch job failed; the check names its exit code. Read the job's error log the remedy names and run `devfleet fleet-watch` on the manager to see the same failure.
- `MANAGER_CLOCK_NOT_SYNCHRONISED`: network time is off on the manager, and every worker's clock is measured against it. `manager:clock` fails and `ansible/macos/manager.yml` asserts the same. Turn on Set time and date automatically in System Settings > General > Date & Time. **Needs a person.**
- `MANAGER_WATCH_NOT_LOADED`: the launchd job that runs fleet-watch on a schedule is not loaded, so no heartbeat reaches the bucket and no notification is sent. Run `devfleet fleet-sync` on the manager, which installs and loads it.
- `MANAGER_DISK_GC_NOT_LOADED`: the launchd job that runs the manager's disk GC (`dev.devfleet.disk-gc`) is not loaded, so nothing removes idle worktrees, unused tool versions or old dev-fleet checkouts on the manager. Run `devfleet fleet-sync` on the manager, which installs and loads it with `ansible/macos/manager.yml`.
- `MANAGER_DISK_GC_FAILING`: the last run of the manager's disk GC failed; the check names its exit code. Read `~/.local/share/personal/fleet/manager/logs/dev.devfleet.disk-gc.err.log`, and start it by hand with `launchctl kickstart gui/$(id -u)/dev.devfleet.disk-gc` to see the same failure.
- `MANAGER_DISK_GC_STALE`: the manager's disk GC is loaded but its last report (`~/Library/Caches/dev-fleet/disk-gc.json`) is more than three hours old: launchd does not start it while the manager sleeps, or a run hangs. Read its error log and `manager:power`.

## Notifications (fleet-watch)

- **Meaning:** fleet-watch could not reach a notification target `notify` in `fleet.json` names, or its address is not stored as a secret.
- **Confirm:** Run `devfleet fleet-watch --test` and read the `notify:*` checks.
- **Fix:** Store the target's address as the secret the remedy names, or fix the endpoint, then run `devfleet fleet-watch --test` again.
- **Escalate:** A target that keeps refusing needs whoever runs that endpoint.

- `NOTIFY_DELIVERY_FAILED`: notify delivery failed.
- `NOTIFY_TARGET_UNAVAILABLE`: notify target unavailable.
- `NOTIFY_NOT_CONFIGURED`: `fleet.json` has no `notify` block, so fleet-watch notifies nobody: a warning of a scheduled run, a failure of `devfleet fleet-watch --test`. Add the block with its targets and store each target's address as its secret (`notify-webhook-url`, `notify-ntfy-url`). **Needs a person.**
- `WATCH_HEARTBEAT_NO_BUCKET`: a warning of `watch:heartbeat`: `fleet.json` names no bucket under `state`, so the heartbeat and what the watcher remembers are not kept, and the heartbeat workflow has nothing to read. Name the bucket. **Needs a person.**
- `WATCH_HEARTBEAT_UNWRITTEN`: the heartbeat could not be written to the bucket. Check the bucket credentials the run was given; `devfleet fleet-state` shows the connection.

## The CLI proxy in a fleet-sync

- **Meaning:** fleet-sync asks the CLI proxy to reconcile itself on every machine (`cliproxy/scripts/fleet_sync.py`) and reports each phase of the answer as a `proxy:*` check whose summary is the code of the phase. The proxy runs on the manager only; a worker is its client. A `PROXY_UNIT_` code followed by the name of a unit is one of the proxy's scheduled jobs that is stopped or disabled: fleet-sync loads it.
- **Confirm:** The `proxy:*` checks of `devfleet fleet-sync --dry-run`; on the manager, `devfleet cliproxy`.
- **Fix:** Run `devfleet fleet-sync` on the manager: it installs a pending revision, loads stopped units, enables the connector and applies the declared settings. What it never does by itself is in the entries below and in [the proxy's README](../cliproxy/README.md).
- **Escalate:** Moving the proxy, recovering its state and removing an installation from a worker are steps a person takes, as [the migration document](../cliproxy/docs/migration.md) describes.

- `PROXY_CLIENT_ROLE`: not a failure. The machine is a worker and hosts no proxy: the proxy runs on the manager.
- `PROXY_ENDPOINT_AUTH`: the phase that checks the proxy's endpoint with the client credential, once every other phase is unchanged. It passes when the endpoint answered; when it fails, the endpoint or its authentication is unavailable. Run `devfleet fleet-sync` again, then read `devfleet cliproxy` on the manager. Provider inference is checked separately (`provider:*`).
- `PROXY_DUPLICATE_OWNER`: a proxy unit is active or enabled on a worker. It is reported and never stopped by fleet-sync. Fence and decommission it as the migration document describes. **Needs a person.**
- `PROXY_DECOMMISSION_PENDING`: a stopped proxy installation, with its private state, remains on a worker. Once the proxy on the manager is verified, remove it as the migration document describes. **Needs a person.**
- `PROXY_PLATFORM_MISMATCH`: the machine declared as the manager does not host the proxy with launchd on macOS. Run `devfleet fleet-sync` for the manager on the manager. **Needs a person.**
- `PROXY_IDENTITY_MISMATCH`: the machine is not the declared manager (its local host name is not `manager.id`). Changing the manager is a reviewed move with the previous one fenced. **Needs a person.**
- `PROXY_RECOVERY_REQUIRED`: the manager holds no runtime state of the proxy. Recover it from the encrypted backup after fencing the previous owner, as the migration document describes; never initialise a second provider identity. **Needs a person.**
- `PROXY_SOURCE_DRIFT`: the installation or its units differ from what was installed: a file is missing or was changed. Read the proxy's audit on the manager, keep the runtime state and reinstall a reviewed revision. **Needs a person.**
- `PROXY_UPDATE_PENDING`: installing the revision fleet-sync runs failed, and the proxy still runs the earlier one; its runtime state is kept. Run the proxy's installer on the manager as the remedy says to see why.
- `PROXY_ENDPOINT_DISABLED`: the proxy's public connector is not enabled. `devfleet fleet-sync` on the manager enables it with the credential it already has.
- `PROXY_CONFIG_PENDING`: the live proxy lacks settings the fleet declares (model aliases, a model prefix for each signed-in account) and applying them failed. The previous configuration is kept beside the live one. Run `devfleet fleet-sync` again; when it repeats, apply the declared settings on the manager as the remedy says to see why.

## Workflows a fleet's repository calls

- **Meaning:** A reusable workflow of dev-fleet (`fleet-heartbeat.yml`, `cliproxy-health.yml`), called from the repository that holds `fleet.json`, failed with the code its error starts with. See [Operations](operations.md).
- **Confirm:** Read the annotations of the failed run on GitHub; on the manager, `devfleet fleet-watch` and the `manager:watch` check of `devfleet fleet-sync --dry-run`.
- **Fix:** A heartbeat code is fixed on the manager; a CLI proxy health code is fixed in the calling workflow or the repository it runs in.
- **Escalate:** A manager that is off or asleep needs a person at it.

- `FLEET_HEARTBEAT_MISSING`: the workflow could not download the heartbeat: the bucket holds none under the prefix, or the inputs or the key the workflow was given do not reach the bucket. Run `devfleet fleet-watch` on the manager, and compare the workflow's `bucket`, `endpoint` and `prefix` with `state` in `fleet.json`.
- `FLEET_HEARTBEAT_UNREADABLE`: what the bucket holds is not a heartbeat fleet-watch wrote. Run `devfleet fleet-watch` on the manager, which writes a new one.
- `FLEET_HEARTBEAT_STALE`: the manager last watched the fleet longer ago than `max-age-minutes`: it is off, asleep, offline or no longer watching. Wake it and read `manager:watch` (`MANAGER_WATCH_NOT_LOADED`, `MANAGER_WATCH_FAILING`).
- `CLIPROXY_HEALTH_PROFILE_UNKNOWN`: the `profile` the caller passed is not liveness, readiness, light, nightly or manual. Correct the calling workflow. **Needs a person.**
- `CLIPROXY_HEALTH_CONFIG_MISSING`: the repository does not hold the fleet configuration at the path the `config` input names. Correct the input or commit the file. **Needs a person.**
- `CLIPROXY_HEALTH_RELEASE_UNPINNED`: `package.json` of the repository does not pin the dev-fleet package to an exact version, so the workflow cannot install the release whose checks it runs. Pin it. **Needs a person.**

## Local command lock

- `SQLITE_BUSY`: SQLite reports that another command holds the local guard. The CLI translates this into a locked message. Wait for that command to finish and retry; do not delete `sync.guard.sqlite` while commands are running. See [local command locking](state.md#local-command-locking).

## Desktop sharing and unattended access

Read the worker checks in `devfleet fleet-status --workers --json`. Compare the
service, session, credential and endpoint findings before starting a client.
See the GNOME desktop sharing and manager keychain procedures in
[Ubuntu sync](ubuntu-sync.md).

- `GITHUB_KEYCHAIN_INACCESSIBLE`: the SSH session cannot read the manager login. Trigger the authorized manager LaunchAgent or run the requested sync from the manager desktop. **Needs a person.**
- `GIT_CREDENTIAL_UNAVAILABLE`: Git has the gh helper configured. Check the GitHub principal in the same session.
- `RDP_ACCOUNT_MISMATCH`: check that the enrolled account is the desktop user. **Needs a person.**
- `RDP_CERTIFICATE_UNAVAILABLE`: verify the GNOME TLS certificate and the desktop user's read access.
- `RDP_CREDENTIAL_UNAVAILABLE`: check the per-worker secret and the session credential publisher, then rerun sync.
- `RDP_DESKTOP_UNAVAILABLE`: confirm automatic graphical login starts GNOME and Mutter on the worker.
- `RDP_ENDPOINT_UNVERIFIED`: check that the manager sees the tailnet peer and the worker reported its certificate.
- `RDP_NEGOTIATION_FAILED`: check the declared port and service. Verify the worker accepts RDP negotiation from the manager.
- `RDP_POLICY_INCOMPLETE`: verify the firewall, session bus and credential publisher, then rerun sync.
- `RDP_PORT_MISMATCH`: restore the declared port and check for another listener occupying it.
- `RDP_RETIREMENT_FAILED`: restore the enrolled user session and confirm ownership of the managed credential service.
- `RDP_SERVICE_STOPPED`: check the desktop login and rerun sync to start the sharing service.
- `RDP_TLS_IDENTITY_MISMATCH`: verify the endpoint and certificate from the enrolled worker before using the saved connection. **Needs a person.**
- `TAILSCALE_SSH_MACOS_UNSUPPORTED`: use a supported open-source macOS tailscaled installation for native SSH. **Needs a person.**
- `TAILSCALE_SSH_NETWORK_REQUIRED`: declare the worker's tailnet name and account and verify its enrolled SSH route.
- `TAILSCALE_SSH_VERIFICATION_FAILED`: confirm both devices have tailnet SSH authorization, the expected host keys, and unconditional access for the enrolled accounts. Check the manager distribution and the sudo privileges of the accounts applying the change.

### Directed T3 grants

To authorize every enrolled environment's agents to work with full access on every other enrolled environment, set `t3.meshAccess` to `"full-access"` in fleet.json. Preview with `devfleet fleet-sync --dry-run`. Each `t3:mesh-link` names the source, destination and measured grant. An unreachable environment or changed identity is reported by `t3:mesh-member`. Restore its T3 service and enrolled tailnet connection, then run fleet-sync. Sync adopts healthy grants in place and replaces incorrect grants or grants expiring within seven days. Scheduled sync retries outstanding pairs. Use `devfleet fleet-status` to measure the links from their sources.

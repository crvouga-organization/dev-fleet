# Authentication and accounts

Where each credential homelab uses lives, who can read it, how it reaches
each node, how it rotates and what happens when it fails. The three tables
are generated from the code; `features/rules/authentication.feature` fails
when one is out of date (`HOMELAB_UPDATE_DOCS=1 bun test features/rules`
rewrites them).

## Where credentials live

| Credential                          | Lives in                                                                                                                       | Read by                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| The fleet's secrets (table below)   | The provider `secrets` names in `fleet.json`                                                                                   | The node that needs it, through `src/secrets.ts` |
| The bucket's two keys               | The environment of the `homelab` command; `~/.config/homelab/bucket.json` (0600) on the manager after `fleet-state --init`  | The manager only                                 |
| A node's Vault token                | That node's own Vault session (`~/.vault-token`)                                                                               | That node only; never copied                     |
| A node's GitHub login               | `gh`'s own store on that node                                                                                                  | `gh`, and git through its credential helper      |
| Provider accounts (Claude, Codex …) | The CLI proxy's store on the manager                                                                                           | The proxy; nodes hold only the proxy client key  |
| Tailscale and T3 pairing            | Each machine, signed in by a person; a replaced worker's T3 is paired by the manager with a one-time code it never writes down | That machine                                     |

## How they reach each node

- **Vault.** A person logs each machine in once (`sync` asks on the
  manager and passes the password to the worker over SSH on standard input).
  From then on the worker's `personal-worker-auth` timer renews its own token
  (`bootstrap/worker-auth.ts`). Nothing renders provider configuration from
  Vault on a worker: agent profiles come from `sync`.
- **GitHub.** The same job restores the declared account (`worker.githubLogin`)
  with the GitHub service token it reads from its own Vault session
  (`bootstrap/worker-github.ts`, on standard input, never argv). `sync`
  makes `gh` git's credential helper and writes the declared identity
  (`git` in `fleet.json`, `ansible/github/git.yml`) on every node.
- **The proxy client key** is read by each node from its own secrets provider
  whenever a launcher starts an agent. The node keeps the last key it read in
  `~/.cache/homelab/proxy-client-key` (0600) and uses it only while the
  provider cannot answer, so an unreachable Vault or an expired session leaves
  that node's agents working until the Vault checks below are fixed.
- **The monitoring hub's backup storage keys** are read on the manager by
  `sync` and handed to the hub's playbook in a private variables file.

## Rotation and failure

Rotate a secret where the provider keeps it; the next read uses it. Only the
proxy client key is remembered, and only as a fallback; a rotated key reaches
every node at its next launch, and `retire-key` should wait until every node
has launched an agent since the rotation. A Vault token that is not renewed expires: `worker:vault-renewal`
fails and the fix is one login of that machine.

Renewal does not keep every login alive. Vault extends a token only up to
its maximum lifetime (its own `explicit_max_ttl`, or the maximum of the auth
method that issued it, 32 days unless the Vault says otherwise) and answers a
renewal that reaches it with success and a shorter lifetime. A worker's token
is periodic and has no such end. The manager's is whatever its person logged
in with: a password login ends at that maximum however often it is renewed.
So the manager's renewal job asks for more than a day at every run
(`vaultRenewal` in `ansible/macos/policy.json`), and `manager:vault-renewal`
warns with `VAULT_LOGIN_EXPIRY_PENDING` from 24 hours before a login that
renewal cannot extend ends: one whose renewal was capped, one with a maximum
lifetime of its own, or one that is not renewable. The fix is one login of
the manager before then. A renewal job whose last run failed warns with
`VAULT_RENEWAL_FAILING`.

When the manager cannot read its secrets, that is one fault, and
`manager:vault-renewal` says which. A session that does not answer is asked
about twice: Vault's own status needs no login, so a Vault that answers it
leaves a lapsed login (`VAULT_LOGIN_REQUIRED`, fixed by one login), and one
that does not answer, or is sealed, is `VAULT_UNREACHABLE`, which no login
repairs. Either way every check on the manager that needed a secret (the
hub's account, tunnel, viewer and backups, a notification target, the
tailnet control plane's credential, the GitHub token, the proxy client key)
reports `SECRET_READ_BLOCKED by manager:vault-renewal` instead of a code of
its own, and `fleet-node-seed` refuses with the same words. A secret that is
absent while the manager can read its provider keeps the code of the check
that needs it.

A worker is the same with its own login. `worker:vault-renewal` owns it: a
session that does not answer while Vault does is
`UNATTENDED_VAULT_IDENTITY_REQUIRED`, fixed by the worker's token (the next
sync delivers it, `fleet-node-replace` issues a new one), and a Vault that
does not answer the worker, or is sealed, is `VAULT_UNREACHABLE`, which no
token repairs. The sync that would have delivered a token says the same as
`auth:vault` and delivers none. Every check on the worker that needed a
secret (`worker:github-sync`, `github:sync` and `github:token-current` for
the GitHub token, `worker:proxy-authentication` and
`provider:*:authentication` for the proxy client key) reports
`SECRET_READ_BLOCKED by worker:vault-renewal`. Vault answers a lapsed
session with the 403 of a policy that refuses, so
`VAULT_POLICY_PERMISSION_REQUIRED` is reported only for a session that
answers.

A reader gets this by handing the provider it read from to `unreadSecret`
(`src/secrets-blocked.ts`), with the owner of a worker's login when it runs
on one; `features/rules/secret-readers.feature` lists every reader. A GitHub token that stops
working fails `auth:github` and `worker:git-push-auth`; store the new one in
Vault and the worker restores itself within ten minutes. During a proxy
outage agents on workers wait: no worker is configured for native clients.
Every failure code is in [the runbooks](runbooks.md).

## The fleet's secrets

<!-- generated: secrets -->

| Secret                         | Required                     | `env` provider variable                       | `file` provider file                                     |
| ------------------------------ | ---------------------------- | --------------------------------------------- | -------------------------------------------------------- |
| `proxy-client-key`             | yes                          | `HOMELAB_SECRET_PROXY_CLIENT_KEY`             | `~/.config/homelab/secrets/proxy-client-key`             |
| `monitoring-account-password`  | yes                          | `HOMELAB_SECRET_MONITORING_ACCOUNT_PASSWORD`  | `~/.config/homelab/secrets/monitoring-account-password`  |
| `monitoring-tunnel-token`      | yes                          | `HOMELAB_SECRET_MONITORING_TUNNEL_TOKEN`      | `~/.config/homelab/secrets/monitoring-tunnel-token`      |
| `proxy-tunnel-token`           | yes                          | `HOMELAB_SECRET_PROXY_TUNNEL_TOKEN`           | `~/.config/homelab/secrets/proxy-tunnel-token`           |
| `github-token`                 | when its feature is declared | `HOMELAB_SECRET_GITHUB_TOKEN`                 | `~/.config/homelab/secrets/github-token`                 |
| `rdp-password`                 | when its feature is declared | `HOMELAB_SECRET_RDP_PASSWORD`                 | `~/.config/homelab/secrets/rdp-password`                 |
| `monitoring-backup-access-key` | when its feature is declared | `HOMELAB_SECRET_MONITORING_BACKUP_ACCESS_KEY` | `~/.config/homelab/secrets/monitoring-backup-access-key` |
| `monitoring-backup-secret-key` | when its feature is declared | `HOMELAB_SECRET_MONITORING_BACKUP_SECRET_KEY` | `~/.config/homelab/secrets/monitoring-backup-secret-key` |
| `notify-webhook-url`           | when its feature is declared | `HOMELAB_SECRET_NOTIFY_WEBHOOK_URL`           | `~/.config/homelab/secrets/notify-webhook-url`           |
| `notify-ntfy-url`              | when its feature is declared | `HOMELAB_SECRET_NOTIFY_NTFY_URL`              | `~/.config/homelab/secrets/notify-ntfy-url`              |
| `tailnet-auth-key`             | when its feature is declared | `HOMELAB_SECRET_TAILNET_AUTH_KEY`             | `~/.config/homelab/secrets/tailnet-auth-key`             |
| `tailnet-admin`                | when its feature is declared | `HOMELAB_SECRET_TAILNET_ADMIN`                | `~/.config/homelab/secrets/tailnet-admin`                |

<!-- end: secrets -->

## Checks of credentials

<!-- generated: checks -->

| Check                         | Measured in                                         |
| ----------------------------- | --------------------------------------------------- |
| `auth:github`                 | `src/github/checks.ts`                              |
| `auth:vault`                  | `src/auth-checks.ts`, `src/cli/fleet-sync-vault.ts` |
| `auth:vault-isolation`        | `src/cli/fleet-sync-vault.ts`                       |
| `worker:credential-renewal`   | `src/worker-host-checks.ts`                         |
| `worker:git-identity`         | `src/git-identity.ts`                               |
| `worker:git-push-auth`        | `src/definition.ts`, `src/git-identity.ts`          |
| `worker:git-signing`          | `src/definition.ts`, `src/git-identity.ts`          |
| `worker:github-sync`          | `src/worker-access-checks.ts`                       |
| `worker:proxy-authentication` | `src/worker-access-checks.ts`                       |
| `worker:rdp-credential`       | `src/screen-sharing.ts`                             |
| `worker:vault-renewal`        | `src/worker-access-checks.ts`                       |

<!-- end: checks -->

## Timers

<!-- generated: timers -->

| Timer                            | Declared in                            | Schedule                                      |
| -------------------------------- | -------------------------------------- | --------------------------------------------- |
| `personal-fleet-disk-gc.timer`   | `ansible/ubuntu/tasks/resources.yml`   | OnBootSec=10min, OnCalendar={{ gc_calendar }} |
| `personal-worker-auth.timer`     | `ansible/ubuntu/tasks/credentials.yml` | OnBootSec=2min, OnUnitActiveSec=10min         |
| `personal-worker-github.timer`   | `ansible/ubuntu/tasks/github.yml`      | OnBootSec=2min, OnUnitActiveSec=10min         |
| `personal-worker-recovery.timer` | `ansible/ubuntu/tasks/recovery.yml`    | OnBootSec=1min, OnUnitActiveSec=1min          |
| `personal-worker-recovery.timer` | `ansible/ubuntu/tasks/recovery.yml`    | OnBootSec=5min, OnUnitActiveSec=15min         |

<!-- end: timers -->

`gc_calendar` is `hourly`, or `*:0/15` when `storage.disposable` in `fleet.json`
is true (docs/ubuntu-sync.md, Disk GC).

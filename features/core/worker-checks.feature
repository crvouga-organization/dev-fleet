# ␊ stands for a line break.
Feature: What is measured on a worker
  A worker is measured where it runs, by commands that only read. A check
  passes on what was observed, never on what an installer once recorded, and
  it reports what it concluded, not what a command printed.

  Rule: A worker proves its access to the proxy without spending a request on a model

    Scenario: The proxy key reaches the proxy on standard input and nowhere else
      The worker reads its own key, lists the models of the proxy with it and
      looks up its own Vault token. The key is in no command line and in no
      check.
      Given these commands print:
        | command            | prints                                                 |
        | gh                 | example-user                                           |
        | vault token lookup | {"data":{"renewable":true,"period":86400,"ttl":80000}} |
        | vault              | PRIVATE_SENTINEL_TOKEN                                 |
      And every other command prints '{"data":[{"id":"model"}]}'
      When the access of the worker is checked
      Then every check passes
      And no command line contains "PRIVATE_SENTINEL_TOKEN"
      And every "curl" command was given "Authorization: Bearer PRIVATE_SENTINEL_TOKEN␊" on standard input
      And nothing reported contains "PRIVATE_SENTINEL_TOKEN"

  Rule: Unattended Vault access counts only when the worker's last renewal succeeded and its policy allows the read

    Background:
      Given these commands print:
        | command                                            | prints                                                 |
        | gh                                                 | example-user                                           |
        | vault token lookup                                 | {"data":{"renewable":true,"period":86400,"ttl":80000}} |
        | vault                                              | PRIVATE_SENTINEL_TOKEN                                 |
        | systemctl --user show personal-worker-auth.service | Result=success␊ExecMainStatus=0                        |
      And every other command prints '{"data":[{"id":"model"}]}'

    Scenario Outline: A renewal job whose last run <outcome> leaves "worker:vault-renewal" <verdict>
      An active timer says when renewal runs, not that it works.
      Given these commands print:
        | command                                            | prints    |
        | systemctl --user show personal-worker-auth.service | <renewal> |
      When the access of the worker is checked
      Then the check "worker:vault-renewal" <verdict>
      And the summary of the check "worker:vault-renewal" mentions "<summary>"
      And nothing reported contains "PRIVATE_SENTINEL"

      Examples:
        | outcome           | renewal                           | verdict | summary                 |
        | succeeded         | Result=success␊ExecMainStatus=0   | passes  | last renewal succeeded  |
        | failed            | Result=exit-code␊ExecMainStatus=1 | fails   | VAULT_RENEWAL_FAILING   |
        | has not run yet   | ExecMainStatus=0                  | passes  | last renewal succeeded  |

    Scenario: A Vault policy that refuses the proxy key is told apart from a missing login
      The token is valid, so the remedy is the policy, never a new secret.
      Given the command "vault kv get" fails with the error "Code: 403. Errors: * permission denied PRIVATE_SENTINEL"
      When the access of the worker is checked
      Then the check "worker:proxy-authentication" fails
      And the summary of the check "worker:proxy-authentication" mentions "VAULT_POLICY_PERMISSION_REQUIRED"
      And the remedy of the check "worker:proxy-authentication" mentions "seeds no secret"
      And the check "worker:vault-renewal" passes
      And nothing reported contains "PRIVATE_SENTINEL"

    Scenario Outline: A worker whose Vault token <situation> needs its own unattended identity
      Given the command "vault token lookup" <answer>
      When the access of the worker is checked
      Then the check "worker:vault-renewal" fails
      And the summary of the check "worker:vault-renewal" mentions "UNATTENDED_VAULT_IDENTITY_REQUIRED"

      Examples:
        | situation           | answer                                                          |
        | is missing          | fails                                                           |
        | cannot be renewed   | prints '{"data":{"renewable":false,"period":0,"ttl":3000}}'     |

  Rule: A secret the worker could not read is one fault, owned by the check of its own Vault login
    Every worker reads its secrets with a Vault session of its own. When that
    session has lapsed, or Vault does not answer the worker, the proxy key is
    neither missing nor forbidden by a policy: "worker:vault-renewal" owns the
    fault and says which it is, and the check that needed the key names it.
    Vault answers a lapsed session with the same 403 as a policy that
    refuses, so the session is asked for before a policy is blamed.

    Background:
      Given these commands print:
        | command                                            | prints                          |
        | gh                                                 | example-user                    |
        | systemctl --user show personal-worker-auth.service | Result=success␊ExecMainStatus=0 |
      And every other command prints '{"data":[{"id":"model"}]}'
      And the command "vault token lookup" fails

    Scenario Outline: A worker whose Vault <state> says so once, and its proxy check names that check
      Given the command "vault kv get" fails with the error "<refusal> PRIVATE_SENTINEL"
      And the command "vault status" <status>
      When the access of the worker is checked
      Then the check "worker:vault-renewal" fails
      And the summary of the check "worker:vault-renewal" mentions "<code>"
      And the remedy of the check "worker:vault-renewal" mentions "<remedy>"
      And the check "worker:proxy-authentication" fails
      And the summary of the check "worker:proxy-authentication" mentions "SECRET_READ_BLOCKED by worker:vault-renewal"
      And the remedy of the check "worker:proxy-authentication" mentions "<blocked>"
      And nothing reported contains "PRIVATE_SENTINEL"

      Examples:
        | state           | refusal                                   | status                  | code                               | remedy                                | blocked                                               |
        | session lapsed  | Code: 403. Errors: * permission denied    | prints '{"sealed":false}' | UNATTENDED_VAULT_IDENTITY_REQUIRED | Enroll this worker’s own periodic     | this machine is not logged in to the secrets provider |
        | does not answer | dial tcp: connect: connection refused     | fails                   | VAULT_UNREACHABLE                  | a new token does not help             | logging in again does not help                        |

    Scenario: A Vault that does not answer the worker is not answered with a new token
      Given the command "vault kv get" fails
      And the command "vault status" fails
      When the access of the worker is checked
      Then the summary of the check "worker:vault-renewal" mentions "VAULT_UNREACHABLE"
      And the remedy of the check "worker:vault-renewal" mentions "issue none"
      And the remedy of the check "worker:vault-renewal" mentions "vault status -address=https://vault.example.com"

  Rule: Recovery after a power loss never passes without a firmware setting that was read

    Scenario: A worker whose firmware cannot be read is skipped
      Given every command fails
      When the recovery of the worker after a power loss is checked
      Then the check "worker:power-loss-recovery" is skipped

    Scenario: A worker whose firmware powers on after a power loss passes
      Given every command prints:
        """
        {"BiosSettings":[{"Name":"AfterPowerLoss","BiosSettingCurrentValue":"Power On"}]}
        """
      When the recovery of the worker after a power loss is checked
      Then the check "worker:power-loss-recovery" passes

    Scenario: A setting written and waiting for the next boot already counts
      Given every command prints:
        """
        {"BiosSettings":[{"Name":"AfterPowerLoss","BiosSettingCurrentValue":"Power Off","BiosSettingTargetValue":"Power On"}]}
        """
      When the recovery of the worker after a power loss is checked
      Then the check "worker:power-loss-recovery" passes

    Scenario: A worker whose firmware stays off after a power loss fails
      Given every command prints:
        """
        {"BiosSettings":[{"Name":"AfterPowerLoss","BiosSettingCurrentValue":"Stay Off","BiosSettingPossibleValues":["Stay Off","Power On"]}]}
        """
      When the recovery of the worker after a power loss is checked
      Then the check "worker:power-loss-recovery" fails
      And the summary of the check "worker:power-loss-recovery" mentions "POWER_LOSS_RECOVERY_UNSET"
      And the remedy of the check "worker:power-loss-recovery" mentions "fleet-sync"

  Rule: The recovery watchdog counts only when its script is there and its last run succeeded
    The unit runs a copy installed outside every revision, so pruning old
    revisions cannot leave it pointing at nothing. An active timer says when
    the watchdog runs, not that it works.

    Background:
      Given these commands print:
        | command                                                   | prints         |
        | systemctl --user is-active personal-worker-recovery.timer | active         |
        | test -r /usr/local/lib/personal-fleet/t3-health.sh        |                |
        | systemctl --user show personal-worker-recovery.service    | Result=success |

    Scenario: A watchdog whose last run succeeded passes
      When the worker's service recovery is checked
      Then the check "worker:service-recovery" passes

    Scenario: A watchdog whose last run failed fails
      Given the command "systemctl --user show personal-worker-recovery.service" prints "Result=exit-code"
      When the worker's service recovery is checked
      Then the check "worker:service-recovery" fails
      And the summary of the check "worker:service-recovery" mentions "WORKER_RECOVERY_LAST_RUN_FAILED (exit-code)"

    Scenario: A watchdog whose script is missing fails
      Given the command "test -r /usr/local/lib/personal-fleet/t3-health.sh" fails
      When the worker's service recovery is checked
      Then the check "worker:service-recovery" fails
      And the summary of the check "worker:service-recovery" mentions "WORKER_RECOVERY_SCRIPT_MISSING"

    Scenario: A watchdog whose timer is not active fails
      Given the command "systemctl --user is-active personal-worker-recovery.timer" fails
      When the worker's service recovery is checked
      Then the check "worker:service-recovery" fails
      And the summary of the check "worker:service-recovery" mentions "WORKER_RECOVERY_TIMER_INACTIVE"

  Rule: The running T3 is the release that is installed, and a restart that waits says for how long
    The running server is asked for its version, so no "t3" on the search
    path is needed. A release installed beside a running app is pending until
    the app restarts into it, which waits for its agent turns to end. A
    worker that always runs a turn would wait for ever, so the recovery timer
    applies the restart 24 hours after it was first deferred (the policy's
    t3RestartMaxDeferralHours), and the turns still running then end. Until
    then the check says how long the restart has waited and when that
    deadline falls; past it, the recovery timer has not done its work.

    Background:
      Given these commands print:
        | command | prints                                          |
        | curl    | {"serverVersion":"0.1.9-nightly.20261111.4501"} |
        | cat     | T3-Code-0.1.9-nightly.20261111.4501-amd64.deb   |
      And the command "cat /run/user/1000/personal-t3-restart-pending" fails

    Scenario: A T3 that runs the installed release passes
      When the release of the running T3 is checked
      Then the check "t3:running-version" passes
      And no "t3" command was run

    Scenario: A release installed without a restart is pending, and the check names the wait and the deadline
      Given the command "cat" prints "T3-Code-0.1.10-nightly.20261112.4600-amd64.deb"
      And a restart of T3 has been deferred for 2 hours
      When the release of the running T3 is checked
      Then the check "t3:running-version" warns
      And the summary of the check "t3:running-version" mentions "T3_RESTART_PENDING"
      And the remedy of the check "t3:running-version" mentions "The restart has waited 2h 0m for agent turns to end."
      And the remedy of the check "t3:running-version" mentions "at the latest in 22h 0m, 24 hours after it was first deferred: the turns still running then end."

    Scenario: A restart deferred for another reason is pending although the release is the installed one
      A staged policy, or an app that must return to loopback, waits for the
      same restart: the worker has not converged until it happens.
      Given a restart of T3 has been deferred for 5 hours
      When the release of the running T3 is checked
      Then the check "t3:running-version" warns
      And the summary of the check "t3:running-version" mentions "T3_RESTART_PENDING"
      And the remedy of the check "t3:running-version" mentions "The restart has waited 5h 0m for agent turns to end."

    Scenario: A restart still pending after its deadline fails
      The recovery timer applies it at the deadline; one that waits longer
      was not applied.
      Given the command "cat" prints "T3-Code-0.1.10-nightly.20261112.4600-amd64.deb"
      And a restart of T3 has been deferred for 25 hours
      When the release of the running T3 is checked
      Then the check "t3:running-version" fails
      And the summary of the check "t3:running-version" mentions "T3_RESTART_PENDING"
      And the remedy of the check "t3:running-version" mentions "The restart has waited 25h 0m, longer than the 24 hours a restart is deferred at most, and personal-worker-recovery has not applied it."

    Scenario: A server that does not say its version is not taken to run the installed one
      Given the command "curl" fails
      When the release of the running T3 is checked
      Then the check "t3:running-version" fails
      And the summary of the check "t3:running-version" mentions "T3_RUNNING_VERSION_UNKNOWN"

  Rule: A restart applied at the deadline is reported, since it ended agent turns
    T3 cannot be told to stop accepting turns, so a restart at the deadline
    ends the turns that still run. The recovery service logs each one as
    T3_RESTART_DEADLINE; the check counts those of the last 24 hours and
    reports no line of the journal.

    Scenario: A worker whose restarts all found it idle passes
      Given the command "journalctl" fails
      When the restarts of T3 at a deadline are checked
      Then the check "worker:t3-deadline-restarts" passes

    Scenario: A restart at the deadline in the last 24 hours warns, and names nothing the journal said
      Given the command "journalctl --user --quiet --unit=personal-worker-recovery.service" prints "T3_RESTART_DEADLINE: PRIVATE_SENTINEL"
      When the restarts of T3 at a deadline are checked
      Then the check "worker:t3-deadline-restarts" warns
      And the summary of the check "worker:t3-deadline-restarts" mentions "T3 was restarted once in the last 24 hours at the deadline of a pending restart, although agent turns ran: they ended."
      And nothing reported contains "PRIVATE_SENTINEL"

    Scenario: A journal that cannot be read is not taken to hold no restart
      Given the command "journalctl" fails with the error "No journal files were opened due to insufficient permissions."
      When the restarts of T3 at a deadline are checked
      Then the check "worker:t3-deadline-restarts" warns
      And the summary of the check "worker:t3-deadline-restarts" mentions "could not be read"

  Rule: The homelab launcher is looked for, and nothing a command printed is reported

    Scenario: A launcher that is there passes, after one command that only reads
      Given every command prints "PRIVATE_SENTINEL"
      When the public homelab launcher is checked
      Then the check "workstation:configuration" passes
      And exactly 1 command was run
      And only "test" commands were run
      And nothing reported contains "PRIVATE_SENTINEL"

    Scenario: A launcher that is missing fails
      Given every command fails, printing "PRIVATE_SENTINEL"
      When the public homelab launcher is checked
      Then the check "workstation:configuration" fails
      And nothing reported contains "PRIVATE_SENTINEL"

  Rule: A failed service check names what was observed

    Scenario: A service with no unit file is reported as not installed
      When systemd shows the service "beszel-agent" as:
        """
        ActiveState=inactive
        UnitFileState=
        Restart=no
        """
      Then the service is reported as "SERVICE_NOT_INSTALLED beszel-agent.service (inactive, unit file missing, restart no)"

    Scenario: A service that failed is reported as not running
      When systemd shows the service "beszel-agent" as:
        """
        ActiveState=failed
        UnitFileState=enabled
        Restart=always
        """
      Then the report of the service starts with "SERVICE_NOT_RUNNING"

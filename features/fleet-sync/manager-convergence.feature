Feature: The manager converges itself before any worker
  The manager converges itself locally, never over SSH. It gets the same T3
  provider instances and the same proxy agent profiles as every worker, never
  sleeps on AC power, and hosts the fleet's services in Docker Desktop.

  Rule: T3 on the manager offers the managed provider instances

    Background:
      Given the proxy has these accounts signed in:
        | tool  | email         | prefix              | models |
        | codex | a@example.com | codex-a@example.com | gpt-x  |

    Scenario: A plan reports pending providers without writing
      Given T3 on the manager is configured with:
        """
        {"providerInstances":{"antigravity":{}}}
        """
      When the providers of "manager-mac" are planned
      Then the check's status is "warn"
      And the check's summary is "T3_PROVIDERS_PENDING"
      And T3 has exactly these provider instances:
        | antigravity |

    Scenario: Applying adds the declared providers and keeps the others
      Given T3 on the manager is configured with:
        """
        {"providerInstances":{"antigravity":{}}}
        """
      When the providers of "manager-mac" are applied
      Then the check's status is "pass"
      And T3 has exactly these provider instances:
        | antigravity                  |
        | personal_codex_a_example_com |
        | personal_gateway_models      |
        | personal_grok_proxy          |
      And the provider instance "personal_codex_a_example_com" is displayed as "Codex a@example.com"
      And the provider instances name "manager-mac"

    Scenario: An existing provider must open an authenticated T3 session on every sync
      Given the proxy has these accounts signed in:
        | tool        | email         | prefix                    | models |
        | antigravity | a@example.com | antigravity-a@example.com | gemini |
        | antigravity | b@example.com | antigravity-b@example.com | gemini |
      And T3 on the manager is configured with:
        """
        {"providerInstances":{"antigravity":{}}}
        """
      And the providers of "manager-mac" have been applied
      And T3 cannot authenticate instance "personal_antigravity_b_example_com"
      When the providers of "manager-mac" are applied
      Then the check's status is "fail"
      And the check's summary is "T3_ANTIGRAVITY_SESSION_UNVERIFIED: account positions 2 of 2."

    Scenario Outline: A worker refreshes its provider when the sync PATH omits the T3 CLI
      Given the worker's T3 CLI is <installation>
      When the worker verifies its Antigravity provider session
      Then the check's status is "<status>"
      And the check's summary is "<summary>"
      And the managed T3 CLI revoked <count> sessions

      Examples:
        | installation                         | status | summary                                                                   | count |
        | available only in its user install   | pass   | T3 reconciled its managed providers and authenticated all 1 Antigravity account sessions. | 1 |
        | missing from the user install too    | fail   | T3_CLI_MISSING                                                            | 0 |

    Scenario: Once applied, a plan has nothing left to do
      Given T3 on the manager is configured with:
        """
        {"providerInstances":{"antigravity":{}}}
        """
      And the providers of "manager-mac" have been applied
      When the providers of "manager-mac" are planned
      Then the check's status is "pass"

    Scenario: An unowned instance with a managed ID is reported, never overwritten
      Given T3 on the manager is configured with:
        """
        {"providerInstances":{"personal_grok_proxy":{"driver":"grok"}}}
        """
      When the providers of "manager-mac" are applied
      Then the check's status is "fail"
      And the check's summary is "T3_PROVIDER_CONFLICT"
      And the provider instances of T3 are exactly:
        """
        {"personal_grok_proxy":{"driver":"grok"}}
        """

    Scenario: A credential playbook that cannot run says so
      The account probe used to report only T3_PROVIDERS_UNVERIFIED, so a
      worker whose credential playbook failed looked like every other failure.
      Given T3 on the manager is configured with:
        """
        {"providerInstances":{"antigravity":{}}}
        """
      And the provider credential playbook cannot run
      When the providers of "manager-mac" are applied
      Then the check's status is "fail"
      And the check's summary is "T3_PROVIDERS_UNVERIFIED"
      And the check's remedy contains "Could not reconcile the local T3 provider credentials."

    Scenario: An unexpected provider failure is not copied into the report
      The failure can carry a credential. The check names the code and the
      dry-run, not the exception.
      Given T3 on the manager is configured with:
        """
        {"providerInstances":{"antigravity":{}}}
        """
      And provider reconciliation fails with "proxy-client-key=secret-value"
      When the providers of "manager-mac" are applied
      Then the check's status is "fail"
      And the check's summary is "T3_PROVIDERS_UNVERIFIED"
      And the check's remedy contains "t3-reconcile --dry-run"
      And the checks do not mention "secret-value"

  Rule: The manager applies every proxy agent profile the workers get

    One command applies them all: each start of the pinned Bun costs about
    as much as a profile does.

    Scenario: A profile is applied for every tool, by one command
      Given every agent profile applies cleanly
      When the agent profiles of "manager-mac" are applied
      Then the first check's status is "pass"
      And one command applied a profile for each of these tools, in this order:
        | codex       |
        | claude      |
        | gemini      |
        | opencode    |
        | grok        |
        | antigravity |
      And every profile was applied with "--yes"
      And every profile was applied with "--profile" set to "proxy"
      And every profile was applied with "--node" set to "manager-mac"

    Scenario: A failed profile fails the manager and names the tool to fix
      Given every agent profile applies cleanly, except that of "claude"
      When the agent profiles of "manager-mac" are applied
      Then the first check's status is "fail"
      And the first check's summary is "MANAGER_AGENT_PROFILES_FAILED"
      And the first check's remedy contains "--tool claude --profile proxy"

    Scenario: A failure that names no tool asks for all of them again
      Given no agent profile can be applied, and the command does not say which failed
      When the agent profiles of "manager-mac" are applied
      Then the first check's summary is "MANAGER_AGENT_PROFILES_FAILED"
      And the first check's remedy contains "--tool codex,claude,gemini,opencode,grok,antigravity --profile proxy"

  Rule: The manager never sleeps on AC power
    The check reads the settings from the policy file the playbook applies, so
    a setting added there is measured without a change here.

    Background:
      Given pmset reports on battery power:
        | sleep | 1 |
        | womp  | 0 |

    Scenario: A manager with every setting of its power policy passes
      Given pmset reports on AC power every setting the manager's power policy declares
      When the power settings of the manager are measured
      Then the check's status is "pass"

    Scenario: A manager that sleeps on AC power is named as such
      Given pmset reports on AC power every setting the manager's power policy declares, but "sleep" as "10"
      When the power settings of the manager are measured
      Then the check's summary is "MANAGER_SLEEPS_ON_POWER"

    Scenario: A setting this Mac does not have is not applicable
      A virtual Mac has no Wake-on-LAN, so pmset lists no womp; the playbook
      skips the setting and the check does not fail on it.
      Given pmset reports on AC power every setting the manager's power policy declares except "womp"
      When the power settings of the manager are measured
      Then the check's status is "pass"
      And the check's summary is "The manager never sleeps on AC power; not applicable on this Mac: womp."

    Scenario: Every other setting the policy declares is measured, and the remedy applies the playbook
      When each setting the manager's power policy declares, except "sleep", is in turn reported as "other" on a manager whose checkout is "/fleet/checkout"
      Then each time the check's status is "fail"
      And each time the check's summary is "MANAGER_POWER_POLICY_DRIFT" and the name of that setting
      And each time the check's remedy contains "cd /fleet/checkout && "
      And each time the check's remedy ends with "-K ansible/macos/manager-privilege.yml"

  Rule: Every applying sync applies the manager playbook like a worker's, with no prompt
    manager.yml is run in check mode first and applied only when that
    passes. A receipt skips an unchanged playbook while its postconditions
    hold (the power policy, the watch job), and a full re-apply comes at
    least once a day. What needs root goes through the grant
    manager-privilege.yml installs once, so nobody is asked for a password.

    Scenario: The playbook is checked, then applied, with the fleet's watch interval
      Given the manager playbook passes its check and passes when applied
      When an applying sync converges the manager's policy
      Then the check's status is "pass"
      And manager.yml was run, in this order:
        | check mode |
        | applied    |
      And manager.yml was never run with a password prompt
      And manager.yml was given the watch interval of 15 minutes and the default storage

    Scenario: A fleet whose storage is disposable gives the manager's disk GC that policy
      Given the manager playbook passes its check and passes when applied
      And fleet.json says storage is disposable
      When an applying sync converges the manager's policy
      Then the check's status is "pass"
      And manager.yml was given the watch interval of 15 minutes and disposable storage

    Scenario: A playbook whose check fails is not applied
      Given the manager playbook fails its check
      When an applying sync converges the manager's policy
      Then the check's status is "fail"
      And the check's summary is "MANAGER_PLAYBOOK_CHECK_FAILED"
      And the check's remedy contains "--check --diff"
      And manager.yml was run, in this order:
        | check mode |

    Scenario: A playbook that fails when applied fails the check
      Given the manager playbook passes its check and fails when applied
      When an applying sync converges the manager's policy
      Then the check's summary is "MANAGER_PLAYBOOK_FAILED"

    Scenario: An unchanged playbook whose postconditions hold is not run again
      Given the manager playbook passes its check and passes when applied
      And an applying sync converged the manager's policy
      When an applying sync converges the manager's policy 23 hours later
      Then the check's status is "pass"
      And manager.yml was run, in this order:
        | check mode |
        | applied    |

    Scenario: A day after it was applied, the playbook is applied again
      Given the manager playbook passes its check and passes when applied
      And an applying sync converged the manager's policy
      When an applying sync converges the manager's policy 25 hours later
      Then manager.yml was run, in this order:
        | check mode |
        | applied    |
        | check mode |
        | applied    |

    Scenario: A watch job that is gone is installed again, however fresh the receipt
      Given the manager playbook passes its check and passes when applied
      And an applying sync converged the manager's policy
      And launchd does not hold the manager's watch job
      When an applying sync converges the manager's policy 1 hours later
      Then manager.yml was run, in this order:
        | check mode |
        | applied    |
        | check mode |
        | applied    |

  Rule: Docker Desktop is measured against its pin and never fails the run
    The manager's services run in Docker Desktop, which no playbook installs
    and which updates itself.

    Scenario: The pin names a release and its build
      Then the Docker Desktop that mise.toml pins is named "Docker Desktop", a release number and a build number in brackets

    Scenario: The pinned release passes
      Given the Docker engine names itself as the Docker Desktop that mise.toml pins
      When the Docker Desktop of the manager is measured
      Then the check's status is "pass"

    Scenario: Another release warns
      Given the Docker engine names itself "Docker Desktop 0.0.1 (1)"
      When the Docker Desktop of the manager is measured
      Then the check's status is "warn"
      And the check's summary is "MANAGER_DOCKER_DESKTOP_DRIFT"

    Scenario: An engine that does not answer warns
      Given the Docker engine does not answer
      When the Docker Desktop of the manager is measured
      Then the check's status is "warn"
      And the check's summary is "MANAGER_DOCKER_DESKTOP_UNOBSERVED"

  Rule: The manager's Vault session renews itself
    Every worker renews its own Vault session; so does the manager, with a
    launch agent vault-renew.yml loads on every applying sync. Without it the
    session lapses while nobody runs converge. A lapsed session needs one
    login by a person.

    Scenario: An applying sync loads the renewal job for the fleet's Vault
      Given the manager is logged in to Vault
      When an applying sync holds the manager's Vault session
      Then the check's status is "pass"
      And vault-renew.yml was applied for "https://vault.example.com" without a password prompt

    Scenario: A manager whose renewal job is not loaded fails
      Given the manager is logged in to Vault
      And the manager's Vault renewal job is not loaded
      When the manager's Vault session is measured
      Then the check's summary is "VAULT_RENEWAL_MISSING"

    Scenario: A lapsed session names the one login that fixes it
      Given the manager's Vault session has lapsed
      When an applying sync holds the manager's Vault session
      Then the check's summary is "VAULT_LOGIN_REQUIRED"
      And the check's remedy contains "vault login -address=https://vault.example.com -method=userpass"

    Scenario: A Vault that does not answer is not a login to repeat
      A session that does not answer says nothing about why. Vault's status
      needs no login: when that fails too, the manager cannot reach Vault or
      Vault is sealed, and logging in again would fail the same way.
      Given Vault does not answer the manager
      When the manager's Vault session is measured
      Then the check's status is "fail"
      And the check's summary is "VAULT_UNREACHABLE"
      And the check's remedy contains "vault status -address=https://vault.example.com"
      And the check's remedy contains "logging in again does not help"
      And the check's remedy does not name "vault login"

  Rule: The manager warns a day before a login that renewal cannot extend ends
    Renewal does not keep every login alive. Vault extends a token only up to
    its maximum lifetime (its own, or that of the auth method that issued
    it), and answers a renewal that reaches it with success and a shorter
    lifetime. So the renewal job asks for more than the warning's lead time
    at every run: a renewal that left less is a login that ends then, and the
    manager says so while a person can still log in again.

    Background:
      Given the manager's Vault renewal job is loaded

    Scenario: The renewal job asks for more than the lead time of the warning
      Then the macOS policy has the renewal job ask Vault for 48 hours, and the manager warn 24 hours before a login ends
      And "ansible/macos/vault-renew.yml" renews for the hours the macOS policy names

    Scenario Outline: A login <situation> passes
      Given the manager's Vault token is renewable, with <left> seconds left, 600 seconds after a renewal that left it <granted>
      When the manager's Vault session is measured
      Then the check's status is "pass"

      Examples:
        | situation                                               | left   | granted |
        | renewed in full                                         | 172200 | 172800  |
        | whose renewal was capped two days before its end        | 171000 | 171600  |
        | whose renewal was capped just over a day before its end | 86400  | 87000   |

    Scenario Outline: A login whose renewal was capped <situation> warns, and names the login that replaces it
      Given the manager's Vault token is renewable, with <left> seconds left, 600 seconds after a renewal that left it <granted>
      When the manager's Vault session is measured
      Then the check's status is "warn"
      And the check's summary is "VAULT_LOGIN_EXPIRY_PENDING"
      And the check's remedy contains "ends <when>"
      And the check's remedy contains "vault login -address=https://vault.example.com -method=userpass"

      Examples:
        | situation                       | left  | granted | when              |
        | just under a day before its end | 85700 | 86300   | in about 23 hours |
        | hours before its end            | 7500  | 8100    | in about 2 hours  |
        | minutes before its end          | 300   | 900     | within the hour   |

    Scenario Outline: A token that is not renewable ends at its lifetime, whatever the job does
      Renewing it fails, which is its nature and not a fault of the job.
      Given the manager's Vault token is not renewable, with <left> seconds left
      And the last run of the manager's Vault renewal job ended with the exit code 2
      When the manager's Vault session is measured
      Then the check's status is "<status>"

      Examples:
        | left   | status |
        | 864000 | pass   |
        | 36000  | warn   |

    Scenario: A token that is not renewable says so a day before it ends
      Given the manager's Vault token is not renewable, with 36000 seconds left
      When the manager's Vault session is measured
      Then the check's summary is "VAULT_LOGIN_EXPIRY_PENDING"
      And the check's remedy contains "ends in about 10 hours"
      And the check's remedy contains "its token is not renewable"

    Scenario: A login nobody renewed yet is not judged by the lifetime it was issued with
      The job renews it within ten minutes; a capped renewal shows then.
      Given the manager's Vault token is renewable, with 3600 seconds left
      When the manager's Vault session is measured
      Then the check's status is "pass"

    Scenario: A periodic token is renewed for as long as the job runs
      Given the manager's Vault token is renewable, with 3000 seconds left, 600 seconds after a renewal that left it 3600
      And that token is periodic, renewed for 3600 seconds at a time
      When the manager's Vault session is measured
      Then the check's status is "pass"

    Scenario: A token with a maximum lifetime of its own warns a day before it, however much a renewal left
      Given the manager's Vault token is renewable, with 86400 seconds left, 0 seconds after a renewal that left it 86400
      And that token is periodic, renewed for 86400 seconds at a time
      And that token was created 90000 seconds ago with a maximum lifetime of 108000 seconds
      When the manager's Vault session is measured
      Then the check's summary is "VAULT_LOGIN_EXPIRY_PENDING"
      And the check's remedy contains "ends in about 5 hours"

    Scenario: A renewal job whose last run failed is reported, not hidden with its output
      The job's output is dropped because a renewal prints the token, so how
      its last run ended is the only thing that says it fails.
      Given the manager's Vault token is renewable, with 100000 seconds left, 72800 seconds after a renewal that left it 172800
      And the last run of the manager's Vault renewal job ended with the exit code 2
      When the manager's Vault session is measured
      Then the check's status is "warn"
      And the check's summary is "VAULT_RENEWAL_FAILING"
      And the check's remedy contains "exit 2"
      And the check's remedy contains "lapses in about 27 hours"

    Scenario: Looking the token up prints the token, which reaches no report
      Given the manager's Vault token is renewable, with 300 seconds left, 600 seconds after a renewal that left it 900
      And looking that token up also prints the token "hvs.PRIVATE_SENTINEL_TOKEN"
      When the manager's Vault session is measured
      Then the check's summary is "VAULT_LOGIN_EXPIRY_PENDING"
      And the checks do not mention "hvs.PRIVATE_SENTINEL_TOKEN"

  Scenario Outline: The manager measures account quota separately from native inference
    When a proxy source at "<source>" reports Antigravity windows last read <age> minutes ago
    Then the account quota check reports "<status>"

    Examples:
      | source | age | status |
      | /hub   | 1   | pass   |
      | /other | 1   | warn   |
      | /hub   | 30  | warn   |

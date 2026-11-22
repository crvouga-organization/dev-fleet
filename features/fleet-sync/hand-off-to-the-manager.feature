Feature: fleet-sync started on a worker is handed to the manager
  fleet-sync only ever runs on the manager. Started anywhere else, the same
  request goes to the manager over host-key-verified SSH (no agent forwarding,
  no credentials copied) and the manager's result is reported unchanged.

  Background:
    Given devfleet runs from "/no-checkout" with the roster "/no-roster"

  Rule: The hand-off is one SSH command that cannot hand off again

    Scenario: The hand-off reaches the manager over verified SSH and never hands off again
      When a worker prepares to hand "fleet-sync --json" at revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" to the manager
      Then the SSH command connects as the user "dev" to "manager-mac-1.tail0a1b2c.ts.net"
      And the SSH command has these arguments:
        | StrictHostKeyChecking=yes |
        | -a                        |
      And what the manager is asked to run contains:
        | PERSONAL_FLEET_NO_FORWARD=1              |
        | fleet-sync                               |
        | aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa |

    Scenario: With the revision's run script the manager runs that exact revision
      Given the run script tracked at the revision is:
        """
        #!/bin/sh
        echo run
        """
      When a worker prepares to hand "fleet-sync --node w1 --json" at revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" to the manager
      Then what the manager is asked to run contains:
        | fleet-manager-run                        |
        | aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa |
        | --json                                   |
      But what the manager is asked to run does not contain "devfleet"

    Scenario: Without a revision there is nothing to pin, so the manager's installed launcher runs
      Given the run script tracked at the revision is:
        """
        #!/bin/sh
        echo run
        """
      When a worker prepares to hand "fleet-sync" with no revision to the manager
      Then what the manager is asked to run names "devfleet" directly followed by "fleet-sync"
      But what the manager is asked to run does not contain "fleet-manager-run"

    Scenario: The hand-off preserves the request
      When a worker prepares to hand "fleet-sync --node w1 --node w2 --dry-run --json --schedule status" at revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" to the manager
      Then the manager is asked for exactly "--revision aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --node w1 --node w2 --schedule status --dry-run --json"

    Scenario: The hand-off keeps the request to restart a busy T3
      When a worker prepares to hand "fleet-sync --restart-busy --dry-run" at revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" to the manager
      Then the manager is asked for exactly "--revision aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --restart-busy --dry-run"

    Scenario: The hand-off keeps the request to take the manager lease over
      fleet-sync also runs itself again from the checkout of the revision;
      a replacement manager that asked for the lease must still hold the
      request there, or it is told to ask for what it asked for.
      When a worker prepares to hand "fleet-sync --take-over --yes" at revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" to the manager
      Then the manager is asked for exactly "--revision aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --yes --take-over"

  Rule: The manager is asked whether the default branch holds the revision, before the revision's run script
    The run script installs the revision's toolchain on the manager. A
    revision that is not on the default branch of the source repository gets
    that far only with --allow-unmerged.

    Background:
      Given the run script tracked at the revision is:
        """
        #!/bin/sh
        echo run
        """

    Scenario: The guard runs first, against the manager's own copy of the source repository
      When a worker prepares to hand "fleet-sync --json" at revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" to the manager
      Then what the manager is asked to run contains:
        | $HOME/.local/share/personal/fleet/manager/source |
        | merge-base --is-ancestor                         |
        | refs/remotes/origin/HEAD                         |
      And what the manager is asked to run names "fleet-revision-guard" before "fleet-manager-run"

    Scenario: --allow-unmerged skips the guard, and the manager is told rather than given a flag
      The run on the manager is the revision's own code, which may be older
      than the flag: it is told what selected its revision instead.
      Given the worker "worker-one" selected the revision from "checkout" with --allow-unmerged
      When a worker prepares to hand "fleet-sync --allow-unmerged --json" at revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" to the manager
      Then what the manager is asked to run does not contain "fleet-revision-guard"
      And what the manager is asked to run contains:
        | aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:checkout@worker-one+unmerged |
      And the manager is asked for exactly "--revision aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --json"

    Scenario: With no revision to say it about, --allow-unmerged reaches the manager's launcher
      When a worker prepares to hand "fleet-sync --allow-unmerged" with no revision to the manager
      Then what the manager is asked to run names "fleet-sync" directly followed by "--allow-unmerged"

    Scenario Outline: "<request>" converges nothing, so the guard is left out
      When a worker prepares to hand "fleet-sync <request>" at revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" to the manager
      Then what the manager is asked to run does not contain "fleet-revision-guard"

      Examples:
        | request                         |
        | --schedule status               |
        | --schedule pause --apply --yes  |
        | --schedule disable --apply --yes |

    Scenario: The manager is told what selected the revision, and which worker hands it off
      Words and the worker's fleet id only: the run on the manager is always
      given --revision, which says nothing about who chose it.
      Given the worker "worker-one" selected the revision from "checkout"
      When a worker prepares to hand "fleet-sync --json" at revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" to the manager
      Then what the manager is asked to run contains:
        | DEVFLEET_SELECTED_BY                                        |
        | aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:checkout@worker-one |

    Scenario: The mise guard runs after the question about the default branch and before the run script
      A revision whose bootstrap is from before the rule that keeps a newer
      mise would replace the manager's with the older one it pins.
      When a worker prepares to hand "fleet-sync --json" at revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" to the manager
      Then what the manager is asked to run contains:
        | $HOME/.local/bin/mise                    |
        | aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa |
      And what the manager is asked to run names "fleet-revision-guard" before "fleet-mise-guard"
      And what the manager is asked to run names "fleet-mise-guard" before "fleet-manager-run"

    Scenario: --allow-mise-downgrade skips the mise guard, and the manager is told rather than given a flag
      The run on the manager is the revision's own code, which may be older
      than the flag: it is told in its environment, about the one revision.
      When a worker prepares to hand "fleet-sync --allow-mise-downgrade --json" at revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" to the manager
      Then what the manager is asked to run does not contain "fleet-mise-guard"
      And what the manager is asked to run contains:
        | DEVFLEET_MISE_DOWNGRADE_ALLOWED=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa |
        | fleet-revision-guard                                                   |
      And the manager is asked for exactly "--revision aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --json"

    Scenario: With no revision to say it about, --allow-mise-downgrade reaches the manager's launcher
      When a worker prepares to hand "fleet-sync --allow-mise-downgrade" with no revision to the manager
      Then what the manager is asked to run names "fleet-sync" directly followed by "--allow-mise-downgrade"

    Scenario: A request about the schedule converges nothing now, so the mise guard is left out
      The runs the schedule starts are asked when they start.
      When a worker prepares to hand "fleet-sync --schedule enable --apply --yes" at revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" to the manager
      Then what the manager is asked to run does not contain "fleet-mise-guard"

    Scenario: A mise guard that exits with 67 is reported as FLEET_MISE_DOWNGRADE, and nothing ran
      Given the manager answers the hand-off with exit code 67 and nothing
      When "fleet-sync --json" at revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" is handed to the manager
      Then the command exits with 1
      And the report has:
        | code     | FLEET_MISE_DOWNGRADE                     |
        | revision | aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa |
      And the report mentions "--allow-mise-downgrade"

    Scenario Outline: A guard that exits with <exit> is reported as <code>, and nothing ran
      Given the manager answers the hand-off with exit code <exit> and nothing
      When "fleet-sync --json" at revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" is handed to the manager
      Then the command exits with 1
      And the report has:
        | code     | <code>                                   |
        | revision | aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa |
      And the report mentions "--allow-unmerged"

      Examples:
        | exit | code                      |
        | 65   | FLEET_REVISION_UNMERGED   |
        | 66   | FLEET_REVISION_UNVERIFIED |

  Rule: A worker reports what the manager answered and runs nothing itself

    Scenario: A worker hands fleet-sync to the manager and reports its result
      Given this machine is a worker, where no command is found
      And the manager answers the hand-off with exit code 0 and:
        """
        {"ok":true}
        """
      When fleet-sync is started with "--revision aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --json"
      Then 1 command was handed to the manager
      And the result is exactly exit code 0 and the report:
        """
        {"ok":true}
        """

    Scenario: An unreachable manager is reported, not a partial run on the worker
      Given the manager answers the hand-off with exit code 255 and nothing
      When "fleet-sync" at revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" is handed to the manager
      Then the command exits with 1
      And the report has:
        | code | FLEET_MANAGER_UNREACHABLE |

    Scenario: A test can never reach the real manager
      Given nothing stands in for the SSH connection to the manager
      When "fleet-sync" at revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" is handed to the manager
      Then the hand-off is refused with "FLEET_FORWARD_IN_TEST"

    Scenario: Off the manager with hand-off disabled, nothing runs
      Given this machine is a worker, where no command is found
      And the environment sets "PERSONAL_FLEET_NO_FORWARD" to "1"
      And a hand-off would fail the scenario
      When fleet-sync is started with "--revision aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --json"
      Then the command exits with 1
      And the report mentions "FLEET_NOT_MANAGER"
      And the report mentions "always a macOS machine"
      And nothing but "scutil" was run

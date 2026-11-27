Feature: homelab converge refuses before it changes anything
  A request that cannot be carried out is answered with a report and a
  nonzero exit code, without a write, an SSH connection or a login. An unsafe
  combination of options is a usage error.

  Rule: Off the manager, fleet-sync reports and changes nothing
    Hand-off is disabled in every scenario here: a test never hands off to the
    real manager over SSH.

    Background:
      Given homelab "0.1.0" runs from "/no-checkout" with the roster "/no-roster"
      And the environment sets "PERSONAL_FLEET_NO_FORWARD" to "1"

    Scenario: A preview reports the manager's scope and applies nothing
      When the operator runs "homelab converge --revision aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --dry-run --json"
      Then the command exits with 1
      And the report has:
        | command         | converge                                 |
        | applied         | false                                    |
        | desiredRevision | aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa |
      And the manager keeps reports under ".local/share/personal/fleet/manager/reports" in the temporary test home

    Scenario: A noninteractive sync cannot enroll or log in without confirmation
      When the operator runs "homelab converge --revision aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --non-interactive --json"
      Then the command exits with 1
      And the report has:
        | applied   | false        |
        | version   | 3            |
        | execution | manager-push |

    Scenario Outline: Selecting workers with "<selection>" needs a roster, and tailnet discovery never stands in for one
      When the operator runs "homelab converge <selection> --revision aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --dry-run --json"
      Then the command exits with 1

      Examples:
        | selection      |
        | --all          |
        | --node unknown |

    Scenario: The help page names the safety flags, without a checkout
      When the operator runs "homelab converge --help"
      Then the command exits with 0
      And the command's output names each of:
        | --dry-run  |
        | --node     |
        | --all      |
        | --apply    |
        | --yes      |
        | --revision |
        | --allow-unmerged |
        | --allow-mise-downgrade |

  Rule: An approval is bound to the plan it approved

    Scenario: A stale approved plan fails before the source is prepared or SSH is used
      Given homelab "0.1.0" runs from "/no-checkout" with the roster "/no-roster"
      And the roster file enrolls:
        | id         | ssh        | workspace |
        | worker-one | worker-one | /fixture  |
      And any command would fail the scenario
      When the manager applies "converge --revision aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --apply --yes --json" to the selected workers, approved for the plan fingerprint "stale-fixture"
      Then no command was run
      And the report mentions "FLEET_PLAN_STALE"
      And the command exits with 1

  Rule: The one public parser keeps the fleet's defaults and refuses unsafe options

    Background:
      Given homelab "test" runs from "/missing-workspace" with the roster "/missing-roster"

    Scenario: Requiring "none" requires no capability
      When the capabilities "none" are required
      Then no capability is required

    Scenario: By default every capability but "worker" is required
      When no capability is named
      Then every capability homelab knows is required, except "worker"

    Scenario: With no command at all, homelab succeeds
      When the operator runs "homelab"
      Then the command exits with 0

    Scenario Outline: "homelab <arguments>" is refused as a usage error
      When the operator runs "homelab <arguments> --json"
      Then the command exits with 2

      Examples:
        | arguments                             |
        | repair --apply                  |
        | check --apply --yes            |
        | check --pull                   |
        | check --local --node dev-one   |
        | check --timeout Infinity       |
        | check --timeout 0              |
        | check --require made-up        |
        | check --tailnet --require none |
        | tailnet --local                |
        | converge --force                    |
        | converge --maintenance-reboot --dry-run |
        | fleet-unknown                         |
        | fleet doctor                          |
        | converge --restart-busy --only accounts |
        | converge --restart-busy --schedule enable |
        | converge --allow-unmerged --schedule enable |
        | converge --allow-unmerged --only accounts |
        | converge --allow-mise-downgrade --schedule enable |
        | converge --allow-mise-downgrade --only accounts |
        | converge --measure-mise |
        | converge --measure-mise --revision aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --dry-run |
        | converge --measure-mise --revision aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --allow-mise-downgrade |

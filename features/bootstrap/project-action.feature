Feature: Checkout project actions run homelab
  A T3 project script in a homelab checkout calls bootstrap/project-action.sh.
  It warms the pinned toolchain, then runs one homelab command. converge and
  converge-local take that checkout's HEAD. A revision the caller already
  named is kept, and rollback, the schedule and an accounts-only run choose
  their own revision.

  Background:
    Given a checkout whose project action stands in for the toolchain and for homelab

  Rule: converge takes this checkout

    Scenario: Sync converges to this checkout
      When the project action "converge" runs
      Then the toolchain was warmed
      And homelab was asked to converge to that checkout

    Scenario: A dry run is forwarded and still names that checkout
      When the project action "converge --dry-run" runs
      Then homelab was asked to converge to that checkout with "--dry-run"

    Scenario: A named revision is kept
      When the project action "converge --revision aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" runs
      Then homelab was asked to "converge --revision aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

    Scenario: A named revision written as one argument is kept
      When the project action "converge --revision=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" runs
      Then homelab was asked to "converge --revision=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

    Scenario: Rollback chooses the revision itself
      When the project action "converge --rollback" runs
      Then homelab was asked to "converge --rollback"

    Scenario: A schedule request keeps the revision the schedule owns
      When the project action "converge --schedule status" runs
      Then homelab was asked to "converge --schedule status"

    Scenario: An accounts-only run does not move the fleet to this checkout
      When the project action "converge --only accounts" runs
      Then homelab was asked to "converge --only accounts"

    Scenario: sync is converge
      When the project action "sync" runs
      Then homelab was asked to converge to that checkout

    Scenario: Node sync previews this checkout
      When the project action "converge-local --dry-run" runs
      Then homelab was asked to converge this machine to that checkout with "--dry-run"

  Rule: The other actions are the current homelab commands

    Scenario Outline: "<action>" runs "<command>"
      When the project action "<action>" runs
      Then the toolchain was warmed
      And homelab was asked to "<command>"

      Examples:
        | action                                | command                         |
        | check                                 | check                           |
        | status                                | check --workers                 |
        | status --local                        | check --local                   |
        | status --node node-a                  | check --node node-a             |
        | repair                                | repair                          |
        | repair --list                         | repair --list                   |
        | tailnet                               | tailnet                         |
        | workers --onboard                     | workers --onboard               |
        | state --export                        | state --export                  |
        | proxy model-health                    | proxy model-health              |
        | infra-cliproxy model-suite --target mock | proxy model-suite --target mock |

  Rule: Setup alone, and a name that is not a command, change nothing else

    Scenario: warm only warms the toolchain
      When the project action "warm" runs
      Then the toolchain was warmed
      And homelab was not run
      And it exits with 0

    Scenario: An unknown action is refused before the toolchain is warmed
      When the project action "fleet-sync" runs
      Then it exits with 2
      And the toolchain was not warmed
      And homelab was not run

    Scenario: No action is refused before the toolchain is warmed
      When the project action runs with no name
      Then it exits with 2
      And the toolchain was not warmed
      And homelab was not run

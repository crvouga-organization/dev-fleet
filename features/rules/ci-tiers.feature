Feature: Checks run in tiers and a failure stays queued

  A pull request aims to finish in under five minutes, a release in under ten
  and a night in under forty-five. The night is its own workflow, so a green
  night does not publish a release.

  Scenario: A readme change checks the repository and skips the slow machines
    When the pull request tier is planned for:
      | README.md |
    Then the plan runs "check"
    And the plan runs no feature
    And the plan skips "fresh"
    And the plan skips "agent"
    And the plan skips "manager_playbook"
    And the plan skips "manager_tests"

  Scenario: A releasing document change runs the rules that name it
    When the pull request tier is planned for:
      | docs/releasing.md |
    Then the plan runs "check"
    And the plan runs the "rules" feature
    And the plan skips "fresh"
    And the plan skips "agent"
    And the plan skips "manager_playbook"
    And the plan skips "manager_tests"

  Scenario: A bootstrap change runs one fresh worker
    When the pull request tier is planned for:
      | src/remote-bootstrap.ts |
    Then the plan runs "fresh"
    And the plan skips "agent"
    And the plan's fresh matrix is exactly:
      | release | architecture | runner        | feature   |
      | 26.04   | amd64        | ubuntu-latest | fresh-box |

  Scenario: A release runs the newest Ubuntu on both architectures
    When the release tier is planned
    Then the plan runs "agent"
    And the plan runs "check"
    And the plan runs every feature
    And the plan lists the affected job and each job it runs
    And the plan's fresh matrix is exactly:
      | release | architecture | runner           | feature   |
      | 26.04   | amd64        | ubuntu-latest    | fresh-box |
      | 26.04   | arm64        | ubuntu-24.04-arm | fresh-box |

  Scenario: A night runs every accepted release, architecture and fresh worker feature
    When the nightly tier is planned
    Then the plan runs "fresh"
    And the plan runs "agent"
    And the plan skips "check"
    And the plan skips "manager"
    And the plan's fresh matrix is every release, architecture and feature of "features/fresh-box"

  Scenario: A manager playbook change converges the manager and skips the fresh worker
    When the pull request tier is planned for:
      | ansible/macos/manager.yml |
    Then the plan runs "manager_playbook"
    And the plan runs "manager_tests"
    And the plan skips "fresh"
    And the plan skips "agent"

  Scenario: A change to the checks themselves runs the whole pull request set
    When the pull request tier is planned for:
      | .github/workflows/ci.yml |
    Then the plan runs "check"
    And the plan runs "fresh"
    And the plan runs "manager_playbook"
    And the plan runs "manager_tests"
    And the plan runs "ansible"
    And the plan runs "state"
    And the plan runs "workflows"
    And the plan runs "proxy"
    And the plan runs "cliproxy"
    And the plan runs every feature
    And the plan skips "agent"
    And the plan lists the affected job and each job it runs

  Scenario: An empty diff runs the whole pull request set
    When the pull request tier is planned for nothing
    Then the plan skips "agent"
    And the plan runs "fresh"
    And the plan runs every feature

  Scenario: A dependency change runs every feature and skips the fresh worker
    When the pull request tier is planned for:
      | package.json |
    Then the plan runs every feature
    And the plan runs "state"
    And the plan runs "manager_tests"
    And the plan skips "manager_playbook"
    And the plan skips "fresh"
    And the plan skips "agent"

  Scenario: The event decides the tier
    Then "workflow_dispatch" of "main" on "main" is the "release" tier
    And "workflow_dispatch" of "renovate/foo" on "main" is the "pr" tier
    And "pull_request" of "feature" on "main" is the "pr" tier
    And "push" of "main" on "main" is the "release" tier
    And "schedule" of "main" on "main" is the "nightly" tier

  Scenario: A failed job is queued and a passed job closes its issue
    Then a "failure" result is "upsert"
    And a "cancelled" result is "upsert"
    And a "success" result is "close"
    And a "skipped" result is "leave"
    And the issue for tier "pr" and job "check" is titled "CI failure: pr / check"

  Scenario: CI checks a pull request, a push to main and a dispatch, and a night is its own workflow
    Then the "CI" workflow runs on "pull_request"
    And the "CI" workflow runs on "push"
    And the "CI" workflow runs on "workflow_dispatch"
    And the "CI" workflow does not run on "schedule"
    And its "affected" job has no condition
    And its "affected" job runs "bun .github/scripts/affected.ts"
    And its "required" job runs "bun .github/scripts/ci-issues.ts"
    And each tiered job times out at the tier ceiling
    And the "Nightly" workflow runs on "schedule"
    And the "Nightly" workflow runs on "workflow_dispatch"
    And the "Nightly" workflow does not run on "pull_request"
    And its "affected" job runs "bun .github/scripts/affected.ts nightly"
    And its "fresh-box" job takes its matrix from the affected job
    And its "fresh-box" job times out after 30 minutes
    And its "gate" job runs "bun .github/scripts/ci-issues.ts"
    And ".github/workflows/nightly.yml" does not contain "Required checks"
    And ".github/workflows/nightly.yml" does not contain "release.yml"

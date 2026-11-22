Feature: A pull request reaches a release with nobody attending
  Most changes are made by agents, many at once. A pull request is merged the
  moment its checks pass, and the merge is checked on main and released.

  Scenario: One check stands for every job of a pull request
    The ruleset of main requires this one check, so a job that is added,
    renamed or split is required from the pull request that does it.
    Then every other job of the "CI" workflow is needed by its "required" job
    And its "required" job runs whatever became of them
    And its "required" job runs "all(.[]; .result == \"success\")"

  Scenario: A newer push replaces the run of a pull request, and a run on main is never cut short
    A run that is cut short on main releases nothing, so merges that follow
    one another closely would never be released.
    Then the "CI" workflow cancels a run in progress only for "pull_request"

  Scenario: Adding a label to a pull request does not start its checks again
    Then the "CI" workflow runs on "pull_request" only when one is:
      | opened           |
      | synchronize      |
      | reopened         |
      | ready_for_review |

  Scenario: Every pull request from a branch of the repository merges itself
    GitHub's native auto-merge is enabled when a pull request opens; nothing
    polls for pull requests to merge.
    Then the "Auto-merge" workflow runs on "pull_request"
    And the "Auto-merge" workflow runs on "pull_request" only when one is:
      | opened           |
      | reopened         |
      | ready_for_review |
    And its "enable" job runs "gh pr merge --auto --squash"

  Scenario: A merge that started no checks on main gets them, and its release
    A merge made with a workflow's own token starts no workflow. Each pull
    request that opens, and once a day, starts CI on main when its newest
    commit has no run. That run, started with the same token, starts no
    release when it ends, so its last job starts the release.
    Then the "Catch up main" workflow runs on "schedule"
    And its "reconcile" job runs "gh workflow run ci.yml"
    And the "CI" workflow runs on "workflow_dispatch"
    And the "CI" workflow runs on "pull_request"
    And its "required" job runs "gh workflow run release.yml"
    And the "Release" workflow runs on "workflow_dispatch"
    And the "Release" workflow follows the "CI" workflow

  Scenario: The issues a merged pull request fixes are closed
    A merge made with a workflow's own token does not close the issues its
    pull request names with "Fixes".
    Then the "Catch up main" workflow runs on "schedule"
    And its "reconcile" job runs "gh issue close"
    And its "reconcile" job runs "closingIssuesReferences"

  Scenario: A pull request a workflow opens is checked like any other
    Then the "Pins" workflow runs on "schedule"
    And its "pin" job runs "gh workflow run ci.yml --ref \"$branch\""
    And its "pin" job runs "gh pr merge --auto --squash"

  Scenario: A failed VM test keeps its evidence
    Then the "Ubuntu VM" workflow runs on "workflow_dispatch"
    And its "vm" job keeps "~/.cache/fleet-vm-*/vm/*.log" when it fails

Feature: Every fleet-sync run is kept in a history, and fleet-report says how reliable it is
  The history is a document in the fleet state, so it goes to the bucket with
  the rest and survives the manager. It keeps check IDs and machine names
  only, and is capped by age and by count.

  Background:
    Given a fleet state of its own, holding no history

  Scenario: A run is recorded with its duration, its failing checks and the machines that were not ready
    When fleet-sync records the run of "2026-11-01T10:00:00Z" to "2026-11-01T10:02:30Z" that ended with 1 and reported:
      """
      {
        "ok": false,
        "desiredRevision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "checks": [{ "id": "tailnet:health", "status": "pass" }],
        "nodes": [
          { "node": "manager", "checks": [{ "id": "manager:docker", "status": "pass" }] },
          {
            "node": "worker-one",
            "checks": [
              { "id": "ssh:timeout", "status": "fail", "remedy": { "action": "PRIVATE remedy" } },
              { "id": "tool:node", "status": "fail" }
            ]
          }
        ]
      }
      """
    Then the history holds this run:
      | trigger    | schedule                                 |
      | ok         | false                                    |
      | exitCode   | 1                                        |
      | durationMs | 150000                                   |
      | revision   | aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa |
      | failing    | ssh:timeout, tool:node                   |
      | not ready  | worker-one                               |

  Scenario: A run is recorded with what selected its revision
    Words and a worker's fleet id only; anything else a report says there is
    left out.
    When fleet-sync records the run of "2026-11-01T10:00:00Z" to "2026-11-01T10:01:00Z" that ended with 0 and reported:
      """
      {
        "ok": true,
        "desiredRevision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "selectedBy": { "by": "revision", "handOff": { "worker": "worker-one" }, "account": "PRIVATE" },
        "checks": [],
        "nodes": []
      }
      """
    Then the history holds this run:
      | trigger     | schedule                                 |
      | ok          | true                                     |
      | exitCode    | 0                                        |
      | durationMs  | 60000                                    |
      | revision    | aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa |
      | failing     |                                          |
      | not ready   |                                          |
      | selected by | --revision, handed off from worker-one   |
    And the history does not mention "PRIVATE"

  Scenario: After three runs the report lists three, with their success rate, failing checks and time not ready
    Given fleet-sync recorded these runs:
      | finished             | seconds | ok  | failing                | not ready  |
      | 2026-11-01T10:00:00Z | 60      | yes |                        |            |
      | 2026-11-01T11:00:00Z | 120     | no  | ssh:timeout, tool:node | worker-one |
      | 2026-11-01T12:00:00Z | 180     | no  | ssh:timeout            | worker-one |
    When the operator asks for the fleet report since "30d", at "2026-11-01T13:00:00Z"
    Then the fleet report lists 3 runs
    And the report has:
      | succeeded      | 1      |
      | meanDurationMs | 120000 |
    And the most frequent failing checks are, in order:
      | ssh:timeout | 2 |
      | tool:node   | 1 |
    And the time each machine was not ready is, in minutes:
      | worker-one | 120 |

  Scenario Outline: The report says so when the last run took much longer than the ones before it: <case>
    At least twice the median of the runs before it, and at least a minute
    more; with fewer than five earlier runs there is nothing to compare.
    Given fleet-sync recorded these runs:
      | finished             | seconds  | ok  |
      | 2026-11-01T10:00:00Z | 180      | yes |
      | 2026-11-01T11:00:00Z | 190      | yes |
      | 2026-11-01T12:00:00Z | 185      | yes |
      | 2026-11-01T13:00:00Z | <fourth> | yes |
      | 2026-11-01T14:00:00Z | 200      | yes |
      | 2026-11-01T15:00:00Z | <last>   | yes |
    When the operator asks for the fleet report since "30d", at "2026-11-01T16:00:00Z"
    Then the fleet report <says> the last run was slower

    Examples:
      | case                         | fourth | last | says         |
      | three times the median       | 185    | 572  | says         |
      | a little slower              | 185    | 240  | does not say |
      | exactly twice the median     | 185    | 370  | says         |

  Scenario: Too few earlier runs are nothing to hold the last run against
    Given fleet-sync recorded these runs:
      | finished             | seconds | ok  |
      | 2026-11-01T10:00:00Z | 60      | yes |
      | 2026-11-01T11:00:00Z | 60      | yes |
      | 2026-11-01T12:00:00Z | 900     | yes |
    When the operator asks for the fleet report since "30d", at "2026-11-01T16:00:00Z"
    Then the fleet report does not say the last run was slower

  Scenario: The slower run is named with both times
    Given fleet-sync recorded these runs:
      | finished             | seconds | ok  |
      | 2026-11-01T10:00:00Z | 180     | yes |
      | 2026-11-01T11:00:00Z | 190     | yes |
      | 2026-11-01T12:00:00Z | 185     | yes |
      | 2026-11-01T13:00:00Z | 185     | yes |
      | 2026-11-01T14:00:00Z | 200     | yes |
      | 2026-11-01T15:00:00Z | 572     | yes |
    When the operator asks for the fleet report since "30d", at "2026-11-01T16:00:00Z"
    Then the fleet report prints "Slower: the last run took 572 s; the median of the 5 before it is 185 s."

  Scenario: A machine is not ready from the run that found it so until the run that found it ready
    Given fleet-sync recorded these runs:
      | finished             | ok  | not ready  |
      | 2026-11-01T10:00:00Z | no  | worker-one |
      | 2026-11-01T10:30:00Z | yes |            |
    When the operator asks for the fleet report since "1d", at "2026-11-01T12:00:00Z"
    Then the time each machine was not ready is, in minutes:
      | worker-one | 30 |

  Scenario: Runs before the period are left out of the report
    Given fleet-sync recorded these runs:
      | finished             | ok  |
      | 2026-10-01T10:00:00Z | no  |
      | 2026-11-01T10:00:00Z | yes |
    When the operator asks for the fleet report since "7d", at "2026-11-02T00:00:00Z"
    Then the fleet report lists 1 runs
    And the report has:
      | successRate | 1 |

  Scenario Outline: The period "<since>" is refused
    When the operator asks for the fleet report since "<since>"
    Then the request is refused as a usage error

    Examples:
      | since |
      | 30    |
      | -1d   |
      | 0d    |
      | 1w    |

  Scenario: The history never holds more than 500 runs
    Given fleet-sync recorded 500 runs, one a minute, the last at "2026-11-01T10:00:00Z"
    When fleet-sync records a run that finished at "2026-11-01T10:01:00Z"
    Then the history holds 500 runs
    And the oldest run in the history finished at "2026-11-01T01:42:00Z"

  Scenario: The history forgets runs older than 90 days
    Given fleet-sync recorded these runs:
      | finished             | ok  |
      | 2026-07-01T10:00:00Z | yes |
      | 2026-09-01T10:00:00Z | yes |
    When fleet-sync records a run that finished at "2026-11-01T10:00:00Z"
    Then the history holds 2 runs
    And the oldest run in the history finished at "2026-09-01T10:00:00Z"

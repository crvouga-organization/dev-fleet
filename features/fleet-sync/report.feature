Feature: fleet-sync prints a short report that is the same every time
  One header line, a grid of the machines, then each problem once with its
  code and its fix. Every line is greppable: plain words when piped, the same
  with symbols and colors on a terminal.

  Background:
    Given a fleet-sync report that applied the revision "abcdef0123456789", with the dashboard "https://beszel.example.com"

  Rule: Warning acceptance and final observations are separate from deployment

    Scenario Outline: Warning acceptance after the revision was applied
      Given the worker "w1", online and applied at "abc" after 10 ms, reports:
        | check        | status | summary             | remedy             |
        | beszel:backup | warn  | Backup is overdue.  | Inspect the timer. |
        | ubuntu:disk-gc | skip | DISK_GC_NOT_REPORTED |                    |
      When the report is accepted <policy> the zero-warning policy
      Then the applied report records 1 warnings and acceptance <accepted>
      And the printed report contains "<verdict>"
      And the printed report contains "Inspect the timer."

      Examples:
        | policy  | accepted | verdict                |
        | with    | false    | WARNING POLICY FAILED  |
        | without | true     | CONVERGED WITH WARNINGS |

    Scenario: Inspection and convergence each measure the same workers
      Given the worker "w1", online and applied at "abc" after 10 ms, reports:
        | check          | status | summary              |
        | ubuntu:disk-gc | skip   | DISK_GC_NOT_REPORTED |
        | worker:power-loss-recovery | skip | Firmware setting unavailable. |
      And the worker "w2", online and applied at "abc" after 10 ms, reports:
        | check          | status | summary              |
        | ubuntu:disk-gc | skip   | DISK_GC_NOT_REPORTED |
      And convergence measures each worker again and reports:
        | check          | status         | summary              |
        | ubuntu:disk-gc | skip           | DISK_GC_NOT_REPORTED |
        | ubuntu:disk-gc | skip           | DISK_GC_NOT_REPORTED |
        | worker:browser | not-applicable | Web profile off.     |
        | ubuntu:boot-policy | warn      | Pending during apply. |
        | ubuntu:boot-policy | pass      | Ready after apply.    |
      When the report is accepted with the zero-warning policy
      Then the applied report records 0 warnings and acceptance true
      And each worker retains 3 earlier observations
      And the printed report names "DISK_GC_NOT_REPORTED" 1 time
      And the printed report contains "3 skipped   2 not applicable"
      And the printed report contains "Firmware settings unavailable on this hardware"

  Rule: Plain output is greppable

    Scenario: A verdict, a grid of words and one line for each problem
      The same warning on two workers is printed once, naming both.
      Given the worker "w1", online and applied at no revision after 1000 ms, reports:
        | check                    | status | summary                       | remedy       |
        | ssh:fresh-session        | pass   | ssh:fresh-session             |              |
        | t3:service               | pass   | t3:service                    |              |
        | t3:paired-access         | fail   | MANAGER_T3_LINK_UNVERIFIED    | Pair it.     |
        | provider:codex:inference | warn   | PROVIDER_UPSTREAM_UNAVAILABLE | Retry later. |
      And the worker "w2", online and applied at "abc" after 1000 ms, reports:
        | check                    | status | summary                       | remedy       |
        | ssh:fresh-session        | pass   | ssh:fresh-session             |              |
        | provider:codex:inference | warn   | PROVIDER_UPSTREAM_UNAVAILABLE | Retry later. |
      When the report is printed in plain text, for a run of 65000 ms saved at "/r/last-sync.json"
      Then the first line printed is "fleet-sync  ACTION REQUIRED  revision abcdef012345  in 1m05s"
      And the grid printed has these lines:
        | NODE | ROLE   | NET | SSH  | OS | T3   | LINK | PROXY | AGENTS | MON | RESULT    |
        | w1   | worker | ·   | PASS | ·  | PASS | FAIL | WARN  | ·      | ·   | 1 failing |
        | w2   | worker | ·   | PASS | ·  | ·    | ·    | WARN  | ·      | ·   | ready     |
      And the printed report contains "1 failing   2 warnings   0 skipped   3 passing"
      And the printed report contains "FAIL t3:paired-access  MANAGER_T3_LINK_UNVERIFIED"
      And the printed report names "PROVIDER_UPSTREAM_UNAVAILABLE" 1 time
      And the printed report contains "    on w1, w2"
      And the printed report contains "    → Pair it."
      And the printed report contains "/r/last-sync.json"
      And the printed report has no color

    Scenario: Only stable public addresses are printed, never a tailnet address
      Given the worker "w1", online and applied at "abc" after 1000 ms, reports:
        | check      | status | summary                | remedy                                                            |
        | beszel:hub | fail   | BESZEL_HUB_UNREACHABLE | The hub is not at https://mgr.tail0a1b2c.ts.net:8443. Inspect it. |
      When the report is printed in plain text
      Then the printed report does not name "ts.net"
      And the printed report contains "its private tailnet address. Inspect it."

    Scenario: The report says what selected the revision, and which one it replaces
      Given the report says the revision was selected by:
        """
        { "by": "checkout", "handOff": { "worker": "w1" }, "allowUnmerged": true }
        """
      And the report says the revision replaces "0123456789abcdef0123456789abcdef01234567"
      When the report is printed in plain text
      Then the printed report contains "selected   by the HEAD of the checkout fleet-sync was started in, handed off from w1 (--allow-unmerged); replaces 0123456789ab"

  Rule: A machine that took a minute or more says where its time went

    Each check carries the time of the step that produced it, and its own
    where that was measured apart. A step is named by the check that explains
    its time: one measured on its own that took at least half of it, else the
    step's first check with how many more it produced.

    Scenario: The slowest steps of a slow machine are listed, slowest first
      Given the worker "w1", online and applied at "abc" after 187000 ms, reports:
        | check                            | status | summary | step ms | own ms |
        | ubuntu:baseline                  | pass   | ok      | 12000   |        |
        | ubuntu:policy                    | pass   | ok      | 12000   |        |
        | provider:codex:inference         | pass   | ok      | 4000    | 3000   |
        | agent:claude:version             | pass   | ok      | 151000  |        |
        | agent:claude:session             | pass   | ok      | 151000  | 20     |
        | agent:opencode:account-1:session | fail   | X_CODE  | 151000  | 150000 |
        | t3:service                       | pass   | ok      | 500     |        |
      When the report is printed in plain text
      Then the printed report contains "slowest    w1 (3m07s): agent:opencode:account-1:session 2m30s, ubuntu:baseline 12s (+1 of its step), provider:codex:inference 3s"

    Scenario: A machine that took under a minute lists none
      Given the worker "w1", online and applied at "abc" after 59000 ms, reports:
        | check           | status | summary | step ms |
        | ubuntu:baseline | pass   | ok      | 40000   |
      When the report is printed in plain text
      Then the printed report does not name "slowest"

    Scenario: A slow machine whose checks measured nothing lists none
      Given the worker "w1", online and applied at "abc" after 187000 ms, reports:
        | check           | status | summary |
        | ubuntu:baseline | pass   | ok      |
      When the report is printed in plain text
      Then the printed report does not name "slowest"

  Rule: Warnings alone are a converged run

    Background:
      Given the worker "w1", online and applied at "abc" after 1000 ms, reports:
        | check                    | status | summary                       | remedy       |
        | ssh:a                    | pass   | ssh:a                         |              |
        | provider:codex:inference | warn   | PROVIDER_UPSTREAM_UNAVAILABLE | Retry later. |

    Scenario: Color output adds symbols
      When the report is printed in color
      Then the printed report contains "✔ CONVERGED"
      And the printed report contains "▲"
      And the printed report has color

    Scenario: A run with no failure never prints red
      The zero count of failures is dimmed instead.
      When the report is printed in color
      Then nothing in the printed report is red
      And the printed report dims "✖ 0 failing"

  Rule: A summary is a leading code and its detail

    Scenario Outline: "<summary>" splits into the code "<code>" and the detail "<detail>"
      When the summary "<summary>" is split
      Then its code is "<code>" and its detail is "<detail>"

      Examples:
        | summary                                    | code                  | detail               |
        | SERVICE_NOT_INSTALLED beszel-agent.service | SERVICE_NOT_INSTALLED | beszel-agent.service |
        | Plain sentence.                            |                       | Plain sentence.      |

  Scenario: Fleet parity remains pending for a worker omitted from a scoped rollout
    Given a fleet-sync report that applied the revision "approved", with the dashboard "unused"
    When version parity is measured for the declared fleet
    Then the parity report lists every unmeasured machine as pending for "rollout"

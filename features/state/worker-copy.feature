@linux
Feature: A worker's edited copy of the configuration stops fleet-sync before anything is changed
  Every worker keeps a copy of the fleet configuration, and its bootstrap
  refuses to replace one that was edited there. But a worker's bootstrap runs
  after the manager has converged, after the fleet state recorded the run and
  after the workers before it: a run that was going to stop on one worker had
  already changed the others. So the manager first asks every worker it is
  about to converge what its bootstrap would decide for the copy this run
  sends, over the usual SSH and without changing anything there. The question
  is the text of that bootstrap's own rule, so the two cannot disagree, and
  the answer is the bootstrap's own refusal: the same check, code and remedy.
  A worker that does not answer does not hold the run back; its bootstrap
  still refuses an edited copy when it gets there.

  The workers here answer that question in a real POSIX shell, in a home
  directory of their own, and refuse every other session. Nothing else is
  installed on the manager, so a run that is not refused stops later for
  another reason. Workers are Ubuntu machines, so this runs on Linux.

  Background:
    Given fleet-sync runs on a manager with these workers enrolled:
      | worker     |
      | worker-one |
      | worker-two |
    And fleet-sync last wrote the copy '{"version":3,"workers":["old"]}' on worker "worker-one"
    And fleet-sync last wrote the copy '{"version":3,"workers":["old"]}' on worker "worker-two"

  Rule: A copy edited on a worker that answers stops the run

    Background:
      Given the copy on worker "worker-two" was edited to '{"version":3,"workers":["old"],"git":{}}'

    Scenario: The run is refused before the fleet state or any worker is changed
      When fleet-sync runs for revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      Then the command exits 1
      And the report contains "FLEET_CONFIGURATION_COPY_CHANGED"
      And the manager has no enrollment
      And these workers were asked about their copy:
        | worker     |
        | worker-one |
        | worker-two |
      And no worker was asked anything else
      And the copy on worker "worker-two" still holds '{"version":3,"workers":["old"],"git":{}}'

    Scenario: The worker carries the check its own bootstrap would have reported
      When fleet-sync runs for revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      Then the report gives worker "worker-two" the check "bootstrap:configuration-install" with the remedy the bootstrap prints for "FLEET_CONFIGURATION_COPY_CHANGED"

    Scenario: The refusal names the worker, where the change belongs and how to discard it
      When fleet-sync runs for revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      Then the report contains "Nothing was changed"
      And the report contains "on worker-two was edited there"
      And the report tells the operator "make the same change in fleet.json ($EXAMPLE)"
      And the report contains "rm ~/.config/homelab/fleet.json"
      And the report does not contain "\"git\""

    Scenario: A preview reports it
      When fleet-sync previews revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      Then the command exits 1
      And the report contains "FLEET_CONFIGURATION_COPY_CHANGED"
      And no worker was asked anything else

    Scenario: A worker the run does not select is not asked
      When fleet-sync runs for revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" on worker "worker-one" only
      Then the report does not contain "FLEET_CONFIGURATION_COPY_CHANGED"
      And these workers were asked about their copy:
        | worker     |
        | worker-one |

  Rule: Nothing else stops the run

    Scenario: Copies nobody touched do not stop the run
      When fleet-sync previews revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      Then the report does not contain "FLEET_CONFIGURATION_COPY_CHANGED"
      And these workers were asked about their copy:
        | worker     |
        | worker-one |
        | worker-two |

    Scenario: A worker that does not answer does not stop the run
      Its copy was edited, but nothing can say so until it is reached: then
      its own bootstrap refuses it.
      Given the copy on worker "worker-two" was edited to '{"version":3,"workers":["old"],"git":{}}'
      And worker "worker-two" does not answer SSH
      When fleet-sync previews revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      Then the report does not contain "FLEET_CONFIGURATION_COPY_CHANGED"
      And these workers were asked about their copy:
        | worker     |
        | worker-one |
        | worker-two |

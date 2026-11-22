Feature: fleet-sync never replaces a copy of the configuration that was edited by hand
  Every machine keeps a copy of the fleet configuration at
  ~/.config/dev-fleet/fleet.json, for launchers and scheduled jobs. fleet-sync
  installs it on every run, so an edit made to it by hand used to be lost
  without a word. Beside the copy fleet-sync now keeps its record,
  fleet.json.sha256: what the copy was when it was last written. A copy that
  no longer matches its record, and says something neither this run nor the
  fleet state holds, stops the run before anything is changed. The refusal
  names the way to keep the edit and the way to discard it, and never what
  the files hold.

  The manager here has no worker enrolled, so a run that is not refused stops
  at FLEET_MANAGER_ENROLLMENT_REQUIRED, after the copy was looked at and
  before any machine is reached. Every run is one without a person
  (--json --non-interactive), as the schedule starts it: it is never asked
  anything. In a path, `~` is the manager's home and `$EXAMPLE` is the
  fleet.json the process reads, the example fleet.

  Background:
    Given fleet-sync runs on a manager with no worker enrolled

  Rule: A copy that is still what fleet-sync wrote is replaced as before

    Scenario: A copy nobody touched does not stop the run
      Given fleet-sync installed the configuration on the manager
      When fleet-sync runs for revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      Then the report contains "FLEET_MANAGER_ENROLLMENT_REQUIRED"

    Scenario: A copy nobody touched does not stop the run when the configuration has moved on
      The copy differs from what this run would install because the project's
      fleet.json changed, not because anybody edited the copy: its record
      says so.
      Given fleet-sync installed the configuration on the manager
      And "~/fleet.json" on the manager holds the example fleet with "worker-two" renamed "worker-new"
      And the process runs with the fleet.json "~/fleet.json"
      When fleet-sync runs for revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      Then the report contains "FLEET_MANAGER_ENROLLMENT_REQUIRED"

    Scenario: A manager with no copy yet is not stopped
      When fleet-sync runs for revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      Then the report contains "FLEET_MANAGER_ENROLLMENT_REQUIRED"

  Rule: A copy edited since it was written stops the run before anything is changed

    Background:
      Given fleet-sync installed the configuration on the manager
      And "~/.config/dev-fleet/fleet.json" on the manager holds the example fleet with "worker-two" renamed "worker-edited"

    Scenario: The run is refused, the edit is kept and nothing is recorded
      When fleet-sync runs for revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      Then the command exits 1
      And the report contains "FLEET_CONFIGURATION_COPY_CHANGED"
      And "~/.config/dev-fleet/fleet.json" on the manager still holds the example fleet with "worker-two" renamed "worker-edited"
      And the manager has no enrollment

    Scenario: A preview is refused the same way
      When fleet-sync previews revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      Then the command exits 1
      And the report contains "FLEET_CONFIGURATION_COPY_CHANGED"

    Scenario: A run from a file names that file to keep the edit in, and how to discard it
      When fleet-sync runs for revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      Then the report tells the operator "make the same change in $EXAMPLE"
      And the report tells the operator "rm ~/.config/dev-fleet/fleet.json"
      And the report does not contain "worker-edited"

    Scenario: Deleting the copy discards the edit
      Given "~/.config/dev-fleet/fleet.json" on the manager was deleted
      When fleet-sync runs for revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      Then the report contains "FLEET_MANAGER_ENROLLMENT_REQUIRED"

    Scenario: An edit that says what the run would install anyway is not refused
      The same change was made in the file the run reads: nothing would be
      lost.
      Given "~/fleet.json" on the manager holds the example fleet with "worker-two" renamed "worker-edited"
      And the process runs with the fleet.json "~/fleet.json"
      When fleet-sync runs for revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      Then the report contains "FLEET_MANAGER_ENROLLMENT_REQUIRED"

  Rule: With the configuration kept in the fleet state, the refusal names the import of the copy

    Background:
      Given the process is the devfleet CLI
      And the fleet state holds the example fleet as its configuration
      And the process is passed no fleet.json of its own
      And fleet-sync installed the configuration on the manager
      And "~/.config/dev-fleet/fleet.json" on the manager holds the example fleet with "worker-two" renamed "worker-edited"

    Scenario: The refusal gives the import command with the path of the copy
      When fleet-sync runs for revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      Then the command exits 1
      And the report contains "FLEET_CONFIGURATION_COPY_CHANGED"
      And the report tells the operator "devfleet fleet-state --import ~/.config/dev-fleet/fleet.json"
      And the report tells the operator "rm ~/.config/dev-fleet/fleet.json"
      And the report does not contain "worker-edited"

    Scenario: Once the copy is imported the run goes on
      Given the operator ran "fleet-state --import ~/.config/dev-fleet/fleet.json" on the manager
      When fleet-sync runs for revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      Then the report contains "FLEET_MANAGER_ENROLLMENT_REQUIRED"
      And the configuration in the fleet state of the manager contains "worker-edited"

  Rule: A copy from before the record existed is an edit only when nothing else holds what it says

    Background:
      Given the process is the devfleet CLI
      And the fleet state holds the example fleet as its configuration

    Scenario: A copy that says what the fleet state last applied is not an edit
      An earlier revision wrote it, without a record and in its own layout.
      The project's fleet.json has changed since, so the copy also differs
      from what this run would install.
      Given "~/.config/dev-fleet/fleet.json" on the manager holds the example fleet
      And "~/fleet.json" on the manager holds the example fleet with "worker-two" renamed "worker-new"
      And the process runs with the fleet.json "~/fleet.json"
      When fleet-sync runs for revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      Then the report contains "FLEET_MANAGER_ENROLLMENT_REQUIRED"

    Scenario: A copy that says something else is refused, not replaced
      Given "~/.config/dev-fleet/fleet.json" on the manager holds the example fleet with "worker-two" renamed "worker-edited"
      When fleet-sync runs for revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      Then the command exits 1
      And the report contains "FLEET_CONFIGURATION_COPY_CHANGED"
      And "~/.config/dev-fleet/fleet.json" on the manager still holds the example fleet with "worker-two" renamed "worker-edited"

    Scenario: A copy that is no fleet configuration at all is refused, not replaced
      Given "~/.config/dev-fleet/fleet.json" on the manager holds:
        """
        { "git": {
        """
      When fleet-sync runs for revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      Then the command exits 1
      And the report contains "FLEET_CONFIGURATION_COPY_CHANGED"

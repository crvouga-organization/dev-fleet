@linux
Feature: A worker's copy of the configuration that was edited there is refused, not replaced
  fleet-sync sends every worker the fleet configuration, and the remote
  bootstrap installs it at ~/.config/dev-fleet/fleet.json before anything
  else. Beside the copy it keeps its record, fleet.json.sha256: what the copy
  was when it was last written. A copy that no longer matches its record was
  edited on the worker. A worker takes its configuration from the manager, so
  the edit would be lost: the bootstrap stops with
  FLEET_CONFIGURATION_COPY_CHANGED before it installs anything, and the
  remedy says where the change belongs. A copy from before the record existed
  is replaced as it always was: nothing says whether it was edited.

  These scenarios run the configuration-install step of
  bootstrap/fleet-remote-bootstrap.sh in a real POSIX shell, in a home
  directory of their own. Workers are Ubuntu machines, so they run on Linux.

  Scenario: A worker without a copy gets the copy and its record
    When the worker is sent the configuration '{"version":3,"workers":[]}'
    Then the configuration is installed
    And the copy on the worker holds '{"version":3,"workers":[]}'
    And the record on the worker is the SHA-256 of the copy

  Scenario: A copy nobody touched is replaced when the configuration changes
    Given the worker was sent the configuration '{"version":3,"workers":[]}'
    When the worker is sent the configuration '{"version":3,"workers":["new"]}'
    Then the configuration is installed
    And the copy on the worker holds '{"version":3,"workers":["new"]}'
    And the record on the worker is the SHA-256 of the copy

  Scenario: A copy edited on the worker stops the bootstrap and is left as it is
    Given the worker was sent the configuration '{"version":3,"workers":[]}'
    And the copy on the worker was edited to '{"version":3,"workers":[],"git":{}}'
    When the worker is sent the configuration '{"version":3,"workers":["new"]}'
    Then the configuration install stops with "FLEET_CONFIGURATION_COPY_CHANGED"
    And the copy on the worker holds '{"version":3,"workers":[],"git":{}}'
    And nothing half written is left beside the copy

  Scenario: An edit that already is what the manager sends is not refused
    Given the worker was sent the configuration '{"version":3,"workers":[]}'
    And the copy on the worker was edited to '{"version":3,"workers":["new"]}'
    When the worker is sent the configuration '{"version":3,"workers":["new"]}'
    Then the configuration is installed
    And the record on the worker is the SHA-256 of the copy

  Scenario: A copy from before the record existed is replaced
    Given the worker holds the copy '{"version":3,"workers":["old"]}' and no record
    When the worker is sent the configuration '{"version":3,"workers":[]}'
    Then the configuration is installed
    And the copy on the worker holds '{"version":3,"workers":[]}'
    And the record on the worker is the SHA-256 of the copy

  Scenario: The refusal needs a person and names where the change belongs
    Then the diagnostic of "FLEET_CONFIGURATION_COPY_CHANGED" is not retryable
    And the remedy the bootstrap prints for "FLEET_CONFIGURATION_COPY_CHANGED" mentions "rm ~/.config/dev-fleet/fleet.json"

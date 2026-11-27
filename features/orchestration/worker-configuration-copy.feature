@linux
Feature: A worker's copy of the configuration that was edited there is refused, not replaced
  fleet-sync sends every worker the fleet configuration, and the remote
  bootstrap installs it at ~/.config/homelab/fleet.json before anything
  else. Beside the copy it keeps its record, fleet.json.sha256: what the copy
  was when it was last written. A copy that no longer matches its record was
  edited on the worker. A worker takes its configuration from the manager, so
  the edit would be lost: the bootstrap stops with
  FLEET_CONFIGURATION_COPY_CHANGED before it installs anything, and the
  remedy says where the change belongs. A copy from before the record existed
  is replaced as it always was: nothing says whether it was edited.

  A revision from before the record existed rewrites the copy and leaves the
  record of an earlier one behind. After a rollback to such a revision the
  record says nothing about the copy, so the roll forward replaces it. What
  says so is the worker's own account of the operation before this one: the
  revision its operation record names, and the bootstrap script in the
  fleet-owned checkout of that commit, which does not name the record. A copy
  changed after that operation's last record was not left by it and is
  refused, and so is one whose writer cannot be read.

  The manager asks every worker what this step would decide before it changes
  anything (features/state/worker-copy.feature). Its question is the text of
  the step's own rule, and here it is asked of the same worker just before
  each bootstrap, so every scenario also says that the two agree.

  These scenarios run the configuration-install step of
  bootstrap/fleet-remote-bootstrap.sh in a real POSIX shell, in a home
  directory of their own. Workers are Ubuntu machines, so they run on Linux.

  Scenario: A worker without a copy gets the copy and its record
    When the worker is sent the configuration '{"version":3,"workers":[]}'
    Then the configuration is installed
    And the manager, asking beforehand, was told the copy would be replaced
    And the copy on the worker holds '{"version":3,"workers":[]}'
    And the record on the worker is the SHA-256 of the copy

  Scenario: A copy nobody touched is replaced when the configuration changes
    Given the worker was sent the configuration '{"version":3,"workers":[]}'
    When the worker is sent the configuration '{"version":3,"workers":["new"]}'
    Then the configuration is installed
    And the manager, asking beforehand, was told the copy would be replaced
    And the copy on the worker holds '{"version":3,"workers":["new"]}'
    And the record on the worker is the SHA-256 of the copy

  Scenario: A copy edited on the worker stops the bootstrap and is left as it is
    Given the worker was sent the configuration '{"version":3,"workers":[]}'
    And the copy on the worker was edited to '{"version":3,"workers":[],"git":{}}'
    When the worker is sent the configuration '{"version":3,"workers":["new"]}'
    Then the configuration install stops with "FLEET_CONFIGURATION_COPY_CHANGED"
    And the manager, asking beforehand, was told the copy would be refused
    And the copy on the worker holds '{"version":3,"workers":[],"git":{}}'
    And nothing half written is left beside the copy

  Scenario: An edit that already is what the manager sends is not refused
    Given the worker was sent the configuration '{"version":3,"workers":[]}'
    And the copy on the worker was edited to '{"version":3,"workers":["new"]}'
    When the worker is sent the configuration '{"version":3,"workers":["new"]}'
    Then the configuration is installed
    And the manager, asking beforehand, was told the copy would be replaced
    And the record on the worker is the SHA-256 of the copy

  Scenario: A copy from before the record existed is replaced
    Given the worker holds the copy '{"version":3,"workers":["old"]}' and no record
    When the worker is sent the configuration '{"version":3,"workers":[]}'
    Then the configuration is installed
    And the manager, asking beforehand, was told the copy would be replaced
    And the copy on the worker holds '{"version":3,"workers":[]}'
    And the record on the worker is the SHA-256 of the copy

  Scenario: A roll forward after a rollback to a revision that keeps no record replaces a copy nobody edited
    Given the worker was sent the configuration '{"version":3,"workers":[]}'
    And a revision that keeps no record then installed '{"version":3,"workers":["old"]}' on the worker
    When the worker is sent the configuration '{"version":3,"workers":["new"]}'
    Then the configuration is installed
    And the manager, asking beforehand, was told the copy would be replaced
    And the copy on the worker holds '{"version":3,"workers":["new"]}'
    And the record on the worker is the SHA-256 of the copy

  Scenario: A copy edited after the rollback is still refused
    The revision that keeps no record did not leave this copy: it was
    changed after that revision's operation ended.

    Given the worker was sent the configuration '{"version":3,"workers":[]}'
    And a revision that keeps no record then installed '{"version":3,"workers":["old"]}' on the worker
    And the copy on the worker was edited to '{"version":3,"workers":["old"],"git":{}}'
    When the worker is sent the configuration '{"version":3,"workers":["new"]}'
    Then the configuration install stops with "FLEET_CONFIGURATION_COPY_CHANGED"
    And the manager, asking beforehand, was told the copy would be refused
    And the copy on the worker holds '{"version":3,"workers":["old"],"git":{}}'

  Scenario: A refused copy stays refused on the next run
    The refused run was an operation too, of a revision that keeps the
    record, so the rollback before it no longer excuses the copy.

    Given the worker was sent the configuration '{"version":3,"workers":[]}'
    And a revision that keeps no record then installed '{"version":3,"workers":["old"]}' on the worker
    And the copy on the worker was edited to '{"version":3,"workers":["old"],"git":{}}'
    And the worker was refused the configuration '{"version":3,"workers":["new"]}'
    When the worker is sent the configuration '{"version":3,"workers":["new"]}'
    Then the configuration install stops with "FLEET_CONFIGURATION_COPY_CHANGED"
    And the manager, asking beforehand, was told the copy would be refused
    And the copy on the worker holds '{"version":3,"workers":["old"],"git":{}}'

  Scenario: A copy whose last writer cannot be read is refused
    Only a bootstrap script that is there and does not name the record
    excuses a copy. Without the checkout nothing says what wrote it.

    Given the worker was sent the configuration '{"version":3,"workers":[]}'
    And a revision that keeps no record then installed '{"version":3,"workers":["old"]}' on the worker
    And the checkout of that revision is no longer on the worker
    When the worker is sent the configuration '{"version":3,"workers":["new"]}'
    Then the configuration install stops with "FLEET_CONFIGURATION_COPY_CHANGED"
    And the manager, asking beforehand, was told the copy would be refused
    And the copy on the worker holds '{"version":3,"workers":["old"]}'

  Scenario: Asking changes nothing on the worker
    Given the worker was sent the configuration '{"version":3,"workers":[]}'
    And the copy on the worker was edited to '{"version":3,"workers":[],"git":{}}'
    When the manager asks what the bootstrap would decide for the configuration '{"version":3,"workers":["new"]}'
    Then the manager is told the bootstrap's own refusal "FLEET_CONFIGURATION_COPY_CHANGED" of "bootstrap:configuration-install"
    And every file on the worker is as it was before the question

  Scenario: A bootstrap script that does not mark its rule is not asked about
    A revision from before the question existed answers for itself, when
    its bootstrap runs.
    Then there is no question to ask about a bootstrap script without the rule's markers

  Scenario: The refusal needs a person and names where the change belongs
    Then the diagnostic of "FLEET_CONFIGURATION_COPY_CHANGED" is not retryable
    And the remedy the bootstrap prints for "FLEET_CONFIGURATION_COPY_CHANGED" mentions "rm ~/.config/homelab/fleet.json"

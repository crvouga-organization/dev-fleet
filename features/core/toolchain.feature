Feature: The toolchain of a checkout is checked tool by tool
  A checkout's own doctor says whether each pinned tool is the expected one.
  The report keeps its verdict for every tool and a version when the detail is
  one; any other detail a tool printed is not kept.

  Scenario: Each tool keeps its own verdict, and only a version is repeated
    Given the doctor of the checkout reports ok, with these checks:
      | id            | status | detail        |
      | node          | pass   | 26.13.0       |
      | bun           | fail   | private-token |
      | docker-engine | warn   | private-token |
    When the toolchain of the checkout at "/repo" is checked
    Then the checks are, in this order:
      | id                 | status |
      | tool:node          | pass   |
      | tool:bun           | fail   |
      | tool:docker-engine | warn   |
    And the summary of the check "tool:node" mentions "26.13.0"
    And every command was run with the argument "--docker"
    And nothing reported contains "private-token"

  Scenario: A doctor that checked nothing verifies nothing
    Given every command prints '{"ok":true,"checks":[]}'
    When the toolchain of the checkout at "/repo" is checked
    Then the check "auth:toolchain" fails

  Scenario: A machine that runs a newer mise than the revision pins is a warning, in the report's own words
    The bootstrap kept the newer mise: replacing it with the older pinned
    one would be a downgrade, and it makes none unasked.
    Given the doctor of the checkout reports ok, with these checks:
      | id   | status | detail        |
      | mise | warn   | private-token |
    When the toolchain of the checkout at "/repo" is checked
    Then the check "tool:mise" warns
    And the summary of the check "tool:mise" mentions "TOOLCHAIN_DOWNGRADE"
    And the remedy of the check "tool:mise" mentions "--allow-mise-downgrade"
    And nothing reported contains "private-token"

  Scenario: A mise older than the revision pins fails, and says to run fleet-sync
    Given the doctor of the checkout reports ok, with these checks:
      | id   | status | detail        |
      | mise | fail   | private-token |
    When the toolchain of the checkout at "/repo" is checked
    Then the check "tool:mise" fails
    And the remedy of the check "tool:mise" mentions "devfleet fleet-sync"
    And nothing reported contains "private-token"

  Scenario: A global mise configuration that is not dev-fleet's says to run fleet-sync
    On a fleet machine the global mise configuration belongs to dev-fleet.
    The report says so in its own words and never repeats what the doctor
    printed.
    Given the doctor of the checkout reports ok, with these checks:
      | id                 | status | detail        |
      | global-mise-config | fail   | private-token |
    When the toolchain of the checkout at "/repo" is checked
    Then the check "tool:global-mise-config" fails
    And the remedy of the check "tool:global-mise-config" mentions "devfleet fleet-sync"
    And the remedy of the check "tool:global-mise-config" mentions "project mise.toml"
    And nothing reported contains "private-token"

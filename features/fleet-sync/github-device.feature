Feature: A new worker authorizes GitHub on its own device
  Background:
    Given the roster entry "worker-one", with the workspace "/home/dev/workspace"

  Scenario Outline: A browser approval succeeds only for the declared login
    Given GitHub has no worker login and the device approval returns "<account>"
    And the operator completes every prompt on the terminal
    When GitHub is authorized for the worker as "example-user"
    Then the GitHub authorization is "<outcome>"

    Examples:
      | account      | outcome  |
      | example-user | verified |
      | another-user | refused  |

  Scenario: Preserve an existing worker login with a different identity
    Given GitHub already authenticates the worker as "another-user"
    And a prompt on the terminal would fail the scenario
    When GitHub is authorized for the worker as "example-user"
    Then the GitHub authorization is "refused"

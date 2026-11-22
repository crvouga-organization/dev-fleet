Feature: Agents keep reaching the proxy while the secrets provider is down
  Every agent launch presents the proxy client key, read from the fleet's
  secrets provider with the node's own access. A node remembers the last key
  the provider gave it, readable by its user alone. The provider stays the
  source: the remembered key is used only when the provider cannot answer, so
  an unreachable Vault or an expired Vault session of one node leaves its
  agents working while the node's Vault checks report the fault.

  Scenario: The key the provider gives is used and remembered
    Given the secrets provider gives the proxy client key "key-one"
    When an agent launches
    Then the launch presents the proxy client key "key-one"
    And the node remembers the proxy client key "key-one" where only its user can read it

  Scenario: A key rotated in the provider is used at the next launch
    Given the node remembers the proxy client key "key-one"
    And the secrets provider gives the proxy client key "key-two"
    When an agent launches
    Then the launch presents the proxy client key "key-two"
    And the node remembers the proxy client key "key-two" where only its user can read it

  Scenario: The remembered key is used while the provider cannot answer
    Given the node remembers the proxy client key "key-one"
    And the secrets provider cannot answer
    When an agent launches
    Then the launch presents the proxy client key "key-one"

  Scenario: A node that never read the key cannot launch without the provider
    Given the secrets provider cannot answer
    When an agent launches
    Then it is refused with "Required secret unavailable: proxy-client-key"

  Rule: A manager with no key to present names the login that kept it from reading one
    A node that never read the key has nothing to fall back on, and every
    provider fails for want of it. On the manager that is one fault when its
    secrets provider cannot be read: the check that owns the manager's login
    says what to do, and the providers name it. A worker's login is its own.

    Scenario Outline: The providers of a manager that <fault> its secrets provider are blocked by its login
      Given the manager <fault> its secrets provider
      When the providers of "manager-mac" are verified
      Then every provider's authentication fails, saying "SECRET_READ_BLOCKED by manager:vault-renewal"

      Examples:
        | fault               |
        | is not logged in to |
        | cannot reach        |

    Scenario: A key the provider does not hold keeps the providers' own code
      When the providers of "manager-mac" are verified
      Then every provider's authentication fails, saying "PROVIDER_UNATTENDED_CREDENTIAL_REQUIRED"

    Scenario: A worker's providers keep their own code
      Given the manager is not logged in to its secrets provider
      When the providers of "worker-one" are verified
      Then every provider's authentication fails, saying "PROVIDER_UNATTENDED_CREDENTIAL_REQUIRED"

Feature: The manager's GitHub sign-in is checked like every worker's
  The manager is where a person drives the fleet from. It is held to the fleet
  login by default, or to a person's own login the fleet configuration names
  under github.manager. A personal login is checked and never replaced.

  Background:
    Given the fleet login is "example-user"
    And GitHub knows the token "TOKEN_A_PRIVATE_0001" as "example-user"
    And GitHub knows the token "TOKEN_P_PRIVATE_0004" as "someone"
    And GitHub knows the token "TOKEN_X_PRIVATE_0005" as "someone-else"
    And the store holds "TOKEN_A_PRIVATE_0001" as "github-token"

  Scenario: fleet-status shows the GitHub checks of the manager
    Given "manager-mac" is signed in with "TOKEN_A_PRIVATE_0001"
    And every other command fails
    When fleet-status checks the "github" capability on the manager
    Then these checks are reported, in this order:
      | auth:github           |
      | github:principal      |
      | github:token-current  |
      | github:permissions    |
      | github:expiry         |
      | github:rate-limit     |
      | github:git-credential |
    And the check "github:principal" passes

  Scenario: By default the manager signed in as another account fails
    Given "manager-mac" is signed in with "TOKEN_X_PRIVATE_0005"
    When the GitHub checks run on the manager
    Then the check "github:principal" fails
    And the check "github:principal" says "GITHUB_LOGIN_MISMATCH"

  Scenario: A worker handoff cannot read the active manager login without keychain interaction
    Given the manager was reached over SSH on macOS
    And the store gives the manager no "github-token"
    And the command "/usr/bin/swift -" prints -25308
    When the GitHub sign-in job runs on the manager
    Then the result on "manager-mac" is "GITHUB_KEYCHAIN_INACCESSIBLE"
    And no command line contains "auth login"

  Rule: A token the manager could not read is blocked by the manager's login, not missing
    The manager reads the token with its own Vault session. A session that
    lapsed, or a Vault that does not answer, has one owner; the GitHub checks
    name it instead of asking for a token to be stored.

    Background:
      Given the fleet keeps its secrets with the "vault" provider
      And the store gives the manager no "github-token"
      And "manager-mac" is signed in with "TOKEN_A_PRIVATE_0001"
      And the command "vault token lookup -address=https://vault.example.com -format=json" fails

    Scenario Outline: The token cannot be compared while the manager <state>
      Given the command "vault status -address=https://vault.example.com -format=json" <status>
      When the GitHub checks run on the manager
      Then the check "github:token-current" is skipped
      And the check "github:token-current" says "SECRET_READ_BLOCKED by manager:vault-renewal"
      And the remedy of the check "github:token-current" mentions "<remedy>"

      Examples:
        | state                      | status   | remedy                                                |
        | is logged out of Vault     | succeeds | this machine is not logged in to the secrets provider |
        | gets no answer from Vault  | fails    | logging in again does not help                        |

    Scenario Outline: A sign-in job that found no token while the manager <state> leaves "github:sync" blocked
      Given the command "vault status -address=https://vault.example.com -format=json" <status>
      And the command "bun bootstrap/worker-github.ts" prints {"name":"dev-fleet-github","event":"job_finished","code":"GITHUB_TOKEN_MISSING","adopted":false}
      When the GitHub sign-in of the manager is converged
      Then the check "github:sync" fails
      And the check "github:sync" says "SECRET_READ_BLOCKED by manager:vault-renewal"

      Examples:
        | state                     | status   |
        | is logged out of Vault    | succeeds |
        | gets no answer from Vault | fails    |

    Scenario: A token Vault does not hold keeps the sign-in's own code
      Given the command "vault token lookup -address=https://vault.example.com -format=json" succeeds
      And the command "bun bootstrap/worker-github.ts" prints {"name":"dev-fleet-github","event":"job_finished","code":"GITHUB_TOKEN_MISSING","adopted":false}
      When the GitHub sign-in of the manager is converged
      Then the check "github:sync" says "GITHUB_TOKEN_MISSING"

  Rule: A manager with a personal login

    Background:
      Given the fleet's github block is:
        """
        { "manager": { "login": "someone" } }
        """

    Scenario: The declared personal login passes, and its token is not compared with the store
      Given "manager-mac" is signed in with "TOKEN_P_PRIVATE_0004"
      When the GitHub checks run on the manager
      Then the check "github:principal" passes
      And no check "github:token-current" is reported

    Scenario: An account the configuration does not declare fails
      Given "manager-mac" is signed in with "TOKEN_X_PRIVATE_0005"
      When the GitHub checks run on the manager
      Then the check "github:principal" fails
      And the remedy of the check "github:principal" mentions "never replaces a personal login"

    Scenario: The sign-in job measures a personal login and never replaces it
      Given "manager-mac" is signed in with "TOKEN_P_PRIVATE_0004"
      When the GitHub sign-in job runs on the manager
      Then "manager-mac" holds the token "TOKEN_P_PRIVATE_0004"
      And no command line contains "auth login"

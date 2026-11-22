Feature: The manager signs in to the hub with one fleet account
  The fleet's secrets hold the password of the hub account the manager enrolls
  machines with. The account itself is named in the fleet configuration. A
  secret written before that, as a JSON pair of identity and password, still
  works.

  Background:
    Given the fleet configuration names the manager's hub account "fleet-manager@example.com"

  Scenario: A generated password belongs to the account the fleet configuration names
    The secret ends in a new line, as a secrets provider prints it.
    When the secret 'generated-secret-value\n' is read as the hub login
    Then the login is "fleet-manager@example.com" with the password "generated-secret-value"

  Scenario: The earlier JSON pair still works
    When the secret '{"identity":"ops@example.test","password":"p"}' is read as the hub login
    Then the login is "ops@example.test" with the password "p"

  Scenario Outline: A secret that is <what> is refused
    When the secret <secret> is read as the hub login
    Then it is refused with "BESZEL_ACCOUNT_INVALID"

    Examples:
      | what                    | secret             |
      | empty                   | ''                 |
      | blank                   | '   '              |
      | a pair without password | '{"identity":"x"}' |
      | not JSON                | '{not json'        |

  Scenario Outline: A hub that answers <status> to <which request> is reported as <failure>
    PocketBase answers a rejected password login with 400, not 401, so that
    answer names the missing hub account.
    Then a hub that answers <status> to "<request>" is reported as "<failure>"

    Examples:
      | which request   | status | request                                   | failure                 |
      | the login       | 400    | /api/collections/users/auth-with-password | BESZEL_ACCOUNT_REQUIRED |
      | another request | 400    | /api/collections/systems/records          | BESZEL_API_UNAVAILABLE  |
      | the login       | 403    | /api/collections/users/auth-with-password | BESZEL_AUTH_REQUIRED    |
      | the login       | 503    | /api/collections/users/auth-with-password | BESZEL_API_UNAVAILABLE  |

  Rule: A password that cannot be read is a missing account only when the manager is logged in to Vault
    The manager reads the password with its own Vault session. A session
    that has lapsed is one fault with one owner, the check of the manager's
    login; it is not a hub that lacks an account.

    Background:
      Given the command "vault kv get -address=https://vault.example.com …" fails

    Scenario: A password Vault does not hold is a missing account
      Given the command "vault token lookup -address=https://vault.example.com -format=json" succeeds
      When the manager signs in to the hub "https://manager-mac-1.tail0a1b2c.ts.net:8443"
      Then it is refused with exactly "BESZEL_ACCOUNT_REQUIRED"

    Scenario Outline: A password the manager cannot read <while> is blocked by its login to Vault
      Given the command "vault token lookup -address=https://vault.example.com -format=json" fails
      And the command "vault status -address=https://vault.example.com -format=json" <status>
      When the manager signs in to the hub "https://manager-mac-1.tail0a1b2c.ts.net:8443"
      Then it is refused with exactly "SECRET_READ_BLOCKED"

      Examples:
        | while                       | status   |
        | while logged out of Vault   | succeeds |
        | while Vault does not answer | fails    |

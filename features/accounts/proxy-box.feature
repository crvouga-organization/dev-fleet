@proxy-box @slow
Feature: The pinned CLI proxy says of an account it holds back what the session checks read
  `account-sessions.feature` injects every answer of the proxy. Here the
  proxy is the one the fleet pins, running in a container, with one account
  whose provider is a stand-in the scenario controls. It proves what the
  proxy itself answers about an account it holds back, and that the session
  check of that account reads it. No provider is contacted and no agent
  runs: the check asks the proxy before it would launch a session, and
  what the proxy says is the result.

  Runs only when HOMELAB_TEST_PROXY_BOX is set, because it downloads the
  pinned proxy image.

  Background:
    Given the pinned CLI proxy runs with the Claude account "a@example.com", whose provider is a stand-in

  Scenario Outline: A model the provider limited is refused by the proxy itself, which says how long it holds it: asked as a <tool> account's check asks
    The proxy holds the model for the time the provider named, or a little
    longer, and answers without asking the provider again. The seconds left
    are in Retry-After in every protocol. Only an answer in the OpenAI
    protocols carries the proxy's own error, with the same seconds.
    Given the provider answers that account with the status 429 and "Retry-After: 1800"
    And the proxy was already asked for that model once
    When the proxy is asked for that model as the check of a <tool> account asks
    Then the proxy answers with the status 429
    And the provider was asked 1 time
    And its answer says in "Retry-After" how many seconds are left
    And its answer <names> "model_cooldown" with the same seconds in "reset_seconds"

    Examples:
      | tool     | names         |
      | claude   | does not name |
      | codex    | names         |
      | opencode | names         |

  Scenario Outline: The session check of a limited account names the instant the proxy says its cooldown clears: <case>
    Given the provider answers that account with the status 429 and "Retry-After: 1800"
    And the proxy was already asked for that model <asked>
    And the session of the account "a@example.com" runs into its deadline
    When this node's account sessions are verified
    Then the check "agent:claude:account-1:session" warns saying "AGENT_ACCOUNT_COOLING_DOWN: claude account 1 is rate limited until 20"
    And the check "agent:claude:account-1:session" names the instant the proxy says the cooldown clears
    And the check "agent:claude:account-1:session" has no remedy
    And the provider was asked 1 time

    Examples:
      | case                               | asked   |
      | the proxy already holds it back    | once    |
      | the check's own request is refused | 0 times |

  Scenario: A limit the provider gives no time for is passed on without one
    The proxy then holds the model back for a moment of its own choosing
    and asks the provider again, so there is no instant to repeat.
    Given the provider answers that account with the status 429
    When the proxy is asked for that model as the check of a claude account asks
    Then the proxy answers with the status 429
    And its answer carries no "Retry-After"

  Scenario: The session check of an account limited for no named time invents none
    Given the provider answers that account with the status 429
    And the session of the account "a@example.com" runs into its deadline
    When this node's account sessions are verified
    Then the summary of the check "agent:claude:account-1:session" is "AGENT_ACCOUNT_COOLING_DOWN: claude account 1 is rate limited; checked again on the next status."

  Scenario: An account its provider wants verified is held back with the provider's words, not as a cooldown
    Given the provider answers that account with the status 403 saying "Verify your account to continue."
    And the proxy was already asked for that model once
    When the proxy is asked for that model as the check of a claude account asks
    Then the proxy answers with the status 503
    And the provider was asked 1 time
    And its answer says in "Retry-After" how many seconds are left
    And its answer names what the provider said

  Scenario Outline: The session check of an account its provider wants verified says so: <case>
    Given the provider answers that account with the status 403 saying "Verify your account to continue."
    And the proxy was already asked for that model <asked>
    And the session of the account "a@example.com" runs into its deadline
    When this node's account sessions are verified
    Then the check "agent:claude:account-1:session" fails saying "AGENT_ACCOUNT_VERIFICATION_REQUIRED: claude account 1"
    And the check "agent:claude:account-1:session" asks to run "homelab fleet-accounts"
    And no check repeats what the provider said
    And the provider was asked 1 time

    Examples:
      | case                               | asked   |
      | the proxy already holds it back    | once    |
      | the check's own request is refused | 0 times |

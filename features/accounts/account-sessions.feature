Feature: Every per-account instance runs a real session, and account changes re-verify
  T3 offers one instance per proxy account. Each one is verified with a real,
  cheap session through its launcher. A rate-limited account is
  cooling-down, never a pass and never a failure. An account its provider
  wants verified, one whose credentials are refused and a session that never
  ended are each reported under a code of their own. An instance whose
  account the proxy no longer holds fails without being run. Results are
  cached under a key that holds the roster version and the client key's
  version.

  Scenario: Each account the proxy holds gets its own session check
    Given the proxy lists these models:
      | claude-a@example.com/claude-sonnet-5-5 |
      | claude-b@example.com/claude-sonnet-5-5 |
    And the sessions answer:
      | account       | result       |
      | a@example.com | ok           |
      | b@example.com | cooling-down |
    When the account sessions are checked
    Then the checks are:
      | id                               | status |
      | agent:claude:account-1:session   | pass   |
      | agent:claude:account-2:session   | warn   |
    And no check names "example.com"

  Scenario: Removing an account on the proxy makes that instance's check fail on the next status
    Given this node offers these account instances:
      | tool  | account       |
      | codex | a@example.com |
      | codex | b@example.com |
    And the proxy lists these models:
      | codex-a@example.com/gpt-6.1-sol |
    And the sessions answer:
      | account       | result |
      | a@example.com | ok     |
    When the account sessions are checked
    Then the checks are:
      | id                             | status |
      | agent:codex:account-1:session  | pass   |
      | agent:codex:removed-1:session  | fail   |
    And only the account "a@example.com" was run

  Scenario Outline: What a session's output says about its account: <case>
    When a session that <exit> printed "<output>" is read
    Then its account is "<result>"

    Examples:
      | case                     | exit      | output                                         | result       |
      | it answered              | succeeded | OK                                             | ok           |
      | the relay said it cools  | failed    | This account is cooling down until 2027-01-15  | cooling-down |
      | the provider limited it  | failed    | 429 Too Many Requests                          | cooling-down |
      | OpenCode retried a quota | failed    | level=ERROR message=\"stream error\" AI_APICallError: 429 RESOURCE_EXHAUSTED | cooling-down |
      | it hung on a limit it printed | ran into its deadline | level=ERROR AI_APICallError: 429 RESOURCE_EXHAUSTED | cooling-down |
      | the provider wants it verified | failed | Verify your account to continue.              | verification-required |
      | its credentials were refused | failed  | unexpected status 401 Unauthorized             | rejected     |
      | it hung and said nothing | ran into its deadline | > build · gemini-3.8-flash           | timed-out    |
      | anything else            | failed    | model_not_found                                | failed       |

  Scenario Outline: A session that is "<result>" <verdict> as <code>
    A cooldown clears on its own, so it is the only result that warns. A
    session that hangs is told apart from a refused sign-in: signing in again
    helps only the second.
    Given the proxy lists these models:
      | claude-a@example.com/claude-sonnet-5-5 |
    And the sessions answer:
      | account       | result   |
      | a@example.com | <result> |
    When the account sessions are checked
    Then the check "agent:claude:account-1:session" <verdict> saying "<code>: claude account 1"
    And no check names "example.com"

    Examples:
      | result                | verdict | code                                |
      | cooling-down          | warns   | AGENT_ACCOUNT_COOLING_DOWN          |
      | verification-required | fails   | AGENT_ACCOUNT_VERIFICATION_REQUIRED |
      | rejected              | fails   | AGENT_ACCOUNT_AUTH_REJECTED         |
      | timed-out             | fails   | AGENT_ACCOUNT_SESSION_TIMED_OUT     |
      | failed                | fails   | AGENT_ACCOUNT_SESSION_FAILED        |

  Scenario: An account its provider wants verified says what a person has to do
    Given the proxy lists these models:
      | codex-a@example.com/gpt-6.1-sol |
    And the sessions answer:
      | account       | result                |
      | a@example.com | verification-required |
    When the account sessions are checked
    Then the remedy of the check "agent:codex:account-1:session" mentions "complete the verification it asks for"
    And the check "agent:codex:account-1:session" asks to run "devfleet fleet-accounts"

  Scenario: A cooldown asks nothing of anyone
    Given the proxy lists these models:
      | codex-a@example.com/gpt-6.1-sol |
    And the sessions answer:
      | account       | result       |
      | a@example.com | cooling-down |
    When the account sessions are checked
    Then the check "agent:codex:account-1:session" has no remedy

  Scenario Outline: A session that ran into its deadline is what the proxy says of its account: <case>
    OpenCode retries a request the proxy refuses until the session's deadline,
    so a limited account ends as a timeout that printed nothing. The proxy is
    then asked for that account's model directly: a model it holds back
    answers 429 at once, without a request to the provider.
    Given the proxy lists these models:
      | antigravity-a@example.com/gemini-3.8-flash |
    And the session of the account "a@example.com" runs into its deadline
    And the proxy answers a request for that account's model with the status <status> saying "<answer>"
    When this node's account sessions are verified
    Then the check "agent:opencode:account-1:session" <verdict> saying "<code>"
    And the proxy was asked for the model "antigravity-a@example.com/gemini-3.8-flash"
    And no check names "example.com"
    And no check repeats what the proxy answered

    Examples:
      | case                           | status | answer                                                   | verdict | code                                |
      | the proxy holds its model back | 429    | {"error":{"code":"model_cooldown","reset_seconds":1800}} | warns   | AGENT_ACCOUNT_COOLING_DOWN          |
      | its provider limits it         | 429    | RESOURCE_EXHAUSTED                                       | warns   | AGENT_ACCOUNT_COOLING_DOWN          |
      | its provider wants it verified | 403    | Verify your account to continue.                         | fails   | AGENT_ACCOUNT_VERIFICATION_REQUIRED |
      | its credentials are refused    | 401    | PRIVATE_SENTINEL                                         | fails   | AGENT_ACCOUNT_AUTH_REJECTED         |
      | the account answers            | 200    | PRIVATE_SENTINEL                                         | fails   | AGENT_ACCOUNT_SESSION_TIMED_OUT     |
      | the proxy does not say why     | 502    | PRIVATE_SENTINEL                                         | fails   | AGENT_ACCOUNT_SESSION_TIMED_OUT     |

  Scenario: A session that ran into its deadline stays a timeout when the proxy does not answer
    Given the proxy lists these models:
      | antigravity-a@example.com/gemini-3.8-flash |
    And the session of the account "a@example.com" runs into its deadline
    When this node's account sessions are verified
    Then the check "agent:opencode:account-1:session" fails saying "AGENT_ACCOUNT_SESSION_TIMED_OUT"

  Scenario: A session that ended on its own is read from what it printed, and the proxy is not asked
    Given the proxy lists these models:
      | antigravity-a@example.com/gemini-3.8-flash |
    And the session of the account "a@example.com" fails printing "Verify your account to continue."
    When this node's account sessions are verified
    Then the check "agent:opencode:account-1:session" fails saying "AGENT_ACCOUNT_VERIFICATION_REQUIRED"
    And the proxy was not asked about any account
    And no check names "Verify your account"

  Scenario: An OpenCode account session prints its errors, so a rate limit it retries shows
    OpenCode retries a request the proxy refuses with 429 until the session's
    deadline and prints nothing about it unless asked to.
    Then the OpenCode account session is launched with "--print-logs --log-level ERROR"

  Scenario: A passing session is not reused once the roster changed
    Given a session check passed under the roster version "aaaa"
    When the session is checked again under the roster version "bbbb"
    Then the session was run again

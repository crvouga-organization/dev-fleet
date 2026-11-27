Feature: Every per-account instance runs a real session, and account changes re-verify
  T3 offers one instance per proxy account. Each one is verified with a real,
  cheap session through its launcher. A rate-limited account is
  cooling-down, never a pass and never a failure. An account its provider
  wants verified, one whose credentials are refused and a session that never
  ended are each reported under a code of their own. An instance whose
  account the proxy no longer holds fails without being run. Results are
  cached under a key that holds the roster version and the client key's
  version: a pass for six hours, anything else for ten minutes. The proxy is
  asked about an account before its session is launched, so an account it
  already answers for costs no session.

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
    And every check says how long its session took

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
      | OpenCode printed the provider's demand | failed | level=ERROR message=\"stream error\" error.error=\"AI_APICallError: Verify your account to continue.\" | verification-required |
      | only the provider's reason is left | failed | status: PERMISSION_DENIED, reason: VALIDATION_REQUIRED | verification-required |
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
    And the check "agent:codex:account-1:session" asks to run "homelab accounts"

  Scenario: A cooldown asks nothing of anyone
    Given the proxy lists these models:
      | codex-a@example.com/gpt-6.1-sol |
    And the sessions answer:
      | account       | result       |
      | a@example.com | cooling-down |
    When the account sessions are checked
    Then the check "agent:codex:account-1:session" has no remedy

  Scenario Outline: A cooling-down session names when the cooldown clears, when the proxy says so: <case>
    The proxy answers a request for a model it holds back with 429 and says
    how long it holds it: in Retry-After, as seconds or as a date, or in the
    reset_seconds of its error. The check repeats that instant and invents
    none: an answer that names no time, a time already past or one that is
    not a time leaves the summary without one.
    Given the proxy lists these models:
      | antigravity-a@example.com/gemini-3.8-flash |
    And the time is "2027-01-15T09:00:00Z"
    And the session of the account "a@example.com" runs into its deadline
    And the proxy answers a request for that account's model with the status 429 saying "<answer>"
    And that answer carries the header "Retry-After: <retry after>"
    When this node's account sessions are verified
    Then the summary of the check "agent:antigravity:account-1:session" is "AGENT_ACCOUNT_COOLING_DOWN: antigravity account 1 <limited>; checked again on the next status."
    And the check "agent:antigravity:account-1:session" has no remedy
    And no check repeats what the proxy answered

    Examples:
      | case                         | retry after                   | answer                                                                                        | limited                                      |
      | seconds                      | 1800                          | {"error":{"message":"PRIVATE_SENTINEL","type":"rate_limit_error","param":null,"code":"model_cooldown"}} | is rate limited until 2027-01-15T09:30:00Z |
      | a date                       | Fri, 15 Jan 2027 10:15:00 GMT | PRIVATE_SENTINEL                                                                              | is rate limited until 2027-01-15T10:15:00Z |
      | the header before the error  | 60                            | {"error":{"code":"model_cooldown","reset_seconds":1800,"message":"PRIVATE_SENTINEL"}}         | is rate limited until 2027-01-15T09:01:00Z |
      | a time already past          | Fri, 15 Jan 2027 08:00:00 GMT | PRIVATE_SENTINEL                                                                              | is rate limited                              |
      | no seconds at all            | 0                             | PRIVATE_SENTINEL                                                                              | is rate limited                              |
      | something that is not a time | soon                          | PRIVATE_SENTINEL                                                                              | is rate limited                              |
      | a time a year away           | 31536000                      | PRIVATE_SENTINEL                                                                              | is rate limited                              |

  Scenario Outline: A cooling-down session whose answer has no Retry-After reads the proxy's error: <case>
    Given the proxy lists these models:
      | antigravity-a@example.com/gemini-3.8-flash |
    And the time is "2027-01-15T09:00:00Z"
    And the session of the account "a@example.com" runs into its deadline
    And the proxy answers a request for that account's model with the status 429 saying "<answer>"
    When this node's account sessions are verified
    Then the summary of the check "agent:antigravity:account-1:session" is "AGENT_ACCOUNT_COOLING_DOWN: antigravity account 1 <limited>; checked again on the next status."

    Examples:
      | case                      | answer                                                     | limited                                      |
      | it names the seconds left | {"error":{"code":"model_cooldown","reset_seconds":1800}}   | is rate limited until 2027-01-15T09:30:00Z |
      | it names no time          | {"error":{"code":"model_cooldown"}}                        | is rate limited                              |
      | its seconds are no number | {"error":{"code":"model_cooldown","reset_seconds":"soon"}} | is rate limited                              |
      | it is not an error object | RESOURCE_EXHAUSTED                                         | is rate limited                              |

  Scenario Outline: A session the fleet's relay refused names the time the relay printed: <case>
    The relay answers a request for an account it holds back with "cooling
    down until" and an instant. Nothing else a session prints is read as a
    time.
    Given the proxy lists these models:
      | claude-a@example.com/claude-sonnet-5-5 |
    And the time is "2027-01-15T09:00:00Z"
    And the session of the account "a@example.com" fails printing "<output>"
    When this node's account sessions are verified
    Then the summary of the check "agent:claude:account-1:session" is "AGENT_ACCOUNT_COOLING_DOWN: claude account 1 <limited>; checked again on the next status."
    And the proxy was asked 1 time

    Examples:
      | case                    | output                                                      | limited                                      |
      | the relay named it      | This account is cooling down until 2027-01-15T09:30:00.000Z. | is rate limited until 2027-01-15T09:30:00Z |
      | the time is past        | This account is cooling down until 2027-01-15T08:30:00.000Z. | is rate limited                              |
      | a provider named a date | 429 Too Many Requests, try again after 2027-01-15T09:30:00Z | is rate limited                              |
      | nothing named a time    | 429 Too Many Requests                                       | is rate limited                              |

  Scenario: A cooldown is named only for an account that is cooling down
    Given the proxy lists these models:
      | claude-a@example.com/claude-sonnet-5-5 |
      | claude-b@example.com/claude-sonnet-5-5 |
    And the sessions answer:
      | account       | result       | clears               |
      | a@example.com | cooling-down | 2027-01-15T09:30:00Z |
      | b@example.com | failed       | 2027-01-15T09:30:00Z |
    When the account sessions are checked
    Then the summary of the check "agent:claude:account-1:session" is "AGENT_ACCOUNT_COOLING_DOWN: claude account 1 is rate limited until 2027-01-15T09:30:00Z; checked again on the next status."
    And the summary of the check "agent:claude:account-2:session" is "AGENT_ACCOUNT_SESSION_FAILED: claude account 2 did not run a session."

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
    Then the check "agent:antigravity:account-1:session" <verdict> saying "<code>"
    And the proxy was asked for the model "antigravity-a@example.com/gemini-3.8-flash"
    And no check names "example.com"
    And no check repeats what the proxy answered

    Examples:
      | case                           | status | answer                                                   | verdict | code                                |
      | the proxy holds its model back | 429    | {"error":{"code":"model_cooldown","reset_seconds":1800}} | warns   | AGENT_ACCOUNT_COOLING_DOWN          |
      | its provider limits it         | 429    | RESOURCE_EXHAUSTED                                       | warns   | AGENT_ACCOUNT_COOLING_DOWN          |
      | its provider wants it verified | 403    | Verify your account to continue.                         | fails   | AGENT_ACCOUNT_VERIFICATION_REQUIRED |
      | the proxy wraps that in its error | 403 | {"error":{"message":"VERIFY  YOUR ACCOUNT","type":"invalid_request_error","param":null,"code":"PRIVATE"}} | fails | AGENT_ACCOUNT_VERIFICATION_REQUIRED |
      | the proxy limits it in its error | 429  | {"error":{"message":"PRIVATE_SENTINEL","type":"rate_limit_error","param":null,"code":"PRIVATE"}} | warns | AGENT_ACCOUNT_COOLING_DOWN |
      | the proxy refuses it in its error | 401 | {"error":{"message":"PRIVATE_SENTINEL","type":"authentication_error","param":null,"code":"PRIVATE"}} | fails | AGENT_ACCOUNT_AUTH_REJECTED |
      | its credentials are refused    | 401    | PRIVATE_SENTINEL                                         | fails   | AGENT_ACCOUNT_AUTH_REJECTED         |
      | the account answers            | 200    | PRIVATE_SENTINEL                                         | fails   | AGENT_ACCOUNT_SESSION_TIMED_OUT     |
      | the proxy does not say why     | 502    | PRIVATE_SENTINEL                                         | fails   | AGENT_ACCOUNT_SESSION_TIMED_OUT     |

  Scenario: A session that ran into its deadline stays a timeout when the proxy does not answer
    Given the proxy lists these models:
      | antigravity-a@example.com/gemini-3.8-flash |
    And the session of the account "a@example.com" runs into its deadline
    When this node's account sessions are verified
    Then the check "agent:antigravity:account-1:session" fails saying "AGENT_ACCOUNT_SESSION_TIMED_OUT"

  Scenario: A session that ended on its own is read from what it printed, and the proxy is not asked again
    Given the proxy lists these models:
      | antigravity-a@example.com/gemini-3.8-flash |
    And the session of the account "a@example.com" fails printing "Verify your account to continue."
    When this node's account sessions are verified
    Then the check "agent:antigravity:account-1:session" fails saying "AGENT_ACCOUNT_VERIFICATION_REQUIRED"
    And the proxy was asked 1 time
    And no check names "Verify your account"

  Scenario Outline: An account the proxy already answers for is reported without a session: <case>
    The proxy is asked for the account's model before its session is
    launched. OpenCode would retry such an account quietly until the
    session's deadline, on every node of every sync.
    Given the proxy lists these models:
      | antigravity-a@example.com/gemini-3.8-flash |
    And the session of the account "a@example.com" runs into its deadline
    And the proxy answers a request for that account's model with the status <status> saying "<answer>"
    When this node's account sessions are verified
    Then the check "agent:antigravity:account-1:session" <verdict> saying "<code>"
    And 0 sessions were launched
    And the proxy was asked 1 time

    Examples:
      | case                           | status | answer                           | verdict | code                                |
      | the proxy holds its model back | 429    | {"error":{"code":"model_cooldown","reset_seconds":1800}} | warns | AGENT_ACCOUNT_COOLING_DOWN |
      | its provider wants it verified | 503    | auth_unavailable: no auth available (last upstream error: 403: Verify your account to continue.) | fails | AGENT_ACCOUNT_VERIFICATION_REQUIRED |
      | its credentials are refused    | 401    | PRIVATE_SENTINEL                 | fails   | AGENT_ACCOUNT_AUTH_REJECTED         |

  Scenario: An account the proxy names nothing for gets its session, with the full deadline
    Given the proxy lists these models:
      | antigravity-a@example.com/gemini-3.8-flash |
    And the session of the account "a@example.com" runs into its deadline
    And the proxy answers a request for that account's model with the status 200 saying "PRIVATE_SENTINEL"
    When this node's account sessions are verified
    Then the check "agent:antigravity:account-1:session" fails saying "AGENT_ACCOUNT_SESSION_TIMED_OUT"
    And 1 session was launched
    And the last session was given 150 seconds to end
    And the proxy was asked 2 times

  Scenario: A session that printed a rate limit is ended at once, not at its deadline
    OpenCode prints the provider's refusal within a second, then retries
    quietly until the deadline. A small request the proxy answers says
    nothing of the session's quota, so the session's own words decide.
    Given the proxy lists these models:
      | antigravity-a@example.com/gemini-3.8-flash |
    And the session of the account "a@example.com" prints "level=ERROR AI_APICallError: Resource has been exhausted (e.g. check quota).\n" and then hangs
    And the proxy answers a request for that account's model with the status 200 saying "PRIVATE_SENTINEL"
    When this node's account sessions are verified
    Then the check "agent:antigravity:account-1:session" warns saying "AGENT_ACCOUNT_COOLING_DOWN"
    And the last session was ended as soon as it said so
    And the proxy was asked 1 time

  Scenario: A session the relay refused keeps the instant it named, ended at once
    Given the proxy lists these models:
      | claude-a@example.com/claude-sonnet-5-5 |
    And the time is "2027-01-15T09:00:00Z"
    And the session of the account "a@example.com" prints "This account is cooling down until 2027-01-15T09:30:00.000Z.\n" and then hangs
    When this node's account sessions are verified
    Then the summary of the check "agent:claude:account-1:session" is "AGENT_ACCOUNT_COOLING_DOWN: claude account 1 is rate limited until 2027-01-15T09:30:00Z; checked again on the next status."
    And the last session was ended as soon as it said so

  Scenario Outline: What a session printed so far ends it: <case>
    Only whole lines are read, so a line cut between two reads is read once
    it is complete, with the instant a cooldown clears.
    When a session has printed "<output>" so far
    Then it is <verdict>

    Examples:
      | case                         | output                                              | verdict      |
      | it printed a limit           | level=ERROR AI_APICallError: 429 RESOURCE_EXHAUSTED\n | ended        |
      | it printed a demand to verify | Verify your account to continue.\n                 | ended        |
      | its credentials were refused | unexpected status 401 Unauthorized\n               | ended        |
      | the line is not complete yet | This account is cooling down until 2027-01          | left running |
      | it printed nothing telling   | > build · gemini-3.8-flash\n                       | left running |

  Scenario: A session that found its account cooling down is run again after ten minutes, with a short deadline
    Given the proxy lists these models:
      | antigravity-a@example.com/gemini-3.8-flash |
    And this node remembers what its account sessions found
    And the session of the account "a@example.com" fails printing "429 Too Many Requests"
    And this node's account sessions were verified 11 minutes ago
    When this node's account sessions are verified
    Then 1 session was launched
    And the last session was given 30 seconds to end

  Scenario: A session that did not pass is not run again within ten minutes, and its check says when that was found
    Back-to-back syncs do not pay for the same dead session twice.
    Given the proxy lists these models:
      | antigravity-a@example.com/gemini-3.8-flash |
    And this node remembers what its account sessions found
    And the session of the account "a@example.com" runs into its deadline
    And this node's account sessions were verified 4 minutes ago
    When this node's account sessions are verified
    Then the summary of the check "agent:antigravity:account-1:session" is "AGENT_ACCOUNT_SESSION_TIMED_OUT: antigravity account 1 did not end a session before the deadline; the proxy named no cooldown and no refusal for it. (found 4m ago; a session that does not pass is run again after 10m or on any change)"
    And 0 sessions were launched
    And the proxy was asked 0 times

  Scenario: A remembered cooldown keeps the instant it clears
    Given the proxy lists these models:
      | claude-a@example.com/claude-sonnet-5-5 |
    And this node remembers what its account sessions found
    And the time is "2027-01-15T09:00:00Z"
    And the session of the account "a@example.com" fails printing "This account is cooling down until 2027-01-15T09:30:00.000Z."
    And this node's account sessions were verified 2 minutes ago
    When this node's account sessions are verified
    Then the summary of the check "agent:claude:account-1:session" is "AGENT_ACCOUNT_COOLING_DOWN: claude account 1 is rate limited until 2027-01-15T09:30:00Z; checked again on the next status. (found 2m ago; a session that does not pass is run again after 10m or on any change)"
    And 0 sessions were launched

  Scenario: A session that ran into its deadline is run again after ten minutes, with a short deadline
    Given the proxy lists these models:
      | antigravity-a@example.com/gemini-3.8-flash |
    And this node remembers what its account sessions found
    And the session of the account "a@example.com" runs into its deadline
    And this node's account sessions were verified 11 minutes ago
    When this node's account sessions are verified
    Then the check "agent:antigravity:account-1:session" fails saying "AGENT_ACCOUNT_SESSION_TIMED_OUT"
    And the summary of the check "agent:antigravity:account-1:session" is "AGENT_ACCOUNT_SESSION_TIMED_OUT: antigravity account 1 did not end a session before the deadline; the proxy named no cooldown and no refusal for it."
    And 1 session was launched
    And the last session was given 30 seconds to end

  Scenario: A session that failed for another reason is run again after ten minutes, with the full deadline
    Given the proxy lists these models:
      | antigravity-a@example.com/gemini-3.8-flash |
    And this node remembers what its account sessions found
    And the session of the account "a@example.com" fails printing "model_not_found"
    And this node's account sessions were verified 11 minutes ago
    When this node's account sessions are verified
    Then 1 session was launched
    And the last session was given 150 seconds to end

  Scenario: An account that answers again passes on the next run, and nothing of its failure is kept
    Given the proxy lists these models:
      | antigravity-a@example.com/gemini-3.8-flash |
    And this node remembers what its account sessions found
    And the session of the account "a@example.com" runs into its deadline
    And this node's account sessions were verified 11 minutes ago
    And the account "a@example.com" answers its session again
    When this node's account sessions are verified
    Then the check "agent:antigravity:account-1:session" passes

  Scenario: A change to the roster runs a remembered session at once
    Given the proxy lists these models:
      | antigravity-a@example.com/gemini-3.8-flash |
    And this node remembers what its account sessions found
    And the session of the account "a@example.com" runs into its deadline
    And this node's account sessions were verified 4 minutes ago
    And the proxy lists these models:
      | antigravity-a@example.com/gemini-3.8-flash |
      | antigravity-b@example.com/gemini-3.8-flash |
    When this node's account sessions are verified
    Then 2 sessions were launched
    And the last session was given 150 seconds to end

  Scenario: A passing session is not reused once the roster changed
    Given a session check passed under the roster version "aaaa"
    When the session is checked again under the roster version "bbbb"
    Then the session was run again

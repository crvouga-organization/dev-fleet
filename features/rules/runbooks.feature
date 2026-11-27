Feature: Every failure code has a runbook, and the documents quote real commands
  A failure code is an upper-case name of two words or more that stands
  where the source reports one: a whole string of the TypeScript (the
  summary of a check, the message of a refusal, a member of a list of
  codes) or the name that opens one ("CODE: what was found"), what a
  bootstrap phase dies with, the name that opens what a script on a machine
  says, the name an Ansible message starts with or a task names, the phase
  the CLI proxy reports to a converge, and the name the error of a
  workflow starts with. A code is never told from
  another name by the word it ends with: a list of such words leaves every
  code that ends otherwise without an entry. A name the TypeScript reads
  from the environment is a variable; the few other names that stand where
  a code stands and are not codes are stated here, one by one. A new name
  is therefore a code until this feature says otherwise. docs/runbooks.md
  has one entry for each code: what it means, how to confirm it, the fix
  and when to escalate. A command the documents quote has to exist, or an
  operator following them runs into an error instead of a fix.

  Background:
    Given these names stand where a code stands and are not codes:
      | name                             | what it is                                             |
      | CLAUDE_CODE_USE_BEDROCK          | an environment variable an agent is started without    |
      | CLAUDE_CODE_USE_FOUNDRY          | an environment variable an agent is started without    |
      | CLAUDE_CODE_USE_VERTEX           | an environment variable an agent is started without    |
      | GROK_CODE_XAI_API_KEY            | an environment variable an agent is started without    |
      | GROK_MODELS_BASE_URL             | an environment variable an agent is started without    |
      | OPENAI_BASE_URL                  | an environment variable an agent is started without    |
      | XAI_API_KEY                      | an environment variable an agent is started without    |
      | WS_AGENT_ACCOUNT                 | a variable of a T3 provider                            |
      | WS_AGENT_NODE                    | a variable of a T3 provider                            |
      | GITHUB_TOKEN                     | the field of a secret                                  |
      | GITHUB_OK                        | the result of a GitHub sign-in that worked             |
      | REPLACE_WITH_ABSOLUTE_SSH_CONFIG | a placeholder in the editor settings onboarding prints |
      | REPLACE_WITH_SAME_OPENSSH_BINARY | a placeholder in the editor settings onboarding prints |
      | YOUR_USERNAME                    | a placeholder in a command a remedy prints             |
      | FLEET_FORWARD_IN_TEST            | a refusal only a scenario of this repository can meet  |

  Scenario: Every failure code in the source has an entry in the runbooks
    When the failure codes of the source are collected
    Then there are more than 400 of them
    And each has an entry in "docs/runbooks.md"
    And "docs/runbooks.md" has no entry for a code the source does not report

  Scenario: A name stated not to be a code still stands where a code stands
    A name that left the source, or became a variable the source reads, is
    removed from the list above: the list never hides a code of that name
    that is added later.
    When the names that stand where a code stands are collected
    Then each name stated not to be a code is one of them

  Scenario Outline: A code that opens a summary is collected: <code>
    These stand inside a sentence.
    When the failure codes of the source are collected
    Then "<code>" is one of them

    Examples:
      | code                                |
      | AGENT_ACCOUNT_SESSION_FAILED        |
      | AGENT_ACCOUNT_COOLING_DOWN          |
      | AGENT_ACCOUNT_VERIFICATION_REQUIRED |
      | AGENT_ACCOUNT_AUTH_REJECTED         |
      | AGENT_ACCOUNT_SESSION_TIMED_OUT     |
      | AGENT_ACCOUNT_REMOVED               |

  Scenario Outline: A code is collected whatever word it ends with: <code>
    Each is reported <where>, and none ends with a word a failure usually
    ends with.
    When the failure codes of the source are collected
    Then "<code>" is one of them

    Examples:
      | code                            | where                                 |
      | TAILSCALE_KEY_EXPIRED           | as the whole summary of a check       |
      | T3_VERSION_SKEW                 | as the whole summary of a check       |
      | WATCH_HEARTBEAT_NO_BUCKET       | as the whole summary of a check       |
      | BESZEL_HUB_UNAVAILABLE_TO_AGENT | as the whole summary of a check       |
      | GITHUB_NOT_SIGNED_IN            | as one of two summaries of a check    |
      | PROVIDER_PROTOCOL_INCOMPATIBLE  | in a list of the codes of a provider  |
      | BESZEL_DUPLICATE_FINGERPRINT    | as the message of a refusal           |
      | VAULT_WORKER_TOKEN_NOT_ISSUED   | as the argument of a failed check     |
      | REMOTE_BOOTSTRAP_INCOMPLETE     | as the code a bootstrap starts with   |
      | APT_UPDATE_FAILED               | by the bootstrap's package step       |
      | T3_NO_GRAPHICAL_SESSION         | in what a script on a worker says     |
      | T3_IDLE_UNKNOWN                 | in what a script on a worker prints   |
      | MANAGER_CLOCK_NOT_SYNCHRONISED  | at the start of an Ansible assertion  |
      | SSH_CONFIG_REJECTED             | at the start of an Ansible failure    |
      | FLEET_HEARTBEAT_STALE           | at the start of a workflow's error    |
      | PROXY_ENDPOINT_AUTH             | as a phase of the CLI proxy           |

  Scenario Outline: The name of an environment variable is not a code: <name>
    The source reads each from the environment, so it is a variable wherever
    else it stands.
    When the failure codes of the source are collected
    Then "<name>" is not one of them

    Examples:
      | name                    |
      | HOMELAB_CONFIG         |
      | HOMELAB_STATE          |
      | MISE_GLOBAL_CONFIG_FILE |
      | ANTHROPIC_BASE_URL      |
      | HOMELAB_SELECTED_BY    |

  Scenario: The runbooks count the codes, and the ones that need a person
    When the failure codes of the source are collected
    Then "docs/runbooks.md" states how many codes there are and how many need a person

  Scenario: Every homelab command the documents quote exists
    When the homelab commands quoted in the documents are read
    Then there are more than 20 of them
    And each is a command of the homelab CLI

  Scenario: The documents quote no earlier executable or package
    When the documents are searched for an earlier executable or package
    Then nothing is found

Feature: T3 shows only the models the proxy serves
  The provider instances are generated from the accounts signed in on the
  proxy. Accounts of one tool are not entitled to the same models, so each
  instance hides the models of T3's catalogue that its own account does not
  serve, and opens on one it does: a model that is shown and not served fails
  on first use. Every model the fleet requires must be both served and shown.

  Background:
    Given the preferred defaults of "codex" are "gpt-6.1-sol, gpt-6-luna"
    And the proxy serves these models:
      | tool  | account          | models                  |
      | codex | dev@example.test | gpt-6.1-sol, gpt-6-luna |
    And T3 holds the instances of every account the proxy serves
    And T3's catalogue for the driver "codex" is "gpt-6.1-sol, gpt-6-luna"

  Scenario: Every offered model is served
    When the models T3 offers are checked
    Then the check "t3:models" passes

  Scenario: An instance whose account serves the whole catalogue is left as it is
    When the models T3 offers are synced
    Then the check "t3:models" passes
    And T3's settings have no "providerModelPreferences"

  Scenario: A proxy that does not answer leaves the models unverified
    Given the proxy does not answer
    When the models T3 offers are checked
    Then the check "t3:models" warns with "T3_MODELS_UNVERIFIED"

  Scenario: A live Antigravity model missing from the static catalogue is hidden only for an account without its route
    Given the proxy serves these models:
      | tool        | account           | models                                                                |
      | antigravity | team@example.test | gemini-3.8-flash, gemini-3.1-flash-lite-preview                       |
      | antigravity | pro@example.test  | gemini-3.8-flash, gemini-3.1-flash-lite-preview, gemini-4-neon-xhigh, gemini-4-neon |
    And T3 holds the instances of every account the proxy serves
    And T3's catalogue for the driver "antigravity" is "gemini-3.8-flash"
    When the models T3 offers are synced
    Then the check "t3:models" passes
    And T3's setting "providerModelPreferences" is:
      """
      {
        "personal_antigravity_team_example_test": {
          "hiddenModels": ["gemini-4-neon"],
          "modelOrder": ["gemini-3.8-flash"]
        }
      }
      """

  Rule: Two accounts of one tool with different entitlements each show what their own account serves

    T3 keeps what an instance's model picker shows under the instance's ID:
    the models it hides and the order of the rest. It opens an instance on
    its catalogue's default, or on the first model shown when that is hidden.

    Background:
      Given the proxy serves these models:
        | tool  | account           | models                               |
        | codex | pro@example.test  | gpt-6.1-sol, gpt-6-astra, gpt-6-luna |
        | codex | team@example.test | gpt-6-luna, gpt-5.6-terra            |
      And T3 holds the instances of every account the proxy serves
      And T3's catalogue for the driver "codex" is "gpt-6-astra, gpt-6.1-sol, gpt-6-luna"

    Scenario: A sync hides what an account does not serve, and lists the preferred default it serves first
      When the models T3 offers are synced
      Then the check "t3:models" passes
      And T3's setting "providerModelPreferences" is:
        """
        {
          "personal_codex_team_example_test": {
            "hiddenModels": ["gpt-6-astra", "gpt-6.1-sol"],
            "modelOrder": ["gpt-6-luna"]
          }
        }
        """

    Scenario: Until a sync, the difference is pending: it is no fault of the fleet's configuration
      When the models T3 offers are checked
      Then the check "t3:models" warns with "T3_MODELS_PENDING"
      And the remedy of the check "t3:models" mentions "codex: hide gpt-6-astra; codex: hide gpt-6.1-sol; codex: list gpt-6-luna first"
      And nothing reported contains "example.test"
      And T3's settings have no "providerModelPreferences"

    Scenario: After a sync, nothing is reported and nothing is written again
      Given the models T3 offers have been synced
      When the models T3 offers are synced
      Then the check "t3:models" passes
      And T3's settings were not written again

    Scenario: A model an account serves again is shown again
      Given the models T3 offers have been synced
      And the proxy serves these models:
        | tool  | account           | models                               |
        | codex | pro@example.test  | gpt-6.1-sol, gpt-6-astra, gpt-6-luna |
        | codex | team@example.test | gpt-6.1-sol, gpt-6-luna              |
      When the models T3 offers are synced
      Then T3's setting "providerModelPreferences" is:
        """
        {
          "personal_codex_team_example_test": {
            "hiddenModels": ["gpt-6-astra"],
            "modelOrder": ["gpt-6.1-sol", "gpt-6-luna"]
          }
        }
        """

    Scenario: What the machine chose for itself is kept
      Another instance, a hidden model outside the catalogue and the order
      of the other models are not the fleet's.
      Given T3's settings hold these model preferences:
        """
        {
          "codex": { "hiddenModels": ["gpt-6-luna"], "modelOrder": [] },
          "personal_codex_team_example_test": {
            "hiddenModels": ["gpt-private"],
            "modelOrder": ["gpt-5.6-terra", "gpt-6-luna"]
          }
        }
        """
      When the models T3 offers are synced
      Then T3's setting "providerModelPreferences" is:
        """
        {
          "codex": { "hiddenModels": ["gpt-6-luna"], "modelOrder": [] },
          "personal_codex_team_example_test": {
            "hiddenModels": ["gpt-private", "gpt-6-astra", "gpt-6.1-sol"],
            "modelOrder": ["gpt-6-luna", "gpt-5.6-terra"]
          }
        }
        """

    Scenario: A catalogue model someone hid on an account's instance is shown again when its account serves it
      On an account's instance, which catalogue models are hidden is the
      fleet's: drift is put right, as it is for the instance itself.
      Given T3's settings hold these model preferences:
        """
        {
          "personal_codex_pro_example_test": {
            "hiddenModels": ["gpt-6-astra"],
            "modelOrder": []
          }
        }
        """
      When the models T3 offers are checked
      Then the check "t3:models" warns with "T3_MODELS_PENDING"
      And the remedy of the check "t3:models" mentions "codex: show gpt-6-astra"

    Scenario Outline: When T3 rewrites its settings <often> during a sync, the check <outcome>
      T3 writes the same file: a write happens only when the file is still
      what was read, and what T3 wrote is never overwritten.
      Given T3 rewrites its settings while the models are synced, <often>
      When the models T3 offers are synced
      Then the check "t3:models" <outcome>
      And T3's setting "lastOpened" is:
        """
        <count>
        """

      Examples:
        | often   | count | outcome                       |
        | 1 time  | 1     | passes                        |
        | 3 times | 3     | warns with "T3_SETTINGS_BUSY" |

  Rule: A model that cannot work is a fault, and is reported until it is put right

    Scenario: A custom model of an instance is always shown
      Given the instance of "dev@example.test" adds the custom model "gpt-private"
      When the models T3 offers are synced
      Then the check "t3:models" warns with "T3_MODELS_MISMATCH"
      And the remedy of the check "t3:models" mentions "T3 offers gpt-private, which the proxy does not serve"
      And nothing reported contains "dev@example.test"

    Scenario Outline: A required model that is <where> is reported
      Given the fleet requires the model "<model>" for "codex"
      And T3's catalogue for the driver "codex" is "<catalogue>"
      When the models T3 offers are synced
      Then the check "t3:models" <outcome>

      Examples:
        | where                   | model       | catalogue               | outcome                         |
        | served and offered      | gpt-6.1-sol | gpt-6.1-sol, gpt-6-luna | passes                          |
        | not served by the proxy | gpt-7       | gpt-6.1-sol             | warns with "T3_MODELS_MISMATCH" |
        | served but not offered  | gpt-6-luna  | gpt-6.1-sol             | warns with "T3_MODELS_MISMATCH" |

    Scenario Outline: T3's <which> model on an account's instance must be one its account serves
      Given T3's setting "<setting>" names the model "gpt-6-astra" on the instance of "dev@example.test"
      When the models T3 offers are synced
      Then the check "t3:models" warns with "T3_MODELS_MISMATCH"
      And the remedy of the check "t3:models" mentions "codex: T3’s <which> model gpt-6-astra is not served by the proxy"

      Examples:
        | which    | setting                |
        | default  | defaultModelSelection  |
        | fallback | fallbackModelSelection |

    Scenario: An account that serves none of the preferred defaults defaults to its first model by name, and is reported
      Given the proxy serves these models:
        | tool  | account          | models                       |
        | codex | dev@example.test | gpt-5.6-terra, gpt-6.1-terra |
      And T3's catalogue for the driver "codex" is "gpt-6.1-terra"
      When the models T3 offers are synced
      Then the check "t3:models" warns with "T3_MODELS_MISMATCH"
      And the remedy of the check "t3:models" mentions "codex: an account serves none of the preferred defaults (gpt-6.1-sol, gpt-6-luna) and defaults to gpt-5.6-terra"

    Scenario: An account that serves nothing of T3's catalogue has an instance with no model that works
      Given the proxy serves these models:
        | tool  | account          | models        |
        | codex | dev@example.test | gpt-6-luna-x2 |
      When the models T3 offers are synced
      Then the check "t3:models" warns with "T3_MODELS_MISMATCH"
      And the remedy of the check "t3:models" mentions "codex: T3 offers no model the proxy serves for an account"

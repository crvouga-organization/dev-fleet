# ␊ stands for a line break.
Feature: Secrets are read by purpose
  Fleet code asks for a secret by what it is for. Where each one is kept is
  the fleet's own choice, declared under "secrets" in its fleet configuration.
  A secret is never passed to a command as an argument, and one that cannot be
  read is not available rather than empty.

  Rule: A fleet may keep its secrets in the environment

    Background:
      Given a fleet whose secrets block is:
        """
        { "provider": "env" }
        """
      And the environment variable "DEVFLEET_SECRET_PROXY_CLIENT_KEY" holds " value␊"

    Scenario: Each secret has an environment variable of its own
      Then the secret "proxy-client-key" is kept in the environment variable "DEVFLEET_SECRET_PROXY_CLIENT_KEY"

    Scenario: A secret in the environment is read without the white space around it
      When the secret "proxy-client-key" is read
      Then the secret read is "value"

    Scenario: A secret whose variable is not set is not available
      When the secret "monitoring-tunnel-token" is read
      Then the secret is not available

  Rule: A fleet may keep each secret in a private file

    Background:
      Given a fleet that keeps its secrets as files in a directory of its own
      And the file "proxy-client-key" in that directory holds "from-file␊"

    Scenario: A secret is the content of the file named after it
      When the secret "proxy-client-key" is read
      Then the secret read is "from-file"

    Scenario: A secret with no file is not available
      When the secret "monitoring-account-password" is read
      Then the secret is not available

  Rule: A fleet may keep its secrets in a sops document

    Scenario: sops is asked for the one key of the encrypted document
      Given a fleet whose secrets block is:
        """
        { "provider": "sops", "file": "/x/secrets.yaml" }
        """
      And every command prints "secret␊"
      When the secret "proxy-client-key" is read
      Then the secret read is "secret"
      And the only command run was:
        | sops | --decrypt | --extract | ["proxy-client-key"] | /x/secrets.yaml |

  Rule: A fleet may keep its secrets in Vault

    Background:
      Given a fleet whose secrets block is:
        """
        {
          "provider": "vault",
          "address": "https://vault.example.org",
          "mount": "secret",
          "locations": {
            "proxy-client-key": { "path": "team/prd", "field": "KEY" },
            "monitoring-account-password": { "path": "team/prd", "field": "KEY" },
            "monitoring-tunnel-token": { "path": "missing", "field": "TOKEN" },
            "proxy-tunnel-token": { "path": "team/prd", "field": "KEY" }
          }
        }
        """
      And every command prints "secret␊"

    Scenario: Vault is asked for the one field the fleet configuration names
      When the secret "proxy-client-key" is read
      Then the secret read is "secret"
      And the only command run was:
        | vault | kv | get | -address=https://vault.example.org | -mount=secret | -field=KEY | team/prd |

    Scenario: A secret Vault does not hold is not available
      Given the command "vault kv get -address=https://vault.example.org -mount=secret -field=TOKEN missing" fails
      When the secret "monitoring-tunnel-token" is read
      Then the secret is not available

  Rule: A provider this machine is not logged in to is told apart from a secret it does not hold
    A check that got no secret asks which it was, so that a Vault login that
    has expired is reported once, by the check that owns it, and a secret that
    is really absent keeps the code of the check that needs it. Only Vault has
    a login; what the lookup prints holds the token and is never kept.

    Background:
      Given a fleet whose secrets block is:
        """
        {
          "provider": "vault",
          "address": "https://vault.example.org",
          "mount": "secret",
          "locations": {
            "proxy-client-key": { "path": "team/prd", "field": "KEY" },
            "monitoring-account-password": { "path": "team/prd", "field": "KEY" },
            "monitoring-tunnel-token": { "path": "missing", "field": "TOKEN" },
            "proxy-tunnel-token": { "path": "team/prd", "field": "KEY" }
          }
        }
        """

    Scenario: A Vault session that answers is a login this machine holds
      Given the command "vault token lookup" prints '{"data":{"id":"hvs.PRIVATE_SENTINEL","ttl":3600}}'
      When this machine's login to the secrets provider is measured
      Then the login is held
      And the only command run was:
        | vault | token | lookup | -address=https://vault.example.org | -format=json |

    Scenario Outline: A Vault session that <answer> is a login that is required
      Given the command "vault token lookup" fails with the error "<error>"
      When this machine's login to the secrets provider is measured
      Then the login is required

      Examples:
        | answer                 | error                                  |
        | Vault refuses          | Code: 403. Errors: * permission denied |
        | gives no reason at all |                                        |

    Scenario Outline: A fleet that keeps its secrets in <where> has no login to lose
      Given a fleet whose secrets block is:
        """
        <block>
        """
      And every command fails
      When this machine's login to the secrets provider is measured
      Then the login is held
      And exactly 0 commands were run

      Examples:
        | where           | block                                             |
        | the environment | { "provider": "env" }                             |
        | private files   | { "provider": "file" }                            |
        | a sops document | { "provider": "sops", "file": "/x/secrets.yaml" } |

  Rule: The secrets block says where every secret is kept, or it is rejected

    Scenario: The example fleet keeps its secrets in Vault
      Then the fleet configuration in use keeps its secrets in "vault"

    Scenario Outline: The block <block> is taken as written
      When the secrets block <block> is read
      Then it is accepted as <block>

      Examples:
        | block               |
        | {"provider":"env"}  |
        | {"provider":"file"} |

    Scenario: A fleet configuration with no secrets block is rejected
      When no secrets block is read
      Then the secrets block is rejected

    Scenario Outline: A block with <fault> is rejected, never guessed
      When the secrets block <block> is read
      Then the secrets block is rejected

      Examples:
        | fault                                  | block                                                                                  |
        | a provider nobody knows                | {"provider":"keychain"}                                                                |
        | a field its provider does not have     | {"provider":"env","extra":1}                                                           |
        | sops and no document                   | {"provider":"sops"}                                                                    |
        | a Vault address that is not HTTPS      | {"provider":"vault","address":"http://plain","mount":"secret","locations":{}}          |
        | Vault and no location for every secret | {"provider":"vault","address":"https://v.example.org","mount":"secret","locations":{}} |

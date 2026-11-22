Feature: Every reader of a secret answers a blocked read the same way
  The manager reads its secrets with one login. When that login lapses, or
  the secrets provider does not answer, every secret is unreadable at once:
  one fault, owned by manager:vault-renewal. A check that only needed a
  secret says SECRET_READ_BLOCKED by that owner, and keeps its own code for
  a secret that is really absent. A reader gets that by handing the provider
  it read from to the one answer in src/secrets-blocked.ts; this feature
  lists every source that touches a provider, so a new reader is not added
  without saying how it answers.

  Scenario: Every source that handles the fleet's secrets says how it answers for one it could not read
    A source handles secrets when it names a secrets provider or the proxy
    client key. One that only hands the provider to a reader, or that
    reports no check, says so here; so does a check of a worker, whose
    login is its own and is owned by its own Vault checks.
    When the sources that handle the fleet's secrets are listed
    Then they are exactly these, and each answers as it says:
      | source                           | a secret it could not read                |
      | bootstrap/worker-github.ts       | is answered by the reader it hands it to  |
      | src/accounts/context.ts          | reports no check                          |
      | src/agents/fleet-verify.ts       | is blocked through the shared answer      |
      | src/agents/launch.ts             | reports no check                          |
      | src/agents/secrets.ts            | reports no check                          |
      | src/agents/verify.ts             | reports no check                          |
      | src/auth-checks.ts               | is answered by the reader it hands it to  |
      | src/cli/fleet-node-lifecycle.ts  | is blocked through the shared answer      |
      | src/cli/fleet-node-seed.ts       | is blocked through the shared answer      |
      | src/cli/fleet-sync-manager.ts    | is answered by the reader it hands it to  |
      | src/cli/fleet-sync-remote.ts     | is answered by the reader it hands it to  |
      | src/cli/fleet-watch.ts           | is answered by the reader it hands it to  |
      | src/cli/fleet.ts                 | is answered by the reader it hands it to  |
      | src/github/checks.ts             | is blocked through the shared answer      |
      | src/github/converge.ts           | is blocked through the shared answer      |
      | src/github/credential.ts         | is answered by the reader it hands it to  |
      | src/monitoring/hub-access.ts     | is blocked through the shared answer      |
      | src/monitoring/hub.ts            | is answered by the reader it hands it to  |
      | src/monitoring/manager-hub.ts    | is blocked through the shared answer      |
      | src/notify.ts                    | is blocked through the shared answer      |
      | src/t3/accounts.ts               | reports no check                          |
      | src/tailnet-cleanup.ts           | is blocked through the shared answer      |
      | src/tailnet-control.ts           | is blocked through the shared answer      |
      | src/worker-access-checks.ts      | is a worker's, whose login is its own     |

  Scenario: Only the secrets layer measures the login
    A reader that looked the session up itself would tell the faults apart
    its own way. The provider carries the measurement (src/secrets.ts).
    When the sources that look up a Vault session are listed
    Then they are exactly these:
      | source                       | because it                                   |
      | src/secrets.ts               | measures the login for every reader          |
      | src/cli/fleet-sync-vault.ts  | owns the login, on the manager and a worker  |
      | src/auth-checks.ts           | reports the session itself, as auth:vault    |
      | src/worker-access-checks.ts  | owns a worker's renewal                      |

  Scenario Outline: A check blocked because the manager <fault> says so in one code, with the owner and what to do
    When a check that fails for want of a secret is answered while the manager <fault> its secrets provider
    Then its summary is "SECRET_READ_BLOCKED by manager:vault-renewal"
    And it still fails
    And its remedy says "<remedy>"
    And its remedy says "Fix manager:vault-renewal"

    Examples:
      | fault               | remedy                                                |
      | is not logged in to | this machine is not logged in to the secrets provider |
      | cannot reach        | logging in again does not help                        |

  Scenario: A check whose secret is absent keeps its own code
    When a check that fails for want of a secret is answered while the manager can read its secrets provider
    Then its summary is "EXAMPLE_SECRET_REQUIRED"

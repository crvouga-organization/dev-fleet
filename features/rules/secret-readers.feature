Feature: Every reader of a secret answers a blocked read the same way
  A machine reads its secrets with one login: the manager with its own, each
  worker with its own. When that login lapses, or the secrets provider does
  not answer, every secret is unreadable at once: one fault, owned by
  manager:vault-renewal on the manager and by worker:vault-renewal on a
  worker. A check that only needed a secret says SECRET_READ_BLOCKED by that
  owner, and keeps its own code for a secret that is really absent. A reader
  gets that by handing the provider it read from to the one answer in
  src/secrets-blocked.ts; this feature lists every source that touches a
  provider, so a new reader is not added without saying how it answers.

  Scenario: Every source that handles the fleet's secrets says how it answers for one it could not read
    A source handles secrets when it names a secrets provider or the proxy
    client key. One that only hands the provider to a reader, or that
    reports no check, says so here. A check of a worker is no exception: it
    answers the same way and names the owner of the worker's login.
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
      | src/node-converge-shared.ts      | is answered by the reader it hands it to  |
      | src/notify.ts                    | is blocked through the shared answer      |
      | src/t3/accounts.ts               | reports no check                          |
      | src/tailnet-cleanup.ts           | is blocked through the shared answer      |
      | src/tailnet-control.ts           | is blocked through the shared answer      |
      | src/worker-access-checks.ts      | is blocked through the shared answer      |

  Scenario: Only the secrets layer measures the login
    A reader that looked the session up itself would tell the faults apart
    its own way. The provider carries the measurement (src/secrets.ts).
    When the sources that look up a Vault session are listed
    Then they are exactly these:
      | source                       | because it                                   |
      | src/secrets.ts               | measures the login for every reader          |
      | src/cli/fleet-sync-vault.ts  | owns the login, on the manager and a worker  |
      | src/auth-checks.ts           | reports the session itself, as auth:vault    |
      | src/worker-access-checks.ts  | owns a worker's login, and its renewal       |

  Scenario Outline: A check blocked because <machine> <fault> says so in one code, with the owner and what to do
    When a check that fails for want of a secret is answered while <machine> <fault> its secrets provider
    Then its summary is "SECRET_READ_BLOCKED by <owner>"
    And it still fails
    And its remedy says "<remedy>"
    And its remedy says "Fix <owner>"

    Examples:
      | machine     | fault               | owner                 | remedy                                                |
      | the manager | is not logged in to | manager:vault-renewal | this machine is not logged in to the secrets provider |
      | the manager | cannot reach        | manager:vault-renewal | logging in again does not help                        |
      | a worker    | is not logged in to | worker:vault-renewal  | this machine is not logged in to the secrets provider |
      | a worker    | cannot reach        | worker:vault-renewal  | logging in again does not help                        |

  Scenario Outline: A check whose secret is absent keeps its own code on <machine>
    When a check that fails for want of a secret is answered while <machine> can read its secrets provider
    Then its summary is "EXAMPLE_SECRET_REQUIRED"

    Examples:
      | machine     |
      | the manager |
      | a worker    |

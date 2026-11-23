Feature: Every worker is an SSH workspace of super.engineering on the manager
  super.engineering is a desktop app on the manager. It reaches a machine
  over the manager's own SSH and runs Git, terminals and coding agents there,
  in a remote workspace. A fleet that enables it gets one such workspace per
  worker: fleet-sync asks the app for it through the app's own CLI. The app is
  installed, started and updated by a person, so nothing here ever fails a
  sync: what is missing is a warning that says what to do.

  The app starts an agent by its plain command. On a worker that command is
  the fleet's launcher, so the sign-in is the CLI proxy's and a worker holds
  none of its own. In these scenarios {launchers} stands for the directory of
  those launchers, "/home/dev/.local/share/personal/fleet/agent-commands", and
  {shims} for the pinned CLIs, "/home/dev/.local/share/mise/shims".

  Background:
    Given the app's CLI on the manager is "/Users/dev/.super.engineering/bin/se"

  Rule: The fleet configuration enables it

    Scenario Outline: The fleet configuration enables <ides>, which is <verdict>
      When a fleet configuration that sets ides to <ides> is read
      Then the configuration is <verdict>

      Examples:
        | ides                | verdict  |
        | ["t3", "super"]     | accepted |
        | ["super"]           | accepted |
        | ["super", "super"]  | refused  |

    Scenario: It is implemented
      Then the IDE "super" is implemented

  Rule: The manager says whether the app answers

    Scenario Outline: An app that <state> <outcome>
      Given the app answers "status" with <answer>
      When the manager's super.engineering is checked
      Then the check "super:app" <outcome>

      Examples:
        | state          | answer                                                     | outcome                          |
        | runs           | {"ok":true,"api_version":40}                               | passes                           |
        | is not started | {"kind":"cli_error","error":{"code":"unavailable"}}        | warns with "SUPER_NOT_RUNNING"   |
        | answers badly  | not JSON                                                   | warns with "SUPER_REFUSED"       |

    Scenario: An app that is not installed is a warning that says where to get it
      Given the app's CLI is not on the manager
      When the manager's super.engineering is checked
      Then the check "super:app" warns with "SUPER_NOT_INSTALLED"
      And the remedy of the check "super:app" mentions "https://super.engineering/download"

  Rule: A worker gets one workspace, told by its SSH target

    Background:
      Given the manager's own SSH finds these commands on "worker-one":
        | command | where              |
        | git     | /usr/bin/git       |
        | flock   | /usr/bin/flock     |
        | claude  | {launchers}/claude |
        | codex   | {launchers}/codex  |

    Scenario: A worker the app does not know yet is given a workspace
      The workspace is named after the worker and keeps the app's consent to
      install its helper there, which live Git status and notifications need.
      Given the app holds these workspaces:
        | id  | type       | ssh target |
        | w-1 | individual |            |
      When the worker "worker-one" is converged for super.engineering
      Then the check "super:ssh" passes
      And the check "super:workspace" passes
      And the app was asked to "workspace create worker-one --type remote --ssh-target worker-one --json"

    Scenario: A worker that has its workspace is left alone
      A workspace the operator renamed is still that worker's.
      Given the app holds these workspaces:
        | id  | type       | ssh target |
        | w-1 | individual |            |
        | w-2 | remote     | worker-one |
      When the worker "worker-one" is converged for super.engineering
      Then the check "super:workspace" passes
      And the app was not asked to create a workspace

    Scenario: A workspace of another worker is not this worker's
      Given the app holds these workspaces:
        | id  | type   | ssh target |
        | w-2 | remote | worker-two |
      When the worker "worker-one" is converged for super.engineering
      Then the app was asked to "workspace create worker-one --type remote --ssh-target worker-one --json"

    Scenario: A worker without an SSH alias is addressed by its declared user and tailnet name
      Given the worker "worker-three" is declared without an alias, as "dev" at "home.ts.net"
      And the manager's own SSH finds these commands on "dev@home.ts.net":
        | command | where              |
        | git     | /usr/bin/git       |
        | flock   | /usr/bin/flock     |
        | claude  | {launchers}/claude |
      And the app holds no workspace
      When the worker "worker-three" is converged for super.engineering
      Then the app was asked to "workspace create worker-three --type remote --ssh-target dev@home.ts.net --json"

    Scenario Outline: An app that <state> leaves the workspace for the next sync
      Given the app answers "workspace list" with <answer>
      When the worker "worker-one" is converged for super.engineering
      Then the check "super:workspace" warns with "<code>"
      And the app was not asked to create a workspace

      Examples:
        | state          | answer                                              | code              |
        | is not started | {"kind":"cli_error","error":{"code":"unavailable"}} | SUPER_NOT_RUNNING |

    Scenario: Remote workspaces switched off in the app is a setting a person turns on
      Given the app holds no workspace
      And the app answers "workspace create" with {"kind":"cli_error","error":{"code":"feature_disabled"}}
      When the worker "worker-one" is converged for super.engineering
      Then the check "super:workspace" warns with "SUPER_REMOTE_WORKSPACES_OFF"
      And the remedy of the check "super:workspace" mentions "Settings → Experimental"

    Scenario: What the app says beyond its code is never reported
      Given the app holds no workspace
      And the app answers "workspace create" with {"kind":"cli_error","error":{"code":"conflict","message":"token hunter2"}}
      When the worker "worker-one" is converged for super.engineering
      Then the check "super:workspace" warns with "SUPER_REFUSED"
      And the remedy of the check "super:workspace" mentions "answered conflict"
      And nothing reported contains "hunter2"

  Rule: The app's own SSH session has to find what a workspace runs

    Scenario: The session is the manager's plain SSH, without the fleet's options
      The app connects with the operator's SSH configuration and never asks
      for a password in the background.
      Given the manager's own SSH finds these commands on "worker-one":
        | command | where              |
        | git     | /usr/bin/git       |
        | flock   | /usr/bin/flock     |
        | claude  | {launchers}/claude |
      And the app holds no workspace
      When the worker "worker-one" is converged for super.engineering
      Then the worker was reached with "ssh -T -o BatchMode=yes -o ConnectTimeout=10 worker-one"

    Scenario: A worker the manager's own SSH does not reach gets no workspace
      A workspace the app cannot connect to only asks the operator for a key.
      Given the manager's own SSH does not reach "worker-one"
      When the worker "worker-one" is converged for super.engineering
      Then the check "super:ssh" warns with "SUPER_SSH_UNREACHABLE"
      And the remedy of the check "super:ssh" mentions "~/.ssh/config"
      And these checks were reported:
        | check     |
        | super:ssh |

    Scenario Outline: A session that finds <found> <outcome>
      Given the manager's own SSH finds on "worker-one" only <found>
      And the app holds no workspace
      When the worker "worker-one" is converged for super.engineering
      Then the check "super:ssh" <outcome>

      Examples:
        | found                  | outcome                              |
        | git, flock, opencode   | passes                               |
        | git, claude            | warns with "SUPER_HOST_INCOMPLETE"   |
        | flock, claude          | warns with "SUPER_HOST_INCOMPLETE"   |
        | git, flock             | warns with "SUPER_AGENTS_NOT_FOUND"  |
        | git, flock, vim        | warns with "SUPER_AGENTS_NOT_FOUND"  |

  Rule: An agent the app starts on a worker signs in through the CLI proxy

    Scenario: A worker whose agent commands are the plain CLIs is a warning that names them
      A worker that has not been converged since its agent commands became
      the fleet's launchers still starts the pinned CLI, which has a sign-in
      of its own or none. The workspace is created all the same.
      Given the manager's own SSH finds these commands on "worker-one":
        | command | where              |
        | git     | /usr/bin/git       |
        | flock   | /usr/bin/flock     |
        | claude  | {shims}/claude     |
        | codex   | {launchers}/codex  |
      And the app holds no workspace
      When the worker "worker-one" is converged for super.engineering
      Then the check "super:ssh" warns with "SUPER_AGENTS_NOT_PROXIED"
      And the remedy of the check "super:ssh" mentions "starts claude as the plain CLI"
      And the check "super:workspace" passes
      And nothing reported contains "/home/dev"

    Scenario: A worker whose agent commands are all the fleet's launchers passes
      Given the manager's own SSH finds these commands on "worker-one":
        | command | where               |
        | git     | /usr/bin/git        |
        | flock   | /usr/bin/flock      |
        | claude  | {launchers}/claude  |
        | grok    | {launchers}/grok    |
      And the app holds no workspace
      When the worker "worker-one" is converged for super.engineering
      Then the check "super:ssh" passes

Feature: On a worker an agent's command is the fleet's launcher
  The CLI proxy holds the provider accounts; a worker holds none. T3 starts
  an agent through a launcher it names by its path. Anything else that starts
  an agent on a worker, a person in a terminal or an app that connects over
  SSH, starts it by its plain command, so on a worker that command is a
  launcher too: it signs in through the proxy and starts the pinned CLI.
  The manager is the operator's machine: its commands are left as they are.

  Rule: Every agent command has a launcher in the repository
    Nothing is generated on a machine: the launchers are tracked files.

    Scenario Outline: The command <command> starts the <agent> launcher
      When the launcher of the agent command "<command>" is read
      Then it is an executable file
      And it starts "<agent>-proxy.ts" beside the directory it is in
      And it puts the pinned shims ahead of itself on the PATH

      Examples:
        | command     | agent       |
        | claude      | claude      |
        | codex       | codex       |
        | opencode    | opencode    |
        | grok        | grok        |
        | antigravity | antigravity |
        | agy         | antigravity |

    Scenario: Every agent the fleet verifies has a command
      When the agent commands of the repository are listed
      Then each of the agents T3 offers has one

  Rule: One link on a worker makes them its commands
    "agent-commands" beside the applied revision points at that revision's
    launchers through "current", so a sync or a rollback moves it without
    writing it again, and every shell of the worker has it first on its PATH.

    Background:
      Given a worker whose applied revision is "revisions/3f2a" of its fleet directory

    @ansible @slow
    Scenario: A worker gets the link
      When the agent commands of the worker are converged
      Then the worker reports "agent:commands" as done
      And "agent-commands" in the fleet directory links to "current/agents/bin"
      And the agent commands play was run once

    @ansible @slow
    Scenario: A worker that has the link is left alone
      Given the agent commands of the worker have been converged
      When the agent commands of the worker are converged again
      Then the worker reports "agent:commands" as done
      And the agent commands play was not run

    @ansible @slow
    Scenario: A link that points elsewhere is replaced
      Given "agent-commands" in the fleet directory already links to "revisions/old/agents/bin"
      When the agent commands of the worker are converged
      Then the worker reports "agent:commands" as done
      And "agent-commands" in the fleet directory links to "current/agents/bin"

    Scenario: Something a person put there is never removed
      Given "agent-commands" in the fleet directory is a directory that holds "claude"
      When the agent commands of the worker are converged
      Then the worker reports "agent:commands" as failed with "AGENT_COMMANDS_CONFLICT"
      And "agent-commands" in the fleet directory still holds "claude"
      And the agent commands play was not run

    Scenario: A play that fails is a failure, and what it printed is not reported
      Given the agent commands play fails
      When the agent commands of the worker are converged
      Then the worker reports "agent:commands" as failed with "AGENT_COMMANDS_NOT_LINKED"
      And nothing the play printed is reported

    Scenario: A checkout the fleet does not own gets no link
      A development checkout converges the machine it is on, which may be
      the operator's own.
      When the agent commands are converged from the checkout "work/homelab" of the home directory
      Then the machine reports "agent:commands" as skipped
      And the fleet directory holds no "agent-commands"
      And the agent commands play was not run

  Rule: A command started from a shell runs as the node the machine is
    T3 names the node of a launch. A shell cannot, so the launcher takes the
    one node whose agent profiles the machine holds.

    Scenario Outline: A machine that holds the profiles of <holds> runs as <node>
      Given the agent profiles of the machine are those of <holds>
      When the node of a launch nothing names is resolved
      Then it is <node>

      Examples:
        | holds                              | node         |
        | "worker-one"                       | "worker-one" |
        | "worker-one" and backups           | "worker-one" |
        | "worker-one" and "worker-old"      | no node      |
        | no node                            | no node      |

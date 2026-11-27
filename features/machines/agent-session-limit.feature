Feature: A worker refuses agent sessions above a limit its fleet declares
  T3 Code starts an agent whenever it is asked for one: its administrator
  policy has no limit on sessions, and systemd has no property that counts
  the scopes of a slice. `agentSessionLimit` in the fleet configuration is
  the opt-in for the one thing that does refuse: the kernel's limit on the
  cgroups below the slice T3 starts agents in. A unit of the worker's own
  user manager holds it, 2 scopes above the declared limit, so that a fleet
  launcher started above the limit ends first and says why. Without the
  setting nothing is installed and nothing is refused.

  The same thing against a running T3, a real user manager and the kernel is
  `features/monitoring/agent-session-limit.feature`.

  Rule: The limit is a number someone chose, declared for every worker or for one

    Scenario: The example fleet declares no limit
      Given the fleet configuration of the example
      When the agent session limit of "worker-one" is read
      Then no agent session limit is declared

    Scenario: A worker's own limit replaces the fleet-wide one
      Given the fleet configuration of the example
      And the worker policy declares an agent session limit of 12
      And "worker-two" declares an agent session limit of 4
      When the agent session limit of "worker-two" is read
      Then the agent session limit is 4 and the kernel holds 6 scopes

    Scenario: Another worker keeps the fleet-wide limit
      Given the fleet configuration of the example
      And the worker policy declares an agent session limit of 12
      And "worker-two" declares an agent session limit of 4
      When the agent session limit of "worker-one" is read
      Then the agent session limit is 12 and the kernel holds 14 scopes

    Scenario Outline: A limit of <limit> is refused where it is written
      A limit below one would refuse every session, with no way back from
      inside T3.
      Given the fleet configuration of the example
      And <where> declares an agent session limit of <limit>
      When the fleet configuration is read
      Then the fleet configuration is refused at "<path>"
      And the schema of the fleet configuration refuses it too

      Examples:
        | where             | limit | path                           |
        | the worker policy | 0     | $.worker.agentSessionLimit     |
        | the worker policy | -3    | $.worker.agentSessionLimit     |
        | the worker policy | 2.5   | $.worker.agentSessionLimit     |
        | the worker policy | "4"   | $.worker.agentSessionLimit     |
        | the worker policy | 513   | $.worker.agentSessionLimit     |
        | "worker-one"      | 0     | $.workers[0].agentSessionLimit |
        | "worker-one"      | true  | $.workers[0].agentSessionLimit |

  Rule: The worker's unit holds the kernel's limit on the slices T3 owns, and lifts it when it stops

    T3 probes whether scopes work, and starts terminals, in
    app-t3code-agents.slice itself. A limit there could refuse the probe, and
    T3 would then run every agent outside a scope for as long as it runs. So
    only the slices below it, which hold the agents, are limited.

    Background:
      Given a user manager whose cgroup tree holds these slices:
        | slice                                                                                    | descendants |
        | app.slice/app-t3code.slice/app-t3code-agents.slice                                       | max         |
        | app.slice/app-t3code.slice/app-t3code-agents.slice/app-t3code-agents-18b8ec851b3f.slice | max         |
        | app.slice/app-t3code.slice/app-t3code-agents.slice/app-t3code-agents-21192dc5d59b.slice | 9           |
        | app.slice/other.slice                                                                    | max         |

    Scenario: It limits the slices T3 owns and no other
      When the unit that holds 6 scopes runs once
      Then the slices hold:
        | slice                                                                                    | descendants |
        | app.slice/app-t3code.slice/app-t3code-agents.slice                                       | max         |
        | app.slice/app-t3code.slice/app-t3code-agents.slice/app-t3code-agents-18b8ec851b3f.slice | 6           |
        | app.slice/app-t3code.slice/app-t3code-agents.slice/app-t3code-agents-21192dc5d59b.slice | 6           |
        | app.slice/other.slice                                                                    | max         |

    Scenario: Stopping it puts every slice back to no limit
      This is the way back that needs no fleet-sync:
      `systemctl --user stop personal-fleet-agent-session-limit.service`.
      When the unit that holds 6 scopes runs until it is stopped
      Then the slices hold:
        | slice                                                                                    | descendants |
        | app.slice/app-t3code.slice/app-t3code-agents.slice                                       | max         |
        | app.slice/app-t3code.slice/app-t3code-agents.slice/app-t3code-agents-18b8ec851b3f.slice | max         |
        | app.slice/app-t3code.slice/app-t3code-agents.slice/app-t3code-agents-21192dc5d59b.slice | max         |
        | app.slice/other.slice                                                                    | max         |

    Scenario: It refuses to hold a limit that admits no agent
      When the unit that holds 0 scopes runs once
      Then the unit ends with an error and changes no slice

  Rule: A fleet launcher started above the limit ends and says why

    T3 starts an agent with `systemd-run --user --scope` and reports only how
    it ended, so the launcher is the one place a refusal can say why. It
    reads the limit the kernel holds on the slice it was started in, counts
    the scopes there (its own included) and ends with code 75 when more run
    than the declared limit. What it prints is in T3's server log, where T3
    sends the reader.

    Scenario Outline: With the kernel holding <held> scopes, the launcher of scope <scopes> <outcome>
      Given a launcher started in the scope "t3code-claude-0000000<scopes>.scope" of the slice "app-t3code-agents-18b8ec851b3f.slice"
      And that slice runs <scopes> agent scopes and its kernel limit reads "<held>"
      When the launcher asks whether it may start
      Then the launcher <outcome>

      Examples:
        | held | scopes | outcome             |
        | 6    | 1      | starts its agent    |
        | 6    | 4      | starts its agent    |
        | 6    | 5      | refuses the session |
        | 6    | 6      | refuses the session |
        | max  | 9      | starts its agent    |
        | 2    | 9      | starts its agent    |

    Scenario: The refusal names the limit, where it is declared and both ways out
      Given a launcher started in the scope "t3code-claude-00000005.scope" of the slice "app-t3code-agents-18b8ec851b3f.slice"
      And that slice runs 5 agent scopes and its kernel limit reads "6"
      When the launcher asks whether it may start
      Then the launcher refuses the session, saying:
        """
        AGENT_SESSION_REFUSED: this worker already runs 4 agent sessions and its limit is 4 (agentSessionLimit in the fleet configuration), so this one was not started. End a session that is no longer needed and send the message again, or raise agentSessionLimit in fleet.json and run homelab fleet-sync.
        """

    Scenario Outline: A launcher started <where> is never refused
      T3 asks a launcher for its version and its models from its own unit,
      outside any scope: those must answer whatever runs.
      Given a launcher started in the cgroup "<cgroup>" of the user manager
      And the kernel limit beside it reads "1"
      When the launcher asks whether it may start
      Then the launcher starts its agent

      Examples:
        | where                     | cgroup                                                                                   |
        | by T3's own unit          | app.slice/t3code-headless.service                                                        |
        | in the slice T3 probes in | app.slice/app-t3code.slice/app-t3code-agents.slice/t3code-opencode-service-00000001.scope |
        | from a terminal           | app.slice/app-org.gnome.Terminal.slice/vte-spawn-00000001.scope                           |

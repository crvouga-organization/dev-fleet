Feature: A quiet session survives another workload's I/O stalls
  Background:
    Given these scopes hold memory in the worker cgroup tree:
      | scope                                     | memory | swap | bytes per second | io psi |
      | agents/t3code-terminal-a.scope            | 100    | 10   | 90               | 75     |
      | agents/thread.slice/t3code-claude-b.scope | 900    | 40   | 1                | 0      |
      | app-com-t3tools.scope                     | 1000   | 500  | 9                | 80     |

  Scenario Outline: Attribute persistent stalls to a busy scope before ending a session
    When the guard samples host I/O PSI "<psi>" every 10 seconds with <rate> device bytes per second, threshold 50, duration 30 and cooldown 120
    Then it records <kills> kills and only "<scope>" receives a kill

    Examples:
      | psi                  | rate | kills | scope                          |
      | 80,80,80,80,80,80    | 100  | 1     | agents/t3code-terminal-a.scope |
      | 80,80,80,20,20,20    | 100  | 0     | none                           |
      | 80,80,80,80,80,80    | 1000 | 0     | none                           |

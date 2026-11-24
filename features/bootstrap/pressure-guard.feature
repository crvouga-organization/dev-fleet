Feature: A quiet session survives another workload's I/O stalls
  Background:
    Given these scopes hold memory in the worker cgroup tree:
      | scope                                     | memory | swap | bytes per second | io psi |
      | agents/t3code-terminal-a.scope            | 100    | 10   | 90               | 75     |
      | agents/thread.slice/t3code-claude-b.scope | 900    | 40   | 1                | 0      |
      | app-com-t3tools.scope                     | 1000   | 500  | 9                | 80     |

  Scenario: Sustained memory pressure still selects the largest agent by RAM and swap
    Given host memory PSI is 80 percent
    When the guard samples host I/O PSI "0,0,0,0,0" every 10 seconds with 0 device bytes per second, threshold 50, duration 30 and cooldown 120
    Then it records 1 kills and only "agents/thread.slice/t3code-claude-b.scope" receives a kill

  Scenario Outline: Attribute persistent stalls to a busy scope before ending a session
    When the guard samples host I/O PSI "<psi>" every 10 seconds with <rate> device bytes per second, threshold 50, duration 30 and cooldown 120
    Then it records <kills> kills and only "<scope>" receives a kill

    Examples:
      | psi                  | rate | kills | scope                          |
      | 80,80,80,80,80,80    | 100  | 1     | agents/t3code-terminal-a.scope |
      | 80,80,80,20,20,20    | 100  | 0     | none                           |
      | 80,80,80,80,80,80    | 1000 | 0     | none                           |

  Scenario: A slow writer counted ahead of the device is still the busy scope
    The cgroup counts a write when it is submitted and the device counts it
    when it completes, so a slow writer can show more bytes than the device.
    When the guard samples host I/O PSI "80,80,80,80,80,80" every 10 seconds with 85 device bytes per second, threshold 50, duration 30 and cooldown 120
    Then it records 1 kills and only "agents/t3code-terminal-a.scope" receives a kill

  Scenario Outline: Sustained I/O from a detached job can be relieved before or after the worker applies the shared budget
    Given these scopes hold memory in the worker cgroup tree:
      | scope                      | memory | swap | bytes per second | io psi |
      | <job>                      | 800    | 10   | 2000             | 80     |
      | t3code-desktop.service     | 5000   | 100  | 3000             | 90     |
      | t3code-headless.service    | 5000   | 100  | 3000             | 90     |
    When the guard samples host I/O PSI "80,80,80,80,80" every 10 seconds with 2500 device bytes per second, threshold 50, duration 30 and cooldown 120
    Then it records 1 kills and only "<job>" receives a kill

    Examples:
      | job                             |
      | run-p100-i200.service           |
      | agents/run-p100-i200.service    |
      | run-p100-i200.scope             |
      | agents/run-p100-i200.scope      |

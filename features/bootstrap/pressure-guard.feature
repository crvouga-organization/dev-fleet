Feature: Sustained pressure sheds one agent and leaves the server running
  Background:
    Given these scopes hold memory in the worker cgroup tree:
      | scope                                      | memory | swap |
      | agents/t3code-terminal-a.scope             | 100    | 10   |
      | agents/thread.slice/t3code-claude-b.scope  | 90     | 40   |
      | app-com.t3tools.T3Code-42.scope            | 1000   | 500  |

  Scenario Outline: Only sustained pressure above the threshold triggers a kill
    When the guard measures <psi> percent I/O pressure at seconds "<times>" with threshold 50, duration 30 and cooldown 120
    Then it records <kills> kills and only "<scope>" receives a kill

    Examples:
      | psi | times      | kills | scope                                     |
      | 40  | 0,30,60    | 0     | none                                      |
      | 80  | 0,29       | 0     | none                                      |
      | 80  | 0,30,60,90 | 1     | agents/thread.slice/t3code-claude-b.scope |

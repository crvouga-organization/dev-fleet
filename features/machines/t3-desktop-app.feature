Feature: A worker runs one T3: the pinned desktop app
  The desktop app starts with the worker's auto-login graphical session. A
  playbook installs it, retires the former headless server and starts the app.
  Around the play, a launcher of another release is refused beforehand and the
  result is measured afterwards: nothing here starts, stops or pairs anything.
  The release the fleet installed last is not another release: the play
  upgrades it to the pin.

  Background:
    Given the pinned T3 release is "0.1.7", installed at "/managed/t3"

  Scenario: A running desktop app is checked without a restart or pairing
    Given these commands answer:
      | command                                            | answer           |
      | t3 --version                                       | prints t3 v0.1.7 |
      | systemctl --user is-active t3code-desktop.service  | succeeds         |
      | systemctl --user is-enabled t3code-desktop.service | succeeds         |
    And the command "python3 -I -B /usr/local/lib/personal-fleet/t3-listener.py" prints managed
    When the worker's T3 desktop app is converged
    Then the check passes
    And no command with any of these words was run:
      | start   |
      | restart |
      | stop    |
      | pair    |

  Scenario: A launcher of another release is kept, not replaced
    Given these commands answer:
      | command                                            | answer           |
      | t3 --version                                       | prints t3 v0.1.8 |
      | cat /opt/T3 Code (Nightly)/.personal-fleet-version | fails            |
    When the worker's T3 desktop app is converged
    Then the summary of the check is "T3_EXECUTABLE_OWNER_CONFLICT"
    And 2 commands ran

  Scenario: A launcher of another release stops policy staging and installation
    Given these commands answer:
      | command                                            | answer           |
      | t3 --version                                       | prints t3 v0.1.8 |
      | cat /opt/T3 Code (Nightly)/.personal-fleet-version | fails            |
    When the worker's T3 desktop app is converged
    Then the policy was not staged
    And the desktop app was not installed

  Scenario: The release the fleet installed last is upgraded to the pin
    Given these commands answer:
      | command                                            | answer                         |
      | t3 --version                                       | prints t3 v0.1.6               |
      | cat /opt/T3 Code (Nightly)/.personal-fleet-version | prints T3-Code-0.1.6-amd64.deb |
      | systemctl --user is-active t3code-desktop.service  | succeeds                       |
      | systemctl --user is-enabled t3code-desktop.service | succeeds                       |
    And the command "python3 -I -B /usr/local/lib/personal-fleet/t3-listener.py" prints managed
    When the worker's T3 desktop app is converged
    Then the check passes
    And the policy was staged
    And the desktop app was installed

  Scenario: A failed installation is reported and nothing is started
    Given these commands answer:
      | command      | answer           |
      | t3 --version | prints t3 v0.1.7 |
    And installing the desktop app fails
    When the worker's T3 desktop app is converged
    Then the summary of the check is "T3_DESKTOP_INSTALL_FAILED"
    And no command with the word "start" was run

  Scenario: An app the play left stopped is reported, not started from here
    The play owns every change. This only measures: it never runs a systemctl
    verb that changes a unit, not even for the former headless server.
    Given these commands answer:
      | command                                            | answer           |
      | t3 --version                                       | prints t3 v0.1.7 |
      | systemctl --user is-active t3code-desktop.service  | fails            |
      | systemctl --user is-enabled t3code-desktop.service | succeeds         |
      | systemctl --user is-active t3code.service          | fails            |
      | systemctl --user is-enabled t3code.service         | succeeds         |
    And the command "systemctl --user is-active graphical-session.target" prints active
    And the command "python3 -I -B /usr/local/lib/personal-fleet/t3-listener.py" prints free
    When the worker's T3 desktop app is converged
    Then the summary of the check is "T3_DESKTOP_STOPPED"
    And no command with any of these words was run:
      | start        |
      | stop         |
      | disable      |
      | restart      |
      | reset-failed |

  Scenario: An app that cannot start without a graphical session is reported
    Given these commands answer:
      | command                                            | answer           |
      | t3 --version                                       | prints t3 v0.1.7 |
      | systemctl --user is-active t3code-desktop.service  | fails            |
      | systemctl --user is-enabled t3code-desktop.service | succeeds         |
      | systemctl --user is-active graphical-session.target | prints inactive  |
      | systemctl --user is-active t3code.service          | fails            |
      | systemctl --user is-enabled t3code.service         | fails            |
    When the worker's T3 desktop app is converged
    Then the summary of the check is "T3_NO_GRAPHICAL_SESSION"

  Scenario: An active unit cannot claim a listener served by a separately launched desktop
    Given the command "t3 --version" prints t3 v0.1.7
    And the command "systemctl --user is-active t3code-desktop.service" succeeds
    And the command "python3 -I -B /usr/local/lib/personal-fleet/t3-listener.py" prints app-com.t3tools.T3Code-123.scope
    When the worker's T3 desktop app is converged
    Then the summary of the check is "T3_DESKTOP_HANDOFF_PENDING"

Feature: A worker's Tailscale is reported by the code its play stopped on
  ansible/ubuntu/tailscale.yml stops with a code of its own: Tailscale older
  than its pin, which a converge never upgrades because it can drop the SSH
  session, or a package source another file owns. tailscale:configuration
  reports that code with its remedy, never a login the worker does not need.
  The play's output is read for its codes only.

  Scenario: A play that completed passes without asking the worker anything more
    Given the Tailscale play completes
    When the Tailscale configuration of the worker is measured
    Then the check is "tailscale:configuration"
    And the check passes
    And the worker was not asked whether it is logged in

  Scenario Outline: A play that stopped on <code> reports it, with its remedy
    The worker is logged in and connected; only the play's own stop is wrong.
    Given the Tailscale play stops, printing "FAILED! msg: <code>; PRIVATE_SENTINEL"
    And the worker is logged in and running on the tailnet
    When the Tailscale configuration of the worker is measured
    Then the check fails
    And the summary of the check is "<code>"
    And the remedy of the check contains "<remedy>"
    And the remedy of the check does not contain "PRIVATE_SENTINEL"

    Examples:
      | code                            | remedy                                   |
      | TAILSCALE_UPGRADE_PENDING       | homelab converge --maintenance-reboot |
      | TAILSCALE_SOURCE_OWNER_CONFLICT | /etc/apt/sources.list.d/tailscale.list   |

  Scenario Outline: A play that stopped on no code of its own, on a worker <state>, reports <code>
    The login assertion hides its output, so the worker is asked instead.
    Given the Tailscale play stops, printing "FAILED! censored: the output has been hidden"
    And the worker is <state> on the tailnet
    When the Tailscale configuration of the worker is measured
    Then the check fails
    And the summary of the check is "<code>"
    And the remedy of the check contains "homelab converge"

    Examples:
      | state                 | code                               |
      | not logged in         | TAILSCALE_SETUP_OR_LOGIN_REQUIRED  |
      | logged in and running | TAILSCALE_CONFIGURATION_INCOMPLETE |

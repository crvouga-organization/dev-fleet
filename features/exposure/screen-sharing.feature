Feature: An enrolled desktop can be controlled over its declared tailnet port
  Scenario: Declaring desktop sharing reserves the port behind the worker firewall
    Given the fleet configuration of the example
    And "worker-one" shares its desktop on port 3395
    When the exposure of "worker-one" is read
    Then the exposure is:
      | publicSsh        | false    |
      | publicPorts      | none     |
      | tailnetOnlyPorts | tcp/3395 |
      | otherListeners   | warn     |

  Scenario: A locked login keyring leaves no readable RDP item and TCP alone is insufficient
    Given the command "ss -H -ltn sport = 3395" prints LISTEN
    And the command "gsettings get org.gnome.desktop.remote-desktop.rdp port" prints uint16 3389
    And the command "/usr/bin/python3 /etc/personal-fleet/screen-sharing-credential.py check" fails
    And the command "systemctl --user is-active gnome-remote-desktop.service" fails
    And every other command fails
    When the worker measures desktop sharing on port 3395
    Then the desktop check "worker:rdp-credential" fails with "RDP_CREDENTIAL_UNAVAILABLE"
    And the desktop check "worker:rdp-service" fails with "RDP_SERVICE_STOPPED"
    And the desktop check "worker:rdp-port" fails with "RDP_PORT_MISMATCH"

  Scenario: The manager rejects an unexpected endpoint certificate
    When the manager compares the endpoint certificate "AB:CD" with the enrolled certificate "12:34"
    Then the desktop check "worker:rdp-endpoint" fails with "RDP_TLS_IDENTITY_MISMATCH"

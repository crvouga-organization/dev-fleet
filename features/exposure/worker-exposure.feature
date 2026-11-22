Feature: Nothing on a worker listens beyond loopback and the tailnet unless the policy allows it
  worker:exposure is measured on the worker. It lists the listening TCP and
  UDP sockets and reads the fleet firewall. A socket bound to an address other
  than loopback or the tailnet fails, apart from what the declared policy
  allows: sshd and tailscaled (the firewall decides who reaches them), the
  system's own listeners and the ports the policy opens. A service that cannot
  bind one address may listen on a port the policy holds to the tailnet, once
  the loaded firewall is measured to hold it. The report names the port and
  the unit that owns it, never a process's arguments. A worker with no address
  outside the tailnet has nothing to expose.

  Background:
    Given a worker with these addresses:
      | interface  | address         |
      | lo         | 127.0.0.1       |
      | eth0       | 192.0.2.10      |
      | tailscale0 | 100.101.102.103 |
      | docker0    | 172.17.0.1      |
    And the worker is not a container
    And the fleet firewall is loaded
    And the worker hands out ports 32768 to 60999 for outgoing connections
    And the exposure policy is:
      """
      {}
      """

  Rule: The default private setup passes

    Scenario: Only loopback, the tailnet and the allow-list listen
      Given these sockets listen:
        | protocol | address         | port  | unit                   |
        | tcp      | 0.0.0.0         | 22    | ssh.service            |
        | tcp      | ::              | 22    | ssh.service            |
        | udp      | 0.0.0.0         | 41641 | tailscaled.service     |
        | udp      | 0.0.0.0         | 68    | systemd-networkd.service |
        | tcp      | 127.0.0.1       | 3773  | t3code-desktop.service |
        | udp      | 127.0.0.53%lo   | 53    | systemd-resolved.service |
        | tcp      | 100.101.102.103 | 443   | tailscaled.service     |
        | tcp      | 172.17.0.1      | 8000  | docker.service         |
      When the exposure of the worker is checked
      Then the check passes
      And the summary of the check mentions "admits inbound traffic only over the tailnet"

  Rule: A fleet service beyond loopback and the tailnet fails, and is named

    Scenario: T3 on every address fails, naming its port and unit
      Given these sockets listen:
        | protocol | address | port | unit                   |
        | tcp      | 0.0.0.0 | 22   | ssh.service            |
        | tcp      | 0.0.0.0 | 3773 | t3code-desktop.service |
      When the exposure of the worker is checked
      Then the check fails
      And the summary of the check is "WORKER_LISTENER_UNRESTRICTED tcp 0.0.0.0:3773 (t3code-desktop.service)"
      And the remedy of the check contains "Bind the named service to 127.0.0.1"

    Scenario: The T3 port fails even when its owner cannot be read
      Given these sockets listen:
        | protocol | address | port | unit |
        | tcp      | ::      | 3773 |      |
      When the exposure of the worker is checked
      Then the check fails
      And the summary of the check is "WORKER_LISTENER_UNRESTRICTED tcp [::]:3773 (unknown unit)"

    Scenario: A fleet service fails even where other listeners only warn
      Given the exposure policy is:
        """
        {"otherListeners": "warn"}
        """
      And these sockets listen:
        | protocol | address    | port  | unit                 |
        | tcp      | 192.0.2.10 | 45876 | beszel-agent.service |
      When the exposure of the worker is checked
      Then the check fails
      And the summary of the check mentions "tcp 192.0.2.10:45876 (beszel-agent.service)"

    Scenario: The T3 server of a headless worker is a fleet service too
      Given the exposure policy is:
        """
        {"otherListeners": "warn"}
        """
      And these sockets listen:
        | protocol | address    | port | unit                    |
        | tcp      | 192.0.2.10 | 4100 | t3code-headless.service |
      When the exposure of the worker is checked
      Then the check fails
      And the summary of the check mentions "tcp 192.0.2.10:4100 (t3code-headless.service)"

    Scenario: The desktop app's own scope is a fleet service too
      The desktop app's main process and its server move out of
      t3code-desktop.service into an application scope of their own.
      Given the exposure policy is:
        """
        {"otherListeners": "warn"}
        """
      And these sockets listen:
        | protocol | address | port | unit                                 |
        | tcp      | 0.0.0.0 | 3773 | app-com.t3tools.T3Code-4242.scope    |
        | udp      | 0.0.0.0 | 3478 | app-com.t3tools.T3Code-4242.scope    |
      When the exposure of the worker is checked
      Then the check fails
      And the summary of the check is "WORKER_LISTENER_UNRESTRICTED tcp 0.0.0.0:3773 (app-com.t3tools.T3Code-4242.scope), udp 0.0.0.0:3478 (app-com.t3tools.T3Code-4242.scope)"
      And the remedy of the check contains "returns to loopback when it next starts"

    Scenario: The report names a unit and a port, never what the process was started with
      Given these sockets listen:
        | protocol | address | port | unit                   |
        | tcp      | 0.0.0.0 | 3773 | t3code-desktop.service |
      When the exposure of the worker is checked
      Then the checks do not contain "pid="
      And the checks do not contain "users:"
      And the checks do not contain "--token"

  Rule: A client's UDP socket on a port the kernel handed out is not a listener
    `ss -l -u` lists every unconnected UDP socket. The tunnel T3 runs speaks
    QUIC from such sockets, on ports the kernel picks for outgoing
    connections; the fleet firewall admits only the replies they asked for.

    Scenario: The tunnel T3 runs, on ports the kernel handed out, passes
      Given these sockets listen:
        | protocol | address | port  | unit                              |
        | tcp      | 0.0.0.0 | 22    | ssh.service                       |
        | udp      | 0.0.0.0 | 47658 | app-com.t3tools.T3Code-4242.scope |
        | udp      | ::      | 35043 | app-com.t3tools.T3Code-4242.scope |
      When the exposure of the worker is checked
      Then the check passes

    Scenario: A UDP socket outside the range the kernel hands out is still a listener
      Given the worker hands out ports 50000 to 60000 for outgoing connections
      And these sockets listen:
        | protocol | address | port  | unit                              |
        | udp      | 0.0.0.0 | 47658 | app-com.t3tools.T3Code-4242.scope |
      When the exposure of the worker is checked
      Then the check fails
      And the summary of the check is "WORKER_LISTENER_UNRESTRICTED udp 0.0.0.0:47658 (app-com.t3tools.T3Code-4242.scope)"

    Scenario: A TCP listener on a port in that range is a listener
      Given these sockets listen:
        | protocol | address | port  | unit                   |
        | tcp      | 0.0.0.0 | 47658 | t3code-desktop.service |
      When the exposure of the worker is checked
      Then the check fails

  Rule: What an agent started is reported apart from the fleet's services
    T3 starts each agent in a scope of its own, `t3code-<agent>-<id>.scope`.
    A development server an agent leaves on every address is no fault of a
    fleet unit and fleet-sync does not change it: it has its own code and
    remedy, and warns or fails by the declared policy like any listener that
    is not the fleet's.

    Scenario Outline: A development server on every address <verdict> when other listeners are "<policy>"
      Given the exposure policy is:
        """
        {"otherListeners": "<policy>"}
        """
      And these sockets listen:
        | protocol | address | port | unit                         |
        | tcp      | 0.0.0.0 | 22   | ssh.service                  |
        | tcp      | 0.0.0.0 | 5173 | t3code-claude-7fd17cb0.scope |
      When the exposure of the worker is checked
      Then the check <verdict>
      And the summary of the check is "WORKER_AGENT_LISTENER_UNRESTRICTED tcp 0.0.0.0:5173 (t3code-claude-7fd17cb0.scope)"
      And the remedy of the check contains "It is no fleet service and fleet-sync does not change it"
      And the remedy of the check does not contain "fault of its unit"

      Examples:
        | policy | verdict |
        | warn   | warns   |
        | fail   | fails   |

    Scenario: A fleet service and an agent's server are named apart, each with its remedy
      The fleet service fails the check; the agent's server is listed after
      it under its own code, so neither is taken for the other.
      Given the exposure policy is:
        """
        {"otherListeners": "warn"}
        """
      And these sockets listen:
        | protocol | address | port | unit                              |
        | tcp      | 0.0.0.0 | 3773 | app-com.t3tools.T3Code-4242.scope |
        | tcp      | 0.0.0.0 | 5173 | t3code-claude-7fd17cb0.scope      |
        | tcp      | ::      | 8080 | t3code-codex-4d7f36df.scope       |
      When the exposure of the worker is checked
      Then the check fails
      And the summary of the check is "WORKER_LISTENER_UNRESTRICTED tcp 0.0.0.0:3773 (app-com.t3tools.T3Code-4242.scope); WORKER_AGENT_LISTENER_UNRESTRICTED tcp 0.0.0.0:5173 (t3code-claude-7fd17cb0.scope), tcp [::]:8080 (t3code-codex-4d7f36df.scope)"
      And the remedy of the check contains "A fleet service on a public address is a fault of its unit"
      And the remedy of the check contains "Have the agent bind it to 127.0.0.1"

    Scenario: A listener that neither the fleet nor an agent owns keeps the general code
      Given the exposure policy is:
        """
        {"otherListeners": "warn"}
        """
      And these sockets listen:
        | protocol | address | port | unit                         |
        | tcp      | 0.0.0.0 | 3389 | gnome-remote-desktop.service |
        | tcp      | 0.0.0.0 | 5173 | t3code-claude-7fd17cb0.scope |
      When the exposure of the worker is checked
      Then the check warns
      And the summary of the check is "WORKER_LISTENER_UNRESTRICTED tcp 0.0.0.0:3389 (gnome-remote-desktop.service); WORKER_AGENT_LISTENER_UNRESTRICTED tcp 0.0.0.0:5173 (t3code-claude-7fd17cb0.scope)"

    Scenario: A port the policy opens may listen on every address
      Given the exposure policy is:
        """
        {"otherListeners": "fail", "publicPorts": [{"protocol": "tcp", "port": 5173}]}
        """
      And these sockets listen:
        | protocol | address | port | unit                         |
        | tcp      | 0.0.0.0 | 5173 | t3code-claude-7fd17cb0.scope |
      When the exposure of the worker is checked
      Then the check passes

  Rule: A service that cannot bind one address listens on a tailnet-only port the firewall holds
    GNOME Remote Desktop binds every address and has no setting for one. Its
    port is declared in "tailnetOnlyPorts" and the firewall drops it for
    everything but loopback and the tailnet. The declaration alone proves
    nothing: the rule is read from the rules the kernel holds.

    Background:
      Given the exposure policy is:
        """
        {"otherListeners": "fail", "tailnetOnlyPorts": [{"protocol": "tcp", "port": 3389}]}
        """
      And these sockets listen:
        | protocol | address | port | unit                         |
        | tcp      | 0.0.0.0 | 22   | ssh.service                  |
        | tcp      | ::      | 3389 | gnome-remote-desktop.service |

    Scenario: The listener passes while the loaded rules hold its port to the tailnet
      Given the loaded rules, marked "tailnet-only", are:
        | protocol | port | verdict |
        | tcp      | 3389 | drop    |
      When the exposure of the worker is checked
      Then the check passes
      And the summary of the check mentions "Its tailnet-only rules hold to loopback and the tailnet: tcp [::]:3389 (gnome-remote-desktop.service)."

    Scenario: The listener fails while the loaded rules do not hold its port
      The port was declared but fleet-sync has not written its rule yet.
      When the exposure of the worker is checked
      Then the check fails
      And the summary of the check is "WORKER_TAILNET_ONLY_RULE_MISSING tcp [::]:3389 (gnome-remote-desktop.service)"
      And the remedy of the check contains "run devfleet fleet-sync"

    Scenario: The listener fails where other listeners only warn
      Given the exposure policy is:
        """
        {"otherListeners": "warn", "tailnetOnlyPorts": [{"protocol": "tcp", "port": 3389}]}
        """
      When the exposure of the worker is checked
      Then the check fails
      And the summary of the check is "WORKER_TAILNET_ONLY_RULE_MISSING tcp [::]:3389 (gnome-remote-desktop.service)"

    Scenario Outline: A rule that <differs> does not hold the port
      Given the loaded rules, marked "<comment>", are:
        | protocol   | port   | verdict   |
        | <protocol> | <port> | <verdict> |
      When the exposure of the worker is checked
      Then the check fails
      And the summary of the check is "WORKER_TAILNET_ONLY_RULE_MISSING tcp [::]:3389 (gnome-remote-desktop.service)"

      Examples:
        | differs                    | comment      | protocol | port | verdict |
        | holds another port         | tailnet-only | tcp      | 3390 | drop    |
        | holds the other protocol   | tailnet-only | udp      | 3389 | drop    |
        | accepts the port           | tailnet-only | tcp      | 3389 | accept  |
        | is not the fleet's marked rule | public-port | tcp   | 3389 | drop    |

    Scenario: Without the fleet firewall the listener fails, and both faults are named
      Given the fleet firewall is not loaded
      When the exposure of the worker is checked
      Then the check fails
      And the summary of the check is "WORKER_FIREWALL_INACTIVE; WORKER_TAILNET_ONLY_RULE_MISSING tcp [::]:3389 (gnome-remote-desktop.service)"

    Scenario: A held port admits no other listener
      Given the loaded rules, marked "tailnet-only", are:
        | protocol | port | verdict |
        | tcp      | 3389 | drop    |
      And these sockets listen:
        | protocol | address | port | unit                         |
        | tcp      | ::      | 3389 | gnome-remote-desktop.service |
        | tcp      | 0.0.0.0 | 3390 | gnome-remote-desktop.service |
      When the exposure of the worker is checked
      Then the check fails
      And the summary of the check is "WORKER_LISTENER_UNRESTRICTED tcp 0.0.0.0:3390 (gnome-remote-desktop.service)"

    Scenario: The general remedy names the declaration for a service that cannot bind one address
      Given the exposure policy is:
        """
        {"otherListeners": "fail"}
        """
      When the exposure of the worker is checked
      Then the check fails
      And the summary of the check is "WORKER_LISTENER_UNRESTRICTED tcp [::]:3389 (gnome-remote-desktop.service)"
      And the remedy of the check contains "is declared in exposure.tailnetOnlyPorts instead, which opens nothing"

    Scenario: What an agent started on a tailnet-only port is held like any other listener
      The declaration names a port, not who listens on it.
      Given the exposure policy is:
        """
        {"otherListeners": "fail", "tailnetOnlyPorts": [{"protocol": "tcp", "port": 5173}]}
        """
      And the loaded rules, marked "tailnet-only", are:
        | protocol | port | verdict |
        | tcp      | 5173 | drop    |
      And these sockets listen:
        | protocol | address | port | unit                         |
        | tcp      | 0.0.0.0 | 5173 | t3code-claude-7fd17cb0.scope |
      When the exposure of the worker is checked
      Then the check passes

    Scenario: A fleet service on a tailnet-only port still fails
      A fleet service binds loopback or the tailnet itself: no declaration
      excuses it, whatever the firewall holds.
      Given the exposure policy is:
        """
        {"tailnetOnlyPorts": [{"protocol": "tcp", "port": 3773}, {"protocol": "tcp", "port": 4100}]}
        """
      And the loaded rules, marked "tailnet-only", are:
        | protocol | port | verdict |
        | tcp      | 3773 | drop    |
        | tcp      | 4100 | drop    |
      And these sockets listen:
        | protocol | address | port | unit                    |
        | tcp      | 0.0.0.0 | 3773 |                         |
        | tcp      | 0.0.0.0 | 4100 | t3code-headless.service |
      When the exposure of the worker is checked
      Then the check fails
      And the summary of the check is "WORKER_LISTENER_UNRESTRICTED tcp 0.0.0.0:3773 (unknown unit), tcp 0.0.0.0:4100 (t3code-headless.service)"

  Rule: The firewall that closes the rest is loaded, as declared

    Scenario: A worker without the fleet firewall fails
      Given the fleet firewall is not loaded
      And these sockets listen:
        | protocol | address | port | unit        |
        | tcp      | 0.0.0.0 | 22   | ssh.service |
      When the exposure of the worker is checked
      Then the check fails
      And the summary of the check is "WORKER_FIREWALL_INACTIVE"
      And the remedy of the check contains "devfleet fleet-sync"

    Scenario: SSH kept open beyond the tailnet without the opt-in fails
      fleet-sync keeps the public SSH port open while it cannot prove the
      manager reaches the worker over the tailnet: that must not pass quietly.
      Given the fleet firewall is loaded, keeping SSH open beyond the tailnet
      And these sockets listen:
        | protocol | address | port | unit        |
        | tcp      | 0.0.0.0 | 22   | ssh.service |
      When the exposure of the worker is checked
      Then the check fails
      And the summary of the check is "WORKER_PUBLIC_SSH_UNDECLARED"
      And the remedy of the check contains "Point the SSH alias of this worker at its tailnet name"

    Scenario: SSH kept open by the break-glass opt-in passes, and says so
      Given the exposure policy is:
        """
        {"publicSsh": true}
        """
      And the fleet firewall is loaded, keeping SSH open beyond the tailnet
      And these sockets listen:
        | protocol | address | port | unit        |
        | tcp      | 0.0.0.0 | 22   | ssh.service |
      When the exposure of the worker is checked
      Then the check passes
      And the summary of the check mentions "break-glass"

  Rule: A worker with no address outside the tailnet has nothing to expose

    Scenario: Only loopback, the tailnet and a container bridge have addresses
      Given a worker with these addresses:
        | interface  | address         |
        | lo         | 127.0.0.1       |
        | tailscale0 | 100.101.102.103 |
        | docker0    | 172.17.0.1      |
      When the exposure of the worker is checked
      Then the check is not applicable
      And the summary of the check mentions "no address outside the tailnet"
      And no command with the word "ss" was run

    Scenario: A worker that runs in a container leaves the network to its host
      Given the worker is a container
      When the exposure of the worker is checked
      Then the check is not applicable
      And the summary of the check mentions "container"

  Rule: What cannot be read fails, and says what

    Scenario: Sockets that sudo cannot list leave exposure unobserved
      Given the command "sudo -n ss -H -l -n -t -u -p" fails
      When the exposure of the worker is checked
      Then the check fails
      And the summary of the check is "WORKER_EXPOSURE_UNOBSERVED (sockets)"

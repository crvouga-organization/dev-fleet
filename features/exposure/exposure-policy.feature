Feature: What a worker opens beyond the tailnet is declared in the fleet configuration
  A rented worker has a public address from its first second. The exposure
  policy says what it opens beyond loopback and the tailnet: fleet-wide as
  "exposure" in the worker policy, and for one worker as "exposure" beside its
  network. A field a worker names replaces the fleet-wide one. Without a
  declaration nothing is public. A tailnet-only port opens nothing: it names
  a service that cannot bind one address, for the firewall to hold to
  loopback and the tailnet.

  Scenario: A fleet that declares nothing opens nothing
    Given the fleet configuration of the example
    When the exposure of "worker-one" is read
    Then the exposure is:
      | publicSsh        | false |
      | publicPorts      | none  |
      | tailnetOnlyPorts | none  |
      | otherListeners   | warn  |

  Scenario: A worker's own declaration replaces the fleet-wide fields it names
    Given the fleet configuration of the example
    And the worker policy declares the exposure:
      """
      {"otherListeners": "fail", "publicPorts": [{"protocol": "tcp", "port": 8080}]}
      """
    And "worker-two" declares the exposure:
      """
      {"publicSsh": true}
      """
    When the exposure of "worker-two" is read
    Then the exposure is:
      | publicSsh        | true     |
      | publicPorts      | tcp/8080 |
      | tailnetOnlyPorts | none     |
      | otherListeners   | fail     |

  Scenario: A worker holds the ports of its remote desktop to the tailnet
    Given the fleet configuration of the example
    And the worker policy declares the exposure:
      """
      {"tailnetOnlyPorts": [{"protocol": "tcp", "port": 5900}]}
      """
    And "worker-two" declares the exposure:
      """
      {"tailnetOnlyPorts": [{"protocol": "tcp", "port": 3389}, {"protocol": "udp", "port": 3389}]}
      """
    When the exposure of "worker-two" is read
    Then the exposure is:
      | publicSsh        | false              |
      | publicPorts      | none               |
      | tailnetOnlyPorts | tcp/3389, udp/3389 |
      | otherListeners   | warn               |

  Scenario: Another worker keeps the fleet-wide declaration
    Given the fleet configuration of the example
    And the worker policy declares the exposure:
      """
      {"otherListeners": "fail"}
      """
    And "worker-two" declares the exposure:
      """
      {"publicSsh": true, "otherListeners": "warn"}
      """
    When the exposure of "worker-one" is read
    Then the exposure is:
      | publicSsh        | false |
      | publicPorts      | none  |
      | tailnetOnlyPorts | none  |
      | otherListeners   | fail  |

  Scenario Outline: A declaration that <breaks> is refused where it is written
    Given the fleet configuration of the example
    And "worker-one" declares the exposure:
      """
      <declaration>
      """
    When the fleet configuration is read
    Then it is refused at "$.workers[0].exposure"

    Examples:
      | breaks                         | declaration                                                                         |
      | names an unknown field         | {"publicHttp": true}                                                                |
      | says yes for true              | {"publicSsh": "yes"}                                                                |
      | opens port 0                   | {"publicPorts": [{"protocol": "tcp", "port": 0}]}                                   |
      | names a protocol that is not one | {"publicPorts": [{"protocol": "icmp", "port": 1}]}                                |
      | opens one port twice           | {"publicPorts": [{"protocol": "tcp", "port": 80}, {"protocol": "tcp", "port": 80}]} |
      | ignores other listeners        | {"otherListeners": "ignore"}                                                        |
      | holds port 0 to the tailnet    | {"tailnetOnlyPorts": [{"protocol": "tcp", "port": 0}]}                              |
      | holds one port twice           | {"tailnetOnlyPorts": [{"protocol": "tcp", "port": 3389}, {"protocol": "tcp", "port": 3389}]} |
      | opens a port it holds to the tailnet | {"publicPorts": [{"protocol": "tcp", "port": 3389}], "tailnetOnlyPorts": [{"protocol": "tcp", "port": 3389}]} |

  Scenario: A worker cannot hold to the tailnet a port the fleet-wide declaration opens
    The worker replaces only the list it names: the other still applies to
    it, and one port cannot be both open to everyone and tailnet-only.
    Given the fleet configuration of the example
    And the worker policy declares the exposure:
      """
      {"publicPorts": [{"protocol": "tcp", "port": 3389}]}
      """
    And "worker-two" declares the exposure:
      """
      {"tailnetOnlyPorts": [{"protocol": "tcp", "port": 3389}]}
      """
    When the fleet configuration is read
    Then it is refused at "$.workers[1].exposure"

  Scenario: The same port number may be open on one protocol and tailnet-only on the other
    Given the fleet configuration of the example
    And "worker-one" declares the exposure:
      """
      {"publicPorts": [{"protocol": "udp", "port": 3389}], "tailnetOnlyPorts": [{"protocol": "tcp", "port": 3389}]}
      """
    When the fleet configuration is read
    Then the parser accepts it

  Scenario: The fleet-wide declaration is checked like the worker's
    Given the fleet configuration of the example
    And the worker policy declares the exposure:
      """
      {"publicSsh": 1}
      """
    When the fleet configuration is read
    Then it is refused at "$.worker.exposure"

  Scenario: The schema an editor checks fleet.json with accepts what the parser accepts
    Given the fleet configuration of the example
    And the worker policy declares the exposure:
      """
      {"publicSsh": false, "publicPorts": [{"protocol": "udp", "port": 51820}], "tailnetOnlyPorts": [{"protocol": "tcp", "port": 3389}], "otherListeners": "fail"}
      """
    And "worker-one" declares the exposure:
      """
      {"publicSsh": true}
      """
    When the fleet configuration is read
    Then the parser accepts it
    And the schema accepts it

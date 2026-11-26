Feature: The manager runs the T3 release the workers run
  Workers get a pinned, checksum-verified T3 with updates off by policy. The
  manager gets the same pin and the same policy, so the IDE that drives the
  workers never runs another release and never updates itself.

  Scenario Outline: The pinned server archive for <platform> <architecture> is <file>
    When the pinned T3 archive for <platform> <architecture> is resolved
    Then it is the file "<file>" with a SHA-256 digest from mise.toml

    Examples:
      | platform | architecture | file                                 |
      | linux    | x64          | t3-<pinned>-linux-x64.tar.gz    |
      | linux    | arm64        | t3-<pinned>-linux-arm64.tar.gz  |
      | darwin   | arm64        | t3-<pinned>-darwin-arm64.tar.gz |

  Scenario: No T3 is pinned for a Mac on Intel
    Upstream publishes no server archive for it.
    When the pinned T3 archive for darwin x64 is resolved
    Then no archive is pinned

  Rule: Every machine reports the version it runs
    `<pinned>` stands for the t3_version that mise.toml pins, so moving the pin
    leaves these examples true.

    Scenario Outline: The manager running <running> <outcome>
      Given the running desktop on the manager reports "<running>"
      When the T3 desktop of the manager is checked
      Then the check "t3:version" <outcome>

      Examples:
        | running                     | outcome                           |
        | <pinned>                    | passes                            |
        | 0.1.9-nightly.20261111.4501 | warns with "T3_VERSION_SKEW"      |
        |                             | warns with "T3_VERSION_UNKNOWN"   |

    Scenario: A sync switches the running manager to its verified desktop
      Given the running desktop on the manager reports "0.1.9-nightly.20261111.4501"
      And the managed desktop is absent until its play succeeds
      And the activation play opens the verified desktop
      When the T3 desktop of the manager is applied
      Then the check "t3:desktop-installed" passes
      And the check "t3:version" passes

    @t3-desktop @slow
    Scenario: macOS verifies the published desktop and a repeat sync reuses it
      Given the pinned macOS desktop has been staged in a temporary directory
      When the manager applies the same macOS desktop again
      Then the check "t3:desktop-installed" passes
      And macOS verified the installed app again without running the installer

    Scenario Outline: Launch Services reports <count> copies of the managed app
      Given Launch Services returns the application count "<count>" as text
      When the T3 desktop of the manager is checked
      Then the check "t3:version" <outcome>

      Examples:
        | count | outcome                         |
        | 0     | warns with "T3_VERSION_UNKNOWN" |
        | 1     | passes                          |
        | 2     | warns with "T3_VERSION_UNKNOWN" |

    Scenario Outline: The live worker server reports its release over SSH
      Given the worker server answers the environment query with '<response>'
      When the T3 version of the worker "worker-one" is checked
      Then the check "t3:version" <outcome>

      Examples:
        | response                      | outcome                         |
        | {"serverVersion":"<pinned>"}  | passes                          |
        | {"serverVersion":"0.1.0"}     | warns with "T3_VERSION_SKEW"    |
        | {}                            | warns with "T3_VERSION_UNKNOWN" |
        | malformed                     | warns with "T3_VERSION_UNKNOWN" |
        | unreachable                   | warns with "T3_VERSION_UNKNOWN" |

  Rule: T3 on the manager does not update itself

    Scenario Outline: A policy with updates <mode> <outcome>
      Given the T3 administrator policy on the manager is:
        """
        <policy>
        """
      When the T3 updater of the manager is checked
      Then the check "t3:updates" <outcome>

      Examples:
        | mode           | policy                                           | outcome                             |
        | off            | { "limits": { "updates": { "mode": "off" } } }   | passes                              |
        | on             | { "limits": { "updates": { "mode": "auto" } } }  | warns with "T3_UPDATES_UNMANAGED"   |
        | not configured | {}                                               | warns with "T3_UPDATES_UNMANAGED"   |

    Scenario: The manager's playbook stages the workers' policy where T3 on macOS reads it
      When the manager's T3 playbook is read
      Then it installs "../ubuntu/t3/policy.json" at "/Library/Application Support/T3Code/policy.json"
      And it records the ownership marker "ansible/ubuntu/t3/policy.json"
      And "ansible/macos/manager-privilege.yml" imports it

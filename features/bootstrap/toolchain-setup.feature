Feature: The shared toolchain is published as the global mise configuration
  Every machine gets the same pins and the same lock, published as one
  managed global mise configuration. Publishing is repeatable and never
  overwrites a configuration a person wrote.

  Rule: The pins, the lock and its sidecars are published, repeatably

    Background:
      Given a toolchain whose "mise.toml" reads:
        """
        [tools]
        bun = "1.4.4"
        """
      And the toolchain's "mise.lock" holds "fixture lock"
      And the toolchain's ".mise/locks/npm.json" holds "fixture graph"

    Scenario: Publishing again writes nothing
      Given the global configuration has been published
      And these published files were last written at the second 1000:
        | config.toml          |
        | mise.lock            |
        | .mise/locks/npm.json |
      When the global configuration is published again
      Then none of them was written again
      And the published "mise.lock" holds "fixture lock"
      And the published ".mise/locks/npm.json" holds "fixture graph"

    Scenario: A configuration someone else wrote is refused and left as it is
      Given the global configuration has been published
      And the published "config.toml" has since been replaced with:
        """
        # my config
        """
      When the global configuration is published again
      Then it is refused with "Nothing was overwritten"
      And the published "config.toml" reads:
        """
        # my config
        """

  Rule: The marker says a configuration is managed, never where it came from
    Any earlier owner name counts: the marker text identifies the file, not
    the repository or the path it was published from.

    Scenario: A configuration published under an earlier owner name is still managed
      Given a global configuration that reads:
        """
        # Managed by another/name scripts/dev/setup.ts
        [tools]
        """
      When the global configuration is checked for its owner
      Then it is accepted

    Scenario: A configuration without the marker is somebody else's
      Given a global configuration that reads:
        """
        [tools]
        node = "22"
        """
      When the global configuration is checked for its owner
      Then it is refused with "Existing mise configuration"

  Rule: The published configuration trusts agent worktree roots and keeps local trust entries
    An agent harness makes a new checkout for every task, and an untrusted
    mise.toml makes every mise shim exit before the agent starts. mise honours
    trusted paths only in the global configuration, so they are added when it
    is published and never written into a project's mise.toml.

    Background:
      Given a toolchain whose "mise.toml" reads:
        """
        [settings]
        lockfile = true

        [tools]
        bun = "1.4.4"
        """
      And the toolchain's "mise.lock" holds "fixture lock"

    Scenario: The agent worktree roots are trusted and the project's settings are kept
      When the global configuration is published
      Then the published configuration trusts exactly the agent worktree roots:
        | ~/.t3/worktrees |
      And the published setting "lockfile" is true

    Scenario: A path trusted on the machine survives the next publish
      What "mise settings add trusted_config_paths" writes must survive.
      Given the global configuration has been published
      And "/srv/local" has been added to the trusted paths of the published configuration
      When the global configuration is published again
      Then the published configuration trusts exactly, in order:
        | ~/.t3/worktrees |
        | /srv/local      |

    Scenario: Once a local path is kept, publishing again writes nothing
      Given the global configuration has been published
      And "/srv/local" has been added to the trusted paths of the published configuration
      And the global configuration has been published again
      And these published files were last written at the second 1000:
        | config.toml |
      When the global configuration is published again
      Then none of them was written again

    Scenario: Trusted paths go into a settings table, which is made when there is none
      Given a project configuration that reads:
        """
        [tools]
        """
      When the trusted path "~/a" is added to it
      Then the project configuration reads:
        """
        [tools]

        [settings]
        trusted_config_paths = ["~/a"]
        """

    Scenario: A project configuration that sets trusted paths itself is refused
      Given a project configuration that reads:
        """
        [settings]
        trusted_config_paths = []
        """
      When the trusted path "~/a" is added to it
      Then it is refused with "global config"

    Scenario: A project's own tools are installed only from the project's lock
      A project pins the tools homelab does not ship in its own mise.toml.
      On a fleet machine this repository's mise.toml is the global
      configuration, published with settings that make mise refuse a
      project tool its mise.lock does not name. mise reads locked_scopes only
      from the global configuration.
      When the global configuration is published
      Then the published setting "locked" is true
      And the published setting "locked_scopes" holds exactly ["project"]
      And the mise.toml of this repository has no setting "locked"
      And the mise.toml of this repository has no setting "locked_scopes"

    Scenario: The repository's mise.toml leaves trusted paths to the global configuration
      mise warns about the setting in a project configuration and ignores it.
      Then the mise.toml of this repository has no setting "trusted_config_paths"

  Rule: The bootstrap installs the pinned mise, and never replaces mise with an older release unasked
    min_version is a minimum: a newer mise satisfies an older pin, and every
    other checkout on the machine whose pin is newer needs it. A revision
    that pinned an older mise once replaced the newer one on every machine,
    and every mise shim then refused to run in a checkout of the default
    branch.

    These run the real bootstrap/bootstrap.sh in a home of its own. A
    stand-in answers its download with the archive whose digest the
    checkout's mise.toml pins, and the mise of that home only says its
    version and records how it is called.

    @bash
    Scenario: A machine without mise gets the pinned release
      Given a machine that has no mise
      And a checkout whose mise.toml pins mise "2026.10.24"
      When the checkout's bootstrap runs with "--tools-only"
      Then it exits with 0
      And the bootstrap downloaded the mise release "2026.10.24"
      And the machine runs mise "2026.10.24"

    @bash
    Scenario Outline: A machine that runs mise <installed> bootstraps a checkout that pins <pinned>
      Releases are compared number by number: 2026.10.3 is older than
      2026.10.24.
      Given a machine that runs mise "<installed>"
      And a checkout whose mise.toml pins mise "<pinned>"
      When the checkout's bootstrap runs with "--tools-only"
      Then it exits with 0
      And the bootstrap downloaded <downloaded>
      And the machine runs mise "<afterwards>"
      And the bootstrap went on to install the pinned tools with the mise of that machine

      Examples:
        | installed  | pinned     | downloaded                    | afterwards |
        | 2026.10.3  | 2026.10.24 | the mise release "2026.10.24" | 2026.10.24 |
        | 2026.10.24 | 2026.10.24 | nothing                       | 2026.10.24 |
        | 2026.11.11 | 2026.10.24 | nothing                       | 2026.11.11 |
        | 2027.1.0   | 2026.10.24 | nothing                       | 2027.1.0   |

    @bash
    Scenario: A newer mise that is kept is said out loud, with how to replace it
      Given a machine that runs mise "2026.11.11"
      And a checkout whose mise.toml pins mise "2026.10.24"
      When the checkout's bootstrap runs with "--tools-only"
      Then the bootstrap says "TOOLCHAIN_DOWNGRADE"
      And the bootstrap says "the newer 2026.11.11, which is kept"
      And the bootstrap says "--allow-mise-downgrade"

    @bash
    Scenario: An upgrade is not a downgrade
      Given a machine that runs mise "2026.10.3"
      And a checkout whose mise.toml pins mise "2026.10.24"
      When the checkout's bootstrap runs with "--tools-only"
      Then the bootstrap does not say "TOOLCHAIN_DOWNGRADE"

    @bash
    Scenario: Asked for by name, the older pinned release replaces the newer one, and that is said too
      Given a machine that runs mise "2026.11.11"
      And a checkout whose mise.toml pins mise "2026.10.24"
      When the checkout's bootstrap runs with "--tools-only --allow-mise-downgrade"
      Then it exits with 0
      And the bootstrap downloaded the mise release "2026.10.24"
      And the machine runs mise "2026.10.24"
      And the bootstrap says "TOOLCHAIN_DOWNGRADE"
      And the bootstrap says "replacing mise 2026.11.11 with the older 2026.10.24"

  Rule: Every base tool has locked artifacts for every supported OS and architecture

    Scenario: The lock holds what every machine installs
      A lazy tool is installed on demand and is not a base tool. A tool
      restricted to some operating systems is never installed elsewhere.
      When every tool mise.toml pins is looked up in mise.lock
      Then every tool that is not lazy is locked at the version it is pinned to
      And every tool installed from a dependency graph is locked by a "sha256:" digest
      And the lock of every such graph records "integrity:"
      And "rust" is locked by the backend "core:rust", at a release number
      And on Windows "aws" comes from its native installer, at the pinned version and with a SHA-256 digest
      And every other tool carries a "sha256:" checksum for each platform it is installed on

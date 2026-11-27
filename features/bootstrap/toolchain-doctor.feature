Feature: The doctor checks a machine's toolchain
  The doctor only reads: it signs in to nothing, installs nothing and
  changes nothing in Docker.

  Rule: A tool must report exactly the version it is pinned to

    Scenario: A shadowed or wrong tool version fails, and a lazy tool is not checked
      Given the toolchain pins:
        | tool  | version | lazy |
        | node  | 22.22.3 |      |
        | bun   | 1.4.4   |      |
        | atlas | 1.3.0   | yes  |
      And the command "node" prints "v20.0.0"
      And every other command prints "1.4.4"
      When the doctor checks the tools
      Then the check "node" fails
      And the check "bun" passes
      And there is no check "atlas"

    Scenario Outline: tmux reports its version with -V
      Given the toolchain pins:
        | tool | version |
        | tmux | 3.8     |
      And the command "tmux -V" prints "tmux <version>"
      When the doctor checks the tools
      Then the check "tmux" <verdict>

      Examples:
        | version | verdict |
        | 3.8     | passes  |
        | 3.7     | fails   |

    Scenario Outline: A version check accepts sentence punctuation but rejects a longer version
      Given the toolchain pins:
        | tool    | version |
        | copilot | 1.0.105 |
      And the command "copilot" prints "<output>"
      When the doctor checks the tools
      Then the check "copilot" <verdict>

      Examples:
        | output                       | verdict |
        | GitHub Copilot CLI 1.0.105.  | passes  |
        | GitHub Copilot CLI 1.0.1050  | fails   |
        | GitHub Copilot CLI 1.0.105.1 | fails   |

  Rule: mise itself is pinned as a minimum, and a newer one is reported as the downgrade the bootstrap withheld
    The bootstrap never replaces mise with an older release unasked: every
    other checkout on the machine whose pin is newer needs the newer one. A
    mise older than the pin refuses to run this checkout's tools.

    Scenario Outline: A machine that runs mise <installed> against the pin <pinned> <verdict>
      Given the command "mise" prints "<installed> linux-arm64 (2026-11-01)"
      When the doctor checks mise itself against the pin "<pinned>"
      Then the check "mise" <verdict>

      Examples:
        | installed  | pinned     | verdict |
        | 2026.11.11 | 2026.11.11 | passes  |
        | 2026.11.11 | 2026.10.24 | warns   |
        | 2027.1.0   | 2026.11.11 | warns   |
        | 2026.10.24 | 2026.11.11 | fails   |
        | 2026.10.3  | 2026.10.24 | fails   |

    Scenario: A newer mise is reported as TOOLCHAIN_DOWNGRADE, with how to install the older one
      Given the command "mise" prints "2026.11.11 linux-arm64 (2026-11-01)"
      When the doctor checks mise itself against the pin "2026.10.24"
      Then the check says "TOOLCHAIN_DOWNGRADE"
      And the check says "pins mise 2026.10.24 and the machine runs the newer 2026.11.11"
      And the check says "--allow-mise-downgrade"

    Scenario: A mise that does not answer fails the check
      Given no command can be run
      When the doctor checks mise itself against the pin "2026.11.11"
      Then the check "mise" fails

  Rule: A tool with no artifact for this platform is skipped, but not native Windows AWS
    On Windows aws is installed by its own installer, not by mise.

    Scenario Outline: On <platform> the doctor checks <checked>
      Given the toolchain pins:
        | tool      | version | os           |
        | http:grok | 1.0.77  | linux, macos |
        | aws       | 2.39.2  | linux, macos |
      And no command can be run
      When the doctor checks the tools on "<platform>"
      Then of the pinned tools it checks <checked>

      Examples:
        | platform | checked            |
        | win32    | "aws"              |
        | linux    | "http:grok", "aws" |
        | darwin   | "http:grok", "aws" |

  Rule: Docker is optional unless the machine requires it

    Scenario Outline: Without Docker, a machine that <requirement> it <verdict>
      Given no command can be run
      When the doctor checks Docker on a machine that <requirement> it
      Then every Docker check <verdict>

      Examples:
        | requirement      | verdict |
        | does not require | warns   |
        | requires         | fails   |

  Rule: The doctor fails when an agent worktree root is not trusted
    Every mise shim fails in a new worktree under a root mise does not trust.

    Scenario Outline: mise trusting <paths> <verdict>
      Given mise says it trusts the configuration paths <paths>
      When the doctor checks that agent worktrees are trusted, for the home "/home/dev"
      Then the check "agent-worktree-trust" <verdict>

      Examples:
        | paths                       | verdict |
        | ["/home/dev/.t3/worktrees"] | passes  |
        | ["~/.t3/worktrees"]         | passes  |
        | []                          | fails   |

    Scenario: A mise that cannot say what it trusts fails the check
      Given mise cannot say which configuration paths it trusts
      When the doctor checks that agent worktrees are trusted, for the home "/home/dev"
      Then the check "agent-worktree-trust" fails

  Rule: The global mise configuration must be the one this revision publishes
    On a fleet machine it belongs to homelab. A project that publishes its
    own takes away the pins and the trusted agent worktree roots until the
    next converge, and the doctor says so.

    Background:
      Given a toolchain whose "mise.toml" reads:
        """
        [tools]
        bun = "1.4.4"
        """
      And the toolchain's "mise.lock" holds "fixture lock"

    Scenario: The configuration converge published passes
      Given the global configuration has been published
      When the doctor checks the global mise configuration
      Then the check "global-mise-config" passes

    Scenario: No global configuration fails
      When the doctor checks the global mise configuration
      Then the check "global-mise-config" fails
      And the check says "There is no global mise configuration"

    Scenario: A configuration another project published fails, and says to run converge
      Given the global configuration has been published
      And the published "config.toml" has since been replaced with:
        """
        # Managed by my-project scripts/setup.ts
        [tools]
        node = "22"
        """
      When the doctor checks the global mise configuration
      Then the check "global-mise-config" fails
      And the check says "Another project or tool replaced"
      And the check says "Run converge"

    Scenario: homelab's configuration from another revision fails
      Given the global configuration has been published
      And the toolchain's "mise.lock" holds "a newer lock"
      When the doctor checks the global mise configuration
      Then the check "global-mise-config" fails
      And the check says "not the one this revision publishes"

    Scenario: A path trusted on the machine is not a change
      Given the global configuration has been published
      And "/srv/local" has been added to the trusted paths of the published configuration
      When the doctor checks the global mise configuration
      Then the check "global-mise-config" passes

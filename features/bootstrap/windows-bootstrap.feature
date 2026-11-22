Feature: The Windows bootstrap installs the pinned mise, and never replaces mise with an older release unasked
  Windows is not a fleet role: bootstrap/bootstrap.ps1 installs the pinned
  tools on a Windows machine and nothing more. It follows the rule of the
  shell bootstrap: min_version is a minimum, so a newer mise is kept, and
  replaced with the older pinned one only when -AllowMiseDowngrade asks.

  These run the real bootstrap/bootstrap.ps1 under PowerShell, in a home of
  its own, from a checkout that holds only the script and a mise.toml. A
  stand-in answers its downloads with the release archive and the checksum
  list as the publisher of mise lays them out, and the mise.exe of that home
  only says its version and records how it is called. PowerShell runs on
  Linux and macOS too, which is where these run: the machine says it is
  Windows x64 where the scenario says so, and nothing here proves the
  script under Windows PowerShell 5.1 itself.

  Rule: The pinned release is installed, checked against the publisher's checksum list

    @pwsh
    Scenario: A Windows machine without mise gets the pinned release
      Given a Windows machine that has no mise
      And a checkout whose mise.toml pins mise "2026.10.24", whose Windows release is published
      When the checkout's Windows bootstrap runs
      Then it exits with 0
      And the Windows bootstrap downloaded these, in order:
        | https://github.com/jdx/mise/releases/download/v2026.10.24/mise-v2026.10.24-windows-x64.zip |
        | https://github.com/jdx/mise/releases/download/v2026.10.24/SHASUMS256.txt                   |
      And the Windows machine runs mise "2026.10.24"
      And the Windows bootstrap went on to run, with the mise of that machine:
        | mise trust <checkout>                               |
        | mise install --locked bun                           |
        | mise exec --locked bun -- bun bootstrap/setup.ts    |

    @pwsh
    Scenario: An archive that does not match the publisher's checksum is never installed
      Given a Windows machine that runs mise "2026.10.3"
      And a checkout whose mise.toml pins mise "2026.10.24", whose Windows release is published
      And the published checksum list names another digest for the archive
      When the checkout's Windows bootstrap runs
      Then it exits with 1
      And the Windows bootstrap says "mise checksum mismatch"
      And the Windows machine runs mise "2026.10.3"
      And the Windows bootstrap ran nothing with the mise of that machine

    @pwsh
    Scenario: A checkout that pins no mise is refused before anything is downloaded
      Given a Windows machine that has no mise
      And a checkout whose mise.toml pins no mise
      When the checkout's Windows bootstrap runs
      Then it exits with 1
      And the Windows bootstrap says "mise.toml does not pin mise"
      And the Windows bootstrap downloaded nothing

    @pwsh
    Scenario: A machine that is not Windows x64 is refused before anything is downloaded
      Given a Windows machine that has no mise
      And the machine says its architecture is "ARM64"
      And a checkout whose mise.toml pins mise "2026.10.24", whose Windows release is published
      When the checkout's Windows bootstrap runs
      Then it exits with 1
      And the Windows bootstrap says "Use Windows x64 PowerShell"
      And the Windows bootstrap downloaded nothing

  Rule: A newer mise is kept, and replaced with the older pinned one only when that is asked for by name

    @pwsh
    Scenario Outline: A Windows machine that runs mise <installed> bootstraps a checkout that pins <pinned>
      Releases are compared number by number: 2026.10.3 is older than
      2026.10.24.
      Given a Windows machine that runs mise "<installed>"
      And a checkout whose mise.toml pins mise "<pinned>", whose Windows release is published
      When the checkout's Windows bootstrap runs
      Then it exits with 0
      And the Windows bootstrap downloaded <downloaded>
      And the Windows machine runs mise "<afterwards>"
      And the Windows bootstrap went on to run, with the mise of that machine:
        | mise trust <checkout>                               |
        | mise install --locked bun                           |
        | mise exec --locked bun -- bun bootstrap/setup.ts    |

      Examples:
        | installed  | pinned     | downloaded                    | afterwards |
        | 2026.10.3  | 2026.10.24 | the mise release "2026.10.24" | 2026.10.24 |
        | 2026.10.24 | 2026.10.24 | nothing                       | 2026.10.24 |
        | 2026.11.11 | 2026.10.24 | nothing                       | 2026.11.11 |
        | 2027.1.0   | 2026.10.24 | nothing                       | 2027.1.0   |

    @pwsh
    Scenario: A newer mise that is kept is said out loud, with how to replace it
      Given a Windows machine that runs mise "2026.11.11"
      And a checkout whose mise.toml pins mise "2026.10.24", whose Windows release is published
      When the checkout's Windows bootstrap runs
      Then the Windows bootstrap says "TOOLCHAIN_DOWNGRADE"
      And the Windows bootstrap says "the newer 2026.11.11, which is kept"
      And the Windows bootstrap says "-AllowMiseDowngrade"

    @pwsh
    Scenario: An upgrade is not a downgrade
      Given a Windows machine that runs mise "2026.10.3"
      And a checkout whose mise.toml pins mise "2026.10.24", whose Windows release is published
      When the checkout's Windows bootstrap runs
      Then the Windows bootstrap does not say "TOOLCHAIN_DOWNGRADE"

    @pwsh
    Scenario: Asked for by name, the older pinned release replaces the newer one, and that is said too
      Given a Windows machine that runs mise "2026.11.11"
      And a checkout whose mise.toml pins mise "2026.10.24", whose Windows release is published
      When the checkout's Windows bootstrap runs with "-AllowMiseDowngrade"
      Then it exits with 0
      And the Windows bootstrap downloaded the mise release "2026.10.24"
      And the Windows machine runs mise "2026.10.24"
      And the Windows bootstrap says "TOOLCHAIN_DOWNGRADE"
      And the Windows bootstrap says "replacing mise 2026.11.11 with the older 2026.10.24"

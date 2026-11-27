Feature: Each process reads the fleet configuration from the one place meant for it
  A file named in HOMELAB_CONFIG comes first. Otherwise the homelab CLI
  reads the configuration fleet-sync last applied from the fleet state, and
  everything else (a launcher, a scheduled job, the worker probe) reads the
  copy fleet-sync installed on the machine: those run under Node, which
  cannot open the state database.

  Every scenario runs with the example fleet: examples/fleet.json without the
  bucket it names. In a path, `~` is the manager's home.

  Scenario: The configuration is read on first use and behaves like the plain object
    Then the configuration names the manager the example fleet names
    And the configuration has the keys of the example fleet, in order
    And the configuration has a "workers" key
    And the configuration prints as the JSON of the example fleet
    And a copy of the configuration equals the example fleet

  Rule: A missing configuration fails the command that needs it, not every command

    Background:
      Given the process is pointed at a fleet.json that does not exist

    Scenario: Reading from it is refused, naming how a manager restores one
      When the manager is read from the configuration
      Then it is refused with "fleet-state --init"

    Scenario: A configuration written afterwards is read without starting over
      Given reading the manager from the configuration was refused
      When the example fleet is written there with "manager-mac" renamed "another-mac"
      Then the configuration names the manager "another-mac"

    Scenario: Pointed back at the example fleet, the process reads that again
      Given reading the manager from the configuration was refused
      And the example fleet was written there with "manager-mac" renamed "another-mac"
      And the configuration named the manager "another-mac"
      When the process is pointed back at the example fleet and forgets what it read
      Then the configuration names the manager "manager-mac"

  Rule: Launchers read the installed copy; only the homelab CLI reads the fleet state

    Background:
      Given the fleet state holds the example fleet as its configuration

    Scenario: A process that is not the homelab CLI reads the copy fleet-sync installed
      A launcher, a scheduled job, the worker probe.
      When a command on the manager asks for the path of its configuration
      Then the process is not the homelab CLI
      And a command on the manager takes its configuration from the installed copy "~/.config/homelab/fleet.json"
      And the path is "~/.config/homelab/fleet.json"

    Scenario: A file named explicitly is the configuration
      Given commands on the manager are passed:
        | HOMELAB_CONFIG | /repo/fleet.json |
      Then a command on the manager takes its configuration from the file "/repo/fleet.json"

    Scenario: A file named explicitly still wins for the homelab CLI
      Given the process is the homelab CLI
      And commands on the manager are passed:
        | HOMELAB_CONFIG | /repo/fleet.json |
      Then a command on the manager takes its configuration from a file

    Scenario: The homelab CLI reads the configuration from the fleet state
      Given the process is the homelab CLI
      Then a command on the manager takes its configuration from the fleet state as "~/.local/share/homelab/state/definition.json"

    Scenario: The commands the homelab CLI starts are handed the same configuration as a file
      Given the process is the homelab CLI
      When a command on the manager asks for the path of its configuration
      Then the path is "~/.local/share/homelab/state/definition.json"
      And commands on the manager are now passed HOMELAB_CONFIG "~/.local/share/homelab/state/definition.json"
      And "~/.local/share/homelab/state/definition.json" on the manager is readable by its owner only
      And "~/.local/share/homelab/state/definition.json" on the manager holds the example fleet, byte for byte
      And a command on the manager takes its configuration from the fleet state

  Rule: A manager whose state holds no configuration falls back to its copy

    Scenario: The homelab CLI on a manager without a fleet state
      Given a manager without a fleet state
      And the process is the homelab CLI
      Then a command on the manager takes its configuration from an installed copy

  Rule: fleet-sync installs the configuration it ran with as the machine copy

    Background:
      Given the directory "~/.config" exists on the manager

    Scenario: The first install writes the copy, for its owner only
      When fleet-sync installs the configuration on the manager
      Then the copy was written
      And "~/.config/homelab/fleet.json" on the manager holds the example fleet as machines are sent it
      And "~/.config/homelab/fleet.json" on the manager is readable by its owner only

    Scenario: Installing the same configuration again writes nothing
      Given fleet-sync installed the configuration on the manager
      When fleet-sync installs the configuration on the manager
      Then the copy was left as it was

    Scenario: Beside the copy fleet-sync records what it wrote
      The copy is JSON that Node and Python read, so it cannot carry a
      header: the record is a file of its own. The next run compares the two
      to tell a copy edited by hand from one nobody touched
      (installed-copy.feature).
      When fleet-sync installs the configuration on the manager
      Then "~/.config/homelab/fleet.json.sha256" on the manager holds the SHA-256 of "~/.config/homelab/fleet.json"
      And "~/.config/homelab/fleet.json.sha256" on the manager is readable by its owner only

  Rule: A remedy names fleet.json where it is for the way the configuration was found
    A remedy that tells the operator to declare something says which file
    to edit, so that nobody edits the installed copy instead.

    Background:
      Given the fleet state holds the example fleet as its configuration

    Scenario: A file named explicitly, or a project's fleet.json, is named by its path
      Given commands on the manager are passed:
        | HOMELAB_CONFIG | /repo/fleet.json |
      Then a remedy on the manager names "fleet.json (/repo/fleet.json)"

    Scenario: A configuration kept in the fleet state is named with the commands that change it
      Given the process is the homelab CLI
      Then a remedy on the manager names "fleet.json (kept in the fleet state: homelab fleet-state --export > fleet.json, edit that file, then homelab fleet-state --import fleet.json)"

    Scenario: A command the homelab CLI started is not sent to the state's copy as a file
      That file is rewritten from the fleet state and never edited.
      Given commands on the manager are passed:
        | HOMELAB_CONFIG | ~/.local/share/homelab/state/definition.json |
      Then a remedy on the manager names "fleet.json (kept in the fleet state: homelab fleet-state --export > fleet.json, edit that file, then homelab fleet-state --import fleet.json)"

    Scenario: A machine that holds only the installed copy is sent to the project, not to the copy
      A launcher, a scheduled job, the worker probe.
      Then a remedy on the manager names the project the fleet is synced from, and not the copy at "~/.config/homelab/fleet.json"

  Rule: The probe workers run under Node never loads the state database

    Scenario: The bundled probe does not import bun:sqlite
      When the probe workers run is bundled
      Then the bundle does not contain "bun:sqlite"

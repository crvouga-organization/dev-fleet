Feature: A revision whose own bootstrap would replace a newer mise is stopped before that bootstrap runs
  Each revision runs its own toolchain bootstrap. One from before the rule
  that keeps a newer mise installs exactly the mise its revision pins, so a
  rollback to an earlier release, or a run for an old branch, would replace a
  newer mise with an older one and break every checkout on the machine whose
  mise.toml asks for the newer one. The run a person, the schedule or a
  worker started is the current code: it reads the pin from the revision's
  own files, measures the mise of each machine it is about to converge, and
  refuses with FLEET_MISE_DOWNGRADE before the revision's bootstrap runs
  anywhere. --allow-mise-downgrade lets it run.

  A bootstrap that knows the flag --allow-mise-downgrade keeps a newer mise
  by itself; that is how the two kinds are told apart.

  Rule: The pin is read from the revision's own files, and every machine about to be converged is measured

    Background:
      Given the fleet's manager is "manager" and the run is about to converge the workers "worker-one, worker-two, worker-three"

    Scenario: The machines that run a newer mise than the revision pins are named
      A worker that does not answer is not measured: it cannot be converged
      either. A machine with no mise has none to replace.
      Given the revision's mise.toml pins mise "2026.10.24"
      And the revision's toolchain bootstrap is from before the rule that keeps a newer mise
      And the machines run these mise releases:
        | machine      | mise       |
        | manager      | 2026.10.24 |
        | worker-one   | 2026.11.11 |
        | worker-two   | none       |
        | worker-three | no answer  |
      When the run asks what the revision's bootstrap would do to mise
      Then it would replace a newer mise than "2026.10.24" on:
        | machine    | mise       |
        | worker-one | 2026.11.11 |

    Scenario Outline: A manager that runs mise <installed> <verdict> by a revision that pins <pinned>
      Releases are compared number by number, as the bootstrap compares them.
      Given the revision's mise.toml pins mise "<pinned>"
      And the revision's toolchain bootstrap is from before the rule that keeps a newer mise
      And the machines run these mise releases:
        | machine | mise        |
        | manager | <installed> |
      When the run asks what the revision's bootstrap would do to mise
      Then the manager's mise <verdict>

      Examples:
        | installed  | pinned     | verdict           |
        | 2026.11.11 | 2026.10.24 | would be replaced |
        | 2026.10.9  | 2026.10.24 | is not at risk    |
        | 2026.10.24 | 2026.10.24 | is not at risk    |
        | 2026.10.24 | 2026.9.30  | would be replaced |
        | 2027.1.0   | 2026.12.31 | would be replaced |

    Scenario: A revision whose bootstrap keeps a newer mise is let through, and no machine is asked
      Given the revision's mise.toml pins mise "2026.10.24"
      And the revision's toolchain bootstrap keeps a newer mise
      And the machines run these mise releases:
        | machine    | mise       |
        | manager    | 2026.11.11 |
        | worker-one | 2026.11.11 |
      When the run asks what the revision's bootstrap would do to mise
      Then no mise would be replaced
      And no machine was asked for its mise

    Scenario: An early revision names its mise in the bootstrap itself
      Given the revision has no mise.toml
      And the revision's toolchain bootstrap is from before the rule that keeps a newer mise, and holds the line "MISE_VERSION=2026.10.24"
      And the machines run these mise releases:
        | machine | mise       |
        | manager | 2026.11.11 |
      When the run asks what the revision's bootstrap would do to mise
      Then it would replace a newer mise than "2026.10.24" on:
        | machine | mise       |
        | manager | 2026.11.11 |

    Scenario: A revision whose files do not name its mise may replace any
      Given the revision has no mise.toml
      And the revision's toolchain bootstrap is from before the rule that keeps a newer mise
      And the machines run these mise releases:
        | machine | mise       |
        | manager | 2026.11.11 |
      When the run asks what the revision's bootstrap would do to mise
      Then it would replace a mise the revision does not name on:
        | machine | mise       |
        | manager | 2026.11.11 |

    Scenario: A revision that cannot be read is not judged
      The run stops by itself when the revision cannot be taken from the
      source repository.
      Given the revision's files cannot be read
      And the machines run these mise releases:
        | machine | mise       |
        | manager | 2026.11.11 |
      When the run asks what the revision's bootstrap would do to mise
      Then no mise would be replaced

    Scenario: The refusal names the machines, the releases and the way on
      Given the revision's mise.toml pins mise "2026.10.24"
      And the revision's toolchain bootstrap is from before the rule that keeps a newer mise
      And the machines run these mise releases:
        | machine    | mise       |
        | manager    | 2026.11.11 |
        | worker-one | 2026.11.12 |
      When the run asks what the revision's bootstrap would do to mise
      Then the refusal says each of:
        | pins mise 2026.10.24                         |
        | manager (2026.11.11), worker-one (2026.11.12) |
        | --allow-mise-downgrade                       |
        | Nothing was changed                          |

  Rule: A hand-off asks the manager before the revision's own run script runs there
    The run script installs the revision's toolchain on the manager. The
    guard is a few lines of shell that ask the manager's own copy of the
    source repository and the manager's mise; it exits with 67 for a revision
    that would replace it with an older one. A hand-off cannot measure the
    workers.

    Background:
      Given a manager's home with nothing on it but Git, where "mise" and "bash" only record how they are called
      And the fleet's source repository holds the commit "released"

    @bash
    Scenario Outline: On a manager that runs mise <installed>, the guard exits with <code> for a revision from before the rule that pins <pinned>
      Given a branch of the fleet's source repository holds the commit "earlier", whose mise.toml pins mise "<pinned>" and whose toolchain bootstrap is from before the rule that keeps a newer mise
      And the manager has its own copy of the source repository
      And the manager runs mise "<installed>"
      When the mise guard of a hand-off runs on the manager for the commit "earlier"
      Then the guard exits with <code>

      Examples:
        | installed  | pinned     | code |
        | 2026.11.11 | 2026.10.24 | 67   |
        | 2026.10.24 | 2026.9.30  | 67   |
        | 2026.10.24 | 2026.10.24 | 0    |
        | 2026.10.9  | 2026.10.24 | 0    |

    @bash
    Scenario: A revision whose bootstrap keeps a newer mise passes the guard
      Given a branch of the fleet's source repository holds the commit "older", whose mise.toml pins mise "2026.10.24"
      And the manager has its own copy of the source repository
      And the manager runs mise "2026.11.11"
      When the mise guard of a hand-off runs on the manager for the commit "older"
      Then the guard exits with 0

    @bash
    Scenario: A revision the manager's copy does not hold yet is fetched before it is judged
      Given the manager has its own copy of the source repository
      And a branch of the fleet's source repository holds the commit "earlier", whose mise.toml pins mise "2026.10.24" and whose toolchain bootstrap is from before the rule that keeps a newer mise
      And the manager runs mise "2026.11.11"
      When the mise guard of a hand-off runs on the manager for the commit "earlier"
      Then the guard exits with 67

    @bash
    Scenario: A manager with no mise has none to replace
      Given a branch of the fleet's source repository holds the commit "earlier", whose mise.toml pins mise "2026.10.24" and whose toolchain bootstrap is from before the rule that keeps a newer mise
      And the manager has its own copy of the source repository
      And the manager has no mise
      When the mise guard of a hand-off runs on the manager for the commit "earlier"
      Then the guard exits with 0

  Rule: --allow-mise-downgrade reaches the bootstrap of a revision that keeps a newer mise
    The run that was given the flag tells the run script in its environment,
    about the one revision: the script is the revision's own and may be older
    than the flag.

    Background:
      Given a manager's home with nothing on it but Git, where "mise" and "bash" only record how they are called
      And the fleet's source repository holds the commit "released"
      And the manager has its own copy of the source repository

    Scenario: Told about its revision, the run script gives the bootstrap the flag
      When the run script is started for the commit "released" with "--json", told that mise may be downgraded for the commit "released"
      Then the run script exits with 0
      And the run script ran "bash bootstrap/bootstrap.sh --tools-only --allow-mise-downgrade"

    Scenario: A warm toolchain does not skip a downgrade that was asked for
      Given the run script has already run for the commit "released" with "--json"
      When the run script is started for the commit "released" with "--json", told that mise may be downgraded for the commit "released"
      Then the run script exits with 0
      And the run script ran "bash bootstrap/bootstrap.sh --tools-only --allow-mise-downgrade"

    Scenario: What the run script was told about another revision says nothing about this one
      Given the fleet's source repository gains the commit "next"
      When the run script is started for the commit "next" with "--json", told that mise may be downgraded for the commit "released"
      Then the run script exits with 0
      And this time the run script ran nothing that names "--allow-mise-downgrade"

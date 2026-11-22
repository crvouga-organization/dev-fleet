Feature: A revision whose own bootstrap would replace a newer mise is stopped before that bootstrap runs
  Each revision runs its own toolchain bootstrap. One from before the rule
  that keeps a newer mise installs exactly the mise its revision pins, so a
  rollback to an earlier release, or a run for an old branch, would replace a
  newer mise with an older one and break every checkout on the machine whose
  mise.toml asks for the newer one. The run a person, the schedule or a
  worker started is the current code: it reads the pin from the revision's
  own files, measures the mise of each machine it is about to converge, and
  refuses with FLEET_MISE_DOWNGRADE before the revision's bootstrap runs
  anywhere. A worker that does not say which mise it runs is not let through
  unmeasured: FLEET_MISE_UNMEASURED. --allow-mise-downgrade lets the
  revision's bootstrap run.

  A bootstrap that knows the flag --allow-mise-downgrade keeps a newer mise
  by itself; that is how the two kinds are told apart.

  Rule: The pin is read from the revision's own files, and every machine about to be converged is measured

    Background:
      Given the fleet's manager is "manager" and the run is about to converge the workers "worker-one, worker-two, worker-three"

    Scenario: The machines that run a newer mise than the revision pins are named, and so is a worker that did not answer
      A machine with no mise has none to replace.
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
      And these workers did not say which mise they run:
        | worker-three |
      And the run is refused with "FLEET_MISE_DOWNGRADE"

    Scenario: A worker that does not answer stops the run, although no machine is known to run a newer mise
      A worker that does not answer now may answer a moment later, when the
      revision's own code reaches it, and from there on nothing stands
      between that bootstrap and its mise. So the run is refused rather than
      let through unmeasured, and says which worker: bring it back, park it,
      name the others with --node, or allow the downgrade.
      Given the revision's mise.toml pins mise "2026.10.24"
      And the revision's toolchain bootstrap is from before the rule that keeps a newer mise
      And the machines run these mise releases:
        | machine      | mise       |
        | manager      | 2026.10.24 |
        | worker-one   | 2026.10.24 |
        | worker-two   | none       |
        | worker-three | no answer  |
      When the run asks what the revision's bootstrap would do to mise
      Then no machine is known to run a newer mise than "2026.10.24"
      And these workers did not say which mise they run:
        | worker-three |
      And the run is refused with "FLEET_MISE_UNMEASURED"
      And the refusal says each of:
        | Nothing was changed                          |
        | worker-three did not say which mise it runs  |
        | devfleet fleet-node-park                     |
        | --node                                       |
        | --allow-mise-downgrade                       |

    Scenario: A worker whose mise answers with something that is no release is not measured either
      Given the revision's mise.toml pins mise "2026.10.24"
      And the revision's toolchain bootstrap is from before the rule that keeps a newer mise
      And the machines run these mise releases:
        | machine      | mise       |
        | manager      | 2026.10.24 |
        | worker-one   | garbled    |
        | worker-two   | 2026.10.24 |
        | worker-three | none       |
      When the run asks what the revision's bootstrap would do to mise
      Then these workers did not say which mise they run:
        | worker-one |

    Scenario: When every machine answers and none runs a newer mise, the revision's bootstrap may run
      Given the revision's mise.toml pins mise "2026.10.24"
      And the revision's toolchain bootstrap is from before the rule that keeps a newer mise
      And the machines run these mise releases:
        | machine      | mise       |
        | manager      | 2026.10.24 |
        | worker-one   | 2026.10.9  |
        | worker-two   | none       |
        | worker-three | 2026.10.24 |
      When the run asks what the revision's bootstrap would do to mise
      Then no mise would be replaced

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
    The run script installs the revision's toolchain on the manager, and from
    there on everything is the revision's own code. The guard is a few lines
    of shell that run before it. A revision whose bootstrap keeps a newer
    mise passes at once, as the manager's own copy of the source repository
    shows it. For any other the guard compares the manager's mise with the
    pin and exits with 67 when it would be replaced; then it asks the
    devfleet installed on the manager, which is the code the manager runs
    now and not the revision's, the same question about the manager and
    every worker the request selects (fleet-sync --measure-mise). What that
    refuses is printed and ends the hand-off. An installed devfleet that
    cannot answer, because it is from before the question or there is none,
    is never a pass: the guard exits with 68, reported as
    FLEET_MISE_UNMEASURED.

    Background:
      Given a manager's home with nothing on it but Git, where "mise" and "bash" only record how they are called
      And the fleet's source repository holds the commit "released"

    @bash
    Scenario Outline: On a manager that runs mise <installed>, the guard exits with <code> for a revision from before the rule that pins <pinned>
      Given a branch of the fleet's source repository holds the commit "earlier", whose mise.toml pins mise "<pinned>" and whose toolchain bootstrap is from before the rule that keeps a newer mise
      And the manager has its own copy of the source repository
      And the manager runs mise "<installed>"
      And the devfleet installed on the manager answers that no mise would be replaced
      When the mise guard of a hand-off runs on the manager for the commit "earlier"
      Then the guard exits with <code>

      Examples:
        | installed  | pinned     | code |
        | 2026.11.11 | 2026.10.24 | 67   |
        | 2026.10.24 | 2026.9.30  | 67   |
        | 2026.10.24 | 2026.10.24 | 0    |
        | 2026.10.9  | 2026.10.24 | 0    |

    @bash
    Scenario: A manager whose own mise is at risk is refused without asking the installed devfleet
      Given a branch of the fleet's source repository holds the commit "earlier", whose mise.toml pins mise "2026.10.24" and whose toolchain bootstrap is from before the rule that keeps a newer mise
      And the manager has its own copy of the source repository
      And the manager runs mise "2026.11.11"
      And the devfleet installed on the manager answers that no mise would be replaced
      When the mise guard of a hand-off runs on the manager for the commit "earlier"
      Then the guard exits with 67
      And the devfleet installed on the manager was not asked

    @bash
    Scenario: The installed devfleet is asked about the revision and the workers the request selects, in the form the request asked for
      Given a branch of the fleet's source repository holds the commit "earlier", whose mise.toml pins mise "2026.10.24" and whose toolchain bootstrap is from before the rule that keeps a newer mise
      And the manager has its own copy of the source repository
      And the manager runs mise "2026.10.24"
      And the devfleet installed on the manager answers that no mise would be replaced
      When the mise guard of a hand-off runs on the manager for the commit "earlier", for a request with "--node worker-one --node worker-two --json"
      Then the guard exits with 0
      And the devfleet installed on the manager was asked "fleet-sync --measure-mise --revision <earlier> --node worker-one --node worker-two --json"

    @bash
    Scenario: A worker's newer mise ends the hand-off, with the report of the installed devfleet
      The manager runs the pinned mise itself, so only a measurement of the
      workers can tell.
      Given a branch of the fleet's source repository holds the commit "earlier", whose mise.toml pins mise "2026.10.24" and whose toolchain bootstrap is from before the rule that keeps a newer mise
      And the manager has its own copy of the source repository
      And the manager runs mise "2026.10.24"
      And the devfleet installed on the manager refuses the question with:
        """
        {"version":1,"ok":false,"code":"FLEET_MISE_DOWNGRADE","error":"it would replace the newer one on worker-one (2026.11.11)"}
        """
      When the mise guard of a hand-off runs on the manager for the commit "earlier", for a request with "--json"
      Then the guard exits with 1
      And the guard prints:
        """
        {"version":1,"ok":false,"code":"FLEET_MISE_DOWNGRADE","error":"it would replace the newer one on worker-one (2026.11.11)"}
        """

    @bash
    Scenario: A worker that did not answer the installed devfleet ends the hand-off the same way
      Given a branch of the fleet's source repository holds the commit "earlier", whose mise.toml pins mise "2026.10.24" and whose toolchain bootstrap is from before the rule that keeps a newer mise
      And the manager has its own copy of the source repository
      And the manager runs mise "2026.10.24"
      And the devfleet installed on the manager refuses the question with:
        """
        {"version":1,"ok":false,"code":"FLEET_MISE_UNMEASURED","error":"worker-two did not say which mise it runs"}
        """
      When the mise guard of a hand-off runs on the manager for the commit "earlier", for a request with "--json"
      Then the guard exits with 1
      And the guard prints:
        """
        {"version":1,"ok":false,"code":"FLEET_MISE_UNMEASURED","error":"worker-two did not say which mise it runs"}
        """

    @bash
    Scenario: An installed devfleet from before the question is not a pass
      It refuses the flag it does not know, as any devfleet released before
      the question does, and says nothing about mise.
      Given a branch of the fleet's source repository holds the commit "earlier", whose mise.toml pins mise "2026.10.24" and whose toolchain bootstrap is from before the rule that keeps a newer mise
      And the manager has its own copy of the source repository
      And the manager runs mise "2026.10.24"
      And the devfleet installed on the manager is from before the question
      When the mise guard of a hand-off runs on the manager for the commit "earlier", for a request with "--json"
      Then the guard exits with 68
      And the guard prints nothing

    @bash
    Scenario: A manager with no devfleet installed is not a pass
      Given a branch of the fleet's source repository holds the commit "earlier", whose mise.toml pins mise "2026.10.24" and whose toolchain bootstrap is from before the rule that keeps a newer mise
      And the manager has its own copy of the source repository
      And the manager runs mise "2026.10.24"
      When the mise guard of a hand-off runs on the manager for the commit "earlier"
      Then the guard exits with 68

    @bash
    Scenario: A revision whose bootstrap keeps a newer mise passes the guard, and nobody is asked
      Every release since the rule: an ordinary hand-off never depends on
      what the manager has installed.
      Given a branch of the fleet's source repository holds the commit "older", whose mise.toml pins mise "2026.10.24"
      And the manager has its own copy of the source repository
      And the manager runs mise "2026.11.11"
      And the devfleet installed on the manager is from before the question
      When the mise guard of a hand-off runs on the manager for the commit "older"
      Then the guard exits with 0
      And the devfleet installed on the manager was not asked

    @bash
    Scenario: A revision the manager's copy does not hold yet is fetched before it is judged
      Given the manager has its own copy of the source repository
      And a branch of the fleet's source repository holds the commit "earlier", whose mise.toml pins mise "2026.10.24" and whose toolchain bootstrap is from before the rule that keeps a newer mise
      And the manager runs mise "2026.11.11"
      When the mise guard of a hand-off runs on the manager for the commit "earlier"
      Then the guard exits with 67

    @bash
    Scenario: A manager with no mise has none to replace, and the workers are still measured
      Given a branch of the fleet's source repository holds the commit "earlier", whose mise.toml pins mise "2026.10.24" and whose toolchain bootstrap is from before the rule that keeps a newer mise
      And the manager has its own copy of the source repository
      And the manager has no mise
      And the devfleet installed on the manager answers that no mise would be replaced
      When the mise guard of a hand-off runs on the manager for the commit "earlier"
      Then the guard exits with 0
      And the devfleet installed on the manager was asked "fleet-sync --measure-mise --revision <earlier>"

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

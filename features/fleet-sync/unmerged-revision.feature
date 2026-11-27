Feature: The fleet moves only to a revision on the default branch of the source repository
  A run started from a branch once made that branch's commit the revision of
  every machine. The branch pinned an older mise, its bootstrap replaced the
  newer one, and every mise shim then refused to run in a checkout of the
  default branch. Two rules keep that from happening again: a revision that is
  not on the default branch is refused unless --allow-unmerged asks for it,
  and a toolchain bootstrap never replaces mise with an older release unasked.

  The manager's own copy of the source repository answers, never the directory
  converge was started in. These scenarios run the real Git, the real run
  script and the real toolchain bootstrap in a manager's home of their own.

  Background:
    Given a manager's home with nothing on it but Git, where "mise" and "bash" only record how they are called
    And the fleet's source repository holds the commit "released"
    And a branch of the fleet's source repository holds the commit "pins"

  Rule: The manager's own copy of the source repository says whether the default branch holds a revision

    Scenario: A revision on the default branch is held, and the copy is made when there is none
      When the manager's copy of the source repository is asked whether the default branch holds the commit "released"
      Then the answer is "merged"

    Scenario: A revision only a branch holds is not
      Given the manager has its own copy of the source repository
      When the manager's copy of the source repository is asked whether the default branch holds the commit "pins"
      Then the answer is "unmerged"

    Scenario: A revision the source repository does not hold at all is not
      Given the manager has its own copy of the source repository
      When the manager's copy of the source repository is asked whether the default branch holds the revision "dddddddddddddddddddddddddddddddddddddddd"
      Then the answer is "unmerged"

    Scenario: Once its branch is merged, the revision is held
      The copy was made before the merge, so it is fetched first.
      Given the manager has its own copy of the source repository
      And the branch that holds the commit "pins" is merged into the default branch
      When the manager's copy of the source repository is asked whether the default branch holds the commit "pins"
      Then the answer is "merged"

    Scenario: A revision known to be on the default branch needs no network
      The schedule converges the fleet while the source repository is away.
      Given the manager has its own copy of the source repository
      And the fleet's source repository can no longer be reached
      When the manager's copy of the source repository is asked whether the default branch holds the commit "released"
      Then the answer is "merged"

    Scenario: With the source repository away, nobody can vouch for any other revision
      Given the manager has its own copy of the source repository
      And the fleet's source repository can no longer be reached
      When the manager's copy of the source repository is asked whether the default branch holds the commit "pins"
      Then the answer is "unverified"

  Rule: A hand-off asks the manager before the revision's own run script runs there
    The run script installs the revision's toolchain on the manager, so the
    question comes first. The guard exits with 65 for a revision that is not
    on the default branch and with 66 when it cannot tell.

    Scenario Outline: The guard exits with <code> for <revision>
      Given the manager has its own copy of the source repository
      When the guard of a hand-off runs on the manager for <revision>
      Then the guard exits with <code>

      Examples:
        | revision                                                | code |
        | the commit "released"                                   | 0    |
        | the commit "pins"                                       | 65   |
        | the revision "dddddddddddddddddddddddddddddddddddddddd" | 65   |

    Scenario: A manager with no copy of the source repository cannot tell
      When the guard of a hand-off runs on the manager for the commit "released"
      Then the guard exits with 66

    Scenario: A manager that cannot fetch the source repository cannot tell
      Given the manager has its own copy of the source repository
      And the fleet's source repository can no longer be reached
      When the guard of a hand-off runs on the manager for the commit "pins"
      Then the guard exits with 66

  Rule: A copy of another repository is replaced before it is asked
    A manager whose copy was made before the fleet's source moved has an
    origin that can never hold the revision: asked as it is, it would call a
    merged revision unmerged. The declared repository is cloned beside it, and
    only a complete clone takes its place.

    Scenario: Asked by converge, the copy of another repository is replaced and answers
      Given the manager's copy of the source repository is a clone of another repository
      When the manager's copy of the source repository is asked whether the default branch holds the commit "released"
      Then the answer is "merged"
      And the origin of the manager's copy of the source repository is the fleet's source repository

    Scenario: A copy of another repository that cannot be replaced is reported as such, not as unmerged
      Given the manager's copy of the source repository is a clone of another repository
      And the fleet's source repository can no longer be reached
      When the manager's copy of the source repository is asked whether the default branch holds the commit "released"
      Then the answer is "mismatched"
      And the origin of the manager's copy of the source repository is the other repository

    Scenario: In a hand-off, the source guard replaces the copy of another repository
      Given the manager's copy of the source repository is a clone of another repository
      When the source guard of a hand-off runs on the manager
      Then the guard exits with 0
      And the origin of the manager's copy of the source repository is the fleet's source repository

    Scenario: Once the source guard replaced the copy, the ancestry guard finds the revision merged
      Given the manager's copy of the source repository is a clone of another repository
      And the source guard of a hand-off has run on the manager
      When the guard of a hand-off runs on the manager for the commit "released"
      Then the guard exits with 0

    Scenario: In a hand-off, a copy of another repository that cannot be replaced stops it with 69
      Given the manager's copy of the source repository is a clone of another repository
      And the fleet's source repository can no longer be reached
      When the source guard of a hand-off runs on the manager
      Then the guard exits with 69
      And the origin of the manager's copy of the source repository is the other repository

    Scenario: The source guard leaves a copy of the fleet's source repository as it is
      Given the manager has its own copy of the source repository
      When the source guard of a hand-off runs on the manager
      Then the guard exits with 0
      And the origin of the manager's copy of the source repository is the fleet's source repository

    Scenario: The source guard leaves a manager without a copy to the guards after it
      When the source guard of a hand-off runs on the manager
      Then the guard exits with 0

  Rule: A branch revision that pins an older mise does not downgrade the manager's

    @bash
    Scenario: Handed off as it was, the branch revision is stopped before its toolchain is installed
      Given a branch of the fleet's source repository holds the commit "older", whose mise.toml pins mise "2026.10.24"
      And the manager has its own copy of the source repository
      When the guard of a hand-off runs on the manager for the commit "older"
      Then the guard exits with 65

    @bash
    Scenario: Allowed through with --allow-unmerged, the branch revision runs and its bootstrap keeps the manager's newer mise
      min_version is a minimum: the newer mise satisfies the branch's pin, and
      every checkout of the default branch on the machine needs it. The run
      script is the revision's own and is given no --allow-unmerged: the run
      that started it answered for that.
      Given a branch of the fleet's source repository holds the commit "older", whose mise.toml pins mise "2026.10.24"
      And the manager has its own copy of the source repository
      And the manager runs mise "2026.11.11", and the toolchain bootstrap really runs
      When the run script is started for the commit "older" with "--json"
      Then the run script exits with 0
      And the manager still runs mise "2026.11.11"
      And this time the run script ran nothing that names "curl"
      And the toolchain setup log of the commit "older" says "TOOLCHAIN_DOWNGRADE"
      And the last thing the run script ran is "mise exec --locked bun -- bun src/cli/cli.ts converge --revision {older} --json", where {older} is that commit

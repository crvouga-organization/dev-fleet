Feature: converge brings the manager's fleet state up to the bucket before it changes anything, and uploads what it records
  A run records the revision it was approved for in the fleet state. With a
  bucket, it first takes the bucket's version when its own copy is stale,
  refuses to run on a copy that diverged, and uploads its record even when it
  stops early.

  The manager here has no worker enrolled and nothing installed but a
  stand-in for Litestream, so every run stops at
  FLEET_MANAGER_ENROLLMENT_REQUIRED, after it has used the state and before
  it reaches a machine. Git answers only about the manager's own copy of the
  source repository, whose default branch holds every revision a scenario
  does not say it lacks. Manager "b" is another manager of the same fleet,
  or its replacement.
  `$BUCKET` is the directory that stands in for the bucket.

  Background:
    Given converge runs on a manager with no worker enrolled

  Scenario: Without a bucket a run still records its approval in the local state
    When converge runs for revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    Then the command exits 1
    And the report contains "FLEET_MANAGER_ENROLLMENT_REQUIRED"
    And the approved revision of the manager is "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    And Litestream was never started
    And the run started over 0 times

  Scenario: A run uploads its approval even when it stops before its report
    Given the manager saved the bucket "$BUCKET" in its bucket.json
    And manager "b" replicates to the bucket
    When converge runs for revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    Then the manager stands "in-sync" with the bucket
    And a refresh of manager "b" reports "in-sync"
    And the enrollment in the fleet state of manager "b" contains "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

  Scenario: A stale manager takes the bucket's state and starts over before it changes anything
    The run builds on what the other manager applied instead of erasing it.
    Given the manager saved the bucket "$BUCKET" in its bucket.json
    And manager "b" replicates to the bucket
    And manager "b" stored the enrollment and uploaded it:
      """
      {
        "version": 1,
        "id": "manager",
        "approvedRevision": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "appliedRevision": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      }
      """
    When converge runs for revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    Then the run started over 1 time
    And the approved revision of the manager is "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    And the applied revision of the manager is "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    And the fleet state says the approved revision was selected by "--revision"
    And the manager stands "in-sync" with the bucket

  Scenario: A manager whose state diverged from the bucket changes nothing
    Given the manager saved the bucket "$BUCKET" in its bucket.json
    And manager "b" replicates to the bucket
    And converge ran for revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    And manager "b" refreshed its copy
    And the bucket stopped answering
    And converge ran for revision "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    And the bucket answered again
    And manager "b" stored the enrollment and uploaded it:
      """
      {
        "version": 1,
        "id": "manager",
        "approvedRevision": "cccccccccccccccccccccccccccccccccccccccc"
      }
      """
    When converge runs for revision "dddddddddddddddddddddddddddddddddddddddd"
    Then the command exits 1
    And the report contains "FLEET_STATE_DIVERGED"
    And the report contains "state --restore --yes"
    And the enrollment in the fleet state of the manager is what it was before the run
    And the manager stands "diverged" with the bucket

  Scenario: A preview records no approval
    Given the manager saved the bucket "$BUCKET" in its bucket.json
    When converge previews revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    Then the command exits 1
    And the manager has no enrollment

  Scenario: A preview of a stale manager is made from the bucket's state, and uploads nothing
    A preview made from a stale copy would plan against a fleet that no
    longer exists. Bringing the copy up to the bucket never uploads.
    Given the manager saved the bucket "$BUCKET" in its bucket.json
    And manager "b" replicates to the bucket
    And manager "b" stored the enrollment and uploaded it:
      """
      {
        "version": 1,
        "id": "manager",
        "approvedRevision": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "appliedRevision": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      }
      """
    When converge previews revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    Then the run started over 1 time
    And the enrollment of the manager is exactly:
      """
      {
        "version": 1,
        "id": "manager",
        "approvedRevision": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "appliedRevision": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      }
      """
    And the manager stands "in-sync" with the bucket
    And the report contains "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

  Scenario: A run from a project replicates to the bucket its fleet.json names and records the configuration it applied
    Nothing is saved on the manager: it has no bucket.json. A replacement
    manager, or a run started outside the project (the schedule, a hand-off
    from a worker), finds what was applied.
    Given "~/fleet.json" on the manager holds the example fleet with the bucket:
      """
      { "directory": "$BUCKET" }
      """
    And the process runs with the fleet.json "~/fleet.json"
    And manager "b" replicates to the bucket
    When converge runs for revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    Then Litestream was started
    And a refresh of manager "b" reports "in-sync"
    And the fleet state of manager "b" holds the configuration that "~/fleet.json" on the manager declares
    And the enrollment in the fleet state of manager "b" contains "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

  Scenario: --rollback approves the revision applied before the current one
    A rollback applies the playbooks and pins of the previous revision: the
    revision, the tools and T3 go back; system packages roll forward only.
    Given the manager stored the enrollment:
      """
      {
        "version": 1,
        "id": "manager",
        "approvedRevision": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "appliedRevision": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "previousRevision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      }
      """
    When converge rolls back
    Then the report contains "FLEET_MANAGER_ENROLLMENT_REQUIRED"
    And the approved revision of the manager is "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

  Scenario: --rollback after a failed upgrade approves the revision still applied
    The canary failed on the approved revision, so the applied one is the
    revision before it: the rollback goes back to that one, not to the one
    applied before it.
    Given the manager stored the enrollment:
      """
      {
        "version": 1,
        "id": "manager",
        "approvedRevision": "cccccccccccccccccccccccccccccccccccccccc",
        "appliedRevision": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "previousRevision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      }
      """
    When converge rolls back
    Then the report contains "FLEET_MANAGER_ENROLLMENT_REQUIRED"
    And the approved revision of the manager is "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

  Scenario: --rollback after a failed first upgrade approves the revision still applied
    Given the manager stored the enrollment:
      """
      {
        "version": 1,
        "id": "manager",
        "approvedRevision": "cccccccccccccccccccccccccccccccccccccccc",
        "appliedRevision": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      }
      """
    When converge rolls back
    Then the report contains "FLEET_MANAGER_ENROLLMENT_REQUIRED"
    And the approved revision of the manager is "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

  Scenario: --rollback with no earlier revision changes nothing
    Given the manager stored the enrollment:
      """
      {
        "version": 1,
        "id": "manager",
        "approvedRevision": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "appliedRevision": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      }
      """
    When converge rolls back
    Then the command exits 1
    And the report contains "FLEET_ROLLBACK_UNAVAILABLE"
    And the enrollment in the fleet state of the manager is what it was before the run

  Rule: A revision that is not on the default branch of the source repository is refused before anything is recorded
    A run started from a branch once made that branch's commit the fleet's
    revision, and its older toolchain every machine's. The manager's own copy
    of the source repository says whether its default branch holds the
    revision, whatever selected it; --allow-unmerged is the way to converge
    to an unmerged revision on purpose.

    Background:
      Given the manager stored the enrollment:
        """
        {
          "version": 1,
          "id": "manager",
          "approvedRevision": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "appliedRevision": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "previousRevision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        }
        """

    Scenario: A branch revision is refused, and the approved revision stays
      Given the default branch of the source repository does not hold revision "cccccccccccccccccccccccccccccccccccccccc"
      When converge runs for revision "cccccccccccccccccccccccccccccccccccccccc"
      Then the command exits 1
      And the report contains "FLEET_REVISION_UNMERGED"
      And the report contains "selected by --revision"
      And the report contains "--allow-unmerged"
      And the enrollment in the fleet state of the manager is what it was before the run

    Scenario: A preview of a branch revision is refused too
      A preview says what a sync would do.
      Given the default branch of the source repository does not hold revision "cccccccccccccccccccccccccccccccccccccccc"
      When converge previews revision "cccccccccccccccccccccccccccccccccccccccc"
      Then the command exits 1
      And the report contains "FLEET_REVISION_UNMERGED"

    Scenario: --rollback to a revision that is not on the default branch is refused
      The revision applied before was itself converged with --allow-unmerged.
      Given the default branch of the source repository does not hold revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      When converge rolls back
      Then the command exits 1
      And the report contains "FLEET_REVISION_UNMERGED"
      And the report contains "selected by --rollback"
      And the enrollment in the fleet state of the manager is what it was before the run

    Scenario: A revision nobody can vouch for is refused
      The manager's copy does not know the revision to be on the default
      branch, and the source repository cannot be asked.
      Given the default branch of the source repository does not hold revision "cccccccccccccccccccccccccccccccccccccccc"
      And the source repository cannot be fetched
      When converge runs for revision "cccccccccccccccccccccccccccccccccccccccc"
      Then the command exits 1
      And the report contains "FLEET_REVISION_UNVERIFIED"
      And the enrollment in the fleet state of the manager is what it was before the run

    Scenario: A revision already known to be on the default branch needs no fetch
      The schedule converges the fleet while the source repository is away.
      Given the source repository cannot be fetched
      When converge runs for revision "cccccccccccccccccccccccccccccccccccccccc"
      Then the report contains "FLEET_MANAGER_ENROLLMENT_REQUIRED"
      And the approved revision of the manager is "cccccccccccccccccccccccccccccccccccccccc"

    Scenario: With --allow-unmerged the revision is approved, and the fleet state says so
      Given the default branch of the source repository does not hold revision "cccccccccccccccccccccccccccccccccccccccc"
      When converge runs for revision "cccccccccccccccccccccccccccccccccccccccc" with --allow-unmerged
      Then the report contains "FLEET_MANAGER_ENROLLMENT_REQUIRED"
      And the approved revision of the manager is "cccccccccccccccccccccccccccccccccccccccc"
      And the fleet state says the approved revision was selected by "--revision (--allow-unmerged)"

    Scenario: The run in the fleet-owned checkout is not asked again, and records what it was told selected the revision
      The run a person or a worker started asked before it left for the
      checkout; the run there is the revision's own code and is always given
      --revision.
      Given the default branch of the source repository does not hold revision "cccccccccccccccccccccccccccccccccccccccc"
      And the process runs from the fleet-owned checkout of revision "cccccccccccccccccccccccccccccccccccccccc", told "cccccccccccccccccccccccccccccccccccccccc:checkout@worker-one+unmerged"
      When converge runs for revision "cccccccccccccccccccccccccccccccccccccccc"
      Then the report contains "FLEET_MANAGER_ENROLLMENT_REQUIRED"
      And the fleet state says the approved revision was selected by "the HEAD of the checkout converge was started in, handed off from worker-one (--allow-unmerged)"

    Scenario: A run started on the manager's own launcher after a hand-off believes what it was told about its revision
      The worker was given --allow-unmerged; the run on the manager is given
      only --revision.
      Given the default branch of the source repository does not hold revision "cccccccccccccccccccccccccccccccccccccccc"
      And the process is told "cccccccccccccccccccccccccccccccccccccccc:revision@worker-one+unmerged"
      When converge runs for revision "cccccccccccccccccccccccccccccccccccccccc"
      Then the report contains "FLEET_MANAGER_ENROLLMENT_REQUIRED"
      And the fleet state says the approved revision was selected by "--revision, handed off from worker-one (--allow-unmerged)"

    Scenario: What a run was told about another revision says nothing about this one
      Given the default branch of the source repository does not hold revision "cccccccccccccccccccccccccccccccccccccccc"
      And the process is told "dddddddddddddddddddddddddddddddddddddddd:revision+unmerged"
      When converge runs for revision "cccccccccccccccccccccccccccccccccccccccc"
      Then the command exits 1
      And the report contains "FLEET_REVISION_UNMERGED"
      And the enrollment in the fleet state of the manager is what it was before the run

  Rule: A revision whose own bootstrap would replace a newer mise is refused before anything is recorded
    Each revision runs its own toolchain bootstrap. One from before the rule
    that keeps a newer mise installs exactly the mise its revision pins, and
    every checkout on the machine whose mise.toml asks for a newer one then
    stops working. The run reads the pin from the revision's own files in the
    manager's copy of the source repository and measures the mise of the
    machines it is about to converge, before it leaves for the revision's
    checkout. --allow-mise-downgrade lets the bootstrap run.

    Background:
      Given the manager stored the enrollment:
        """
        {
          "version": 1,
          "id": "manager",
          "approvedRevision": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "appliedRevision": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "previousRevision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        }
        """
      And the manager runs mise "2026.11.11"

    Scenario: --rollback to an earlier release that would replace the manager's mise is refused
      Given revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" pins mise "2026.10.24", and its toolchain bootstrap is from before the rule that keeps a newer mise
      When converge rolls back
      Then the command exits 1
      And the report contains "FLEET_MISE_DOWNGRADE"
      And the report contains "pins mise 2026.10.24"
      And the report contains "(2026.11.11)"
      And the report contains "--allow-mise-downgrade"
      And the enrollment in the fleet state of the manager is what it was before the run

    Scenario: A run for such a revision is refused whatever selected it
      Given revision "cccccccccccccccccccccccccccccccccccccccc" pins mise "2026.10.24", and its toolchain bootstrap is from before the rule that keeps a newer mise
      When converge runs for revision "cccccccccccccccccccccccccccccccccccccccc"
      Then the command exits 1
      And the report contains "FLEET_MISE_DOWNGRADE"
      And the enrollment in the fleet state of the manager is what it was before the run

    Scenario: A preview of such a revision is refused too
      A preview says what a sync would do.
      Given revision "cccccccccccccccccccccccccccccccccccccccc" pins mise "2026.10.24", and its toolchain bootstrap is from before the rule that keeps a newer mise
      When converge previews revision "cccccccccccccccccccccccccccccccccccccccc"
      Then the command exits 1
      And the report contains "FLEET_MISE_DOWNGRADE"

    Scenario: Asked only the question, converge gives the same refusal and records nothing
      --measure-mise is how the guard of a hand-off asks the manager's
      installed homelab, before the revision's own run script starts there.
      Given revision "cccccccccccccccccccccccccccccccccccccccc" pins mise "2026.10.24", and its toolchain bootstrap is from before the rule that keeps a newer mise
      When converge is asked only what revision "cccccccccccccccccccccccccccccccccccccccc" would do to mise
      Then the command exits 1
      And the report contains "FLEET_MISE_DOWNGRADE"
      And the report contains "(2026.11.11)"
      And the enrollment in the fleet state of the manager is what it was before the run

    Scenario: Asked only the question about a revision that keeps a newer mise, converge says so and approves nothing
      Given revision "cccccccccccccccccccccccccccccccccccccccc" pins mise "2026.10.24", and its toolchain bootstrap keeps a newer mise
      When converge is asked only what revision "cccccccccccccccccccccccccccccccccccccccc" would do to mise
      Then the command exits 0
      And the report includes:
        """
        { "ok": true, "revision": "cccccccccccccccccccccccccccccccccccccccc", "miseDowngrade": null }
        """
      And the enrollment in the fleet state of the manager is what it was before the run

    Scenario: With --allow-mise-downgrade the rollback goes on
      Given revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" pins mise "2026.10.24", and its toolchain bootstrap is from before the rule that keeps a newer mise
      When converge rolls back with --allow-mise-downgrade
      Then the report contains "FLEET_MANAGER_ENROLLMENT_REQUIRED"
      And the approved revision of the manager is "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

    Scenario: A revision whose bootstrap keeps a newer mise is not refused
      Its bootstrap keeps the manager's mise, and check reports the
      warning TOOLCHAIN_DOWNGRADE.
      Given revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" pins mise "2026.10.24", and its toolchain bootstrap keeps a newer mise
      When converge rolls back
      Then the report contains "FLEET_MANAGER_ENROLLMENT_REQUIRED"
      And the approved revision of the manager is "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

    Scenario: A revision that pins the mise the manager runs is not refused
      Given revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" pins mise "2026.11.11", and its toolchain bootstrap is from before the rule that keeps a newer mise
      When converge rolls back
      Then the report contains "FLEET_MANAGER_ENROLLMENT_REQUIRED"
      And the approved revision of the manager is "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

    Scenario: The run in the fleet-owned checkout is not asked again
      The run a person or a worker started asked before it left for the
      checkout; the run there is the revision's own code.
      Given revision "cccccccccccccccccccccccccccccccccccccccc" pins mise "2026.10.24", and its toolchain bootstrap is from before the rule that keeps a newer mise
      And the process runs from the fleet-owned checkout of revision "cccccccccccccccccccccccccccccccccccccccc", told "cccccccccccccccccccccccccccccccccccccccc:revision"
      When converge runs for revision "cccccccccccccccccccccccccccccccccccccccc"
      Then the report contains "FLEET_MANAGER_ENROLLMENT_REQUIRED"

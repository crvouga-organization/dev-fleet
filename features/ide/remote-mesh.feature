Feature: Orca and Paradev hold every machine as a remote host
  Orca and Paradev are desktop apps a person installs. A fleet that names
  one under ides gets every machine registered on every other machine.
  Orca has no command that adds an SSH target, so a missing one is a warning
  that names Settings → SSH. Paradev sets a machine up over SSH with
  `paradev hosts add`, which repairs a later run. Nothing here fails a sync.

  Background:
    Given the remote mesh has a manager "manager-mac" and workers "worker-one" and "worker-two"

  Rule: Orca measures the hosts it can already reach

    Scenario: A worker already listed is kept
      Given orca on the manager lists these hosts:
        | name       | kind | selector        |
        | worker-one | ssh  | worker-one      |
        | worker-two | ssh  | worker-two      |
      When the orca mesh is applied
      Then the check "orca:app" passes
      And the checks contain "holds worker-one"
      And no command with the word "setup" was run

    Scenario: A worker Orca does not list is added in Settings
      Given orca on the manager lists these hosts:
        | name       | kind | selector   |
        | worker-one | ssh  | worker-one |
      When the orca mesh is applied
      Then the check "orca:host" warns with "ORCA_SSH_TARGET_MISSING"
      And the remedy of the check "orca:host" mentions "Settings → SSH"
      And no command with the word "setup" was run

    Scenario: A preview plans the host and adds nothing
      Given orca on the manager lists no host
      When the orca mesh is previewed
      Then the checks contain "Planned: add worker-one"
      And no command with the word "add" was run

  Rule: Paradev sets every machine up over SSH

    Scenario: A signed-in manager adds each worker by its node id
      Given paradev on the manager is signed in and its host is running
      And paradev on the manager lists no host
      When the paradev mesh is applied
      Then the check "paradev:app" passes
      And the checks contain "holds worker-one"
      And the checks contain "holds worker-two"
      And a command contains "hosts add worker-one --name worker-one --yes"

    Scenario: A manager that is not signed in adds no host
      Given paradev on the manager is not signed in
      When the paradev mesh is applied
      Then the check "paradev:app" warns with "PARADEV_NOT_SIGNED_IN"
      And no command with the word "add" was run

    Scenario: A host Paradev already lists online is left as it is
      Given paradev on the manager is signed in and its host is running
      And paradev on the manager lists these hosts:
        | name       | online |
        | worker-one | yes    |
        | worker-two | yes    |
      When the paradev mesh is applied
      Then the checks contain "holds worker-one"
      And no command with the word "add" was run

    Scenario: What hosts add prints never reaches a check
      Given paradev on the manager is signed in and its host is running
      And paradev on the manager lists no host
      And paradev hosts add prints "sk_live_secretvalue"
      When the paradev mesh is applied
      Then the checks do not contain "sk_live_secretvalue"

Feature: The policy a worker's T3 has loaded is measured, never assumed
  fleet-sync stages the managed policy, and a playbook restarts a running T3
  that has not loaded it, but only while it runs no agent turn: a busy T3
  keeps its turns and the restart is recorded as pending, for the recovery
  watchdog to apply at the first idle check, or at its deadline when the
  worker is never idle. Afterwards T3 itself is asked,
  with "t3 policy show", and only its own word that it loaded this policy
  counts.

  Rule: The running T3 is asked, a bounded number of times, and nothing is changed

    Scenario: A T3 that is still starting is asked again until it has loaded the policy
      A newly started T3 can be active before it loads its policy. Asking
      again restarts nothing and changes no state.
      Given the command "/pinned/t3 policy show" answers in turn:
        | prints Not yet loaded.            |
        | prints Not yet loaded.            |
        | prints Server loaded this policy. |
      When the policy loaded by the T3 at "/pinned/t3" is measured
      Then the check passes
      And the measurement paused 2 times
      And every command that ran was "/pinned/t3 policy show"
      And every command was given 5000 ms

    Scenario: Asking stops after six tries, and missing evidence is never promoted
      Given every command times out, printing "PRIVATE_SENTINEL" on both streams
      When the policy loaded by the T3 at "/pinned/t3" is measured
      Then 6 commands ran
      And the check fails
      And the checks do not contain "PRIVATE_SENTINEL"

    Scenario: A T3 still running the previous policy is not reported as running the staged one
      Given these commands answer:
        | command                 | answer                                                                              |
        | /managed/t3 policy show | prints Server loaded the old policy. Restart T3 Code to apply the installed policy. |
      When the policy loaded by the T3 at "/managed/t3" is measured
      Then the check fails with "T3_POLICY_RESTART_PENDING"

    Scenario: T3's own word that it loaded this policy is what passes
      Given these commands answer:
        | command                 | answer                              |
        | /managed/t3 policy show | prints Server loaded this policy.\n |
      When the policy loaded by the T3 at "/managed/t3" is measured
      Then the check passes

  Rule: The play restarts T3; afterwards the outcome is measured

    Scenario: A T3 the play restarted is reported as restarted
      That summary tells the manager to wait for its link to T3 to reconnect.
      Given these commands answer:
        | command                 | answer                                        |
        | /managed/t3 policy show | prints The running server loaded this policy. |
      When the policy loaded by the T3 at "/managed/t3" is measured after a play that restarted it
      Then the check passes
      And the summary of the check is "T3 was restarted to load the new managed policy; the running server confirms it."
      And that summary is the one the manager takes as a restart

    Scenario: A T3 the play left running is not reported as restarted
      Given these commands answer:
        | command                 | answer                                        |
        | /managed/t3 policy show | prints The running server loaded this policy. |
      When the policy loaded by the T3 at "/managed/t3" is measured after a play that left it running
      Then the check passes
      But the summary of the check is not the one the manager takes as a restart

    Scenario: A policy still not loaded after the play is a failure, never a wait
      Given these commands answer:
        | command                                        | answer                                                |
        | /managed/t3 policy show                        | prints Restart T3 Code to apply the installed policy. |
        | cat /run/user/1000/personal-t3-restart-pending | fails                                                 |
      When the policy loaded by the T3 at "/managed/t3" is measured after a play that restarted it
      Then the check fails with "T3_POLICY_RESTART_FAILED"
      And no command with the word "start" was run

  Rule: A restart deferred while agent turns run is pending, and says how long it has waited
    The recovery watchdog applies it at the first idle check, and 24 hours
    after it was first deferred at the latest (t3RestartMaxDeferralHours in
    the policy), which ends the turns still running then.

    Background:
      Given these commands answer:
        | command                 | answer                                                |
        | /managed/t3 policy show | prints Restart T3 Code to apply the installed policy. |

    Scenario: A policy change while an agent turn runs leaves the turn running and reports the wait and the deadline
      Given a restart of T3 has been deferred for 2 hours
      When the policy loaded by the T3 at "/managed/t3" is measured after a play that left it running
      Then the check warns
      And the summary of the check is "T3_POLICY_RESTART_PENDING"
      And the remedy of the check contains "The restart has waited 2h 0m for agent turns to end."
      And the remedy of the check contains "at the latest in 22h 0m, 24 hours after it was first deferred: the turns still running then end."
      And no command with the word "start" was run

    Scenario: A restart still pending after its deadline fails
      The watchdog applies it at the deadline; one that waits longer was not
      applied.
      Given a restart of T3 has been deferred for 25 hours
      When the policy loaded by the T3 at "/managed/t3" is measured after a play that left it running
      Then the check fails with "T3_POLICY_RESTART_PENDING"
      And the remedy of the check contains "longer than the 24 hours a restart is deferred at most, and personal-worker-recovery has not applied it."

  Rule: The staged policy keeps linked environments on

    Scenario: A worker's policy turns linked environments on beside the provider instances it locks
      The manager pairs with a replaced worker's T3 without a person, which
      both T3s allow only with linked environments on.
      When the policy for a worker with the provider instance "codex" is composed
      Then the policy sets these settings:
        | setting                   | value              | locked |
        | linkedEnvironmentsEnabled | true               | true   |
        | providerInstances.codex   | {"driver":"codex"} | true   |

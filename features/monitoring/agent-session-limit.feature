@agent-box @slow
Feature: A declared limit on agent sessions refuses the next session of a running T3
  The limit of `features/machines/agent-session-limit.feature`, for real: the
  T3 Code server the fleet pins runs in the user manager of a disposable
  Ubuntu machine, the baseline's own tasks declare the limit there, and
  sessions are started through T3. One provider starts its agents through a
  stand-in for a fleet launcher that asks the launcher's own question; the
  other starts them directly, as a provider added by hand does. Agents only
  wait: this proves what is started and what is refused, not a conversation.

  It lives beside the monitoring agent because the disposable systemd machine
  does. Runs only when HOMELAB_TEST_AGENT_BOX is set, because it downloads
  the pinned T3 server.

  Background:
    Given a disposable Ubuntu 26.04 machine booted with systemd
    And the pinned T3 Code server runs there in the user manager of "ubuntu"
    And the baseline declared a limit of 2 agent sessions there
    And no agent session runs

  Scenario: The worker's own unit holds the kernel's limit on the slice T3 owns, and no other
    Given 1 agent sessions were started through the fleet launcher
    Then the slice T3 owns admits "4" scopes
    And the slice T3 probes scope support in admits "max" scopes
    And the capacity probe reports "agentlimitunit=4"
    And applying the baseline again changes nothing

  Scenario: The session above the limit is refused by the launcher, which says why
    Given 2 agent sessions were started through the fleet launcher
    When another session is started through the fleet launcher
    Then T3 reports that its provider exited with code 75 before it started
    And T3's server log says "AGENT_SESSION_REFUSED: this worker already runs 2 agent sessions and its limit is 2 (agentSessionLimit in the fleet configuration), so this one was not started."
    And 2 agent scopes run

  Scenario: An agent T3 starts with no fleet launcher is refused by the kernel, two scopes higher
    Nothing asks on its behalf, so it is the kernel that refuses, and T3 can
    only say that the provider exited.
    Given 4 agent sessions were started directly
    When another session is started directly
    Then T3 reports that its provider exited with code 1 before it started
    And 4 agents were started directly
    And 4 agent scopes run

  Scenario: Ending a session admits the next one
    Given 2 agent sessions were started through the fleet launcher
    And one of them ended
    When another session is started through the fleet launcher
    Then 2 agent scopes run
    And 3 agents were started through the fleet launcher

  Scenario: Stopping the unit lifts the limit without a sync
    The way back for someone at the worker.
    Given 4 agent sessions were started directly
    When the unit that holds the limit is stopped
    Then the slice T3 owns admits "max" scopes
    And another session started directly runs

  Scenario: A fleet that no longer declares a limit has it lifted and removed
    The way back from the fleet configuration.
    Given 4 agent sessions were started directly
    When the baseline is applied with no limit declared
    Then the slice T3 owns admits "max" scopes
    And the limit's unit and its script are gone
    And another session started directly runs
    And applying the baseline again changes nothing

  Scenario: T3 still finds that scopes work while the worker is at its limit
    T3 asks once, when it starts, and runs every agent outside a scope for
    as long as it runs when the answer is no. Last, because a T3 that
    restarts resumes the sessions it ran, and those count toward the limit
    like any other.
    Given 4 agent sessions were started directly
    Then the command T3 probes scope support with succeeds
    And a T3 that restarts starts its agents in scopes

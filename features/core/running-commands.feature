Feature: A command is run within bounds
  Every command dev-fleet starts has a deadline and a limit on what it may
  print, and how it ended is told apart: it exited, it does not exist, it ran
  out of time, it printed too much or it printed enough to be stopped.

  Scenario: What a command prints is captured
    When this script is run:
      """
      process.stdout.write("ok")
      """
    Then it prints exactly "ok"

  Scenario: A command that does not exist is told apart from one that failed
    When the command "/fleet-definitely-missing-command" is run
    Then it ended for the reason "missing"

  Scenario: A command that outlives its deadline is stopped
    When this script is run with a deadline of 100 milliseconds:
      """
      setInterval(() => {}, 1000)
      """
    Then it did not succeed
    And it ended for the reason "timeout"

  Scenario: A command is stopped as soon as what it printed says enough
    A session that prints why it cannot answer and then retries quietly is
    not left to run into its deadline.
    When this script is run until it prints "429":
      """
      process.stderr.write("level=ERROR 429 Too Many Requests\n"); setInterval(() => {}, 1000)
      """
    Then it did not succeed
    And it ended for the reason "stopped"
    And it printed "429 Too Many Requests" on its error output

  Scenario: A command that prints more than a megabyte is stopped
    When this script is run:
      """
      process.stdout.write("x".repeat(2 * 1024 * 1024))
      """
    Then it did not succeed
    And it ended for the reason "overflow"
    And at most 1048576 characters of what it printed are kept

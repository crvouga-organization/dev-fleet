Feature: One operation at a time on a machine
  A remote operation takes a lock before it changes anything, so two syncs
  never run on one machine at once. The lock belongs to the shell's open file
  descriptor 9 and lasts until whatever holds that descriptor has exited.

  Scenario: The lock is taken with flock where there is one, and through Python where there is not
    Linux has flock(1); macOS does not, so the same descriptor is locked
    through Python's fcntl.
    When the lock prelude of a remote operation is written
    Then it contains "flock -w 5 9"
    And it contains "signal.alarm(5); fcntl.flock(9, fcntl.LOCK_EX)"
    And a POSIX shell parses it

  Scenario: The bootstrap of a worker waits for the lock as long as every other operation
    Then the script "bootstrap/fleet-remote-bootstrap.sh" contains "flock -w 5 9 || die FLEET_REMOTE_LOCKED"

  @linux
  Scenario: An operation that starts while a manager looks at the lock still takes it
    Whether the lock is held can only be tested by taking it, so a manager
    that follows an operation holds the lock for an instant at every look. A
    run that starts in that instant is not refused a machine nobody holds.
    Given a look at the operation lock that takes 1 second
    When a remote operation starts
    Then it holds the operation lock

  @linux
  Scenario: Of two operations that start together, the first holds the lock and the second is refused after 5 seconds
    The second waits out a look, not an operation. It is refused once the
    first has had time to record itself, so a run of the same revision finds
    an operation to follow.
    Given another operation that holds the operation lock
    When a remote operation starts
    Then it is refused the operation lock after at least 5 seconds

  Scenario Outline: <script> parses on the shell of this machine
    These scripts are sent to a machine before any toolchain is there.
    Then a POSIX shell parses the script "<script>"

    Examples:
      | script                              |
      | bootstrap/fleet-remote-bootstrap.sh |
      | ansible/ubuntu/authorize-sudo.sh    |

  @linux
  Scenario: An installer keeps the lock after the process that started it is killed
    A command started with the lock kept inherits descriptor 9, so a second
    operation cannot begin while an orphaned installer is still running.
    Given a shell that holds the operation lock and starts an installer that runs for 2 seconds with the lock kept
    When the shell is killed while the installer runs
    Then the installer had been started
    And the operation lock cannot be taken
    And the operation lock can be taken once the installer has ended

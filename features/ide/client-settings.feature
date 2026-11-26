Feature: The manager's current desktop preferences reach workers on every full sync

  Scenario: The complete manager document replaces the worker's preferences at the same revision
    Given the manager's T3 client settings file holds:
      """
      {"settings": {"notificationMode":"notifications-and-sound", "snapShotSound":"camera-shutter", "wordWrap":false}}
      """
    And the worker's T3 client settings file holds:
      """
      {"notificationMode":"off","voiceShortcutMode":"auto"}
      """
    When the manager's preferences are captured and installed on the worker
    Then the worker's client preferences are:
      """
      {"notificationMode":"notifications-and-sound","snapShotSound":"camera-shutter","wordWrap":false}
      """
    And the fleet state holds the same client preferences

  Scenario: A replacement manager recovers the last snapshot
    Given the fleet state holds these client preferences:
      """
      {"snapShotPlaySound":false}
      """
    When the manager's preferences are captured and installed on the worker
    Then the manager's client preferences are:
      """
      {"snapShotPlaySound":false}
      """
    And the worker's client preferences are:
      """
      {"snapShotPlaySound":false}
      """

  Scenario: A malformed manager file preserves the previous snapshot and worker
    Given the manager's T3 client settings file holds:
      """
      {"settings":[]}
      """
    And the fleet state holds these client preferences:
      """
      {"wordWrap":false}
      """
    And the worker's T3 client settings file holds:
      """
      {"snapShotSound":"soft-pop"}
      """
    When the manager's preferences are captured and installed on the worker
    Then the snapshot is refused
    And the worker's client preferences are:
      """
      {"snapShotSound":"soft-pop"}
      """
    And the saved client preferences are:
      """
      {"wordWrap":false}
      """

Feature: Full sync reproduces T3 customizations at the same revision

  Scenario: A worker and a replacement manager receive keybindings, migration history and published themes
    Given the manager has these T3 customization files:
      | file                  | content                                                              |
      | keybindings.json      | [{"key":"cmd+k","command":"thread.new"}]                             |
      | keybindings-migrations | late-default                                                        |
      | themes/twilight.json  | {"name":"Twilight","appearance":"dark","colors":{"accent":"#dd9988"}} |
      | themes/twilight.png   | example-image                                                       |
    And the native theme reader lists "twilight"
    When the manager syncs its customizations twice and a replacement manager recovers them
    Then the worker and replacement manager have the original customizations
    And the second sync makes no customization writes

  Scenario: Removing a customization on an initialized manager removes it on the worker
    Given the manager has these T3 customization files:
      | file                   | content |
      | keybindings.json       | []      |
      | keybindings-migrations | applied |
    And the manager has already synced those customizations
    When the manager removes "keybindings.json" and syncs again
    Then the worker lacks "keybindings.json"
    And the worker file "keybindings-migrations" contains "applied"

  Scenario: T3 refuses a theme before it can replace the saved snapshot
    Given the manager has these T3 customization files:
      | file             | content |
      | keybindings.json | []      |
    And the manager has already synced those customizations
    And the manager has these T3 customization files:
      | file             | content |
      | themes/dusk.json | {}      |
    And the native theme reader lists "none"
    When the manager tries to sync its customizations
    Then the snapshot is refused
    And the saved customization snapshot still matches the worker

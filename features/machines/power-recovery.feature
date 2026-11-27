Feature: A physical worker is configured to power on after a power loss
  ansible/ubuntu/tasks/power.yml sets the one recognized restore-after-AC-loss
  setting the firmware exposes, to a value that setting offers. The names and
  the values are powerLossRecovery in ansible/ubuntu/policy.json, which the
  check reads too. A virtual machine has no such firmware and is left alone.
  The play writes the setting and never reboots: the firmware applies it at
  the next boot.

  Scenario: The power tasks set only the recognized setting, and only on a physical machine
    When the power tasks are read
    Then the firmware is read only when the machine is physical
    And the setting written is one powerLossRecovery names, at a value it names
    And the write is skipped when no recognized setting offers such a value
    And the write asks fwupd not to reboot

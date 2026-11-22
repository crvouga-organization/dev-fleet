Feature: A worker's memory and disk guards are measured where they run
  What is measured is the running system, not the files Ansible wrote:
  systemd-oomd, the disk guard and the disk GC timer are running, user
  workloads are capped below physical memory, T3 agents have a limit each, swap is active, free disk is
  above the guard's floor and /tmp can be written to. The floor is 3% of the
  filesystem, never under 1024 MiB or over 3072 MiB (`sizing` in the Ubuntu
  policy).

  Background:
    Given these commands answer:
      | command                                                          | answer                                                                 |
      | systemctl is-active personal-fleet-pressure-guard.service        | prints active\n                                                        |
      | systemctl is-active systemd-oomd.service                         | prints active\n                                                        |
      | systemctl is-active personal-fleet-disk-guard.service            | prints active\n                                                        |
      | systemctl is-active personal-fleet-disk-gc.timer                 | prints active\n                                                        |
      | systemctl is-enabled personal-fleet-disk-gc.timer | prints enabled |
      | busctl get-property … LastTriggerUSec | prints t 100000000000 |
      | date +%s | prints 100900 |
      | systemctl show personal-fleet-disk-gc.service --property=Result --value | prints success |
      | cat /proc/uptime | prints 30000.0 5000.0 |
      | systemctl show --property=MemoryMax -- user.slice                | prints MemoryMax=29720510464\n                                         |
      | systemctl show --property=ManagedOOMSwap -- -.slice              | prints ManagedOOMSwap=kill\n                                           |
      | test -f /etc/systemd/user/t3code-.scope.d/60-personal-fleet.conf | succeeds                                                               |
      | systemctl --user show app-t3code-agents.slice …                    | prints LoadState=loaded\nMemoryHigh=5153751040\nMemoryMax=6012534784\nMemorySwapMax=4294967296\nTasksMax=3000\nCPUWeight=50\nIOWeight=50 |
      | cat /proc/meminfo                                                | prints MemTotal: 8388608 kB |
      | cat /proc/swaps                                                  | prints Filename Type Size Used Priority\n/dev/zram0 partition 2097152 0 100\n/swap.img file 8388604 0 -2\n |
      | cat /proc/sys/vm/swappiness /proc/sys/vm/page-cluster | prints 180\n0 |
      | df --output=avail,size -B1 /                                     | prints Avail Size\n107374182400 536870912000\n                         |
      | df --output=avail,size -B1 /home/fixture                         | prints Avail Size\n107374182400 536870912000\n                         |
      | sh -c …mktemp /tmp/personal-fleet-probe.XXXXXX…                  | succeeds                                                               |

  Scenario: A guarded worker with headroom passes
    When the resource safety of the worker whose home is "/home/fixture" is measured
    Then the check passes

  Scenario Outline: <what is wrong> fails the worker
    Free space under the floor fails even when every guard runs: the disk GC
    has already removed idle build output and caches, so what is left is work
    a person must decide about. An exhausted /tmp quota fails even when the filesystem reports free
    space: /tmp is held in memory with a quota for each user, which only a real
    write of 1 MiB shows.
    Given the command "<command>" <answer>
    When the resource safety of the worker whose home is "/home/fixture" is measured
    Then the summary of the check is "<summary>"

    Examples:
      | what is wrong              | command                                               | answer                                    | summary                 |
      | A missing agent slice | systemctl --user show app-t3code-agents.slice … | prints LoadState=not-found | AGENT_SLICE_MISSING |
      | An overridden agent cap | systemctl --user show app-t3code-agents.slice … | prints LoadState=loaded\nMemoryMax=infinity | AGENT_LIMIT_OVERRIDDEN |
      | A disk GC that stopped running | date +%s | prints 200000 | DISK_GC_RUN_STALE |
      | A disabled disk GC timer | systemctl is-enabled personal-fleet-disk-gc.timer | prints disabled | DISK_GC_TIMER_MISSING |
      | A stopped disk guard       | systemctl is-active personal-fleet-disk-guard.service | fails printing failed\n                   | DISK_GUARD_INACTIVE |
      | A stopped disk GC timer    | systemctl is-active personal-fleet-disk-gc.timer      | fails printing inactive\n                 | DISK_GC_TIMER_MISSING |
      | Uncapped user memory       | systemctl show --property=MemoryMax -- user.slice     | prints MemoryMax=infinity\n               | MEMORY_RESERVE_MISSING  |
      | Disk swap without zram | cat /proc/swaps | prints Filename Type Size Used Priority\n/swap.img file 8388604 0 -2 | ZRAM_PRIORITY_MISMATCH |
      | Wrong reclaim tuning | cat /proc/sys/vm/swappiness /proc/sys/vm/page-cluster | prints 60\n3 | ZRAM_RECLAIM_MISMATCH |
      | No swap                    | cat /proc/swaps                                       | prints Filename Type Size Used Priority\n | SWAP_MISSING            |
      | Free space under the floor | df --output=avail,size -B1 …                          | prints Avail Size\n2147483648 536870912000\n | DISK_FREE_BELOW_FLOOR |
      | An exhausted /tmp quota    | sh -c …mktemp /tmp/personal-fleet-probe.XXXXXX…       | fails                                     | TMP_QUOTA_EXHAUSTED     |

  Scenario Outline: On a <disk> disk the floor is <floor> MiB, so <free> MiB free <verdict>
    Given the command "df --output=avail,size -B1 …" prints Avail Size\n<free bytes> <size bytes>\n
    When the resource safety of the worker whose home is "/home/fixture" is measured
    Then the check <verdict>

    Examples:
      | disk    | floor | free | free bytes | size bytes   | verdict |
      | 40 GiB  | 1228  | 1536 | 1610612736 | 42949672960  | passes  |
      | 40 GiB  | 1228  | 1024 | 1073741824 | 42949672960  | fails   |
      | 500 GiB | 3072  | 2048 | 2147483648 | 536870912000 | fails   |

  Scenario Outline: The listener's actual cgroup provides its reserve
    Given these commands answer:
      | command                                    | answer                       |
      | ss -Hltnp sport = 3773                     | prints users:(("t3",pid=42)) |
      | cat /proc/42/cgroup                        | prints 0::/app.scope         |
      | cat /sys/fs/cgroup/app.scope/cpu.weight    | prints <cpu>                 |
      | cat /sys/fs/cgroup/app.scope/io.weight     | prints default 1000          |
      | cat /sys/fs/cgroup/app.scope/memory.low    | prints 1610612736            |
    When the protection of the T3 listener on port 3773 is measured
    Then the check <verdict>

    Examples:
      | cpu  | verdict |
      | 1000 | passes  |
      | 100  | fails   |

  Scenario: An unprotected listener is repaired by fleet-sync without restarting T3
    A drop-in fleet-sync writes for the unit T3 serves from reaches the
    running unit when the user manager is reloaded, so the remedy does not
    wait for T3 to restart.
    Given these commands answer:
      | command                                    | answer                       |
      | ss -Hltnp sport = 3773                     | prints users:(("t3",pid=42)) |
      | cat /proc/42/cgroup                        | prints 0::/app.scope         |
      | cat /sys/fs/cgroup/app.scope/cpu.weight    | prints 100                   |
      | cat /sys/fs/cgroup/app.scope/io.weight     | prints default 100           |
      | cat /sys/fs/cgroup/app.scope/memory.low    | prints 0                     |
    When the protection of the T3 listener on port 3773 is measured
    Then the check fails
    And the summary of the check is "T3_PROTECTION_ESCAPED cpu io memory"
    And the remedy of the check contains "applies it to the running T3 without a restart"
    And the remedy of the check does not contain "--maintenance-reboot"

  Rule: An io reserve that waits for the user manager says so
    Ubuntu hands the user manager cpu, memory and pids only. It takes the io
    controller fleet-sync declares when it next starts, which in practice is
    the worker's next reboot: until then the listener's cgroup has no
    io.weight, although T3 never left its unit and has its CPU and memory
    reserve. Restarting T3 does not change that.

    Background:
      Given the T3 listener on port 3773 runs in "app.slice/app-com.t3tools.T3Code-41.scope" under the user manager of user 1000, where:
        | file       | answer            |
        | cpu.weight | prints 1000       |
        | io.weight  | fails             |
        | memory.low | prints 1610612736 |

    Scenario: A user manager without the io controller names the reserve it lacks and asks for a reboot
      Given reading the controllers of the user manager of user 1000 prints cpu memory pids
      When the protection of the T3 listener on port 3773 is measured
      Then the check fails
      And the summary of the check is "T3_PROTECTION_ESCAPED io"
      And the remedy of the check contains "--maintenance-reboot"
      And the remedy of the check contains "Restarting T3 does not change it"

    Scenario: A user manager whose controllers cannot be read is taken to lack it
      Given reading the controllers of the user manager of user 1000 fails
      When the protection of the T3 listener on port 3773 is measured
      Then the summary of the check is "T3_PROTECTION_ESCAPED io"
      And the remedy of the check contains "--maintenance-reboot"

    Scenario: With the io controller in the user manager, a missing io reserve is for fleet-sync to declare
      A reboot would change nothing: the user manager has the controller and
      the unit T3 serves from was not given its weight.
      Given reading the controllers of the user manager of user 1000 prints cpu io memory pids
      When the protection of the T3 listener on port 3773 is measured
      Then the check fails
      And the summary of the check is "T3_PROTECTION_ESCAPED io"
      And the remedy of the check contains "Run devfleet fleet-sync on this worker"
      And the remedy of the check does not contain "--maintenance-reboot"

  Rule: A listener that is not there has no reserve to measure
    While T3 is stopped or restarting nothing listens on its port. That is
    not a listener that left its unit, and it is not reported as one.

    Scenario Outline: <what happens> leaves the protection unobserved
      Given the command "ss -Hltnp sport = 3773" <answer>
      And the command "cat /proc/42/cgroup" fails
      When the protection of the T3 listener on port 3773 is measured
      Then the check fails
      And the summary of the check is "T3_PROTECTION_UNOBSERVED"
      And the remedy of the check contains "T3 is stopped or restarting"

      Examples:
        | what happens                              | answer                       |
        | Nothing listening on the T3 port          | succeeds                     |
        | Sockets that cannot be listed             | fails                        |
        | A listener that ends while it is measured | prints users:(("t3",pid=42)) |

  Scenario Outline: The desktop renderer subgroup warns above its memory budget
    Given these commands answer:
      | command                                                 | answer |
      | systemctl --user show t3code-desktop.service --property=ControlGroup --value | prints /app.slice/t3code-desktop.service |
      | cat /sys/fs/cgroup/app.slice/t3code-desktop.service/renderers/memory.current | prints <used> |
      | cat /sys/fs/cgroup/app.slice/t3code-desktop.service/renderers/memory.high | prints 6442450944 |
      | cat /sys/fs/cgroup/app.slice/t3code-desktop.service/renderers/memory.max | prints 8589934592 |
    When the desktop renderer budget is measured
    Then the check <verdict>

    Examples:
      | used       | verdict |
      | 4000000000 | passes  |
      | 7000000000 | warns   |

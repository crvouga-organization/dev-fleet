Feature: A worker's disk and memory lines scale with the machine
  Every line of the worker policy is a share of the root filesystem or of
  memory, between a lower and an upper bound, declared once under `sizing`
  in the Ubuntu policy: the swap file, the free disk the baseline keeps, the
  disk guard's floor, the line under which the disk GC works under pressure,
  and the lines under which worker:capacity warns and fails. A small rented
  instance gets lines it can meet; large disks retain enough free space for builds before warning or cleanup.

  Rule: The lines are shares between bounds

    Scenario: A small rented instance gets lines it can meet
      Then on a machine with 8 GiB of memory and a 40 GiB disk the lines are, in MiB:
        | line            | MiB  |
        | swapFile        | 4096 |
        | minimumFreeDisk | 2048 |
        | diskGuardFloor  | 1228 |
        | diskGcPressure  | 8192 |
        | capacityWarn    | 6144 |
        | capacityFail    | 1024 |

    Scenario: A large workstation reserves space before builds fill its disk
      Then on a machine with 64 GiB of memory and a 500 GiB disk the lines are, in MiB:
        | line            | MiB   |
        | swapFile        | 8192  |
        | minimumFreeDisk | 4096  |
        | diskGuardFloor  | 3072  |
        | diskGcPressure  | 102400 |
        | capacityWarn    | 76800 |
        | capacityFail    | 2048  |

    Scenario: A nearly one terabyte disk warns before it is full
      Then on a machine with 64 GiB of memory and a 937 GiB disk the lines are, in MiB:
        | line           | MiB    |
        | diskGcPressure | 191897 |
        | capacityWarn   | 143923 |

    Scenario Outline: No line leaves its bounds on a <disk> GiB disk
      Then no line is above its declared upper bound on a <disk> GiB disk

      Examples:
        | disk |
        | 20   |
        | 500  |
        | 4000 |

  Rule: worker:capacity warns and fails at the lines of its own disk

    Scenario Outline: <free> MiB free on a <disk> GiB disk <verdict>
      When a disk of <disk> GiB has <free> MiB free
      Then the check "worker:capacity:disk" <verdict>

      Examples:
        | disk | free  | verdict |
        | 40   | 7000  | passes  |
        | 40   | 3500  | warns   |
        | 40   | 900   | fails   |
        | 500  | 9000  | warns   |
        | 500  | 80000 | passes  |

  Rule: fleet-status says how many agent sessions the memory policy supports, and how many run

    The memory user workloads may use (90%), less what T3 keeps for itself
    (1536 MiB), in sessions of 512 MiB plus a 4096 MiB build. The size of a
    session is an estimate that budgets a build for every session at once, so
    it decides the warning only where nothing was measured. Where the kernel
    kept the peak of each running agent, the check warns when those peaks,
    added up, are more than the memory the policy leaves agents. The number
    is a recommendation: T3 Code has no limit on the sessions it starts, so
    nothing refuses the next one, and the check says so instead of implying
    a limit.

    What runs is read from the scopes T3 Code starts its agents in. A terminal
    a person opened and a preview browser get such a scope too and are no
    agent, so the capacity probe leaves them out. Codex and OpenCode serve all
    their sessions from one process, so the check counts that process and
    says so, and names no number of sessions for it.

    Scenario Outline: A worker with <memory> MiB running <running> sessions <verdict>
      When a worker with <memory> MiB of memory runs <running> agent sessions
      Then the check "worker:agent-sessions" <verdict>
      And the summary of the check "worker:agent-sessions" mentions "<summary>"

      Examples:
        | memory | running | verdict | summary                                                                                                |
        | 8192   | 1       | passes  | 1 agent sessions running; the memory policy supports 1 at once on 8192 MiB (an estimated 4608 MiB each). |
        | 16384  | 2       | passes  | the memory policy supports 2 at once                                                                  |
        | 8192   | 6       | warns   | AGENTS_OVER_CAPACITY: 6 agent sessions running                                             |

    Scenario: More sessions than supported says that nothing refuses the next one
      When a worker with 60416 MiB of memory runs 12 agent sessions
      Then the check "worker:agent-sessions" warns
      And the summary of the check "worker:agent-sessions" mentions "AGENTS_OVER_CAPACITY: 12 agent sessions running; the memory policy supports 11 at once on 60416 MiB (an estimated 4608 MiB each). Nothing refuses a session above that number."
      And the remedy of the check "worker:agent-sessions" mentions "a recommendation, not an admission limit: T3 Code has no limit on the sessions it starts"

    Scenario: The estimate is held against the agents running now
      The estimate cannot be right for every worker, so the check says what
      the running agents took at their peak, how far the estimate is from
      their median and how many sessions the worker would support at it.
      When a worker with 60416 MiB of memory and no declared limit measures:
        | agentsessions     | 12   |
        | agentshared       | 0    |
        | agentpeaks        | 11   |
        | agentpeakmedianmb | 795  |
        | agentpeakmaxmb    | 9422 |
      Then the check "worker:agent-sessions" warns
      And the summary of the check "worker:agent-sessions" mentions "Measured: the 11 running now peaked at a median of 795 MiB and at most 9422 MiB each; the estimate is 3813 MiB above that median, at which this worker would support 66."

    Scenario: A measured median above the estimate is reported the same way
      When a worker with 16384 MiB of memory and no declared limit measures:
        | agentsessions     | 2    |
        | agentshared       | 0    |
        | agentpeaks        | 2    |
        | agentpeakmedianmb | 6000 |
        | agentpeakmaxmb    | 7000 |
      Then the check "worker:agent-sessions" passes
      And the summary of the check "worker:agent-sessions" mentions "the estimate is 1392 MiB below that median, at which this worker would support 2."

    Scenario: More sessions than the estimate supports do not warn while what they took fits
      Twelve sessions on a worker the estimate gives eleven: they took 9540
      MiB between them at their peaks, of the 52838 MiB agents may use.
      When a worker with 60416 MiB of memory and no declared limit measures:
        | agentsessions     | 12   |
        | agentshared       | 0    |
        | agentpeaks        | 12   |
        | agentpeakmedianmb | 795  |
        | agentpeakmaxmb    | 1200 |
        | agentpeaksummb    | 9540 |
      Then the check "worker:agent-sessions" passes
      And the summary of the check "worker:agent-sessions" mentions "12 agent sessions running; the memory policy supports 11 at once on 60416 MiB (an estimated 4608 MiB each). Measured: the 12 running now peaked at a median of 795 MiB and at most 1200 MiB each, 9540 MiB added up, of the 52838 MiB the memory policy leaves agents;"
      And the summary of the check "worker:agent-sessions" mentions "More run than the estimate supports, and that does not warn: what they took fits."
      And the summary of the check "worker:agent-sessions" does not mention "AGENTS_OVER_CAPACITY"

    Scenario: Fewer sessions than the estimate supports warn once what they took does not fit
      Three sessions on a worker the estimate gives eleven, each with a
      large build: the estimate would have passed them.
      When a worker with 60416 MiB of memory and no declared limit measures:
        | agentsessions     | 3     |
        | agentshared       | 0     |
        | agentpeaks        | 3     |
        | agentpeakmedianmb | 18000 |
        | agentpeakmaxmb    | 19000 |
        | agentpeaksummb    | 54000 |
      Then the check "worker:agent-sessions" warns
      And the summary of the check "worker:agent-sessions" mentions "AGENT_PEAK_PROJECTION: 3 agent sessions running; the memory policy supports 11 at once on 60416 MiB (an estimated 4608 MiB each). Nothing refuses a session above that number. Measured: the 3 running now peaked at a median of 18000 MiB and at most 19000 MiB each, 54000 MiB added up, of the 52838 MiB the memory policy leaves agents;"
      And the remedy of the check "worker:agent-sessions" mentions "Inspect the aggregate memory peak"

    Scenario Outline: The aggregate peak decides whether simultaneous memory use exceeded the budget
      When a worker with 60416 MiB of memory and no declared limit measures:
        | agentsessions   | 3       |
        | agentpeaksummb  | 61253   |
        | agentsreachedmb | <peak>  |
      Then the check "worker:agent-sessions" <result>

      Examples:
        | peak  | result |
        | 33353 | passes |
        | 55000 | warns  |

    Scenario: What they took exactly fits
      When a worker with 60416 MiB of memory and no declared limit measures:
        | agentsessions     | 2     |
        | agentshared       | 0     |
        | agentpeaks        | 2     |
        | agentpeakmedianmb | 26419 |
        | agentpeakmaxmb    | 26419 |
        | agentpeaksummb    | 52838 |
      Then the check "worker:agent-sessions" passes

    Scenario: The check says what everything T3 Code started took at one moment, ended sessions among it
      The kernel keeps that for the slice, so it is the one number that
      holds the sessions that ended.
      When a worker with 60416 MiB of memory and no declared limit measures:
        | agentsessions     | 2     |
        | agentshared       | 0     |
        | agentpeaks        | 2     |
        | agentpeakmedianmb | 185   |
        | agentpeakmaxmb    | 2030  |
        | agentpeaksummb    | 2215  |
        | agentsreachedmb   | 15253 |
      Then the check "worker:agent-sessions" passes
      And the summary of the check "worker:agent-sessions" mentions "Everything T3 Code started on this worker, sessions that ended among it, took at most 15253 MiB at one moment."

    Scenario: A worker that runs no agent has nothing to hold the estimate against
      When a worker with 16384 MiB of memory and no declared limit measures:
        | agentsessions | 0 |
        | agentshared   | 0 |
      Then the check "worker:agent-sessions" passes
      And the summary of the check "worker:agent-sessions" does not mention "Measured"

    Scenario: The capacity probe of a worker reports its sessions
      Given every command prints:
        """
        ncpu=2
        load=0.2
        memfree=60
        memtotalmb=8192
        agentsessions=1
        agentshared=0
        swap=0
        diskmb=30000
        disktotalmb=40960
        """
      When the capacity of the worker is checked
      Then the check "worker:agent-sessions" passes
      And the summary of the check "worker:agent-sessions" mentions "1 agent sessions running; the memory policy supports 1 at once"
      And the check "worker:capacity:disk" passes

    Scenario: A process Codex or OpenCode shares is counted as that, not as one session
      Nothing on the worker says how many sessions such a process serves.
      When a worker with 60416 MiB of memory and no declared limit measures:
        | agentsessions | 6 |
        | agentshared   | 2 |
      Then the check "worker:agent-sessions" passes
      And the summary of the check "worker:agent-sessions" mentions "6 agent processes running: 4 agent sessions, and 2 that Codex or OpenCode serves all its sessions from, however many those are; the memory policy supports 11 at once on 60416 MiB"

    Scenario: More processes than supported warns, and still names the shared ones
      When a worker with 8192 MiB of memory and no declared limit measures:
        | agentsessions | 3 |
        | agentshared   | 1 |
      Then the check "worker:agent-sessions" warns
      And the summary of the check "worker:agent-sessions" mentions "AGENTS_OVER_CAPACITY: 3 agent processes running: 2 agent sessions, and 1 that Codex or OpenCode serves all its sessions from"

    Scenario: A count from an older capacity probe says what it holds
      While a revision rolls out, a reader can meet a probe from before
      terminals and preview browsers were left out. It prints no
      "agentshared", and its count is reported as what it is.
      Given every command prints:
        """
        ncpu=2
        load=0.2
        memfree=60
        memtotalmb=60416
        agentsessions=7
        agentscopes=6
        swap=0
        diskmb=30000
        disktotalmb=40960
        """
      When the capacity of the worker is checked
      Then the check "worker:agent-sessions" passes
      And the summary of the check "worker:agent-sessions" mentions "7 agent sessions running, as counted by an older capacity probe: each open terminal and preview browser is among them, and all the sessions of Codex or of OpenCode are one; the memory policy supports 11 at once"

    @linux
    Scenario: The capacity probe counts agents, and leaves terminals and preview browsers out
      T3 Code starts a terminal, and the service OpenCode's sessions share,
      beside the slice it owns, and everything else inside it. An older
      reader takes "agentsessions" as it always did and ignores the rest.
      Given T3 Code runs these scopes on a worker:
        | slice  | scope                                  | peak MiB |
        | beside | t3code-terminal-9784d547.scope         | 40       |
        | beside | t3code-opencode-service-0c1d2e3f.scope | 300      |
        | owned  | t3code-claude-643bed65.scope           | 700      |
        | owned  | t3code-claude-bc65c965.scope           | 900      |
        | owned  | t3code-pi-9a6350f2.scope               | 500      |
        | owned  | t3code-codex-1b2c3d4e.scope            | 1200     |
        | owned  | t3code-preview-browser-5f6a7b8c.scope  | 9000     |
      And everything T3 Code started there took at most 11800 MiB at one moment
      When the capacity probe reads that worker
      Then the capacity probe prints these lines:
        | agentsessions=5       |
        | agentshared=2         |
        | agentscopes=5         |
        | agentpeaks=5          |
        | agentpeakmedianmb=700 |
        | agentpeakmaxmb=1200   |
        | agentpeaksummb=3600   |
        | agentsreachedmb=11800 |

    @linux
    Scenario: A worker where T3 Code has started nothing runs no agent
      Given T3 Code runs no scope on a worker
      When the capacity probe reads that worker
      Then the capacity probe prints these lines:
        | agentsessions=0 |
        | agentshared=0   |

  Rule: A declared limit on agent sessions is measured, and one the worker does not hold fails

    `agentSessionLimit` in the fleet configuration is opt-in. A unit of the
    worker's user manager holds the kernel's limit on the slice T3 starts
    agents in, 2 scopes above the declared limit, so that a fleet launcher
    refuses first and can say why. The check reads the number that unit runs
    with and the one the kernel holds.

    Scenario: A worker under its declared limit says what refuses the next session
      When a worker with 60416 MiB of memory and a declared limit of 16 agent sessions measures:
        | agentsessions  | 12 |
        | agentshared    | 0  |
        | agentscopes    | 11 |
        | agentlimitunit | 18 |
        | agentlimitheld | 18 |
      Then the check "worker:agent-sessions" warns
      And the summary of the check "worker:agent-sessions" mentions "AGENTS_OVER_CAPACITY: 12 agent sessions running; the memory policy supports 11 at once on 60416 MiB (an estimated 4608 MiB each). The worker refuses a session above its declared limit of 16; 11 count toward it."
      And the summary of the check "worker:agent-sessions" does not mention "Nothing refuses"
      And the remedy of the check "worker:agent-sessions" mentions "the declared limit of 16 admits them"

    Scenario: A worker at its declared limit says how a refusal looks in T3
      When a worker with 60416 MiB of memory and a declared limit of 4 agent sessions measures:
        | agentsessions  | 4 |
        | agentshared    | 0 |
        | agentscopes    | 4 |
        | agentlimitunit | 6 |
        | agentlimitheld | 6 |
      Then the check "worker:agent-sessions" passes
      And the summary of the check "worker:agent-sessions" mentions "It is at that limit: the next session is refused, which T3 shows as a provider that exited before it started."

    Scenario: A worker that runs no agent holds the limit in its unit alone
      The slice T3 owns exists only while an agent runs, so there is nothing
      for the kernel to hold yet.
      When a worker with 16384 MiB of memory and a declared limit of 4 agent sessions measures:
        | agentsessions  | 0 |
        | agentshared    | 0 |
        | agentlimitunit | 6 |
      Then the check "worker:agent-sessions" passes
      And the summary of the check "worker:agent-sessions" mentions "The worker refuses a session above its declared limit of 4; 0 count toward it."

    Scenario Outline: A declared limit the worker does not hold fails: <reason>
      When a worker with 16384 MiB of memory and a declared limit of 4 agent sessions measures:
        | agentsessions  | 2        |
        | agentshared    | 0        |
        | agentscopes    | <scopes> |
        | agentlimitunit | <unit>   |
        | agentlimitheld | <held>   |
      Then the check "worker:agent-sessions" fails
      And the summary of the check "worker:agent-sessions" mentions "AGENT_SESSION_LIMIT_INACTIVE: the declared limit of 4 agent sessions is not held on this worker: <reason>."
      And the remedy of the check "worker:agent-sessions" mentions "Run devfleet fleet-sync"

      Examples:
        | scopes | unit | held | reason                                                                    |
        | 2      | 0    |      | its unit is not running                                                   |
        | 2      |      |      | whether its unit runs could not be read                                   |
        | 2      | 10   | 10   | its unit holds 10 scopes, not the 6 that limit needs                      |
        | 2      | 6    | 3    | the kernel holds 3 scopes on the slice T3 starts agents in, not 6         |
        | 2      | 6    |      | the kernel holds no limit on the slice T3 starts agents in                |

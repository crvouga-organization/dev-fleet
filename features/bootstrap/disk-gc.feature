Feature: The disk GC removes only what a node can rebuild
  Every hour each worker and the manager remove ignored build output and
  caches from checkouts nobody has used for a while. It never removes a tracked file, and it leaves
  alone a checkout that was used recently, holds a recent uncommitted edit or
  has a process running in it. These scenarios run the collector on a
  temporary home directory only, never on the machine's own Docker or apt
  cache, and it measures the disk each scenario describes, never the disk of
  the machine the scenario runs on.

  Background:
    Given a home directory with one checkout that ignores:
      | node_modules/ |
      | .cache/       |
    And the checkout holds these files, all committed except the ignored ones:
      | node_modules/pkg/index.js |
      | .cache/scratch/blob       |
      | dist/keep.js              |
      | src/main.ts               |
    And a disk with 102400 MiB and 50% of its inodes free

  Scenario: An idle checkout loses only ignored build output
    "dist" is tracked in this checkout, so it is source, not build output.
    Given the checkout was last used 30 days ago
    When the disk GC runs
    Then these are gone from the checkout:
      | node_modules |
      | .cache       |
    But these are still in the checkout:
      | dist/keep.js |
      | src/main.ts  |

  Scenario: A recently used checkout is left alone
    Given the checkout was last used 1 day ago
    When the disk GC runs
    Then these are still in the checkout:
      | node_modules |

  Scenario: A recent uncommitted edit keeps an otherwise idle checkout
    Given the checkout was last used 30 days ago
    But "src/main.ts" was edited just now and not committed
    When the disk GC runs
    Then these are still in the checkout:
      | node_modules |

  Scenario: A checkout a process is running in is left alone
    Given the checkout was last used 30 days ago
    But a process is running in "src" of the checkout
    When the disk GC runs
    Then these are still in the checkout:
      | node_modules |

  Scenario: A dry run reports without deleting
    Given the checkout was last used 30 days ago
    When the disk GC runs as a dry run
    Then these are still in the checkout:
      | node_modules |
    And it reports a removal marked as a dry run

  Scenario Outline: A disk that is <disk> makes a checkout idle after <idle>
    A filesystem with free bytes and no free inodes fails every write as
    surely as a full one. Under pressure 12 hours without use is idle;
    otherwise it takes 7 days.
    Given the checkout was last used 1 day ago
    And a disk with <free> MiB and <inodes>% of its inodes free
    When the disk GC runs with these limits:
      | --pressure-mib           | 15360 |
      | --pressure-inode-percent | 5     |
      | --pressure-idle-hours    | 12    |
      | --idle-days              | 7     |
    Then the checkout's "node_modules" is <verdict>
    And these are still in the checkout:
      | src/main.ts |

    Examples:
      | disk                | free   | inodes | idle     | verdict |
      | short of free space | 15359  | 50     | 12 hours | gone    |
      | short of inodes     | 102400 | 4      | 12 hours | gone    |
      | at both its floors  | 15360  | 5      | 7 days   | kept    |
      | nearly empty        | 102400 | 50     | 7 days   | kept    |

  Rule: Stores that only grow are kept under the limits of the Ubuntu policy

    Scenario Outline: An agent worktree last used <days> days ago with <work> is <verdict>
      A worktree goes only when Git can vouch for everything in it: nothing
      uncommitted or untracked, and every commit on a remote. Its branch is
      kept either way.
      Given the checkout has a remote that holds its commits
      And an agent worktree "fix-login" of the checkout under ".t3/worktrees/project" with <work>
      And the worktree was last used <days> days ago
      When the disk GC runs with these limits:
        | --worktree-root      | .t3/worktrees |
        | --worktree-idle-days | 30            |
      Then the worktree is <verdict>

      Examples:
        | days | work                     | verdict |
        | 40   | nothing unsaved          | removed |
        | 10   | nothing unsaved          | kept    |
        | 40   | a commit no remote holds | kept    |
        | 40   | an uncommitted edit      | kept    |
        | 40   | an untracked file        | kept    |
        | 40   | a process running in it  | kept    |

    Scenario: A cache past its cap loses its oldest files until it fits
      Given the cache ".bun/install/cache" holds 6 files of 1 MiB, written an hour apart
      When the disk GC runs with these limits:
        | --cache-cap | .bun/install/cache=3 |
      Then the cache ".bun/install/cache" holds 3 MiB or less
      And the newest file of the cache is still there
      And the run reports at least 3 MiB reclaimed

    Scenario: Only the current and the previous downloaded T3 package are kept
      Given the directory "packages" holds these downloads, oldest first:
        | t3-1.deb |
        | t3-2.deb |
        | t3-3.deb |
        | t3-4.deb |
      When the disk GC runs with these limits:
        | --keep-newest | packages=2 |
      Then the directory "packages" holds exactly:
        | t3-3.deb |
        | t3-4.deb |

    Scenario Outline: A worker with containers and <free> MiB free prunes Docker's <leftovers>
      This is a dry run, so nothing is pruned. Unused anonymous volumes go
      only under pressure.
      Given a disk with <free> MiB and 50% of its inodes free
      When the disk GC dry-runs on the whole machine, with a docker command on its path and a floor of 15360 MiB free
      Then the run would prune these Docker steps: <steps>

      Examples:
        | free   | leftovers                                   | steps                                                       |
        | 102400 | old images and build cache                  | docker_images, docker_build_cache                           |
        | 1024   | images, build cache and anonymous volumes   | docker_images, docker_build_cache, docker_anonymous_volumes |

    Scenario Outline: A worker without containers has no Docker to prune, with <free> MiB free
      A worker whose containers feature is off is given --no-docker.
      Given a disk with <free> MiB and 50% of its inodes free
      When the disk GC dry-runs on the whole machine without containers, with a docker command on its path and a floor of 15360 MiB free
      Then the run would prune these Docker steps: (none)

      Examples:
        | free   |
        | 102400 |
        | 1024   |

    Scenario: Tool versions no configuration uses are pruned by mise
      Given a stand-in for mise that records how it is run
      When the disk GC runs with the stand-in for mise
      Then the stand-in for mise was run with "prune --yes"

    @linux
    Scenario: A worker expires stale host cache files and preserves active and unrelated files
      Given old, open and recent files in the host temporary caches
      When the disk GC runs
      Then the cache child "host-tmp/metro-cache/stale" is removed
      And the cache child "host-tmp/node-compile-cache/open" is kept
      And the cache child "host-tmp/metro-cache/new" is kept
      And the cache child "host-tmp/metro-cache/link" is kept
      And the cache child "host-tmp/other/keep" is kept
      And the cache child "host-tmp/.123abc-1.native" is removed
      And the cache child "host-tmp/.123abc-1.project" is kept
      And the cache child "host-tmp/.123abc-1.manifest-only" is kept

    Scenario: A cache over the total budget loses rebuildable children while exclusions survive
      Given the cache ".cache/rebuildable" holds 3 files of 1 MiB, written an hour apart
      And the cache ".cache/mise" holds 2 files of 1 MiB, written an hour apart
      When the disk GC runs with these limits:
        | --home-cache-mib | 1    |
        | --exclude-cache  | mise |
      Then the cache child ".cache/rebuildable" is removed
      And the cache child ".cache/mise" is kept
      And the run reports at least 3 MiB reclaimed

    Scenario Outline: A package store uses its own pruning command when over budget
      Given a stand-in for mise that records how it is run
      And the cache ".npm/_cacache" holds 3 files of 1 MiB, written an hour apart
      When the disk GC runs with the stand-in for mise and these limits:
        | --home-cache-mib | 32        |
        | --store-cap      | npm=<cap> |
      Then the package store command "npm cache clean --force" <result>

      Examples:
        | cap | result      |
        | 1   | ran         |
        | 8   | was skipped |

    Scenario Outline: A disposable fleet's Docker prune <what>
      storage.disposable in fleet.json makes every node disk a cache: what no
      container uses goes on every run.
      Given a disk with 102400 MiB and 50% of its inodes free
      When the disk GC <how> on the whole machine, with a docker command on its path and a floor of 15360 MiB free
      Then the run would prune <what>

      Examples:
        | how                                | what                                                                       |
        | dry-runs                           | Docker images and build cache older than 168 hours                         |
        | of a disposable fleet dry-runs     | every Docker image and all build cache no container uses, whatever their age |

  Rule: The manager has no /proc, so lsof names the directories processes run in

    Scenario Outline: An idle checkout on the manager, where lsof answers <answer>, <verdict> its build output
      Where processes cannot be listed, nothing a process could be using is
      removed.
      Given the checkout was last used 30 days ago
      And lsof answers <answer>
      When the disk GC runs
      Then the checkout's "node_modules" is <state>

      Examples:
        | answer                                    | verdict | state |
        | with a process in "src" of the checkout   | keeps   | kept  |
        | with processes elsewhere only             | loses   | gone  |
        | with an error                             | keeps   | kept  |

  Rule: A node keeps two dev-fleet checkouts: the current one and the previous one

    Background:
      Given the directory ".local/share/personal/fleet/revisions" holds these dev-fleet checkouts, oldest first:
        | 1111111111111111111111111111111111111111 |
        | 2222222222222222222222222222222222222222 |
        | 3333333333333333333333333333333333333333 |
        | 4444444444444444444444444444444444444444 |

    Scenario: The checkout the current link points at and the most recent other are kept
      T3's providers launch from the checkout fleet/current points at, so it
      stays however old it is.
      Given the link ".local/share/personal/fleet/current" points at the checkout "1111111111111111111111111111111111111111" of ".local/share/personal/fleet/revisions"
      When the disk GC runs with these limits:
        | --keep-checkouts | .local/share/personal/fleet/revisions=2 |
        | --current        | .local/share/personal/fleet/current     |
      Then the directory ".local/share/personal/fleet/revisions" holds exactly:
        | 1111111111111111111111111111111111111111 |
        | 4444444444444444444444444444444444444444 |

    Scenario: A checkout a process runs in is kept beyond the two
      Given a process is running in the checkout "2222222222222222222222222222222222222222" of ".local/share/personal/fleet/revisions"
      When the disk GC runs with these limits:
        | --keep-checkouts | .local/share/personal/fleet/revisions=2 |
      Then the directory ".local/share/personal/fleet/revisions" holds exactly:
        | 2222222222222222222222222222222222222222 |
        | 3333333333333333333333333333333333333333 |
        | 4444444444444444444444444444444444444444 |

  Rule: Agents' scratch space is kept for a number of hours

    Scenario: A scratch entry nothing was written in for a day goes, a recent one stays
      Given the directory ".t3/scratch" holds these entries:
        | entry    | last written |
        | old-task | 30 hours ago |
        | new-task | 1 hour ago   |
      When the disk GC runs with these limits:
        | --expire | .t3/scratch=24 |
      Then the directory ".t3/scratch" holds exactly:
        | new-task |

  Rule: A disposable fleet keeps only what is not saved elsewhere

    storage.disposable in fleet.json: work lives on remotes and in the WIP
    guard's recovery refs, so a node disk is a cache. The idle limit is
    hours, not days, and a worktree whose branch is done with on its remote
    goes at once. A process running in a worktree still keeps it.

    Background:
      Given the checkout has a remote that holds its commits

    Scenario Outline: A worktree last used <days> days ago with <work> is <verdict>
      Given an agent worktree "fix-login" of the checkout under ".t3/worktrees/project" with <work>
      And the worktree was last used <days> days ago
      When the disk GC of a disposable fleet runs with these limits:
        | --worktree-root      | .t3/worktrees |
        | --worktree-idle-days | 0.25          |
      Then the worktree is <verdict>

      Examples:
        | days | work                                                    | verdict |
        | 1    | an uncommitted edit the WIP guard saved                 | removed |
        | 1    | a commit no remote holds, which the WIP guard saved     | removed |
        | 1    | an uncommitted edit                                     | kept    |
        | 1    | an uncommitted edit the WIP guard saved 40 days ago     | kept    |
        | 1    | a process running in it                                 | kept    |
        | 1    | nothing unsaved                                         | removed |
        | 0    | nothing unsaved                                         | kept    |
        | 0    | a pushed commit whose branch was deleted on the remote  | removed |
        | 0    | a commit merged into the remote's main branch           | removed |
        | 0    | a branch pushed with no commit of its own               | kept    |

    Scenario: Without the disposable setting, a save in a recovery ref keeps nothing from staying
      Given an agent worktree "fix-login" of the checkout under ".t3/worktrees/project" with an uncommitted edit the WIP guard saved
      And the worktree was last used 40 days ago
      When the disk GC runs with these limits:
        | --worktree-root      | .t3/worktrees |
        | --worktree-idle-days | 30            |
      Then the worktree is kept

    Scenario Outline: A disk of 144000 MiB with <free> MiB free is <state> under a 25% floor
      Given the checkout was last used 1 day ago
      And a disk of 144000 MiB with <free> MiB free
      When the disk GC runs with these limits:
        | --pressure-mib        | 15360 |
        | --pressure-percent    | 25    |
        | --pressure-idle-hours | 6     |
        | --idle-days           | 7     |
      Then the checkout's "node_modules" is <verdict>

      Examples:
        | free  | state           | verdict |
        | 30000 | under pressure  | gone    |
        | 40000 | not under it    | kept    |

  Rule: Each run leaves a report fleet-status reads

    Scenario: An under-target disposable disk reports that it reached its target
      Given a disk of 100000 MiB with 45000 MiB free
      When the disk GC runs with these limits:
        | --target-used-percent | 60           |
        | --report              | disk-gc.json |
      Then the report "disk-gc.json" says:
        | usedPercentAfter | 55   |
        | targetReached    | true |

    Scenario: A protected disk above the disposable target reports the measured shortfall
      Given a disk of 100000 MiB with 34000 MiB free
      When the disk GC runs with these limits:
        | --target-used-percent | 60           |
        | --report              | disk-gc.json |
      Then the report "disk-gc.json" says:
        | pressure          | true |
        | targetReached     | false |
        | usedPercentBefore | 66   |
        | usedPercentAfter  | 66   |
        | targetUsedPercent | 60   |

    Scenario: The report says what was reclaimed and what the worktrees and package stores hold
      Given the checkout has a remote that holds its commits
      And an agent worktree "fix-login" of the checkout under ".t3/worktrees/project" with nothing unsaved
      And the package store ".local/share/pnpm/store" holds a file of 2 MiB, linked into the worktree as "node_modules/pkg/index.js"
      When the disk GC runs with these limits:
        | --worktree-root | .t3/worktrees   |
        | --report        | disk-gc.json    |
      Then the report "disk-gc.json" says:
        | version           | 1          |
        | sameFilesystem    | true       |
        | hardlinkedPercent | at least 90 |
        | storesMiB         | at least 1 |
        | worktreesMiB      | at least 1 |
      And the report "disk-gc.json" names how much each of these reclaimed:
        | checkouts       |
        | worktrees       |
        | fleet_checkouts |
        | expired         |

    Scenario: Under pressure the compatible pnpm prunes its generation and the other stays intact
      Given a stand-in for mise that records how it is run
      And pnpm can prune "v3" among the store generations "v3,v10"
      And a disk with 20 MiB and 50% of its inodes free
      When the disk GC runs with the stand-in for mise and these limits:
        | --home-cache-mib | 32           |
        | --store-cap      | pnpm=1       |
        | --report         | disk-gc.json |
      Then the report "disk-gc.json" gives "v3" the pnpm outcome "pruned"
      And the report "disk-gc.json" gives "v10" the pnpm outcome "unsupported"
      And the cache child ".local/share/pnpm/store/v10/blob" is kept

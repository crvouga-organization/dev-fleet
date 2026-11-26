Feature: The fleet tells someone when a worker becomes unhealthy
  fleet-watch runs fleet-status --workers, compares what it sees with the
  previous run and notifies the targets fleet.json names under "notify" when a
  worker changes between ready and degraded. A notification carries node and
  check IDs only: never a secret, the address of a target or what a command
  printed. Every run also leaves a heartbeat in the bucket, which a check off
  the manager reads.

  Background:
    Given a webhook receiver on this machine
    And the bucket is a directory
    And the fleet configuration says:
      """
      { "notify": { "targets": ["webhook"], "repeatHours": 24 } }
      """

  Rule: A notification is sent on a transition only

    Scenario: Losing the desktop credential degrades a worker until it is readable again
      When the watcher runs at these times, while fleet-status sees these failing checks:
        | time                 | worker-a              | worker-b |
        | 2026-11-11T00:00:00Z |                       |          |
        | 2026-11-11T00:15:00Z | worker:rdp-credential |          |
        | 2026-11-11T00:30:00Z |                       |          |
      Then the webhook receiver got, in order:
        | event     | node     | checks                |
        | degraded  | worker-a | worker:rdp-credential |
        | recovered | worker-a |                       |

    Scenario: Stopping a worker sends one notification, and recovering one more
      When the watcher runs at these times, while fleet-status sees these failing checks:
        | time                 | worker-a                                       | worker-b |
        | 2026-11-11T00:00:00Z |                                                |          |
        | 2026-11-11T00:15:00Z | tailscale:reachability, worker:service:docker  |          |
        | 2026-11-11T00:30:00Z | tailscale:reachability, worker:service:docker  |          |
        | 2026-11-11T00:45:00Z | tailscale:reachability                         |          |
        | 2026-11-11T01:00:00Z |                                                |          |
        | 2026-11-11T01:15:00Z |                                                |          |
      Then the webhook receiver got, in order:
        | event     | node     | checks                                        |
        | degraded  | worker-a | tailscale:reachability, worker:service:docker |
        | recovered | worker-a |                                               |
      And nothing the receiver got contains "PRIVATE"

    Scenario: A worker that stays degraded is mentioned again after the repeat interval
      When the watcher runs at these times, while fleet-status sees these failing checks:
        | time                 | worker-a      |
        | 2026-11-11T00:00:00Z | worker:ubuntu |
        | 2026-11-11T12:00:00Z | worker:ubuntu |
        | 2026-11-12T00:00:00Z | worker:ubuntu |
        | 2026-11-12T00:15:00Z | worker:ubuntu |
      Then the webhook receiver got, in order:
        | event          | node     | checks        |
        | degraded       | worker-a | worker:ubuntu |
        | still-degraded | worker-a | worker:ubuntu |

    Scenario: A fleet that is ready sends nothing and leaves a heartbeat
      Given fleet-status sees every worker ready
      When the watcher runs
      Then the receiver got 0 notifications
      And fleet-watch exits with 0 and its check "watch:heartbeat" passes
      And the bucket holds a heartbeat from "2026-11-11T00:00:00Z"

    Scenario: Low disk space warns the operator before the worker fails
      Given fleet-status warns about "worker:capacity:disk" on "worker-a"
      When the watcher runs
      Then the webhook receiver got, in order:
        | event    | node     | checks               |
        | degraded | worker-a | worker:capacity:disk |

  Rule: Every run says which revision the fleet is to run and what selected it
    The fleet state records what made a revision the approved one: fixed
    words and a worker's fleet id, never an account or a command line.

    Scenario: The approved revision is reported with what selected it and when
      Given fleet-status sees every worker ready
      And the fleet state says of the approved revision:
        """
        {
          "approved": "cccccccccccccccccccccccccccccccccccccccc",
          "applied": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "selectedBy": {
            "by": "checkout",
            "handOff": { "worker": "worker-a" },
            "allowUnmerged": true,
            "at": "2026-11-10T23:50:00.000Z"
          }
        }
        """
      When the watcher runs
      Then fleet-watch reports the revision:
        """
        {
          "approved": "cccccccccccccccccccccccccccccccccccccccc",
          "applied": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "selectedBy": {
            "by": "checkout",
            "handOff": { "worker": "worker-a" },
            "allowUnmerged": true,
            "at": "2026-11-10T23:50:00.000Z"
          }
        }
        """
      And fleet-watch prints "revision cccccccccccc selected by the HEAD of the checkout fleet-sync was started in, handed off from worker-a (--allow-unmerged) at 2026-11-10T23:50:00.000Z (not applied to the whole fleet)"

    Scenario: A fleet state that does not say what selected the revision still names it
      Fleet states written before this was recorded have no such record.
      Given fleet-status sees every worker ready
      And the fleet state says of the approved revision:
        """
        {
          "approved": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "applied": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        }
        """
      When the watcher runs
      Then fleet-watch prints "revision bbbbbbbbbbbb"

    Scenario: Before the first fleet-sync there is no revision to report
      Given fleet-status sees every worker ready
      When the watcher runs
      Then fleet-watch reports no revision

  Rule: A changed approved revision is a notification
    The watcher remembers the approved revision it saw. A run that finds
    another one says so once, with what selected it: fixed words and a
    worker's fleet id only.

    Scenario: The first revision the watcher sees is only remembered
      Given fleet-status sees every worker ready
      And the fleet state says of the approved revision:
        """
        { "approved": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "applied": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
        """
      When the watcher runs
      Then the receiver got 0 notifications

    Scenario: A new approved revision is notified once, with what selected it
      Given fleet-status sees every worker ready
      And the watcher ran while the fleet state said of the approved revision:
        """
        { "approved": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "applied": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
        """
      And the fleet state says of the approved revision:
        """
        {
          "approved": "cccccccccccccccccccccccccccccccccccccccc",
          "applied": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "selectedBy": {
            "by": "checkout",
            "handOff": { "worker": "worker-a" },
            "allowUnmerged": true,
            "at": "2026-11-10T23:50:00.000Z"
          }
        }
        """
      When the watcher runs twice
      Then the receiver got 1 notification
      And the webhook receiver was told of the revision:
        """
        {
          "event": "revision-changed",
          "node": "fleet",
          "revision": {
            "approved": "cccccccccccccccccccccccccccccccccccccccc",
            "replaced": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "selectedBy": "the HEAD of the checkout fleet-sync was started in, handed off from worker-a (--allow-unmerged)"
          },
          "text": "dev-fleet: the approved revision of the fleet changed from bbbbbbbbbbbb to cccccccccccc, selected by the HEAD of the checkout fleet-sync was started in, handed off from worker-a (--allow-unmerged)"
        }
        """

    Scenario: A fleet state that cannot be read does not forget the revision
      The next run that reads it compares with the revision seen last.
      Given fleet-status sees every worker ready
      And the watcher ran while the fleet state said of the approved revision:
        """
        { "approved": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "applied": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
        """
      And the watcher ran while the fleet state could not be read
      And the fleet state says of the approved revision:
        """
        { "approved": "cccccccccccccccccccccccccccccccccccccccc", "applied": "cccccccccccccccccccccccccccccccccccccccc" }
        """
      When the watcher runs
      Then the receiver got 1 notification

  Rule: A test notification proves a target works, without a fleet to watch

    Scenario: The test reaches the webhook
      When the watcher sends a test notification
      Then the receiver got 1 notification
      And fleet-watch exits with 0 and its check "notify:webhook" passes
      And nothing fleet-watch reported contains "PRIVATE-TOKEN"

    Scenario: The test reaches an ntfy topic as text
      Given an ntfy receiver on this machine
      And the fleet configuration says:
        """
        { "notify": { "targets": ["ntfy"] } }
        """
      When the watcher sends a test notification
      Then the ntfy receiver got the text "dev-fleet: fleet-watch sent a test notification"

    Scenario: A target that refuses fails, without repeating its answer
      Given a webhook receiver on this machine, answering 500
      When the watcher sends a test notification
      Then fleet-watch exits with 1 and its check "notify:webhook" fails
      And nothing fleet-watch reported contains "PRIVATE"

    Scenario: A target whose address is not stored fails with a remedy
      Given the fleet configuration says:
        """
        { "notify": { "targets": ["ntfy"] } }
        """
      When the watcher sends a test notification
      Then fleet-watch exits with 1 and its check "notify:ntfy" fails
      And the check "notify:ntfy" of fleet-watch says "NOTIFY_TARGET_UNAVAILABLE"

    Scenario Outline: A target whose address the manager could not read is blocked by the manager's login, not missing
      Nothing is to be stored: the manager <fault> its secrets provider, and
      the check that owns that says what to do.
      Given the fleet configuration says:
        """
        { "notify": { "targets": ["ntfy"] } }
        """
      And the manager <fault> its secrets provider
      When the watcher sends a test notification
      Then fleet-watch exits with 1 and its check "notify:ntfy" fails
      And the check "notify:ntfy" of fleet-watch says "SECRET_READ_BLOCKED by manager:vault-renewal"
      And nothing fleet-watch reported contains "NOTIFY_TARGET_UNAVAILABLE"

      Examples:
        | fault               |
        | is not logged in to |
        | cannot reach        |

    Scenario: A fleet with no notify block is told how to add one
      Given the fleet configuration has no notify block
      And fleet-status sees every worker ready
      When the watcher runs
      Then fleet-watch exits with 0 and its check "notify:configured" warns

  Rule: The notify block names known targets only

    Scenario Outline: The notify block <block> is refused
      Then the notify block '<block>' is refused

      Examples:
        | block                                         |
        | {"targets": []}                               |
        | {"targets": ["pager"]}                        |
        | {"targets": ["webhook", "webhook"]}           |
        | {"targets": ["webhook"], "repeatHours": -1}   |
        | {"targets": ["webhook"], "url": "https://x"}  |

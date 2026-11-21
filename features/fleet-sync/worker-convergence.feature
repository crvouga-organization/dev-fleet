Feature: Fleet status identifies the last failed apply of each worker
  Scenario: A worker with an older receipt reports its failed step
    Given a fleet state of its own, holding no history
    When fleet-sync records the run of "2026-10-01T01:00:00Z" to "2026-10-01T01:10:00Z" that ended with 1 and reported:
      """
      {"nodes":[{"node":"worker-one","role":"worker","checks":[{"id":"ubuntu:baseline","status":"fail"}]}]}
      """
    Then worker "worker-one" with applied revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" and approval "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" at "2026-10-01T05:00:00Z" reports:
      | WORKER_NOT_CONVERGED |
      | Applied aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa |
      | Approved bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb |
      | Last failure at 2026-10-01T01:10:00.000Z in ubuntu:baseline |

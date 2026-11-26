Feature: New T3 work can choose a worker with spare capacity
  Scenario: Two simultaneous starts can prefer different available environments
    When two clients request placement with worker samples aged 2 seconds
    Then their placement decisions are "prefer:worker-a,prefer:worker-b"

  Scenario: No start is placed from a stale sample
    When two clients request placement with worker samples aged 45 seconds
    Then their placement decisions are "queue,queue"

Feature: Maintaining directed full-access T3 grants
  Scenario Outline: Assess a grant by enrolled destination identity
    When the source lists a "<access>" grant to "worker-one" that is "<status>" for <days> more days
    Then its mesh grant to "<target>" is "<assessment>"

    Examples:
      | access            | status      | days | target     | assessment       |
      | full-access       | reachable   | 30   | worker-one | verified         |
      | full-access       | reachable   | 7    | worker-one | renewal due      |
      | full-access       | reachable   | -1   | worker-one | renewal due      |
      | approval-required | reachable   | 30   | worker-one | incorrect access |
      | full-access       | unreachable | 30   | worker-one | unreachable      |
      | full-access       | reachable   | 30   | worker-two | missing          |

  Scenario Outline: Verify every directed grant between available environments
    When the mesh has <members> enrolled environments with <offline> offline and full-access grants between all reachable members
    Then it verifies <links> directed grants and reports <offline> unreachable members

    Examples:
      | members | offline | links |
      | 4       | 0       | 12    |
      | 4       | 1       | 6     |

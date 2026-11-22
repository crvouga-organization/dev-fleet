Feature: The image of the fresh machines is built before any scenario
  The fresh-box features run against disposable machines made from one
  image. Building it downloads a base image and packages, which fails when a
  registry or an archive does for a moment. That says nothing about dev-fleet,
  so the build is tried again, and a build that still fails is reported once,
  as the runner's, before any scenario runs.

  Scenario Outline: A build that fails is tried again, three times at most
    Given the build of the image fails <failures> times
    When the image of the fresh machines is built
    Then the build was tried <attempts> times
    And the image <outcome>

    Examples:
      | failures | attempts | outcome       |
      | 0        | 1        | was built     |
      | 1        | 2        | was built     |
      | 2        | 3        | was built     |
      | 3        | 3        | was not built |

  Scenario: The build waits longer before each further attempt
    Given the build of the image fails 3 times
    When the image of the fresh machines is built
    Then it paused for these seconds between the attempts:
      | 15 |
      | 45 |

  Scenario: An image that cannot be built is a failure of the runner, not of a scenario
    Given the build of the image fails 3 times
    When the image of the fresh machines is built
    Then the failure says "The image of the fresh machines could not be built in 3 attempts. This is a failure of the runner or of the network the image is downloaded over, not of a scenario: none was run."

  Scenario: The image is built before the scenarios, so its failure is reported once
    A step that failed to build the image would fail in every scenario that
    names a machine. Built before all of them, it fails the run once.
    When the file "features/fresh-box/features.test.ts" is read
    Then it builds the image of the fresh machines before every scenario

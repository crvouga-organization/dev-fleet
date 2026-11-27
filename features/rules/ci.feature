Feature: Every pull request is checked the way machines run

  Scenario: A service a check starts is pinned by digest
    When the service images of the "CI" workflow are read
    Then there is at least one
    And each is pinned by tag and SHA-256 digest

  Scenario: The fleet state check runs when the diff affects it and cannot skip the tools
    Then the "CI" workflow runs on "pull_request"
    And its "state" job runs when the affected job selects "state"
    And its "state" job sets "HOMELAB_TEST_LITESTREAM" to "required"
    And its "state" job points "HOMELAB_TEST_S3" at a local S3 service

  Scenario Outline: The <job> check runs when the diff affects it
    Then the "CI" workflow runs on "pull_request"
    And its "<job>" job runs when the affected job selects "<output>"

    Examples:
      | job       | output    |
      | check     | check     |
      | state     | state     |
      | fresh-box | fresh     |
      | agent-box | agent     |
      | proxy-box | proxy     |
      | workflows | workflows |
      | ansible   | ansible   |
      | manager   | manager   |

  Scenario: A fresh worker is bootstrapped over SSH when the diff affects it
    The cells come from the affected job. A pull request runs one, a release
    runs the newest Ubuntu on both architectures, and the night runs the rest.
    A job that names a feature that does not exist fails instead of passing
    with nothing run.
    Then the "CI" workflow runs on "pull_request"
    And its "fresh-box" job runs when the affected job selects "fresh"
    And its "fresh-box" job takes its matrix from the affected job
    And its "fresh-box" job runs "bun test features/fresh-box"
    And its "fresh-box" job sets "HOMELAB_TEST_FRESH_BOX" to "required"
    And its "fresh-box" job sets "HOMELAB_TEST_FRESH_BOX_RELEASE" to "${{ matrix.release }}"
    And its "fresh-box" job sets "HOMELAB_TEST_FRESH_BOX_FEATURE" to "${{ matrix.feature }}"

  Scenario: The monitoring agent is applied on a systemd machine when the diff affects it
    Then the "CI" workflow runs on "pull_request"
    And its "agent-box" job runs when the affected job selects "agent"
    And its "agent-box" job runs "bun test features/monitoring"
    And its "agent-box" job sets "HOMELAB_TEST_AGENT_BOX" to "required"

  Scenario: The pinned CLI proxy is asked about an account it holds back when the diff affects it
    Then the "CI" workflow runs on "pull_request"
    And its "proxy-box" job runs when the affected job selects "proxy"
    And its "proxy-box" job runs "bun test features/accounts"
    And its "proxy-box" job sets "HOMELAB_TEST_PROXY_BOX" to "required"

  Scenario: The agents play renders every CLI's configuration when the diff affects it and cannot skip
    Then the "CI" workflow runs on "pull_request"
    And its "check" job runs when the affected job selects "check"
    And its "check" job sets "HOMELAB_TEST_ANSIBLE" to "required"

  Scenario: Every playbook is linted in the production profile and syntax-checked
    Then the "CI" workflow runs on "pull_request"
    And its "ansible" job runs when the affected job selects "ansible"
    And its "ansible" job runs "ansible-lint"
    And its "ansible" job runs "--syntax-check"
    And ".ansible-lint.yml" requires the profile "production"

  Scenario: Every pinned Ubuntu package is found in the pinned snapshot when the diff affects it
    A pin moved without its snapshot has no installation candidate, which a
    machine only learns when its baseline fails.
    Then the "CI" workflow runs on "pull_request"
    And its "ansible" job runs when the affected job selects "ansible"
    And its "ansible" job runs "ansible/ubuntu/tests/snapshot-pins.py"

  Scenario: The manager is checked on macOS when the diff affects it
    The manager runs only on macOS: launchd, pmset and Docker Desktop are
    proven there and not by stand-ins alone. The manager playbook is converged
    on the runner, then applied again and checked, and neither may change
    anything. The one administrator grant (sudoers, newsyslog drop-in, T3
    policy) is applied the same way, with the runner's sudo.
    Then the "CI" workflow runs on "pull_request"
    And its "manager" job runs when the affected job selects "manager"
    And its "manager" job runs on "macos-latest"
    And its "manager" job runs "bun test"
    And its "manager" job runs "ansible/macos/manager.yml"
    And its "manager" job runs "converge --check --diff"
    And its "manager" job runs "changed=0"
    And its "manager" job runs "ansible/macos/manager-privilege.yml"

  Scenario: The real Ubuntu machine is tested weekly and can be run by hand
    Then the "Ubuntu VM" workflow runs on "schedule"
    And the "Ubuntu VM" workflow runs on "workflow_dispatch"
    And its "vm" job runs "bun ansible/ubuntu/tests/run-vm.ts"

  Scenario: Tailnet enrolment is tested weekly against a self-hosted control plane and can be run by hand
    Then the "Tailnet" workflow runs on "schedule"
    And the "Tailnet" workflow runs on "workflow_dispatch"
    And its "tailnet" job runs "bun test features/tailnet-box"
    And its "tailnet" job sets "HOMELAB_TEST_TAILNET_BOX" to "required"

  Scenario: A release stamps the commit it is published from into the package
    converge run from the package converges every machine to the commit the
    package names, so a release that does not name one cannot move a fleet.
    When the "Pack the release" step of the "Release" workflow is read
    Then it runs "npm pkg set gitHead=\"$(git rev-parse HEAD)\"" before "npm pack"

  Scenario: Nothing is published until the packed release ran and the VM and tailnet tests passed for its commit
    A broken bin path, a file missing from the package, a machine the
    release cannot bring up or a worker that cannot join the tailnet fails
    the run before npm sees anything.
    Then the "Release" workflow's "release" job needs "pack", "smoke", "vm" and "tailnet"
    And its "smoke" job runs "bun bootstrap/package-smoke.ts"
    And its "smoke" job runs once for each of:
      | node |
      | 22   |
      | 24   |
    And its "vm" job calls ".github/workflows/vm.yml" for the commit "pack" packed
    And its "tailnet" job calls ".github/workflows/tailnet.yml" for the commit "pack" packed
    When the "Publish to npm" step of the "Release" workflow is read
    Then it runs "npm publish \"$TARBALL\"" before "--provenance"

  Scenario: A version that is on npm from another commit is never tagged on this one
    A release that published and then failed leaves its version on npm with
    no tag. The next merge computes the same version: tagging it there would
    name a commit the package does not hold.
    When the "Publish to npm" step of the "Release" workflow is read
    Then it runs "npm view \"$NAME@$VERSION\" gitHead" before "npm publish"
    And it runs "[ \"$published\" = \"$COMMIT\" ]" before "exit 1"

  Scenario: A release is described by the commits it contains
    When the "Tag and release" step of the "Release" workflow is read
    Then it runs "gh release create" before "--notes-file"

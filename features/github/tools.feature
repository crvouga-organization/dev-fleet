Feature: Every tool on a node takes its GitHub credential from gh
  gh holds the node's token. git asks gh for it at every use, so a replaced
  token reaches git with no change to git and no second copy of the token on
  disk. ansible/github/git.yml, which writes the declared Git identity, owns
  the helper on the manager and every worker.

  Background:
    Given the fleet login is "example-user"
    And GitHub knows the token "TOKEN_A_PRIVATE_0001" as "example-user"
    And "worker-one" is signed in with "TOKEN_A_PRIVATE_0001"

  Scenario: git that asks gh passes
    Given git on "worker-one" has these GitHub credential helpers:
      |                                                       |
      | !'/home/dev/.local/share/mise/shims/gh' auth git-credential |
    When the GitHub checks run on "worker-one"
    Then the check "github:git-credential" passes

  Scenario Outline: git that asks gh by <how> passes
    gh auth setup-git, which a person may have run on the node, writes its
    own helper in ~/.gitconfig: the same credential source by another path.
    Given git on "worker-one" has these GitHub credential helpers:
      | <first>  |
      | <second> |
      | <third>  |
      | <fourth> |
    When the GitHub checks run on "worker-one"
    Then the check "github:git-credential" passes

    Examples:
      | how                                  | first                                                       | second                                                      | third | fourth                                    |
      | gh auth setup-git's path, after ours | !'/home/dev/.local/share/mise/shims/gh' auth git-credential |                                                             |       | !/opt/tools/bin/gh auth git-credential    |
      | a quoted path, or none               |                                                             | !'/opt/tools with space/gh' auth git-credential             | !gh auth git-credential | !/opt/tools/bin/gh auth git-credential |

  Scenario Outline: git that also asks <what> fails
    Git asks every helper after the last empty one, in order.
    Given git on "worker-one" has these GitHub credential helpers:
      | <first>  |
      | <second> |
      | <third>  |
    When the GitHub checks run on "worker-one"
    Then the check "github:git-credential" fails
    And the check "github:git-credential" says "GITHUB_GIT_CREDENTIAL_MISSING"

    Examples:
      | what                       | first                                                       | second                                                      | third |
      | a store after gh           |                                                             | !'/home/dev/.local/share/mise/shims/gh' auth git-credential | store |
      | nothing, having cleared it | !'/home/dev/.local/share/mise/shims/gh' auth git-credential |                                                             |       |

  Scenario: git with a credential store of its own fails
    Given git on "worker-one" has these GitHub credential helpers:
      | store |
    When the GitHub checks run on "worker-one"
    Then the check "github:git-credential" fails
    And the check "github:git-credential" says "GITHUB_GIT_CREDENTIAL_MISSING"

  Scenario: One playbook sets gh as git's only helper, and the sign-in writes no token
    When the GitHub tasks of the playbooks are read
    Then only "ansible/github/git.yml" sets git's GitHub credential helper
    And it clears every earlier helper before naming gh
    And the GitHub sign-in tasks write no file but its job and timer

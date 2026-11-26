@ansible @slow
Feature: The declared Git configuration holds beside a person's ~/.gitconfig
  ansible/github/git.yml writes the declared identity and gh as GitHub's
  credential helper in ~/.config/git/config and reads back what Git really
  uses: both per-user files, ~/.gitconfig winning. The helper that
  `gh auth setup-git` writes in ~/.gitconfig asks gh too, by another path,
  and may stay. These scenarios run the real play, with the locked Ansible,
  against a home directory of their own.

  Scenario: A ~/.gitconfig that gh auth setup-git wrote leaves the declared identity in effect
    Given the node's ~/.gitconfig holds:
      """
      [credential "https://github.com"]
      	helper =
      	helper = !/opt/tools/bin/gh auth git-credential
      """
    When the Git identity "Example User" <example-user@users.noreply.github.com> is converged on the node
    Then the check "git:configuration" passes
    And the node's ~/.gitconfig is as it was

  Scenario: Without a ~/.gitconfig the declared identity is in effect
    When the Git identity "Example User" <example-user@users.noreply.github.com> is converged on the node
    Then the check "git:configuration" passes

  Scenario Outline: A ~/.gitconfig that <how> fails git:configuration
    Given the node's ~/.gitconfig holds:
      """
      <file>
      """
    When the Git identity "Example User" <example-user@users.noreply.github.com> is converged on the node
    Then the check "git:configuration" fails
    And the play stopped with "GIT_IDENTITY_OVERRIDDEN"
    And the remedy of the check "git:configuration" mentions "gh auth setup-git writes may stay"
    And the node's ~/.gitconfig is as it was

    Examples:
      | how                                      | file                                                                  |
      | sets another author                      | [user]␊name = Someone Else                                          |
      | asks a credential store after gh         | [credential "https://github.com"]␊helper = store                     |
      | clears the helpers and names a store     | [credential "https://github.com"]␊helper =␊helper = store          |

  Scenario: Git obtains its credential noninteractively inside an untrusted checkout
    Given the fleet gh shim refuses to run inside a project containing mise.toml
    When the Git identity "Example User" <example-user@users.noreply.github.com> is converged on the node
    Then Git obtains the fixture credential inside the untrusted checkout

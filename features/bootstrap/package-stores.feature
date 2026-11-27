Feature: Agent worktrees link their packages from one store per machine
  Every agent worktree installs the same few dependencies. The global mise
  configuration homelab publishes on every fleet machine (the [env] of
  mise.toml) gives pnpm one store and Bun one cache, so an install links
  files from the store instead of copying them, and a worktree whose
  node_modules the disk GC removed is installed again from the store without
  a download.

  Scenario: The fleet's package-manager settings name one store per machine
    When the environment mise.toml declares for every fleet machine is read with the home "/home/dev"
    Then it sets:
      | pnpm_config_store_dir             | /home/dev/.local/share/pnpm/store |
      | pnpm_config_package_import_method | auto                              |
      | pnpm_config_prefer_offline        | true                              |
      | BUN_INSTALL_CACHE_DIR             | /home/dev/.bun/install/cache      |

  @linux @pnpm
  Scenario: Two worktrees installed offline from the shared store share the files of an identical package
    On ext4 pnpm links a package's files from the store: both worktrees hold
    the same file, not a copy each.
    Given a home directory with the environment mise.toml declares for every fleet machine
    And a package "left-pad-fixture" packed as a tarball
    And two worktrees "one" and "two" that depend on it
    When pnpm installs each worktree offline
    Then "index.js" of "left-pad-fixture" is one file on disk in both worktrees

#!/bin/sh
# Every fleet-sync on the manager runs through this, whether started there or
# handed off from a worker over strict SSH. Runs fleet-sync from a clean,
# fleet-owned checkout of the exact approved revision, so the result never
# depends on the working tree it was started in (uncommitted edits, another
# branch, a removed worktree). Checkouts are reused when warm and pruned to two:
# this one and the one T3's providers launch from, or the most recent other
# when they are the same. Never touches the human's working tree.
set -eu
revision=$1
shift
case "$revision" in *[!a-f0-9]*|'') exit 2;; esac
[ "${#revision}" = 40 ] || exit 2
say() { printf 'fleet-sync (manager): %s\n' "$1" >&2; }
# A preview (--dry-run) changes nothing outside homelab's own disposable
# caches: it never publishes the global mise configuration, never edits shell
# profiles and never prunes run checkouts. Only an apply does.
preview=false
for arg in "$@"; do [ "$arg" != --dry-run ] || preview=true; done
# The run that started this one was given --allow-mise-downgrade for this
# revision: the toolchain bootstrap installs the mise the revision pins even
# when the manager runs a newer one. Without it a newer mise is kept.
downgrade=''
[ "${HOMELAB_MISE_DOWNGRADE_ALLOWED:-}" != "$revision" ] || downgrade=--allow-mise-downgrade
# mise is installed here by the toolchain step below; a login shell is not
# required to find it.
export PATH="$HOME/.local/bin:$PATH"
fleet="$HOME/.local/share/personal/fleet"
# The repository to take the revision from. Nobody keeps a clone of homelab:
# fleet-sync names the one it prepared, and a hand-off (which names none) uses
# the manager's own copy of the source repository, or the checkout the homelab
# launcher is linked into.
repo=${HOMELAB_REPO:-${DEVFLEET_REPO:-}}
if [ -z "$repo" ] && git -C "$fleet/manager/source" rev-parse --git-dir >/dev/null 2>&1; then
  repo="$fleet/manager/source"
fi
if [ -z "$repo" ]; then
  launcher=$(command -v homelab) || { say 'this manager has no copy of the source yet; run fleet-sync once on the manager itself, from the project that holds your fleet.json.'; exit 3; }
  repo=$(dirname "$(readlink -f "$launcher")")
fi
repo=$(git -C "$repo" rev-parse --show-toplevel) || { say 'cannot read the source repository on the manager; run fleet-sync once on the manager itself to fetch it again.'; exit 3; }
runs="$fleet/manager-runs"
dir="$runs/$revision"
ready() {
  [ "$(git -C "$dir" rev-parse HEAD 2>/dev/null)" = "$revision" ] &&
    [ -z "$(git -C "$dir" status --porcelain 2>/dev/null)" ]
}
if ! ready; then
  git -C "$repo" cat-file -e "$revision^{commit}" 2>/dev/null || git -C "$repo" fetch --quiet origin || true
  git -C "$repo" cat-file -e "$revision^{commit}" 2>/dev/null || git -C "$repo" fetch --quiet --no-tags origin "$revision" || true
  git -C "$repo" cat-file -e "$revision^{commit}" 2>/dev/null || { say "revision $revision is neither on the manager nor on origin; push it first."; exit 4; }
  mkdir -p "$runs"
  chmod 700 "$runs"
  # A fleet-owned, disposable run checkout: recreate it when stale or dirty.
  if [ -e "$dir" ]; then git -C "$repo" worktree remove --force "$dir" 2>/dev/null || rm -rf -- "$dir"; fi
  git -C "$repo" worktree prune
  git -C "$repo" worktree add --quiet --detach "$dir" "$revision"
fi
touch "$dir"
cd "$dir"
mise trust --quiet "$dir" >/dev/null 2>&1 || true
# The manager runs the same locked toolchain (and so the same agent versions)
# as every worker: publish this revision's global config, install it and the
# frozen dependencies. Warm: the toolchain is skipped when the same inputs
# (tool pins, locks, setup code) were installed within a day, so a revision
# that changes none of them only installs its own dependencies.
# Stamp and log sit beside the checkout: inside it they would make it dirty.
stamp="$runs/toolchain-ready"
log="$runs/$revision.setup.log"
key=$(git rev-parse HEAD:mise.toml HEAD:mise.lock HEAD:.mise HEAD:bun.lock HEAD:package.json HEAD:bootstrap 2>/dev/null | tr '\n' ' ')
[ -n "$key" ] || key=$revision
failed() {
  tail -n 20 "$log" >&2
  say "toolchain or dependency install failed in the run checkout; full log: $log"
  exit 5
}
if [ "$preview" = true ]; then
  # The revision's own locked Bun is enough to preview; mise keeps it beside
  # its other versions without making it the global one.
  command -v mise >/dev/null 2>&1 || { say 'this manager has no toolchain yet, so a preview cannot run; fleet-sync without --dry-run installs it.'; exit 6; }
  mise install --locked bun >"$log" 2>&1 || failed
elif [ -n "$downgrade" ] || [ "$(cat "$stamp" 2>/dev/null)" != "$key" ] || [ -z "$(find "$stamp" -mmin -1440 2>/dev/null)" ]; then
  rm -f -- "$stamp"
  # The toolchain bootstrap installs the pinned mise first when the manager
  # has none (or an older one; a newer one is kept), so Git is all a new
  # manager needs.
  bash bootstrap/bootstrap.sh --tools-only ${downgrade:+"$downgrade"} >"$log" 2>&1 || failed
  printf '%s' "$key" >"$stamp"
fi
if [ ! -d node_modules ]; then
  mise exec --locked bun -- bun install --frozen-lockfile --silent >>"$log" 2>&1 || failed
fi
# Keep two run checkouts (names are commit SHAs), the current and the
# previous: this one and the applied one (fleet/current points at it and T3's
# providers launch from there), or the most recent other when this one is the
# applied one. The disk GC keeps the same two (resourceSafety.diskGcCheckoutsKept
# in ansible/ubuntu/policy.json). A preview leaves them for the next apply to
# prune.
if [ "$preview" = false ]; then
  applied=$(basename "$(readlink "$(dirname "$runs")/current" 2>/dev/null || true)")
  # Older launchers can point inside a nested checkout in a previous run.
  # Keep that run until the manager playbook links the launcher to current.
  launcher=$(readlink -f "$HOME/.local/bin/homelab" 2>/dev/null || true)
  runs_real=$(cd "$runs" && pwd -P)
  kept=0
  if [ -n "$applied" ] && [ "$applied" != "$revision" ] && [ -d "$runs/$applied" ]; then kept=1; fi
  # shellcheck disable=SC2012
  ls -1td "$runs"/*/ | while IFS= read -r old; do
    [ "$(basename "$old")" != "$revision" ] && [ "$(basename "$old")" != "$applied" ] || continue
    case "$launcher" in "$runs_real/$(basename "$old")"/*) continue;; esac
    kept=$((kept + 1))
    [ "$kept" -gt 1 ] || continue
    # A checkout made from another repository (an earlier clone) is not this
    # repository's worktree: remove the directory itself.
    git -C "$repo" worktree remove --force "$old" 2>/dev/null || rm -rf -- "$old"
    rm -f -- "${old%/}.setup.log"
  done
  git -C "$repo" worktree prune
fi
export PERSONAL_WORKSPACE="$dir" PERSONAL_FLEET_RUN_CHECKOUT="$revision"
exec mise exec --locked bun -- bun src/cli/cli.ts fleet-sync --revision "$revision" "$@"

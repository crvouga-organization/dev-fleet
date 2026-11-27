#!/bin/sh
# Links ~/.local/bin/homelab to this checkout (or the one given). Idempotent.
# homelab is the command. The fleet is the set of machines it keeps.
# A leftover symlink of the previous command name is removed.
set -eu
root=${1:-$(cd "$(dirname "$0")/.." && pwd)}
[ -x "$root/bootstrap/homelab" ] || exit 1
# Only ever a checkout: an installed package sits wherever a package manager
# put it and may be gone tomorrow.
[ -e "$root/.git" ] || { echo 'The homelab launcher links to a checkout of homelab; converge installs it.' >&2; exit 1; }
mkdir -p "$HOME/.local/bin"
ln -sfn "$root/bootstrap/homelab" "$HOME/.local/bin/homelab"
# Drop the previous command only when it still points at this launcher.
legacy="$HOME/.local/bin/devfleet"
if [ -L "$legacy" ]; then
  case $(readlink "$legacy") in
    */bootstrap/homelab | */bootstrap/devfleet) rm -f "$legacy" ;;
  esac
fi

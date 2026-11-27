#!/usr/bin/env bash
# Installs the pinned toolchain for the checkout this script is in. fleet-sync
# runs it on every machine from the checkout of the revision it applies;
# nobody clones homelab to use it (see README.md).
set -euo pipefail
os=$(uname -s)
case "$os" in
  Darwin) platform=macos ;;
  Linux) platform=linux ;;
  *) echo 'Use bootstrap.ps1 for native Windows.' >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64) arch=x64 ;;
  *) echo 'Supported: x64 and arm64.' >&2; exit 1 ;;
esac
# Git, TLS roots and extraction are OS prerequisites, outside the mise lock.
if ! git --version >/dev/null 2>&1; then
  case "$os" in
    Darwin)
      xcode-select --install || true
      echo 'Finish installing Apple Command Line Tools, then rerun this script.' >&2
      exit 1 ;;
    Linux)
      if command -v apt-get >/dev/null; then
        sudo apt-get update
        sudo apt-get install -y git curl ca-certificates unzip xz-utils build-essential
      elif command -v dnf >/dev/null; then
        sudo dnf install -y git curl ca-certificates unzip xz gcc gcc-c++ make
      else
        echo 'Install git, curl, CA certificates, unzip, xz and a C/C++ toolchain, then rerun.' >&2
        exit 1
      fi ;;
  esac
fi
for tool in curl tar unzip; do
  command -v "$tool" >/dev/null || { echo "Install $tool, then rerun." >&2; exit 1; }
done
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
[[ -f "$script_dir/../mise.toml" ]] || {
  echo 'Run this from a homelab checkout. To use homelab, run its CLI instead: fleet-sync installs the toolchain.' >&2; exit 1;
}
checkout=$(cd "$script_dir/.." && pwd)
cd "$checkout"
# mise is pinned where every other tool is: `min_version` in mise.toml is the
# version installed on a machine that has none or an older one, and [vars]
# holds the digest of its release archive for each platform. mise cannot read
# them for us before it exists.
pin() { sed -n "s/^$1 = \"\\(.*\\)\"\$/\\1/p" "$checkout/mise.toml" | head -n 1; }
MISE_VERSION=$(pin min_version)
mise_sha256=$(pin "mise_${platform}_${arch}_sha256")
[[ -n "$MISE_VERSION" && -n "$mise_sha256" ]] || {
  echo 'mise.toml does not pin mise for this platform.' >&2; exit 1;
}
# Reuse an observed matching managed executable. Repeated reconciliation must
# not download/reinstall mise solely because a previous run finished.
installed_mise=$("$HOME/.local/bin/mise" --version 2>/dev/null | awk '{print $1}') || installed_mise=''
# `min_version` is a minimum: a newer mise satisfies this checkout's pin, and
# every other checkout on the machine whose pin is newer than this one needs
# it. So a newer mise is kept, and replaced with the older pinned one only
# when that is asked for by name. The doctor reports a kept one as
# TOOLCHAIN_DOWNGRADE (tool:mise).
allow_downgrade=false
for arg; do [[ "$arg" != --allow-mise-downgrade ]] || allow_downgrade=true; done
# Whether release $1 is newer than release $2, number by number.
newer() {
  local IFS=. index left right
  local -a first second
  read -r -a first <<<"$1"
  read -r -a second <<<"$2"
  for index in 0 1 2; do
    left=${first[index]:-0} right=${second[index]:-0}
    left=${left//[^0-9]/} right=${right//[^0-9]/}
    ((10#${left:-0} > 10#${right:-0})) && return 0
    ((10#${left:-0} < 10#${right:-0})) && return 1
  done
  return 1
}
install_mise=false
if [[ "$installed_mise" != "$MISE_VERSION" ]]; then
  install_mise=true
  if [[ -n "$installed_mise" ]] && newer "$installed_mise" "$MISE_VERSION"; then
    if [[ "$allow_downgrade" == true ]]; then
      echo "TOOLCHAIN_DOWNGRADE: replacing mise $installed_mise with the older $MISE_VERSION this checkout pins, as --allow-mise-downgrade asks." >&2
    else
      install_mise=false
      echo "TOOLCHAIN_DOWNGRADE: this checkout pins mise $MISE_VERSION and the machine runs the newer $installed_mise, which is kept. Pass --allow-mise-downgrade to install the older one." >&2
    fi
  fi
fi
if [[ "$install_mise" == true ]]; then
temp=$(mktemp -d)
trap 'rm -rf "$temp"' EXIT
asset="mise-v${MISE_VERSION}-${platform}-${arch}.tar.gz"
# Alpine/musl is not part of the supported workstation baseline.
curl -fsSL "https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/$asset" -o "$temp/$asset"
if command -v sha256sum >/dev/null; then
  actual=$(sha256sum "$temp/$asset" | cut -d' ' -f1)
else
  actual=$(shasum -a 256 "$temp/$asset" | cut -d' ' -f1)
fi
[[ "$actual" == "$mise_sha256" ]] || {
  echo 'The mise archive does not match the digest pinned in mise.toml.' >&2; exit 1;
}
tar -xzf "$temp/$asset" -C "$temp"
mkdir -p "$HOME/.local/bin"
install -m 0755 "$temp/mise/bin/mise" "$HOME/.local/bin/mise"
fi
export PATH="$HOME/.local/bin:$PATH"
# Trust the checkout directory, not only its file, so `mise trust --show` there
# reports trusted.
mise trust "$checkout"
mise install --locked bun
mise exec --locked bun -- bun bootstrap/setup.ts "$@"

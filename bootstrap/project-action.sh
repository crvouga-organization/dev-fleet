#!/usr/bin/env bash
# A T3 project script in a homelab checkout calls this. It warms the pinned
# toolchain, then runs one homelab command. converge and converge-local take
# this checkout's HEAD unless the caller already named a revision, asked to
# roll back, or limited the run to accounts or the schedule.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"

if [[ $# -lt 1 ]]; then
  echo 'Usage: bootstrap/project-action.sh ACTION [args...]' >&2
  echo 'ACTION is a homelab command: converge, converge-local, check, tailnet, state, repair, workers, proxy, warm.' >&2
  echo 'sync is converge. status is check --workers. infra-cliproxy is proxy.' >&2
  exit 2
fi

action=$1
shift

command=()
case "$action" in
  converge|sync) command=(converge) ;;
  converge-local) command=(converge-local) ;;
  check) command=(check) ;;
  status)
    command=(check)
    scoped=false
    for arg in "$@"; do
      case "$arg" in
        --local|--workers|--tailnet|--all|--node|--node=*) scoped=true ;;
      esac
    done
    [[ "$scoped" == true ]] || command+=(--workers)
    ;;
  tailnet) command=(tailnet) ;;
  state) command=(state) ;;
  repair) command=(repair) ;;
  workers) command=(workers) ;;
  proxy|infra-cliproxy) command=(proxy) ;;
  warm) ;;
  *)
    echo "Unknown project action '$action'. The homelab commands are converge, converge-local, check, tailnet, state, repair, workers, proxy and warm." >&2
    exit 2
    ;;
esac

bash "$root/bootstrap/bootstrap.sh"

if [[ "$action" == warm ]]; then
  exit 0
fi

if [[ "${command[0]}" == converge || "${command[0]}" == converge-local ]]; then
  pin=true
  for arg in "$@"; do
    case "$arg" in
      --revision|--revision=*|--rollback|--schedule|--schedule=*|--only|--only=*) pin=false ;;
    esac
  done
  if [[ "$pin" == true ]]; then
    revision=$(git -C "$root" rev-parse --verify HEAD) || {
      echo 'This checkout has no commit to converge to.' >&2
      exit 2
    }
    [[ "$revision" =~ ^[0-9a-f]{40}$ ]] || {
      echo 'This checkout has no commit to converge to.' >&2
      exit 2
    }
    command+=(--revision "$revision")
  fi
fi

exec "$root/bootstrap/homelab" "${command[@]}" "$@"

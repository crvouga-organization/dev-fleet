#!/bin/sh
# Keep the worker's T3 up, responsive and on the installed release: the
# desktop app (UI and server) on a desktop worker, the native server
# (t3code-headless.service, t3-headless.yml) on a headless one. Run every
# minute by personal-worker-recovery.timer (managed by converge,
# tasks/recovery.yml), from the stable copy the role installs beside
# t3-idle.py.
# - The former upstream server unit (t3code.service) is stopped and
#   disabled: one T3 per worker.
# - Desktop only. No graphical session: T3_NO_GRAPHICAL_SESSION; after three
#   checks in a row the display manager is restarted so auto-login starts
#   one, three times at most until a session is seen again. A headless
#   worker has no session to wait for.
# - Stopped or failed: reset its start limit and start it.
# - Running but its local API has not answered for three checks in a row:
#   restart it, since a hung server serves no turns.
# - Running another release than the installed one, or a restart a play
#   deferred: restart it once it runs no agent turn (T3_RESTART_PENDING). A
#   busy worker is never idle, so the wait is bounded: the restart is applied
#   T3_RESTART_MAX_DEFERRAL_HOURS (policy.json) after it was first deferred
#   although agent turns run, and they end (T3_RESTART_DEADLINE). T3 has no
#   way to stop accepting turns first.
set -u
if [ -f /run/personal-fleet-pressure-guard/active ]; then
  echo "Deferring T3 recovery while the worker is under sustained pressure."
  exit 0
fi
url=http://127.0.0.1:3773/.well-known/t3/environment
runtime="${XDG_RUNTIME_DIR:?}"
failures="$runtime/personal-t3-health-failures"
no_session="$runtime/personal-t3-no-session"
display_restarts="$runtime/personal-t3-display-restarts"
pending="$runtime/personal-t3-restart-pending"
handoff="$runtime/personal-t3-desktop-handoff"
restarted="$runtime/personal-t3-restarted-for"
installed="${T3_DESKTOP_DIR:-/opt/T3 Code (Nightly)}/.personal-fleet-version"
here=$(dirname "$0")
limit=3
# Both the installed timer and the play hold this lock through handoff/start.
exec 9>"$runtime/personal-t3-recovery.lock"
if [ "${1:-}" = --apply ]; then
  flock -w 120 9 || { echo "T3_RECOVERY_IN_PROGRESS"; exit 1; }
elif ! flock -n 9; then
  echo "T3_RECOVERY_IN_PROGRESS"
  exit 0
fi
unit=t3code-desktop.service
headless=
if systemctl --user is-enabled --quiet t3code-headless.service; then
  unit=t3code-headless.service
  headless=1
fi
stage=${2:-}
force=${3:-}
record_pending() {
  [ -s "$pending" ] || date +%s > "$pending"
}

count() {
  n=$(($(cat "$1" 2>/dev/null || echo 0) + 1))
  echo "$n" > "$1"
  echo "$n"
}

if systemctl --user is-active --quiet t3code.service ||
  systemctl --user is-enabled --quiet t3code.service; then
  echo "Retiring the former headless T3 server."
  if ! systemctl --user disable --now t3code.service; then
    echo "T3_LEGACY_SERVER_RUNNING"
    exit 1
  fi
fi

if [ -z "$headless" ] && ! systemctl --user is-active --quiet graphical-session.target; then
  rm -f "$failures"
  if [ "${1:-}" = --apply ]; then
    echo "T3_NO_GRAPHICAL_SESSION"
    exit 0
  fi
  seen=$(count "$no_session")
  echo "T3_NO_GRAPHICAL_SESSION ($seen/$limit)."
  if [ "$seen" -ge "$limit" ]; then
    rm -f "$no_session"
    restarts=$(count "$display_restarts")
    if [ "$restarts" -le "$limit" ]; then
      echo "Restarting the display manager so auto-login starts a session ($restarts/$limit)."
      sudo -n systemctl restart display-manager.service
    else
      echo "The display manager was restarted $limit times; a person must log in."
    fi
  fi
  exit 1
fi
rm -f "$no_session" "$display_restarts"

if [ -z "$headless" ]; then
  owner=$(python3 -I -B "$here/t3-listener.py") || exit 1
  case "$owner" in
    managed)
      # A previous invocation may have stopped after systemd started the
      # replacement. The new managed process already loaded the staged files.
      if [ -f "$handoff" ]; then rm -f "$pending" "$handoff"; fi
      ;;
    free)
      # Electron may close its socket before releasing its single-instance
      # lock. Wait for systemd to finish the outstanding scope stop.
      previous=$(cat "$handoff" 2>/dev/null)
      case "$previous" in
        app-com.t3tools.T3Code-*.scope)
          state=$(systemctl --user show "$previous" -p ActiveState --value)
          case "$state" in
            deactivating)
              [ "${1:-}" = --apply ] || exit 0
              systemctl --user stop "$previous" || exit 1
              [ "$(python3 -I -B "$here/t3-listener.py")" = free ] || exit 0
              ;;
            active | activating) exit 0 ;;
          esac
          ;;
      esac
      ;;
    exposed) record_pending ;;
    app-com.t3tools.T3Code-*.scope)
      if [ "$(cat "$handoff" 2>/dev/null)" != "$owner" ]; then
        printf '%s\n' "$owner" > "$handoff" || exit 1
      fi
      if [ "$force" != --force ] && ! python3 -I -B "$here/t3-idle.py" --state "${T3CODE_HOME:-$HOME/.t3}/userdata/statev2.sqlite"; then
        record_pending
        echo "T3_RESTART_PENDING: desktop handoff waits for active turns."
        exit 0
      fi
      # Remeasure after the idle probe. An interrupted handoff resumes from
      # the listener that actually exists on the next invocation.
      [ "$(python3 -I -B "$here/t3-listener.py")" = "$owner" ] || exit 1
      echo "T3_HANDOFF: stopping the idle desktop scope."
      record_pending
      if [ "${1:-}" = --apply ]; then
        systemctl --user stop "$owner" || exit 1
      else
        systemctl --user stop --no-block "$owner" || exit 1
      fi
      # The application may spend its full stop timeout flushing state.
      # Leave the stop job in systemd and resume on the next observation.
      [ "$(python3 -I -B "$here/t3-listener.py")" = free ] || exit 0
      state=$(systemctl --user show "$owner" -p ActiveState --value)
      case "$state" in active | activating | deactivating) exit 0 ;; esac
      ;;
    *)
      echo "T3_LISTENER_OWNER_UNKNOWN"
      [ "${1:-}" = --apply ] && exit 0
      exit 1
      ;;
  esac
fi
if ! systemctl --user is-active --quiet "$unit"; then
  # A T3 that starts loads everything staged: no restart is pending after it.
  rm -f "$failures"
  echo "T3 is not running; starting it."
  systemctl --user reset-failed "$unit" 2>/dev/null
  systemctl --user start "$unit" || exit 1
  systemctl --user is-active --quiet "$unit" || exit 1
  rm -f "$pending" "$handoff"
  exit 0
fi
[ "$stage" != --stage ] || record_pending
if [ -z "$headless" ] && [ -n "${T3_RENDERER_HIGH_MIB:-}" ]; then
  group=$(systemctl --user show "$unit" --property=ControlGroup --value)
  main_pid=$(systemctl --user show "$unit" --property=MainPID --value)
  python3 -I -B "$here/t3-renderers.py" --main-pid "$main_pid" "$group" "$T3_RENDERER_HIGH_MIB" "$T3_RENDERER_MAX_MIB" ||
    echo "T3 renderer limits could not be applied."
fi
if ! environment=$(curl --fail --silent --max-time 10 "$url"); then
  # Only timed observations count toward the unresponsive threshold.
  [ "${1:-}" != --apply ] || exit 0
  failed=$(count "$failures")
  echo "T3 local API did not answer ($failed/$limit)."
  if [ "$failed" -ge "$limit" ]; then
    rm -f "$failures" "$pending"
    echo "T3 is unresponsive; restarting it."
    systemctl --user reset-failed "$unit" 2>/dev/null
    exec systemctl --user restart "$unit"
  fi
  exit 0
fi
rm -f "$failures"

running=$(printf '%s' "$environment" | sed -n 's/.*"serverVersion" *: *"\([^"]*\)".*/\1/p')
if [ -n "$headless" ]; then
  # The release is the versioned directory the unit runs the server from.
  release=$(systemctl --user show --property=ExecStart --value "$unit" | sed -n 's|.*/t3-\([^/ ]*\)-linux-[a-z0-9]*/t3 .*|\1|p' | head -n 1)
else
  release=$(sed -n 's/^T3-Code-\(.*\)-[a-z0-9]*\.deb$/\1/p' "$installed" 2>/dev/null)
fi
reason=
[ -f "$pending" ] && reason="the staged policy"
if [ -n "$release" ] && [ "$running" != "$release" ]; then
  # One restart per release: a server that still reports another version
  # after it is never restarted in a loop.
  if [ "$(cat "$restarted" 2>/dev/null)" = "$release" ]; then
    echo "T3_RUNNING_VERSION_MISMATCH: restarted for $release, still reports ${running:-nothing}."
    exit 1
  fi
  reason="release $release"
else
  rm -f "$restarted"
fi
[ -z "$reason" ] && exit 0
restart() {
  echo "$1"
  systemctl --user reset-failed "$unit" 2>/dev/null
  systemctl --user restart "$unit" || exit 1
  rm -f "$pending"
  [ "$reason" != "release $release" ] || echo "$release" > "$restarted"
  exit 0
}
if [ "$force" = --force ] || python3 -I -B "$here/t3-idle.py" --state "${T3CODE_HOME:-$HOME/.t3}/userdata/statev2.sqlite"; then
  restart "T3 runs no agent turn; restarting it to load $reason."
fi
# The deadline counts from the second the restart was first deferred: the
# play records it (tasks/t3-restart.yml), and this check does when it is the
# first to defer. A time that cannot be read, or lies ahead, counts from now.
now=$(date +%s)
since=$(cat "$pending" 2>/dev/null)
case "$since" in '' | 0* | *[!0-9]*) since=$((now + 1)) ;; esac
if [ "$since" -gt "$now" ]; then
  since=$now
  echo "$since" > "$pending"
fi
waited=$((now - since))
hours="${T3_RESTART_MAX_DEFERRAL_HOURS:-}"
case "$hours" in '' | 0* | *[!0-9]*) hours= ;; esac
spent="$((waited / 3600))h $((waited % 3600 / 60))m"
if [ -n "$hours" ] && [ "$waited" -ge $((hours * 3600)) ]; then
  restart "T3_RESTART_DEADLINE: $reason has waited $spent, the $hours hours a restart is deferred at most; restarting T3 although agent turns are running. They end."
fi
echo "T3_RESTART_PENDING: agent turns are running; $reason has waited $spent and loads at the first idle check${hours:+, or $hours hours after it was first deferred}."
exit 0

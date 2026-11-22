/** How long an operation waits for the lock before it is refused, in
 * seconds. A manager that looks whether the lock is held takes it for an
 * instant (OPERATION_PROBE in remote-operation.ts): an operation that starts
 * in that instant waits it out instead of reporting a machine nobody holds
 * as locked. bootstrap/fleet-remote-bootstrap.sh waits as long.
 */
export const LOCK_WAIT_SECONDS = 5;

/** POSIX lock prelude shared by every remote operation. Linux uses flock(1);
 * macOS lacks it, so the same descriptor is locked through Python's fcntl. The
 * lock belongs to the shell's open descriptor and persists until that exits.
 */
export function remoteLockPrelude(
  root = '"$HOME/.local/share/personal/fleet"'
): string {
  return [
    `exec 9>${root}/remote-operation.lock`,
    `if command -v flock >/dev/null 2>&1; then flock -w ${LOCK_WAIT_SECONDS} 9; else python3 -c "import fcntl, signal, sys; signal.signal(signal.SIGALRM, lambda *_: sys.exit(1)); signal.alarm(${LOCK_WAIT_SECONDS}); fcntl.flock(9, fcntl.LOCK_EX)" 9>&9; fi`,
  ].join(' && ');
}

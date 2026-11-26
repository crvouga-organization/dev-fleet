#!/usr/bin/python3
"""Recover disk space by deleting only what a build or install can recreate.

Managed by personal fleet-sync: on an Ubuntu worker (tasks/resources.yml) as
personal-fleet-disk-gc.service, started by personal-fleet-disk-gc.timer; on
the macOS manager (ansible/macos/manager.yml) as the launchd job
dev.devfleet.disk-gc. Both run it hourly, or every 15 minutes when fleet.json
says storage is disposable.

What it deletes:
  * dependency and build directories (node_modules, .turbo, dist, Rust target,
    ...) inside git checkouts under the home directory, only when git says the
    directory is ignored, the checkout has been idle for --idle-days and no
    process is running inside it;
  * Docker images and build cache that no container uses and that are older
    than --docker-age-hours, plus unused anonymous volumes under pressure;
  * the apt package cache (where there is apt);
  * agent worktrees under each --worktree-root that nobody has used for
    --worktree-idle-days, only when Git says they hold no uncommitted,
    untracked or unpushed work and no process runs in them (the branch is
    kept);
  * the oldest files of each --cache-cap DIR=MIB cache beyond its size;
  * all but the newest N files of each --keep-newest DIR=N directory (the
    downloaded T3 packages: the current one and the previous one);
  * all but N dev-fleet checkouts of each --keep-checkouts DIR=N directory
    (fleet-owned checkouts named by their commit): the one each --current
    link points at and the most recently used others, never one a process
    runs in;
  * entries of each --expire DIR=HOURS directory nothing was written in for
    that long, never one a process runs in (agents' scratch space);
  * whole children of each --cache-root directory (~/.cache, and
    ~/Library/Caches on macOS) beyond --home-cache-mib, oldest first;
  * tool versions no mise configuration uses (--mise, run as --user).
When a watched filesystem has less than --pressure-mib free, less than
--pressure-percent of its size free, or less than --pressure-inode-percent of
its inodes free, idle checkouts qualify after --pressure-idle-hours, Docker
leftovers after --pressure-docker-age-hours, and aged entries of each
--pressure-cache directory are removed too.

--disposable is the policy of a fleet whose node disks are a cache
(storage.disposable in fleet.json). Work in a worktree that is not on a remote
no longer keeps it once the WIP guard (wip-guard.py) has saved that work to a
recovery ref after the worktree last changed; a worktree whose branch was
deleted on its remote, or merged into the remote's default branch after work
on it, goes whatever its age; and Docker images and build cache no container
uses are pruned on every run, whatever their age.

Running processes are found in --proc (Linux), or with lsof (--lsof, macOS,
which has no /proc). When they cannot be listed, nothing that a process could
be using is removed.

It never deletes a main checkout, a tracked file, uncommitted or unpushed
work that is not saved elsewhere, a container or a named volume. Every
decision is one JSON line on stdout, and the last one says how many MiB were
reclaimed. --report FILE (under --home when relative) also keeps that summary,
with what the worktrees, package stores and tool installs hold, for
fleet-status.

Usage: disk-gc.py --home H [--path P ...] [--idle-days N] [--pressure-mib N]
                  [--pressure-percent N] [--pressure-inode-percent N]
                  [--pressure-idle-hours N] [--docker-age-hours N]
                  [--pressure-docker-age-hours N] [--no-docker] [--pressure-cache DIR ...]
                  [--worktree-root DIR ...] [--worktree-idle-days N] [--disposable]
                  [--recovery-node NAME] [--cache-cap DIR=MIB ...] [--keep-newest DIR=N ...]
                  [--keep-checkouts DIR=N ...] [--current LINK ...] [--expire DIR=HOURS ...]
                  [--cache-root DIR ...] [--mise PATH] [--user NAME] [--report FILE]
                  [--max-depth N] [--proc DIR | --lsof] [--home-only] [--dry-run]

--home-only skips the machine-wide Docker and apt steps.
"""
import argparse
import json
import os
import re
import shutil
import socket
import stat
import subprocess
import sys
import time
from pathlib import Path

MIB = 1024 * 1024
HOUR = 3600
# Directory names that hold only installed dependencies or build output.
REGENERABLE = frozenset({
    'node_modules', '.cache', '.turbo', '.next', '.nuxt', '.svelte-kit', '.astro',
    '.vite', '.parcel-cache', '.expo', '.gradle', 'dist', 'build', 'coverage',
    '.pytest_cache', '.mypy_cache', '.ruff_cache', '__pycache__', '.venv',
})
# Directory names that are regenerable only beside the manifest that builds them.
REGENERABLE_BESIDE = {'target': 'Cargo.toml'}
# Hidden directories under the home directory that still hold checkouts.
HIDDEN_ROOTS = frozenset({'.t3'})
GIT = ['git', '-c', 'safe.directory=*']


def log(**event):
    print(json.dumps(event, sort_keys=True), flush=True)


def free_bytes(path):
    st = os.statvfs(path)
    return st.f_bavail * st.f_frsize


def used_percent(path):
    disk = os.statvfs(path)
    used = disk.f_blocks - disk.f_bfree
    return 100 * used / max(1, used + disk.f_bavail)


def free_inodes_percent(path):
    """Free inodes as a percentage; None on a filesystem without a fixed count."""
    st = os.statvfs(path)
    if st.f_files <= 0:
        return None
    return st.f_favail * 100 / st.f_files


def under_pressure(paths, pressure_bytes, inode_percent, free_percent=0):
    """Any watched filesystem short of free bytes, of a free share of its
    size, or of free inodes."""
    for path in paths:
        if free_bytes(path) < pressure_bytes:
            return True
        st = os.statvfs(path)
        if st.f_blocks > 0 and st.f_bavail * 100 / st.f_blocks < free_percent:
            return True
        inodes = free_inodes_percent(path)
        if inodes is not None and inodes < inode_percent:
            return True
    return False


def mtime(path):
    try:
        return os.lstat(path).st_mtime
    except OSError:
        return 0.0


def is_real_dir(path):
    try:
        return stat.S_ISDIR(os.lstat(path).st_mode)
    except OSError:
        return False


def find_checkouts(home, max_depth):
    """Git checkouts (repositories and worktrees) under home, outermost only."""
    found = []

    def walk(directory, depth):
        if os.path.lexists(os.path.join(directory, '.git')):
            found.append(directory)
            return
        if depth >= max_depth:
            return
        try:
            entries = list(os.scandir(directory))
        except OSError:
            return
        for entry in entries:
            if not entry.is_dir(follow_symlinks=False):
                continue
            name = entry.name
            if name in REGENERABLE or name in REGENERABLE_BESIDE:
                continue
            if name.startswith('.') and not (depth == 0 and name in HIDDEN_ROOTS):
                continue
            walk(entry.path, depth + 1)

    walk(home, 0)
    return sorted(found)


def git_dir(checkout):
    """The checkout's git directory, following a worktree's .git file."""
    dot_git = os.path.join(checkout, '.git')
    if is_real_dir(dot_git):
        return dot_git
    try:
        text = Path(dot_git).read_text()
    except OSError:
        return None
    if not text.startswith('gitdir:'):
        return None
    target = text[len('gitdir:'):].strip()
    target = os.path.normpath(os.path.join(checkout, target))
    return target if is_real_dir(target) else None


def run_git(checkout, args, data=None):
    try:
        out = subprocess.run(GIT + ['-C', checkout] + args, input=data,
                             capture_output=True, timeout=600)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return out


def candidates(checkout):
    """Regenerable directories in a checkout, outermost only, never through a link."""
    found = []
    for current, dirs, files in os.walk(checkout):
        keep = []
        for name in dirs:
            path = os.path.join(current, name)
            if name == '.git' or os.path.islink(path):
                continue
            if os.path.lexists(os.path.join(path, '.git')):
                continue  # a nested repository answers for itself
            beside = REGENERABLE_BESIDE.get(name)
            if name in REGENERABLE or (beside and beside in files):
                found.append(path)
                continue
            keep.append(name)
        dirs[:] = keep
    return found


def ignored(checkout, paths):
    """The subset of paths git ignores; tracked or unignored paths are kept."""
    if not paths:
        return []
    rel = [os.path.relpath(p, checkout) for p in paths]
    out = run_git(checkout, ['check-ignore', '--stdin', '-z'],
                  data=('\0'.join(rel) + '\0').encode())
    if out is None or out.returncode not in (0, 1):
        return []
    hits = {item for item in out.stdout.decode(errors='replace').split('\0') if item}
    return [p for p, r in zip(paths, rel) if r in hits or r.rstrip('/') in hits]


def git_activity(checkout, gdir):
    """The latest commit, checkout or index refresh: cheap, read first."""
    marks = [checkout, os.path.join(gdir, 'index'), os.path.join(gdir, 'HEAD'),
             os.path.join(gdir, 'logs', 'HEAD')]
    return max(mtime(p) for p in marks)


def last_activity(checkout, gdir, dirs):
    """The latest sign of work: git activity, changed files, build output writes."""
    latest = max([git_activity(checkout, gdir)] + [mtime(p) for p in dirs])
    out = run_git(checkout, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    if out is None or out.returncode != 0:
        return None
    entries = out.stdout.decode(errors='replace').split('\0')
    for entry in entries:
        if len(entry) > 3:
            latest = max(latest, mtime(os.path.join(checkout, entry[3:])))
    return latest


def busy_roots(proc, lsof=False):
    """Working directories of every running process, or None when they cannot
    be listed: then nothing a process could be using may go."""
    if lsof:
        return lsof_roots()
    roots = set()
    try:
        pids = [p for p in os.listdir(proc) if p.isdigit()]
    except OSError:
        return roots
    for pid in pids:
        try:
            roots.add(os.readlink(os.path.join(proc, pid, 'cwd')))
        except OSError:
            continue
    return roots


def lsof_roots():
    """macOS has no /proc: lsof names each process's working directory."""
    try:
        out = subprocess.run(['lsof', '-n', '-w', '-a', '-d', 'cwd', '-F', 'n'],
                             capture_output=True, timeout=300)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if out.returncode not in (0, 1):
        return None
    roots = {line[1:] for line in out.stdout.decode(errors='replace').splitlines()
             if line.startswith('n/')}
    # This process has a working directory too: an empty list is a failure.
    return roots or None


def in_use(checkout, roots):
    prefix = checkout.rstrip('/') + '/'
    return any(r == checkout or r.startswith(prefix) for r in roots)


def size_of(path):
    total = 0
    for current, dirs, files in os.walk(path):
        for name in dirs + files:
            try:
                total += os.lstat(os.path.join(current, name)).st_blocks * 512
            except OSError:
                continue
    return total


def remove(path, dry_run):
    """Deletes one directory without following links; returns bytes freed."""
    if not is_real_dir(path):
        return 0
    size = size_of(path)
    if not dry_run:
        shutil.rmtree(path, ignore_errors=True)
        if os.path.lexists(path):
            return 0
    return size


def collect_checkouts(home, idle_seconds, max_depth, busy, now, dry_run):
    roots = busy()
    if roots is None:
        log(event='checkouts_skipped', reason='processes_unlisted')
        return 0
    freed = 0
    for checkout in find_checkouts(home, max_depth):
        gdir = git_dir(checkout)
        if gdir is None:
            log(event='checkout_skipped', checkout=checkout, reason='no_git_dir')
            continue
        if in_use(checkout, roots) or now - git_activity(checkout, gdir) < idle_seconds:
            continue
        dirs = ignored(checkout, candidates(checkout))
        if not dirs:
            continue
        latest = last_activity(checkout, gdir, dirs)
        if latest is None:
            log(event='checkout_skipped', checkout=checkout, reason='git_status_failed')
            continue
        if now - latest < idle_seconds:
            continue
        for path in dirs:
            got = remove(path, dry_run)
            freed += got
            log(event='removed', path=path, mib=got // MIB, dry_run=dry_run)
    return freed


def collect_cache(directory, age_seconds, now, dry_run):
    """Removes top-level cache entries not written for age_seconds."""
    freed = 0
    try:
        entries = list(os.scandir(directory))
    except OSError:
        return 0
    for entry in entries:
        if now - mtime(entry.path) < age_seconds:
            continue
        if entry.is_dir(follow_symlinks=False):
            got = remove(entry.path, dry_run)
        elif entry.is_file(follow_symlinks=False):
            got = entry.stat(follow_symlinks=False).st_blocks * 512
            if not dry_run:
                try:
                    os.unlink(entry.path)
                except OSError:
                    got = 0
        else:
            continue
        freed += got
    if freed:
        log(event='cache_pruned', cache=directory, mib=freed // MIB, dry_run=dry_run)
    return freed


def linked_worktrees(root, max_depth=3):
    """Linked worktrees (a .git file, never a repository) under root."""
    found = []

    def walk(directory, depth):
        dot_git = os.path.join(directory, '.git')
        if os.path.lexists(dot_git):
            if not is_real_dir(dot_git) and not os.path.islink(dot_git):
                found.append(directory)
            return
        if depth >= max_depth:
            return
        try:
            entries = list(os.scandir(directory))
        except OSError:
            return
        for entry in entries:
            if entry.is_dir(follow_symlinks=False) and entry.name not in REGENERABLE:
                walk(entry.path, depth + 1)

    walk(root, 0)
    return sorted(found)


def unsaved_work(worktree):
    """Why Git cannot vouch for a worktree, or None when everything in it is
    committed and every commit is on a remote."""
    status = run_git(worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    if status is None or status.returncode != 0:
        return 'git_status_failed'
    if status.stdout.strip(b'\0'):
        return 'uncommitted'
    unpushed = run_git(worktree, ['rev-list', '-n', '1', 'HEAD', '--not', '--remotes'])
    if unpushed is None or unpushed.returncode != 0:
        return 'git_rev_list_failed'
    if unpushed.stdout.strip():
        return 'unpushed'
    return None


def ref_part(value):
    """A branch or node name as wip-guard.py writes it into a recovery ref."""
    part = re.sub(r'[^A-Za-z0-9._/-]+', '-', value).strip('./-')
    part = re.sub(r'/+', '/', part).replace('..', '.')
    return part or 'unnamed'


def git_line(worktree, args):
    out = run_git(worktree, args)
    if out is None or out.returncode != 0:
        return ''
    return out.stdout.decode(errors='replace').strip()


def saved_in_recovery_ref(worktree, node, latest):
    """Whether the WIP guard saved this worktree's work after it last changed.

    wip-guard.py pushes the worktree's files as one commit on HEAD (or HEAD
    itself when only commits are unpushed) to refs/recovery/<node>/<branch>
    of the remote, and keeps the same ref locally once the push succeeded.
    The save counts when it is of this HEAD and no older than the worktree's
    last change.
    """
    head = git_line(worktree, ['rev-parse', '--verify', '--quiet', 'HEAD'])
    if not head:
        return False
    branch = git_line(worktree, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
    ref = 'refs/recovery/%s/%s' % (ref_part(node), ref_part(branch or 'detached-' + head[:12]))
    saved = git_line(worktree, ['rev-parse', '--verify', '--quiet', ref + '^{commit}'])
    if not saved:
        return False
    if saved != head and git_line(worktree, ['rev-parse', '--verify', '--quiet', saved + '^']) != head:
        return False
    when = git_line(worktree, ['show', '-s', '--format=%ct', saved])
    return when.isdigit() and int(when) >= int(latest)


def as_user(argv, user, home):
    if user:
        return ['runuser', '-u', user, '--', 'env', f'HOME={home}'] + argv
    return argv


def refresh_remotes(worktrees, user, home):
    """Fetches each repository's remotes once, pruning deleted branches.

    Run as the development user: the objects it writes belong to that user,
    and so do the credentials of a private remote. A failed fetch leaves the
    remote-tracking refs as they were.
    """
    done = set()
    for worktree in worktrees:
        common = git_line(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
        if not common or common in done:
            continue
        done.add(common)
        try:
            out = subprocess.run(
                as_user(GIT + ['--git-dir', common, 'fetch', '--all', '--prune', '--quiet'], user, home),
                capture_output=True, timeout=300,
                env={**os.environ, 'GIT_TERMINAL_PROMPT': '0'})
            ok = out.returncode == 0
        except (OSError, subprocess.TimeoutExpired):
            ok = False
        if not ok:
            log(event='fetch_failed', repository=common)


def retired(worktree):
    """Why the worktree's branch is done with on its remote, or None.

    deleted: the branch was pushed and its remote branch is gone (a merged
    pull request whose branch was deleted, or one closed with its branch
    deleted). merged: commits were made on the branch and its HEAD is in the
    remote's default branch. A branch that was never pushed and never had a
    commit of its own is neither: that is a task that has just started.
    """
    branch = git_line(worktree, ['symbolic-ref', '--quiet', 'HEAD'])
    if not branch:
        return None
    upstream = git_line(worktree, ['for-each-ref', '--format=%(upstream:track)', branch])
    if upstream == '[gone]':
        return 'deleted'
    remote = git_line(worktree, ['config', '--get', 'branch.%s.remote' % branch[len('refs/heads/'):]]) or 'origin'
    default = git_line(worktree, ['symbolic-ref', '--quiet', 'refs/remotes/%s/HEAD' % remote])
    candidates = [default] if default else ['refs/remotes/%s/main' % remote, 'refs/remotes/%s/master' % remote]
    target = next((ref for ref in candidates
                   if git_line(worktree, ['rev-parse', '--verify', '--quiet', ref])), None)
    if not target:
        return None
    merged = run_git(worktree, ['merge-base', '--is-ancestor', 'HEAD', target])
    if merged is None or merged.returncode != 0:
        return None
    reflog = git_line(worktree, ['reflog', 'show', '--format=%gs', branch])
    worked = any(not entry.startswith('branch: Created from')
                 for entry in reflog.splitlines() if entry)
    return 'merged' if worked else None


def collect_worktrees(root, idle_seconds, busy, now, dry_run, disposable=False,
                      node=None, user=None, home=None):
    worktrees = linked_worktrees(root)
    # What each branch's remote branch held before the fetch: once it is
    # deleted, that is the only proof every commit of the worktree was pushed.
    pushed = {}
    if disposable and worktrees:
        pushed = {w: git_line(w, ['rev-parse', '--verify', '--quiet', '@{upstream}'])
                  for w in worktrees}
        refresh_remotes(worktrees, user, home)
    roots = busy()
    if roots is None:
        if worktrees:
            log(event='worktrees_skipped', root=root, reason='processes_unlisted')
        return 0
    freed = 0
    for worktree in worktrees:
        gdir = git_dir(worktree)
        if gdir is None or in_use(worktree, roots):
            continue
        done = retired(worktree) if disposable else None
        if not done:
            if now - git_activity(worktree, gdir) < idle_seconds:
                continue
        latest = last_activity(worktree, gdir, [])
        if latest is None or (not done and now - latest < idle_seconds):
            continue
        reason = unsaved_work(worktree)
        if reason == 'unpushed' and done == 'deleted' and pushed.get(worktree) and \
                pushed[worktree] == git_line(worktree, ['rev-parse', 'HEAD']):
            # Its commits were on the remote branch until it was deleted.
            reason = None
        if reason in ('uncommitted', 'unpushed') and disposable:
            if saved_in_recovery_ref(worktree, node, latest):
                log(event='worktree_saved', worktree=worktree, reason=reason)
                reason = None
            else:
                reason += '_not_in_recovery_ref'
        if reason:
            log(event='worktree_kept', worktree=worktree, reason=reason)
            continue
        size = size_of(worktree)
        if not dry_run:
            common = run_git(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
            if common is None or common.returncode != 0:
                continue
            out = subprocess.run(
                GIT + ['--git-dir', common.stdout.decode().strip(), 'worktree', 'remove', '--force', worktree],
                capture_output=True, timeout=600)
            if out.returncode != 0 or os.path.lexists(worktree):
                log(event='worktree_kept', worktree=worktree, reason='git_worktree_remove_failed')
                continue
        freed += size
        log(event='worktree_removed', worktree=worktree, mib=size // MIB, dry_run=dry_run,
            **({'branch': done} if done else {}))
    return freed


def files_under(directory):
    """Every regular file under directory, never through a link."""
    found = []
    for current, dirs, files in os.walk(directory):
        dirs[:] = [d for d in dirs if not os.path.islink(os.path.join(current, d))]
        for name in files:
            path = os.path.join(current, name)
            try:
                st = os.lstat(path)
            except OSError:
                continue
            if stat.S_ISREG(st.st_mode):
                found.append((st.st_mtime, st.st_blocks * 512, path))
    return found


def unlink(path, dry_run):
    if dry_run:
        return True
    try:
        os.unlink(path)
        return True
    except OSError:
        return False


def cap_cache(directory, cap_bytes, dry_run):
    """Removes the oldest files of a cache until it fits its cap."""
    entries = sorted(files_under(directory))
    total = sum(size for _, size, _ in entries)
    freed = 0
    for _, size, path in entries:
        if total - freed <= cap_bytes:
            break
        if unlink(path, dry_run):
            freed += size
    if not dry_run:
        for current, dirs, files in os.walk(directory, topdown=False):
            if current != directory and not dirs and not files:
                try:
                    os.rmdir(current)
                except OSError:
                    pass
    if freed:
        log(event='cache_capped', cache=directory, mib=freed // MIB,
            cap_mib=cap_bytes // MIB, dry_run=dry_run)
    return freed


def keep_newest(directory, count, dry_run):
    """Removes all but the newest count files directly in directory."""
    try:
        entries = [e for e in os.scandir(directory) if e.is_file(follow_symlinks=False)]
    except OSError:
        return 0
    entries.sort(key=lambda e: e.stat(follow_symlinks=False).st_mtime, reverse=True)
    freed = 0
    for entry in entries[count:]:
        size = entry.stat(follow_symlinks=False).st_blocks * 512
        if unlink(entry.path, dry_run):
            freed += size
            log(event='superseded_removed', path=entry.path, mib=size // MIB, dry_run=dry_run)
    return freed


COMMIT = re.compile(r'^[0-9a-f]{40}$')


def keep_checkouts(directory, count, protected, busy, dry_run):
    """Keeps count fleet-owned checkouts of dev-fleet in directory.

    Each is named by its commit. The ones a --current link points at are kept
    first, then the most recently used others; a checkout a process runs in
    is never removed. A checkout made with `git worktree add` leaves an entry
    its repository prunes (`git worktree prune`) on the next sync.
    """
    try:
        entries = [e.path for e in os.scandir(directory)
                   if COMMIT.match(e.name) and e.is_dir(follow_symlinks=False)]
    except OSError:
        return 0
    if len(entries) <= count:
        return 0
    roots = busy()
    if roots is None:
        log(event='checkouts_kept', directory=directory, reason='processes_unlisted')
        return 0
    entries.sort(key=mtime, reverse=True)
    kept = [e for e in entries if os.path.realpath(e) in protected]
    freed = 0
    for path in entries:
        if path in kept:
            continue
        if len(kept) < count or in_use(path, roots):
            kept.append(path)
            continue
        got = remove(path, dry_run)
        log_file = path + '.setup.log'
        if os.path.isfile(log_file) and not os.path.islink(log_file):
            got += os.lstat(log_file).st_blocks * 512
            unlink(log_file, dry_run)
        freed += got
        log(event='checkout_removed', path=path, mib=got // MIB, dry_run=dry_run)
    return freed


def latest_write(path):
    """The newest modification time of path and of everything under it."""
    if not is_real_dir(path):
        return mtime(path)
    return max([mtime(path)] + [stamp for stamp, _, _ in files_under(path)]
               + [mtime(current) for current, _, _ in os.walk(path)])


def expire_entries(directory, hours, busy, now, dry_run):
    """Removes entries of directory nothing was written in for hours."""
    try:
        entries = list(os.scandir(directory))
    except OSError:
        return 0
    if not entries:
        return 0
    roots = busy()
    if roots is None:
        log(event='expiry_skipped', directory=directory, reason='processes_unlisted')
        return 0
    freed = 0
    for entry in entries:
        if now - latest_write(entry.path) < hours * HOUR or in_use(entry.path, roots):
            continue
        if entry.is_dir(follow_symlinks=False):
            got = remove(entry.path, dry_run)
        else:
            got = entry.stat(follow_symlinks=False).st_blocks * 512
            if not unlink(entry.path, dry_run):
                got = 0
        freed += got
    if freed:
        log(event='expired', directory=directory, mib=freed // MIB, dry_run=dry_run)
    return freed


def footprint(paths):
    """What the files under paths hold: their bytes, the bytes of the ones
    that have more than one link, and their share of the disk, where a file
    with N links is charged a 1/N share to each of them. Nothing is
    remembered per file: a node may hold millions."""
    total = linked = charged = 0
    for top in paths:
        if not is_real_dir(top):
            continue
        for current, dirs, files in os.walk(top):
            dirs[:] = [d for d in dirs if not os.path.islink(os.path.join(current, d))]
            for name in files:
                try:
                    st = os.lstat(os.path.join(current, name))
                except OSError:
                    continue
                if not stat.S_ISREG(st.st_mode):
                    continue
                size = st.st_blocks * 512
                total += size
                charged += size / max(1, st.st_nlink)
                if st.st_nlink > 1:
                    linked += size
    return total, linked, int(charged)


# Package stores installs link from instead of copying (mise.toml [env]).
LINKED_STORES = ('pnpm', 'bun')


def measure(home, worktree_roots):
    """What the worktrees, the package stores and the tool installs take on
    disk, the share of the worktrees' and stores' bytes that is hardlinked,
    and whether every store is on the filesystem of every worktree root:
    hardlinks cannot cross filesystems."""
    worktrees = [os.path.join(home, root) for root in worktree_roots]
    stores = [os.path.join(home, STORES[name][0]) for name in LINKED_STORES]
    tools = [os.path.join(home, '.local', 'share', 'mise', 'installs')]
    worktree_total, worktree_linked, worktree_bytes = footprint(worktrees)
    store_total, store_linked, store_bytes = footprint(stores)
    _, _, tool_bytes = footprint(tools)
    total = worktree_total + store_total
    devices = {}
    for path in worktrees + stores:
        try:
            devices[path] = os.stat(path).st_dev
        except OSError:
            continue
    present_roots = [devices[p] for p in worktrees if p in devices]
    present_stores = [devices[p] for p in stores if p in devices]
    same = None
    if present_roots and present_stores:
        same = len(set(present_roots + present_stores)) == 1
    return {
        'worktreesMiB': worktree_bytes // MIB,
        'storesMiB': store_bytes // MIB,
        'toolsMiB': tool_bytes // MIB,
        'hardlinkedPercent': round((worktree_linked + store_linked) * 100 / total) if total else 0,
        'sameFilesystem': same,
    }


def write_report(path, report):
    """Replaces the report in one step: a reader never sees half of it."""
    directory = os.path.dirname(path) or '.'
    os.makedirs(directory, exist_ok=True)
    temporary = path + '.tmp'
    with open(temporary, 'w') as out:
        json.dump(report, out, sort_keys=True)
    os.chmod(temporary, 0o644)
    os.replace(temporary, path)


def pair(text, kind):
    name, _, value = text.rpartition('=')
    if not name:
        raise argparse.ArgumentTypeError(f'expected DIR={kind}')
    return name, int(value)


def command(argv, dry_run, name, **detail):
    if shutil.which(argv[0]) is None:
        return
    if dry_run:
        log(event='would_run', step=name, **detail)
        return
    try:
        out = subprocess.run(argv, capture_output=True, timeout=1800)
        log(event='ran', step=name, ok=out.returncode == 0, **detail)
    except (OSError, subprocess.TimeoutExpired) as exc:
        log(event='ran', step=name, ok=False, error=type(exc).__name__, **detail)


def cache_children(directory, cap, excluded, pressure, idle, now, dry_run):
    """Remove whole cache entries; keep protected stores for their own managers."""
    if not is_real_dir(directory):
        return 0
    entries = []
    for entry in os.scandir(directory):
        if entry.name in excluded or not entry.is_dir(follow_symlinks=False):
            continue
        files = files_under(entry.path)
        latest = max([mtime(entry.path)] + [stamp for stamp, _, _ in files])
        entries.append((latest, sum(size for _, size, _ in files), entry.path))
    total = sum(size for _, size, _ in entries)
    freed = 0
    for latest, size, path in sorted(entries):
        if total - freed <= cap and not (pressure and now - latest >= idle):
            break
        freed += remove(path, dry_run)
    return freed


STORES = {
    'pnpm': ('.local/share/pnpm/store', ['pnpm', 'store', 'prune']),
    'npm': ('.npm/_cacache', ['npm', 'cache', 'clean', '--force']),
    'bun': ('.bun/install/cache', ['bun', 'pm', 'cache', 'rm']),
    'uv': ('.cache/uv', ['uv', 'cache', 'prune']),
}


def package_operation_active():
    """Skip collection while a package manager is installing, linking or pruning."""
    try:
        rows = subprocess.run(['ps', '-A', '-o', 'args='], capture_output=True,
                              text=True, timeout=10, check=True).stdout.splitlines()
    except (OSError, subprocess.SubprocessError, UnicodeError):
        return True
    return any(re.search(r'^\s*(?:\S*/)?(?:(?:node(?:-MainThread)?|bun)\s+(?:\S*/)?)?(?:pnpm|npm(?:-cli)?|yarn|bun)(?:\.c?js)?(?:\s+(?:install|add|i|ci|update|upgrade|remove|prune|store)(?:\s|$)|\s*$)', row)
               for row in rows)


def pnpm_stores(args, home, root, prune):
    """Ask each installed CLI which store it manages. Never remove store files ourselves."""
    generations = {entry.name: 'below-cap' for entry in os.scandir(root)
                   if re.fullmatch(r'v[0-9]+', entry.name) and entry.is_dir(follow_symlinks=False)}
    if not prune or not generations:
        return generations
    if package_operation_active():
        return dict.fromkeys(generations, 'busy')
    generations = dict.fromkeys(generations, 'unsupported')
    candidates = [[args.mise, 'exec', '--', 'pnpm']] if args.mise else []
    for folder in sorted(Path(home, '.local/share/mise/installs/pnpm').glob('*')):
        if not folder.is_symlink() and re.fullmatch(r'[0-9]+(?:\.[0-9]+){2}', folder.name):
            candidates.extend([[str(exe)] for exe in [folder / 'pnpm', folder / 'bin/pnpm']
                               if exe.is_file()])
    for pattern in ('.local/share/pnpm/.tools/pnpm/*/bin/pnpm',
                    '.local/share/pnpm/.tools/pnpm/*/node_modules/pnpm/bin/pnpm.cjs',
                    '.cache/node/corepack/v1/pnpm/*/bin/pnpm.cjs'):
        candidates.extend([[str(exe)] for exe in sorted(Path(home).glob(pattern))
                           if exe.is_file() and os.access(exe, os.X_OK)])
    env = {**os.environ, 'npm_config_store_dir': root, 'pnpm_config_store_dir': root,
           'npm_config_manage_package_manager_versions': 'false'}
    for cli in candidates:
        try:
            cmd = cli + ['--store-dir', root, 'store']
            reply = subprocess.run(cmd + ['path'], env=env, cwd=home, capture_output=True,
                                   text=True, timeout=30, check=True).stdout.strip()
            generation = os.path.basename(reply)
            if (generation not in generations or generations[generation] != 'unsupported'
                    or reply != os.path.join(root, generation)):
                continue
            if args.dry_run:
                generations[generation] = 'would-prune'
            else:
                result = subprocess.run(cmd + ['prune'], env=env, cwd=home,
                                        capture_output=True, timeout=1800)
                generations[generation] = 'pruned' if result.returncode == 0 else 'failed'
        except (OSError, subprocess.SubprocessError, UnicodeError):
            continue
    return generations


def collect_staging(root, busy, cutoff, dry_run):
    """Bun names extracted tarballs .<nonce>-<counter>.<unscoped package basename>.
    Accept only complete matching package layouts with no mounted, linked,
    foreign, active or recent entry. All inspection is descriptor-relative."""
    if busy is None or os.getuid() == 0 or package_operation_active():
        return 0
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    freed = 0
    with os.scandir(root) as entries:
        names = [entry.name for entry in entries if entry.is_dir(follow_symlinks=False)]
    parent = os.open(root, flags)
    try:
        for name in names:
            match = re.fullmatch(r'\.[a-fA-F0-9]{1,16}-[a-fA-F0-9]{1,16}\.([a-zA-Z0-9_.-]{1,32})', name)
            if not match or any(p == name or p.startswith(name + '/') for p in busy):
                continue
            try:
                fd = os.open(name, flags, dir_fd=parent)
                try:
                    size = staging_size(fd, match[1], cutoff)
                    if size is None or not os.path.samestat(os.fstat(fd), os.stat(name, dir_fd=parent, follow_symlinks=False)):
                        continue
                    if not dry_run:
                        shutil.rmtree(name, dir_fd=parent)
                    freed += size
                finally:
                    os.close(fd)
            except (OSError, ValueError, UnicodeError):
                continue
    finally:
        os.close(parent)
    return freed


def staging_size(fd, basename, cutoff):
    top = os.fstat(fd)
    uid = os.getuid()
    if top.st_uid != uid or top.st_mtime >= cutoff:
        return None
    size = 0
    def unreadable(error):
        raise error
    for _, dirs, files, directory in os.fwalk('.', dir_fd=fd, onerror=unreadable):
        for name in dirs + files:
            info = os.stat(name, dir_fd=directory, follow_symlinks=False)
            if (info.st_dev != top.st_dev or info.st_uid != uid or info.st_mtime >= cutoff
                    or name in ('.git', 'node_modules') or stat.S_ISLNK(info.st_mode)):
                return None
            if stat.S_ISREG(info.st_mode):
                if info.st_atime >= cutoff or info.st_nlink != 1:
                    return None
                size += info.st_blocks * 512
            elif not stat.S_ISDIR(info.st_mode):
                return None
    manifest = os.open('package.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    with os.fdopen(manifest, 'rb') as stream:
        if not stat.S_ISREG(os.fstat(manifest).st_mode):
            return None
        content = stream.read(262145)
    if len(content) > 262144:
        return None
    value = json.loads(content)
    if not isinstance(value, dict) or not isinstance(value.get('version'), str):
        return None
    package = value.get('name')
    if isinstance(package, str) and package.rsplit('/', 1)[-1][:32] == basename:
        return size
    return None


def prune_stores(args, home, pressure):
    generations = {}
    freed = 0
    for name, cap in args.store_cap:
        relative, argv = STORES[name]
        path = os.path.join(home, relative)
        if not is_real_dir(path):
            continue
        before = size_of(path)
        if name == 'pnpm':
            generations = pnpm_stores(args, home, path, pressure or before > cap * MIB)
            freed += max(0, before - size_of(path))
        elif pressure or before > cap * MIB:
            command([args.mise, 'exec', '--'] + argv, args.dry_run, name + '_store')
            freed += max(0, before - size_of(path))
    return freed, generations


def open_temp_paths(alias, proc, host_path='/var/tmp'):
    """Inspect host processes before dropping privileges. The private mount
    namespace may give a file a different name in the collector and its user."""
    paths = set()

    def record(path):
        for root in (host_path, alias):
            if path.startswith(root + '/'):
                paths.add(path[len(root) + 1:])

    try:
        for process in os.scandir(proc):
            if not process.name.isdigit():
                continue
            try:
                record(os.readlink(process.path + '/cwd'))
                for fd in os.scandir(process.path + '/fd'):
                    try:
                        record(os.readlink(fd.path))
                    except FileNotFoundError:
                        continue
                with open(process.path + '/maps', 'rb') as maps:
                    for line in maps:
                        fields = line.rstrip(b'\n').split(None, 5)
                        if len(fields) == 6:
                            record(os.fsdecode(fields[5]))
            except (FileNotFoundError, ProcessLookupError):
                continue
    except OSError:
        return None
    return sorted(paths)


def collect_temp_files(root, busy, cutoff, dry_run):
    """Only the worker user unlinks files. Walk relative to directory descriptors
    without following symlinks, including when a directory is replaced mid-walk."""
    if busy is None:
        return 0
    uid = os.getuid()
    if uid == 0:
        raise ValueError('host temporary files must be collected as the worker user')
    names = {f'jest_{base36(uid)}',
             'node-compile-cache', 'metro-cache', f'tsx-{uid}'}
    protected = set(busy)
    freed = 0
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    for name in sorted(names - protected):
        try:
            top = os.open(os.path.join(root, name), flags)
        except OSError:
            continue
        try:
            info = os.fstat(top)
            if info.st_uid != uid:
                continue
            for directory, dirs, files, fd in os.fwalk('.', dir_fd=top):
                prefix = os.path.normpath(os.path.join(name, directory))
                current = os.fstat(fd)
                if current.st_dev != info.st_dev or current.st_uid != uid or prefix in protected:
                    dirs.clear()
                    continue
                for entry in files:
                    if prefix + '/' + entry in protected:
                        continue
                    try:
                        item = os.stat(entry, dir_fd=fd, follow_symlinks=False)
                        if (stat.S_ISREG(item.st_mode) and item.st_uid == uid
                                and max(item.st_atime, item.st_mtime) < cutoff):
                            if not dry_run:
                                os.unlink(entry, dir_fd=fd)
                            if item.st_nlink == 1:
                                freed += item.st_blocks * 512
                    except OSError:
                        continue
        finally:
            os.close(top)
    return freed


def base36(value):
    """Jest names the user's cache with the uid encoded in base 36."""
    digits = '0123456789abcdefghijklmnopqrstuvwxyz'
    result = ''
    while value:
        value, digit = divmod(value, 36)
        result = digits[digit] + result
    return result or '0'


def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument('--home', required=True)
    parser.add_argument('--path', action='append', default=[])
    parser.add_argument('--idle-days', type=float, default=7)
    parser.add_argument('--pressure-mib', type=int, default=15360)
    parser.add_argument('--target-used-percent', type=int, choices=range(1, 100))
    parser.add_argument('--pressure-percent', type=float, default=0)
    parser.add_argument('--pressure-inode-percent', type=float, default=0)
    parser.add_argument('--pressure-idle-hours', type=float, default=12)
    parser.add_argument('--docker-age-hours', type=int, default=168)
    parser.add_argument('--pressure-docker-age-hours', type=int, default=24)
    # A worker without containers (fleet.json features.containers) has no
    # Docker to prune.
    parser.add_argument('--docker-cap-percent', type=float)
    parser.add_argument('--home-cache-mib', type=int)
    parser.add_argument('--cache-root', action='append', default=[])
    parser.add_argument('--exclude-cache', action='append', default=[])
    parser.add_argument('--store-cap', action='append', default=[], type=lambda text: pair(text, 'MIB'))
    parser.add_argument('--host-var-tmp')
    parser.add_argument('--host-tmp')
    parser.add_argument('--mise-cache-mib', type=int)
    parser.add_argument('--user-caches-only', action='store_true')
    parser.add_argument('--no-docker', action='store_true')
    parser.add_argument('--pressure-cache', action='append', default=[])
    parser.add_argument('--worktree-root', action='append', default=[])
    parser.add_argument('--worktree-idle-days', type=float, default=30)
    parser.add_argument('--disposable', action='store_true')
    parser.add_argument('--recovery-node', default=socket.gethostname().split('.')[0])
    parser.add_argument('--cache-cap', action='append', default=[],
                        type=lambda text: pair(text, 'MIB'))
    parser.add_argument('--keep-newest', action='append', default=[],
                        type=lambda text: pair(text, 'N'))
    parser.add_argument('--keep-checkouts', action='append', default=[],
                        type=lambda text: pair(text, 'N'))
    parser.add_argument('--current', action='append', default=[])
    parser.add_argument('--expire', action='append', default=[],
                        type=lambda text: pair(text, 'HOURS'))
    parser.add_argument('--mise')
    parser.add_argument('--user')
    parser.add_argument('--report')
    parser.add_argument('--max-depth', type=int, default=4)
    parser.add_argument('--proc', default='/proc')
    parser.add_argument('--lsof', action='store_true')
    parser.add_argument('--home-only', action='store_true')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args(argv)
    home = os.path.realpath(args.home)
    paths = args.path or ['/', home]
    now = time.time()
    before = {p: free_bytes(p) for p in paths}
    pressure = under_pressure(paths, args.pressure_mib * MIB,
                              args.pressure_inode_percent, args.pressure_percent)
    target = args.target_used_percent
    initial_used = max(used_percent(p) for p in paths) if target else None
    if target and initial_used > target:
        pressure = True
    # Pressure only ever shortens a limit: a disposable fleet's is shorter
    # than the pressure one already.
    idle = args.idle_days * 24 * HOUR
    if pressure:
        idle = min(idle, args.pressure_idle_hours * HOUR)
    docker_age = args.pressure_docker_age_hours if pressure else args.docker_age_hours
    log(event='started', pressure=pressure, idle_hours=idle / HOUR,
        docker_age_hours=docker_age, dry_run=args.dry_run, disposable=args.disposable,
        free_mib={p: v // MIB for p, v in before.items()})
    cache_roots = args.cache_root or ['.cache']

    def busy():
        return busy_roots(args.proc, args.lsof)

    if args.user_caches_only:
        temporary = staging = 0
        inspected = json.load(sys.stdin) if args.host_var_tmp or args.host_tmp else {}
        if args.host_tmp:
            staging = collect_staging(args.host_tmp, inspected.get('tmp'), now - idle, args.dry_run)
        if args.host_var_tmp:
            opened = inspected.get('var_tmp')
            staging += collect_staging(args.host_var_tmp, opened, now - idle, args.dry_run)
            temporary = collect_temp_files(args.host_var_tmp, opened,
                                           now - idle, args.dry_run)
        caches = sum(cache_children(os.path.join(home, root), args.home_cache_mib * MIB,
                                    args.exclude_cache, pressure, idle, now, args.dry_run)
                     for root in cache_roots)
        stores, generations = prune_stores(args, home, pressure)
        mise_bytes = 0
        if args.mise_cache_mib is not None:
            directory = os.path.join(home, '.cache', 'mise')
            before_cache = size_of(directory)
            if before_cache > args.mise_cache_mib * MIB or pressure:
                command(['env', f'MISE_CACHE_PRUNE_AGE={int(idle)}s', args.mise,
                         'cache', 'prune'], args.dry_run, 'mise_cache')
                mise_bytes = max(0, before_cache - size_of(directory))
        log(pnpm_generations=generations, staging_bytes=staging, cache_bytes=caches, store_bytes=stores, temporary_bytes=temporary,
            mise_cache_bytes=mise_bytes)
        return
    categories = {}
    generations = {}
    freed = collect_checkouts(home, idle, args.max_depth, busy, now, args.dry_run)
    categories['checkouts'] = freed
    reclaimed = 0
    if pressure:
        for cache in args.pressure_cache:
            reclaimed += collect_cache(os.path.join(home, cache), idle, now, args.dry_run)
    categories['pressure_caches'] = reclaimed
    reclaimed = 0
    for root in args.worktree_root:
        reclaimed += collect_worktrees(os.path.join(home, root),
                                       min(idle, args.worktree_idle_days * 24 * HOUR)
                                       if pressure else args.worktree_idle_days * 24 * HOUR,
                                       busy, now, args.dry_run, args.disposable,
                                       args.recovery_node, args.user, home)
    categories['worktrees'] = reclaimed
    reclaimed = 0
    protected = {os.path.realpath(os.path.join(home, link)) for link in args.current}
    for directory, count in args.keep_checkouts:
        reclaimed += keep_checkouts(os.path.join(home, directory), count, protected,
                                    busy, args.dry_run)
    categories['fleet_checkouts'] = reclaimed
    reclaimed = 0
    for directory, hours in args.expire:
        reclaimed += expire_entries(os.path.join(home, directory), hours, busy, now,
                                    args.dry_run)
    categories['expired'] = reclaimed
    reclaimed = 0
    for cache, cap_mib in args.cache_cap:
        reclaimed += cap_cache(os.path.join(home, cache), cap_mib * MIB, args.dry_run)
    for directory, count in args.keep_newest:
        reclaimed += keep_newest(os.path.join(home, directory), count, args.dry_run)
    categories['limited_caches'] = reclaimed
    if args.home_cache_mib is not None:
        # Only the development user removes cache entries or runs package tools.
        argv = [sys.executable, '-I', '-B', __file__, *sys.argv[1:], '--user-caches-only']
        if args.user:
            argv = ['runuser', '-u', args.user, '--', 'env', f'HOME={home}'] + argv
        opened = open_temp_paths(args.host_var_tmp, args.proc) if args.host_var_tmp else None
        if args.host_var_tmp and opened is None:
            log(event='host_temp_inspection_failed')
        out = subprocess.run(argv, cwd=home, input=json.dumps({'var_tmp': opened, 'tmp': open_temp_paths(args.host_tmp, args.proc, '/tmp') if args.host_tmp else None}).encode(),
                             capture_output=True, timeout=3600)
        if out.returncode == 0:
            evidence = json.loads(out.stdout.splitlines()[-1])
            generations = evidence['pnpm_generations']
            categories.update(package_staging=evidence['staging_bytes'], cache=evidence['cache_bytes'], stores=evidence['store_bytes'],
                              host_temp=evidence['temporary_bytes'], mise_cache=evidence['mise_cache_bytes'])
        else:
            log(event='user_cache_cleanup_failed')
    if args.mise:
        installs = os.path.join(home, '.local', 'share', 'mise', 'installs')
        before_mise = size_of(installs)
        prune = [args.mise, 'prune', '--yes']
        if args.user:
            prune = ['runuser', '-u', args.user, '--', 'env', f'HOME={home}'] + prune
        command(prune, args.dry_run, 'mise_prune')
        categories['mise'] = max(0, before_mise - size_of(installs))
    if not args.home_only and not args.no_docker:
        before_docker = free_bytes('/')
        # A disposable node prunes everything no container uses on every run.
        unaged = pressure or args.disposable
        age_filter = [] if unaged else ['--filter', f'until={docker_age}h']
        until = None if unaged else docker_age
        command(['docker', 'image', 'prune', '--all', '--force', *age_filter],
                args.dry_run, 'docker_images', until_hours=until)
        if unaged or args.docker_cap_percent is None:
            build_limit = age_filter
        else:
            disk = os.statvfs('/')
            cap_mib = max(1, int(disk.f_blocks * disk.f_frsize * args.docker_cap_percent / 100 / MIB))
            build_limit = ['--keep-storage', f'{cap_mib}MB']
        command(['docker', 'builder', 'prune', '--all', '--force', *build_limit],
                args.dry_run, 'docker_build_cache',
                until_hours=until if build_limit == age_filter else None)
        if pressure:
            command(['docker', 'volume', 'prune', '--force'], args.dry_run, 'docker_anonymous_volumes')
        categories['docker'] = max(0, free_bytes('/') - before_docker)
    if not args.home_only:
        before_apt = free_bytes('/')
        command(['apt-get', 'clean'], args.dry_run, 'apt_cache')
        categories['apt'] = max(0, free_bytes('/') - before_apt)

    after = {p: free_bytes(p) for p in paths}
    categories_mib = {k: v // MIB for k, v in categories.items()}
    reclaimed_mib = sum(categories.values()) // MIB
    log(event='finished', checkout_mib=freed // MIB, categories_mib=categories_mib,
        reclaimed_mib=reclaimed_mib, dry_run=args.dry_run,
        free_mib={p: v // MIB for p, v in after.items()})
    if args.report and not args.dry_run:
        write_report(os.path.join(home, args.report), {
            'version': 1,
            'finished': int(time.time()),
            'pressure': pressure,
            'disposable': args.disposable,
            'reclaimedMiB': reclaimed_mib,
            'categoriesMiB': categories_mib,
            'pnpmStores': generations,
            **({'targetUsedPercent': target, 'usedPercentBefore': initial_used,
                'usedPercentAfter': max(used_percent(p) for p in paths)} if target else {}),
            **measure(home, args.worktree_root),
        })


if __name__ == '__main__':
    main(sys.argv[1:])

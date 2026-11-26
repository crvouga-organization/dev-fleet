"""Every Ubuntu package ansible/ubuntu/policy.json pins exists, at exactly its
pinned version, in the snapshot the policy names: for every accepted release
and architecture. A pin moved without its snapshot (or a snapshot moved past
a pin) fails here instead of on a machine, where the baseline finds no
installation candidate.

    python3 ansible/ubuntu/tests/snapshot-pins.py

Reads the Packages indexes of snapshot.ubuntu.com; changes nothing.
"""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import subprocess
import gzip
import json
from pathlib import Path
import sys
import time
import urllib.error
import urllib.request

POLICY = Path(__file__).resolve().parents[1] / 'policy.json'
COMPONENTS = ('main', 'universe', 'restricted', 'multiverse')
ATTEMPTS = 5
# Few enough parallel fetches to stay polite to a mirror that is struggling.
WORKERS = 4


def fetch(url):
    """The body at url, retrying the mirror's transient 5xx and timeouts."""
    for attempt in range(1, ATTEMPTS + 1):
        try:
            with urllib.request.urlopen(url, timeout=120) as response:
                return response.read()
        except urllib.error.HTTPError as error:
            if error.code < 500 or attempt == ATTEMPTS:
                raise
        except (urllib.error.URLError, TimeoutError):
            if attempt == ATTEMPTS:
                raise
        time.sleep(5 * attempt)


def versions(snapshot, codename, architecture):
    """Every version of every package the snapshot offers this release."""
    urls = [
        f'https://snapshot.ubuntu.com/ubuntu/{snapshot}/dists/{suite}/{component}/binary-{architecture}/Packages.gz'
        for suite in (codename, f'{codename}-updates', f'{codename}-security')
        for component in COMPONENTS
    ]
    found = {}
    with ThreadPoolExecutor(WORKERS) as pool:
        for body in pool.map(fetch, urls):
            index = gzip.decompress(body).decode()
            name = None
            for line in index.splitlines():
                if line.startswith('Package: '):
                    name = line[len('Package: '):]
                elif line.startswith('Version: ') and name:
                    found.setdefault(name, set()).add(line[len('Version: '):])
    return found


def advance(policy):
    # Yesterday's immutable UTC snapshot, once for all suites and architectures.
    snapshot = (datetime.now(timezone.utc) - timedelta(days=1)).strftime('%Y%m%dT000000Z')
    changed = 0
    for release in policy['releases']:
        offers = [versions(snapshot, release['codename'], arch) for arch in release['architectures']]
        groups = (release.get('packages', policy['packages']),
                  release.get('browserPackages', policy['browser']['packages']),
                  release['screenSharingPackages'])
        for group in groups:
            for name, previous in group.items():
                common = set.intersection(*(offered.get(name, set()) for offered in offers))
                if not common:
                    raise ValueError('No common version of ' + name + ' for Ubuntu ' + release['release'])
                newest = next(iter(common))
                for candidate in common:
                    if subprocess.run(['dpkg', '--compare-versions', candidate, 'gt', newest]).returncode == 0:
                        newest = candidate
                if subprocess.run(['dpkg', '--compare-versions', newest, 'lt', previous]).returncode == 0:
                    raise ValueError('Refusing a package downgrade for ' + name)
                if newest != previous:
                    group[name] = newest
                    changed += 1
    if changed:
        policy['snapshot'] = snapshot
        POLICY.write_text(json.dumps(policy, indent=2) + '\n')
    print(f'Ubuntu snapshot: {changed} pins advanced')
    return 0


def main():
    policy = json.loads(POLICY.read_text())
    if sys.argv[1:] == ['--advance']:
        return advance(policy)
    missing = []
    for release in policy['releases']:
        # The same merge src/platform/ubuntu-release.ts makes.
        pins = {
            **release['screenSharingPackages'],
            **policy['packages'], **release.get('packages', {}),
            **policy['browser']['packages'], **release.get('browserPackages', {}),
        }
        for architecture in release['architectures']:
            offered = versions(policy['snapshot'], release['codename'], architecture)
            absent = [(name, version) for name, version in pins.items() if version not in offered.get(name, ())]
            for name, version in absent:
                missing.append(f"Ubuntu {release['release']} {architecture}: {name}={version} is not in snapshot {policy['snapshot']}, which offers {', '.join(sorted(offered.get(name, []))) or 'no version'}")
            print(f"Ubuntu {release['release']} {architecture}: {len(pins) - len(absent)} of {len(pins)} pins are in snapshot {policy['snapshot']}", flush=True)
    for line in missing:
        print(f'::error::{line}')
    return 1 if missing else 0


if __name__ == '__main__':
    sys.exit(main())

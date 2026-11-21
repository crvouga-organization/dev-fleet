"""Resolve one stable provider release centrally, then lock all its platforms."""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import tomllib
from urllib.request import urlopen

PACKAGES = {
    'codex': ('codex', '@openai/codex'),
    'claude': ('claude', '@anthropic-ai/claude-code'),
    'gemini': ('gemini', '@google/gemini-cli'),
    'copilot': ('copilot', '@github/copilot'),
    'opencode': ('aqua:anomalyco/opencode', 'opencode-ai'),
    'grok': ('http:grok', '@xai-official/grok'),
    'antigravity': ('http:antigravity', None),
}
PLATFORMS = {
    'linux-x64': 'linux_amd64', 'linux-arm64': 'linux_arm64',
    'macos-x64': 'darwin_amd64', 'macos-arm64': 'darwin_arm64',
}
MANIFEST = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/'
CONFIG = Path('mise.toml')


def fetch(url):
    with urlopen(url, timeout=60) as response:
        return json.load(response)


def main(name):
    tool, package = PACKAGES[name]
    source = CONFIG.read_text()
    entry = tomllib.loads(source)['tools'][tool]
    previous = entry if isinstance(entry, str) else entry['version']
    manifests = {}
    if package:
        version = fetch('https://registry.npmjs.org/' + package + '/latest')['version']
    else:
        manifests = {key: fetch(MANIFEST + arch + '.json') for key, arch in PLATFORMS.items()}
        versions = {manifest['version'] for manifest in manifests.values()}
        if len(versions) != 1:
            raise ValueError('Antigravity stable release is incomplete across supported platforms')
        version = versions.pop()
    if not re.fullmatch(r'\d+\.\d+\.\d+', version):
        raise ValueError('Upstream latest is not a stable release')
    if version == previous:
        print(f'{name} {version} is current')
        return
    print(f'Resolved {name} {previous} -> {version}, verifying platform locks', file=sys.stderr)
    for key, manifest in manifests.items():
        url = manifest['url']
        if not re.fullmatch(r'https://storage\.googleapis\.com/antigravity-public/antigravity-cli/[\w./-]+', url):
            raise ValueError('Unexpected Antigravity artifact origin')
        with urlopen(url, timeout=120) as artifact:
            if hashlib.file_digest(artifact, 'sha512').hexdigest() != manifest['sha512']:
                raise ValueError('Antigravity release checksum mismatch for ' + key)
        source = source.replace(entry['platforms'][key]['url'], url)
    if manifests:
        CONFIG.write_text(source)
    subprocess.run(['mise', 'lock', tool + '@' + version], check=True, stdout=sys.stderr)
    config = tomllib.loads(CONFIG.read_text())['tools'][tool]
    if (config if isinstance(config, str) else config['version']) != version:
        raise ValueError('mise did not update the exact provider pin')
    locks = tomllib.loads(Path('mise.lock').read_text())['tools'][tool]
    locked = next(row for row in locks if row['version'] == version)
    if 'aube' in locked:
        if not locked['aube']['digest'].startswith('sha256:') or not Path(locked['aube']['path']).exists():
            raise ValueError('Missing package dependency integrity lock')
    else:
        for platform in PLATFORMS:
            if not locked['platforms.' + platform].get('checksum'):
                raise ValueError('No integrity lock for ' + platform)
    print(f'{name} {previous} -> {version}')


if __name__ == '__main__':
    main(sys.argv[1])

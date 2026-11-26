"""Advance the monitoring release and all its platform digests together."""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tarfile
from tempfile import TemporaryDirectory

directory = Path('ansible/monitoring')
lock_path = directory / 'lock.json'
lock = json.loads(lock_path.read_text())
repo = 'henrygd/beszel'
release = json.loads(subprocess.check_output(['gh', 'api', f'repos/{repo}/releases/latest']))
tag = release['tag_name']
if not re.fullmatch(r'v\d+\.\d+\.\d+', tag):
    raise ValueError('Expected a stable monitoring release')
version = tag[1:]
previous = lock['version']
if version == previous:
    print(f'beszel {version} is current')
    raise SystemExit(0)
assets = {asset['name']: asset for asset in release['assets']}


def digest(name):
    value = assets[name]['digest']
    if not re.fullmatch(r'sha256:[a-f0-9]{64}', value):
        raise ValueError('Missing release digest for ' + name)
    return value.removeprefix('sha256:')


with TemporaryDirectory() as temp:
    for key in lock['agents']:
        platform = key if key.startswith('darwin-') else 'linux-' + key
        name = 'beszel-agent_' + platform.replace('-', '_') + '.tar.gz'
        lock['agents'][key] = digest(name)
        if key in lock['agentBinaries']:
            subprocess.run(['gh', 'release', 'download', tag, '--repo', repo, '--pattern', name,
                            '--dir', temp], check=True)
            with open(Path(temp, name), 'rb') as file:
                if hashlib.file_digest(file, 'sha256').hexdigest() != digest(name):
                    raise ValueError('Agent archive digest mismatch')
                file.seek(0)
                with tarfile.open(fileobj=file, mode='r:gz') as archive:
                    member, = [m for m in archive if m.isfile() and m.name.lstrip('./') == 'beszel-agent']
                    lock['agentBinaries'][key] = hashlib.file_digest(archive.extractfile(member), 'sha256').hexdigest()

for key in lock['hubArchives']:
    lock['hubArchives'][key] = digest('beszel_' + key.replace('-', '_') + '.tar.gz')
image = f'{repo}:{version}'
manifest = subprocess.check_output(['docker', 'buildx', 'imagetools', 'inspect', image,
                                    '--format', '{{json .Manifest}}'])
image_digest = json.loads(manifest)['digest']
if not re.fullmatch(r'sha256:[a-f0-9]{64}', image_digest):
    raise ValueError('Missing hub image digest')
compose = directory / 'compose.yml'
previous_image = lock['image']
if previous_image not in compose.read_text():
    raise ValueError('Compose and the monitoring lock disagree')
lock.update(version=version, image=image + '@' + image_digest, source=f'https://github.com/{repo}/releases/tag/{tag}')
compose.write_text(compose.read_text().replace(previous_image, lock['image']))
# The installed service names its versioned immutable binary in ExecStart.
unit = directory / 'beszel-agent.service'
unit.write_text(unit.read_text().replace('/' + previous + '/', '/' + version + '/'))
for feature in ['monitoring/hub-evidence', 'monitoring/enrollment',
                'fleet-sync/dashboard-evidence', 'fleet-sync/monitoring-enrollment']:
    fixture = Path('features', feature + '.feature')
    fixture.write_text(fixture.read_text().replace('"' + previous + '"', '"' + version + '"'))
lock_path.write_text(json.dumps(lock, indent=2) + '\n')
print(f'beszel {previous} -> {version}')

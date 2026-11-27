import { afterAll, mock } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join, resolve } from 'node:path';

// No test touches a real machine's fleet state or bucket: each run gets an
// empty directory.
const state = mkdtempSync(join(os.tmpdir(), 'homelab-test-state-'));
// Real-tool scenarios may consult the existing tool installations with
// `mise which`. Capture their location before moving into the test home.
export const miseInstalls =
  process.env['MISE_INSTALLS_DIR'] ??
  join(
    process.env['MISE_DATA_DIR'] ??
      join(
        process.env['XDG_DATA_HOME'] ?? join(os.homedir(), '.local/share'),
        'mise'
      ),
    'installs'
  );
// Children inherit the test home. Bun caches os.homedir() at startup, and
// os.userInfo() reads the system account database, so redirect those too.
process.env['HOME'] = state;
process.env['USERPROFILE'] = state;
const userInfo = os.userInfo.bind(os);
mock.module('node:os', () => ({
  ...os,
  homedir: () => state,
  userInfo: (options?: Parameters<typeof userInfo>[0]) => ({
    ...userInfo(options ?? {}),
    homedir: options?.encoding === 'buffer' ? Buffer.from(state) : state,
  }),
}));
process.env['HOMELAB_STATE'] = join(state, 'state');
process.env['HOMELAB_BUCKET'] = join(state, 'bucket.json');
// `bun test` does not emit 'exit'; the directory goes when the run ends.
afterAll(() => rmSync(state, { recursive: true, force: true }));

// Tests run against the example fleet, never a real machine's configuration,
// and without the bucket the example names: a test that replicates anywhere
// names its own target.
const { state: _bucket, ...example } = JSON.parse(
  readFileSync(resolve(import.meta.dir, '../../examples/fleet.json'), 'utf8')
) as Record<string, unknown>;
process.env['HOMELAB_CONFIG'] = join(state, 'fleet.json');
writeFileSync(
  process.env['HOMELAB_CONFIG'],
  JSON.stringify(example, null, 2) + '\n'
);
// The manager lease names this process, never the machine it runs on.
process.env['HOMELAB_MANAGER_HOLDER'] = 'machine-under-test';
// Nor with a developer's own bucket credentials.
delete process.env['HOMELAB_BUCKET_ACCESS_KEY_ID'];
delete process.env['HOMELAB_BUCKET_SECRET_ACCESS_KEY'];

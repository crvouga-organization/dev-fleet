import { unreadSecret, WORKER_SECRETS_LOGIN } from './secrets-blocked';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { secretVia } from './fleet-config';
import type { MachineDefinition } from './definition';
import { runAnsible } from './platform/ansible';
import type { Runner, Check } from './types';
import { PACKAGE_ROOT } from './package-info';

const RDP = 'org.gnome.desktop.remote-desktop.rdp';
const remedy = {
  action:
    'Run fleet-sync for this desktop worker and check its active graphical login and per-worker rdp-password in the secrets provider.',
};

export async function applyScreenSharing(
  root: string,
  machine: MachineDefinition,
  run: Runner
): Promise<Check> {
  const id = 'worker:screen-sharing-policy';
  const user = userInfo();
  const secrets = secretVia(run);
  const password = await secrets('rdp-password', machine.id);
  if (!password)
    return unreadSecret(
      secrets,
      { id, status: 'fail', summary: 'RDP_CREDENTIAL_UNAVAILABLE', remedy },
      WORKER_SECRETS_LOGIN
    );
  if (machine.network?.user !== user.username)
    return {
      id,
      status: 'fail',
      summary: 'RDP_ACCOUNT_MISMATCH',
      remedy,
    };
  const applied = await runAnsible(
    run,
    join(root, 'ansible/ubuntu/screen-sharing.yml'),
    {
      input: JSON.stringify({
        rdp_port: machine.screenSharing!.port,
        rdp_host: machine.network.tailscaleName,
        rdp_password: password,
        development_uid: user.uid,
        development_user: user.username,
        development_home: user.homedir,
      }),
      timeoutMs: 900_000,
    }
  );
  return applied.ok
    ? {
        id,
        status: 'pass',
        summary: 'The GNOME desktop sharing policy was applied.',
      }
    : { id, status: 'fail', summary: 'RDP_POLICY_INCOMPLETE', remedy };
}

export async function desktopChecks(
  port: number,
  run: Runner
): Promise<Check[]> {
  const runtime = '/run/user/' + userInfo().uid;
  const sessionCommand = (argv: string[]) =>
    run(argv, {
      env: {
        XDG_RUNTIME_DIR: runtime,
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=' + runtime + '/bus',
      },
    });
  const [service, session, configured, listening, credential, cert] =
    await Promise.all([
      sessionCommand([
        'systemctl',
        '--user',
        'is-active',
        'gnome-remote-desktop.service',
      ]),
      sessionCommand([
        'gdbus',
        'call',
        '--session',
        '--dest',
        'org.freedesktop.DBus',
        '--object-path',
        '/org/freedesktop/DBus',
        '--method',
        'org.freedesktop.DBus.NameHasOwner',
        'org.gnome.Mutter.RemoteDesktop',
      ]),
      sessionCommand(['gsettings', 'get', RDP, 'port']),
      sessionCommand(['ss', '-H', '-ltn', 'sport', '=', String(port)]),
      sessionCommand([
        '/usr/bin/python3',
        '/etc/personal-fleet/screen-sharing-credential.py',
        'check',
      ]),
      sessionCommand(['gsettings', 'get', RDP, 'tls-cert']),
    ]);
  const path = cert.ok && /^'(\/[^'\n]+)'$/.exec(cert.stdout.trim())?.[1];
  const certificate =
    path &&
    (await run([
      'openssl',
      'x509',
      '-in',
      path,
      '-noout',
      '-sha256',
      '-fingerprint',
    ]));
  const fingerprint =
    certificate &&
    certificate.ok &&
    /=((?:[\da-f]{2}:){31}[\da-f]{2})$/i.exec(certificate.stdout.trim())?.[1];
  const measured = (
    id: string,
    ok: boolean,
    pass: string,
    fail: string
  ): Check =>
    ok
      ? { id, status: 'pass', summary: pass }
      : { id, status: 'fail', summary: fail, remedy };
  return [
    measured(
      'worker:rdp-service',
      service.ok && service.stdout.trim() === 'active',
      'The GNOME sharing service is active.',
      'RDP_SERVICE_STOPPED'
    ),
    measured(
      'worker:rdp-session',
      session.ok && session.stdout.trim() === '(true,)',
      'Mutter offers the active graphical session for remote control.',
      'RDP_DESKTOP_UNAVAILABLE'
    ),
    measured(
      'worker:rdp-port',
      configured.ok &&
        configured.stdout.trim().replace(/^uint16 /, '') === String(port) &&
        listening.ok &&
        !!listening.stdout.trim(),
      'The declared RDP port is configured and listening.',
      'RDP_PORT_MISMATCH'
    ),
    measured(
      'worker:rdp-credential',
      credential.ok,
      'The desktop account can read the RDP credential without unlocking a keyring.',
      'RDP_CREDENTIAL_UNAVAILABLE'
    ),
    measured(
      'worker:rdp-certificate',
      !!fingerprint,
      `SHA256 ${fingerprint}`,
      'RDP_CERTIFICATE_UNAVAILABLE'
    ),
  ];
}

export async function desktopEndpoint(
  address: string | undefined,
  port: number,
  checks: Check[],
  run: Runner
): Promise<Check> {
  const id = 'worker:rdp-endpoint';
  const expected = checks.find(
    (check) => check.id === 'worker:rdp-certificate' && check.status === 'pass'
  )?.summary;
  if (!expected || !address)
    return { id, status: 'fail', summary: 'RDP_ENDPOINT_UNVERIFIED', remedy };
  const measured = await run(
    [
      'python3',
      join(PACKAGE_ROOT, 'bootstrap/rdp-probe.py'),
      address,
      String(port),
    ],
    { timeoutMs: 8000 }
  );
  if (!measured.ok)
    return { id, status: 'fail', summary: 'RDP_NEGOTIATION_FAILED', remedy };
  if (
    'SHA256 ' + measured.stdout.trim().toUpperCase() !==
    expected.toUpperCase()
  )
    return {
      id,
      status: 'fail',
      summary: 'RDP_TLS_IDENTITY_MISMATCH',
      remedy: {
        action:
          'Verify the certificate on the enrolled worker and the tailnet destination before connecting.',
      },
    };
  return {
    id,
    status: 'pass',
    summary:
      'The manager negotiated RDP and verified the worker TLS certificate. Authenticated desktop access is unverified.',
  };
}

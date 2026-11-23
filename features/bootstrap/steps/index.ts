import { diskGc } from './disk-gc';
import { installer } from './installer';
import { mise } from './mise';
import { packageSmoke } from './package-smoke';
import { packageStores } from './package-stores';
import { pins } from './pins';
import { notes } from './release-notes';
import { publishing } from './publishing';
import { toolchain } from './toolchain';
import { windows } from './windows';
import { worker } from './worker';
import { BootstrapWorld, common } from './world';

export { BootstrapWorld };
/** Every step of this area. */
export const bootstrap = [
  common,
  publishing,
  installer,
  toolchain,
  mise,
  windows,
  worker,
  diskGc,
  pins,
  packageSmoke,
  packageStores,
  notes,
];

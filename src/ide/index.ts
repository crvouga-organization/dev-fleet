import type { Ide } from './ide';
import { superIde } from './super';
import { t3Ide } from './t3';
import { remoteIde } from './remote';
import { ORCA, PARADEV } from './remote-mesh';

/** Every IDE dev-fleet implements, by the ID fleet.json enables it with.
 * Orca and Paradev are measured by remoteMeshChecks once the workers exist,
 * so every machine can register every other machine in one pass.
 */
export const IDES: Readonly<Record<string, Ide>> = {
  t3: t3Ide(),
  super: superIde(),
  orca: remoteIde(ORCA),
  paradev: remoteIde(PARADEV),
};

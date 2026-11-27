import type { Ide } from './ide';
import type { RemoteIdeSpec } from './remote-mesh';

/** Orca and Paradev are measured once, by remoteMeshChecks, after the
 * workers exist, so every machine can register every other machine. The
 * interface still has an implementation: its per-machine calls add nothing,
 * because a single machine cannot see the rest of the mesh.
 */
export function remoteIde(spec: RemoteIdeSpec): Ide {
  return {
    id: spec.id,
    settings: async () => [],
    manager: async () => [],
    worker: async () => [],
  };
}

/** The image of the fresh machines is built once, before any scenario. Its
 * build downloads a base image and two packages, so it fails when a registry
 * or an archive does for a moment: it is tried again, and a build that still
 * fails is one failure of the runner, not one of every scenario.
 */

/** The pauses before the second and the third attempt. */
export const IMAGE_BUILD_PAUSES_MS = [15_000, 45_000];

export class ImageBuildFailed extends Error {
  constructor(attempts: number) {
    super(
      `The image of the fresh machines could not be built in ${attempts} attempts. This is a failure of the runner or of the network the image is downloaded over, not of a scenario: none was run.`
    );
    this.name = 'ImageBuildFailed';
  }
}

/** Runs the build until it succeeds, three times at most. */
export async function buildImage(
  build: () => Promise<boolean>,
  pause: (ms: number) => Promise<unknown> = (ms) =>
    new Promise((done) => setTimeout(done, ms))
): Promise<void> {
  let attempts = 0;
  for (const wait of [0, ...IMAGE_BUILD_PAUSES_MS]) {
    if (wait > 0) await pause(wait);
    attempts += 1;
    if (await build()) return;
  }
  throw new ImageBuildFailed(attempts);
}

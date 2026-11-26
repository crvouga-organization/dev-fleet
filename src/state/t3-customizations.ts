import { dirname } from 'node:path';
import { packagePlaybook } from '../platform/ansible';
import { clientSettingsPath } from '../t3/client-settings';
import { canonical, read } from '../t3/files';
import {
  captureCustomizations,
  customizationDocument,
  installCustomizations,
  managerMarker,
  withCustomizations,
} from '../t3/customizations';
import { databasePath } from './paths';
import { readDocument, writeDocument } from './store';
import { mutateState, type StateContext } from './sync';

export async function managerCustomizations(
  context: StateContext,
  userdata = dirname(clientSettingsPath()),
  play = packagePlaybook(context.run)
) {
  const file = databasePath(context.root);
  const { value } = await mutateState(context, async () => {
    const saved = readDocument(file, 't3-customizations');
    const initialized = await read(managerMarker(userdata));
    if (initialized !== null && initialized !== 'dev-fleet\n')
      throw new Error('T3_CUSTOMIZATIONS_CONFLICT');
    const snapshot =
      saved !== null && initialized === null
        ? customizationDocument(JSON.parse(saved))
        : await captureCustomizations(userdata);
    await withCustomizations(snapshot, context.run, async (stage) => {
      if (initialized === null)
        await installCustomizations(
          snapshot,
          stage,
          { userdata, manager: true },
          play
        );
    });
    writeDocument(file, 't3-customizations', canonical(snapshot));
    return snapshot;
  });
  return value;
}

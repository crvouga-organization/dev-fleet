import type { Ide } from './ide';
import { superIde } from './super';
import { t3Ide } from './t3';

/** Every IDE dev-fleet implements, by the ID fleet.json enables it with. */
export const IDES: Readonly<Record<string, Ide>> = {
  t3: t3Ide(),
  super: superIde(),
};

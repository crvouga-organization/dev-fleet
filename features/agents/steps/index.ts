import { accounts } from './accounts';
import { commands } from './commands';
import { native } from './native';
import { profiles } from './profiles';
import { providers } from './providers';
import { proxyKeys } from './proxy-key';
import { AgentsWorld, common } from './world';

export { AgentsWorld };
/** Every step of this area. */
export const agents = [
  common,
  accounts,
  commands,
  profiles,
  native,
  providers,
  proxyKeys,
];

import { SOURCE_OPERATIONS } from './source-operations';
import { commandCatalog } from './registry';
import type { CommandSpec } from './contracts';

const APPLIES = new Set(['converge-local', 't3-reconcile', 't3-remove']);

/** Additive machine-readable discovery; the registry also drives the menu. */
export function indexedCommands(search = '', group?: string) {
  return commandCatalog(search, group).map((entry) => ({
    ...entry,
    help: `homelab ${entry.args.join(' ')} --help`,
    execution: execution(entry),
  }));
}

function execution(entry: CommandSpec) {
  if (Object.hasOwn(SOURCE_OPERATIONS, entry.id))
    return {
      default: 'depends-on-subcommand',
      authorization: 'owner-specific; inspect leaf help before invocation',
      requirements: ['homelab checkout and its toolchain'],
      note: 'Streams the owner protocol. JSON and mutation flags depend on the leaf operation.',
    };
  if (entry.id === 'converge')
    return {
      default: 'interactive-confirmation-or-action-required',
      authorization: 'interactive-confirmation or --apply --yes',
      preview: 'homelab converge --dry-run --json',
      scope:
        'enrolled Ubuntu fleet over verified SSH; manager is not an implicit target',
      note: 'JSON/noninteractive never prompt. Full Ubuntu acceptance is not yet implemented.',
    };
  if (entry.mutation && entry.id.startsWith('state '))
    return {
      default: 'apply',
      authorization: 'command-invocation',
      preview: 'homelab state --json',
      note: 'Each flag is one explicit action on this manager’s fleet state. JSON selects output format; it does not prevent writes.',
    };
  if (APPLIES.has(entry.id))
    return {
      default: 'apply',
      authorization: 'command-invocation',
      preview: `homelab ${entry.id} --dry-run --json`,
      note:
        entry.id === 't3-reconcile'
          ? '--import ID adopts an existing instance without reconciling. JSON selects output format; it does not prevent writes.'
          : 'JSON selects output format; it does not prevent writes.',
    };
  if (entry.mutation)
    return {
      default: 'preview',
      authorization: '--apply --yes',
      note: 'Supply required options shown by command --help. A preview does not apply changes.',
    };
  return { default: 'read-only', authorization: 'none' };
}

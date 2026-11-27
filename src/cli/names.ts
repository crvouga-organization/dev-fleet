/** Commander command name. A trailing `[args...]` stays on the name. */
export function commandNames(name: string): { name: string } {
  return { name };
}

// Names of Pipedream's Data Store actions that the converter rebuilds (their code is in builtinActions.ts).
// Kept apart from that code so the report can tell which actions convert without loading the converter.

export const BUILTIN_DATA_STORE_ACTIONS = [
  "add-update-record",
  "add-update-multiple-records",
  "get-record-or-create",
  "get-all-records",
  "delete-all-records",
  "delete-single-record",
  "append-to-record",
  "has-key-or-create",
  "list-keys",
  "list-records",
  "update-ttl",
] as const;

/** The data store action a component key names (`data_stores-<name>`, any `@scope/` prefix), if the converter rebuilds it. */
export function builtinActionName(componentKey: string): string | undefined {
  const m = componentKey.replace(/^@[^/]+\//, "").match(/^data_stores-(.+)$/);
  return m && (BUILTIN_DATA_STORE_ACTIONS as readonly string[]).includes(m[1]) ? m[1] : undefined;
}

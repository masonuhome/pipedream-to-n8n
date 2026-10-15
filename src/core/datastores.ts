// Pipedream data stores: which workflows use which store, and reading exported records. Browser-safe: records are
// matched on the user's machine, never sent to a server. Writing them into converted workflows is convert/preload.ts.
import { analyzeCode } from "./analyze/code";
import { builtinActionName } from "./convert/builtinKeys";
import type { PropValue, Step, Workflow } from "./ir";

/** Format id written by the Workflow Exit data store exporter step (https://workflowexit.com/tools/pipedream-data-store-exporter.mjs). */
export const DATA_STORE_EXPORT_FORMAT = "workflow-exit/pipedream-data-stores";

/** One data store prop in one step. `ns` is the key the converted code uses in n8n workflow static data. */
export interface DataStoreSlot {
  ns: string;
  storeId?: string;
  workflowId: string;
  workflowName: string;
  step: string;
  prop: string;
  /** Keys the code or action uses as literals, for matching exported stores. */
  keys: string[];
}

/** Usage of one data store across the project: one per Pipedream store id, or per workflow and step prop when the id is unknown. */
export interface DataStoreGroup {
  /** Stable id for assignments: the namespace for known store ids, "<workflow id>|<namespace>" otherwise. */
  key: string;
  ns: string;
  storeId?: string;
  workflows: string[];
  keys: string[];
  slots: DataStoreSlot[];
}

/** Records of one exported data store (all parts merged). */
export interface ExportedStore {
  /** Name the user gave it in the exporter, or the file name. */
  name: string;
  /** Pipedream store id (ds_…), when the exporter could read it. */
  id?: string;
  records: Record<string, unknown>;
  /** Absolute expiry (epoch ms) per key, for records that had a TTL. */
  expiresAt: Record<string, number>;
  /** Records in the files (after merging parts) and the total the exporter counted, if known. */
  count: number;
  total?: number;
}

/** Exported stores and which one each data store group gets. */
export interface DataStorePlan {
  groups: DataStoreGroup[];
  stores: ExportedStore[];
  /** Group key → store key (see `storeKey`). */
  assign: Record<string, string>;
}

const flat = (steps: Step[]): Step[] => steps.flatMap((s) => (s.kind === "control" ? [s, ...s.branches.flatMap((b) => flat(b.steps))] : [s]));

/** Same naming as the code shim's `__db(...)`: the store id when known, otherwise "<step>.<prop>". */
export const dataStoreNs = (storeId: string | undefined, step: string, prop: string) => (storeId ? `ds:${storeId}` : `${step}.${prop}`);

/** The store id of a configured data store prop, read the way the code shim reads it. */
const storeIdOf = (v: PropValue | undefined): string | undefined => {
  if (!v || v.t !== "value" || !v.value || typeof v.value !== "object") return undefined;
  const id = (v.value as { storeId?: unknown }).storeId;
  return typeof id === "string" && id ? id : undefined;
};

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Literal keys the code passes to the given data store props: `this.db.get("x")`, `db.set('x', …)`, Python
 * `data_store["x"]`, `pd.inputs["data_store"].get("x")`, `"x" in data_store`.
 */
function literalKeys(code: string, props: string[]): string[] {
  if (!props.length) return [];
  const names = new Set(props);
  // Python: a variable that holds the store (db = pd.inputs["data_store"]).
  for (const p of props) for (const m of code.matchAll(new RegExp(`\\b(\\w+)\\s*=\\s*pd\\.inputs\\[\\s*["']${esc(p)}["']\\s*\\]`, "g"))) names.add(m[1]);
  const alt = [...names].map(esc).join("|");
  const recv = `(?:\\b(?:${alt})|pd\\.inputs\\[\\s*["'](?:${alt})["']\\s*\\])`;
  const lit = `(["'\`])([^"'\`$\\\\\\n]{1,200})\\1`;
  const keys = new Set<string>();
  for (const re of [
    new RegExp(`${recv}\\s*\\.\\s*(?:get|set|has|delete|setTtl|getTtl|set_ttl|get_ttl)\\(\\s*${lit}`, "g"),
    new RegExp(`${recv}\\s*\\[\\s*${lit}\\s*\\]`, "g"),
  ]) {
    for (const m of code.matchAll(re)) keys.add(m[2]);
  }
  for (const m of code.matchAll(new RegExp(`${lit}\\s+in\\s+${recv}`, "g"))) keys.add(m[2]);
  return [...keys];
}

/** Every data store prop in a workflow, with the namespace its converted code uses. */
export function dataStoreSlots(wf: Workflow): DataStoreSlot[] {
  const out: DataStoreSlot[] = [];
  const add = (step: string, prop: string, storeId: string | undefined, keys: string[]) => {
    const ns = dataStoreNs(storeId, step, prop);
    if (out.some((s) => s.ns === ns && s.step === step && s.prop === prop)) return;
    out.push({ ns, storeId, workflowId: wf.id, workflowName: wf.name, step, prop, keys });
  };
  for (const step of flat(wf.steps)) {
    if (step.kind === "code") {
      const declared = new Set(analyzeCode(step).props.filter((p) => p.type === "data_store").map((p) => p.name));
      for (const d of step.declared ?? []) if (d.type === "data_store") declared.add(d.name);
      const names = [...new Set([...declared, ...Object.keys(step.props).filter((k) => storeIdOf(step.props[k]))])];
      const keys = literalKeys(step.code, names);
      for (const prop of names) add(step.name, prop, storeIdOf(step.props[prop]), keys);
    } else if (step.kind === "action" && builtinActionName(step.componentKey)) {
      const key = step.props.key;
      const keys = key && key.t === "value" && typeof key.value === "string" && key.value && !key.value.includes("{{") ? [key.value] : [];
      add(step.name, "dataStore", storeIdOf(step.props.dataStore), keys);
    }
  }
  return out;
}

/** Data stores across a project, grouped by the namespace they get in n8n. */
export function dataStoreGroups(workflows: Workflow[]): DataStoreGroup[] {
  const groups = new Map<string, DataStoreGroup>();
  for (const wf of workflows) {
    for (const slot of dataStoreSlots(wf)) {
      // Slots without a store id are separate even when the step and prop names repeat across workflows.
      const key = slot.storeId ? slot.ns : `${wf.id}|${slot.ns}`;
      const g = groups.get(key) ?? { key, ns: slot.ns, storeId: slot.storeId, workflows: [], keys: [], slots: [] };
      if (!g.workflows.includes(wf.name)) g.workflows.push(wf.name);
      for (const k of slot.keys) if (!g.keys.includes(k)) g.keys.push(k);
      g.slots.push(slot);
      groups.set(key, g);
    }
  }
  return [...groups.values()];
}

function fromRecords(name: string, records: unknown, id?: unknown, ttl?: unknown, exportedAt?: unknown, total?: unknown): ExportedStore | undefined {
  if (!records || typeof records !== "object" || Array.isArray(records)) return undefined;
  const base = typeof exportedAt === "string" && !Number.isNaN(Date.parse(exportedAt)) ? Date.parse(exportedAt) : Date.now();
  const recs = records as Record<string, unknown>;
  const expiresAt: Record<string, number> = {};
  if (ttl && typeof ttl === "object") {
    for (const [k, s] of Object.entries(ttl as Record<string, unknown>)) if (typeof s === "number" && s > 0 && k in recs) expiresAt[k] = base + s * 1000;
  }
  return {
    name: String(name || "data store").slice(0, 120),
    ...(typeof id === "string" && /^ds_[A-Za-z0-9]+$/.test(id) ? { id } : {}),
    records: recs,
    expiresAt,
    count: Object.keys(recs).length,
    ...(typeof total === "number" && total >= 0 ? { total } : {}),
  };
}

/**
 * Exported data stores in a file, or undefined if the file is something else. Reads the Workflow Exit exporter format
 * (several stores, expiry times) and the single-store `.datastore.json` format other tools write.
 */
export function parseDataStoreFile(text: string, fileName = ""): ExportedStore[] | undefined {
  if (!/^\s*\{/.test(text)) return undefined;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!j || typeof j !== "object") return undefined;
  if (j.format === DATA_STORE_EXPORT_FORMAT && Array.isArray(j.stores)) {
    const out: ExportedStore[] = [];
    for (const s of j.stores as Record<string, unknown>[]) {
      const store = s && typeof s === "object" ? fromRecords(String(s.name ?? ""), s.records, s.id, s.ttl, j.exportedAt, s.total) : undefined;
      if (store) out.push(store);
    }
    return out;
  }
  // Single-store format: { "<tool>": "pipedream-data-store", name, records }
  if (Object.values(j).includes("pipedream-data-store") && "records" in j) {
    const name = typeof j.name === "string" && j.name ? j.name : fileName.replace(/^.*[\\/]/, "").replace(/\.datastore\.json$|\.json$/i, "");
    const store = fromRecords(name, j.records, j.id, undefined, j.exportedAt);
    return store ? [store] : undefined;
  }
  return undefined;
}

export const storeKey = (s: ExportedStore) => s.id ?? `name:${s.name.toLowerCase()}`;

/** Joins stores that are the same store (same id, or same name without an id), e.g. from two exports. */
export function mergeStores(stores: ExportedStore[]): ExportedStore[] {
  const byKey = new Map<string, ExportedStore>();
  for (const s of stores) {
    const k = storeKey(s);
    const prev = byKey.get(k);
    if (!prev) {
      byKey.set(k, { ...s, records: { ...s.records }, expiresAt: { ...s.expiresAt } });
      continue;
    }
    Object.assign(prev.records, s.records);
    Object.assign(prev.expiresAt, s.expiresAt);
    prev.count = Object.keys(prev.records).length;
    const total = Math.max(prev.total ?? 0, s.total ?? 0);
    if (total) prev.total = total;
  }
  return [...byKey.values()];
}

/**
 * Suggested store for each group: the same Pipedream id first, then the store whose records contain the most of the
 * keys the code uses, then the only store when there is one group and one store. Unclear groups are left out.
 */
export function autoMatch(groups: DataStoreGroup[], stores: ExportedStore[]): Record<string, string> {
  const out: Record<string, string> = {};
  const used = new Set<string>();
  for (const g of groups) {
    const byId = g.storeId ? stores.find((s) => s.id === g.storeId) : undefined;
    if (byId) {
      out[g.key] = storeKey(byId);
      used.add(storeKey(byId));
    }
  }
  for (const g of groups) {
    if (out[g.key] || !g.keys.length) continue;
    // A store with a different known id belongs to another group.
    const scored = stores
      .filter((s) => !used.has(storeKey(s)) && !(s.id && g.storeId && s.id !== g.storeId))
      .map((s) => ({ s, hits: g.keys.filter((k) => Object.prototype.hasOwnProperty.call(s.records, k)).length }))
      .filter((x) => x.hits > 0)
      .sort((a, b) => b.hits - a.hits);
    if (scored.length && (scored.length === 1 || scored[0].hits > scored[1].hits)) {
      out[g.key] = storeKey(scored[0].s);
      used.add(storeKey(scored[0].s));
    }
  }
  const open = groups.filter((g) => !out[g.key]);
  const free = stores.filter((s) => !used.has(storeKey(s)));
  if (groups.length === 1 && stores.length === 1 && open.length === 1 && free.length === 1) out[open[0].key] = storeKey(free[0]);
  return out;
}

/**
 * Assignments after the stores or groups changed: the user's choices stay (including "" for "none") while their store
 * is still there, and the other groups get the suggested store if no group has it yet.
 */
export function refreshAssign(groups: DataStoreGroup[], stores: ExportedStore[], prev: Record<string, string> = {}): Record<string, string> {
  const keys = new Set(stores.map(storeKey));
  const out: Record<string, string> = {};
  for (const [g, k] of Object.entries(prev)) if (groups.some((x) => x.key === g) && (k === "" || keys.has(k))) out[g] = k;
  const taken = new Set(Object.values(out));
  for (const [g, k] of Object.entries(autoMatch(groups, stores))) {
    if (g in out || taken.has(k)) continue;
    out[g] = k;
    taken.add(k);
  }
  return out;
}

/** The assigned stores of one workflow, by the namespace its converted code uses. */
export function storesForWorkflow(plan: DataStorePlan, workflowId: string): Record<string, ExportedStore> {
  const out: Record<string, ExportedStore> = {};
  for (const g of plan.groups) {
    const key = plan.assign[g.key];
    const store = key ? plan.stores.find((s) => storeKey(s) === key) : undefined;
    if (!store) continue;
    for (const slot of g.slots) if (slot.workflowId === workflowId) out[slot.ns] = store;
  }
  return out;
}


/** Rows for an n8n Data Table (columns key, value as JSON text, expires_at) built from an exported store. */
export function dataTableRows(store: ExportedStore, now = Date.now()): { key: string; value: string; expires_at: string | null }[] {
  return Object.entries(store.records)
    .filter(([k]) => store.expiresAt[k] === undefined || store.expiresAt[k] > now)
    .map(([key, value]) => ({ key, value: JSON.stringify(value) ?? "null", expires_at: store.expiresAt[key] ? new Date(store.expiresAt[key]).toISOString() : null }));
}

/** Records up to this size (JSON) are also embedded in the Code nodes that use them (convert/preload.ts). */
export const SEED_MAX_BYTES = 200_000;

/** Approximate JSON size of a store's records, in bytes. */
export const storeBytes = (s: ExportedStore) => JSON.stringify(s.records).length;

/** File name for a store in the bundle's data-stores/ folder. */
export function storeFileName(s: ExportedStore, taken: Set<string>): string {
  const base = (s.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "data-store") + (s.id ? `-${s.id}` : "");
  let name = `${base}.json`;
  for (let i = 2; taken.has(name); i++) name = `${base}-${i}.json`;
  taken.add(name);
  return name;
}

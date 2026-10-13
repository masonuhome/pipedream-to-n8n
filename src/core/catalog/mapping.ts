// Which Pipedream registry components have a verified n8n mapping. This is the small
// index (key -> node type) that ships to the browser for the free report; full node
// templates live in convert/templates.generated.json (server only).
// Regenerate both with: node scripts/gen-mapping.mjs
import index from "./mapping.index.json";

export interface MappingInfo {
  type: string;
  confidence: "high" | "medium" | "low";
  polling?: boolean;
}

type Row = [string | null, string, number?];
const idx = index as unknown as { actions: Record<string, Row>; sources: Record<string, Row> };

const toInfo = (row: Row | undefined): MappingInfo | undefined =>
  row && row[0] ? { type: row[0], confidence: row[1] as MappingInfo["confidence"], ...(row[2] ? { polling: true } : {}) } : undefined;

export const lookupAction = (key: string) => toInfo(idx.actions[key]);
export const lookupSource = (key: string) => toInfo(idx.sources[key]);
export const knownSource = (key: string) => key in idx.sources;

/** Pipedream app slug (normalized) -> native n8n node. Used for coverage stats and fallback hints. */
export { APP_NODES } from "./apps";

import type { Platform } from "./ir";

/** "Pipedream" or "Zapier", for messages about where a workflow came from. */
export const platformLabel = (p?: Platform): string => (p === "zapier" ? "Zapier" : "Pipedream");

/** What one automation is called on the platform: a workflow on Pipedream, a Zap on Zapier. */
export const workflowNoun = (p?: Platform): string => (p === "zapier" ? "Zap" : "workflow");

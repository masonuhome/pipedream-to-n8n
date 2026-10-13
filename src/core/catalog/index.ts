// Registry lookups: which Pipedream components have a deterministic n8n mapping,
// and which apps have a native n8n node at all.
import { APP_NODES } from "./apps";
import { lookupAction, lookupSource, knownSource, type MappingInfo } from "./mapping";

export type { MappingInfo };

export function actionMapping(componentKey: string): MappingInfo | undefined {
  return lookupAction(componentKey);
}

export function sourceMapping(componentKey: string): MappingInfo | undefined {
  return lookupSource(componentKey);
}

/** True when the source is in the mapping table but has no n8n trigger node (polling needed). */
export const sourceWithoutTrigger = (componentKey: string) => knownSource(componentKey) && !lookupSource(componentKey);

/** n8n node for a Pipedream app slug, when n8n ships a native node for it. */
export function n8nNodeForApp(app: string): { type: string; displayName: string; credential?: string } | undefined {
  return APP_NODES[normalizeApp(app)];
}

/**
 * Pipedream app slugs whose name (after the suffix rules below) differs from the app n8n integrates:
 * "xero_accounting_api" is Xero, "salesforce_rest_api" is Salesforce, and so on.
 */
const APP_ALIASES: Record<string, string> = {
  xero_accounting: "xero",
  salesforce_rest: "salesforce",
  linear_app: "linear",
  whatsapp_business: "whatsapp",
  zoom_admin: "zoom",
  microsoft_outlook_calendar: "microsoft_outlook",
  quickbooks_sandbox: "quickbooks",
  wordpress_org: "wordpress",
};

export function normalizeApp(app: string): string {
  const n = app
    .toLowerCase()
    .replace(/_v\d+$/, "")
    .replace(/_(oauth|api_key|bot_api|bot|webhook|api|custom_oauth|developer_app)$/, "");
  return APP_ALIASES[n] ?? n;
}

/** Human label for a Pipedream app slug: "google_sheets" -> "Google Sheets". */
export function appLabel(app: string): string {
  const known: Record<string, string> = {
    openai: "OpenAI",
    github: "GitHub",
    hubspot: "HubSpot",
    clickup: "ClickUp",
    sendgrid: "SendGrid",
    postgresql: "PostgreSQL",
    mysql: "MySQL",
    aws: "AWS",
    http: "HTTP",
    microsoft_teams: "Microsoft Teams",
    microsoft_outlook: "Outlook",
    youtube_data: "YouTube",
    google_gemini: "Google Gemini",
    pipedream_utils: "Pipedream Utils",
    helper_functions: "Helper Functions",
    whatsapp: "WhatsApp",
    linkedin: "LinkedIn",
    youtube: "YouTube",
  };
  const n = normalizeApp(app);
  if (known[n]) return known[n];
  return n
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

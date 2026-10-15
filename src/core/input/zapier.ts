// Zapier exports are read by the free web report at https://workflowexit.com/zapier-to-n8n.
// This open-source CLI reads Pipedream exports only.
import type { Project, VirtualFile } from "../ir";
import { InputError } from "./load";

/** True for a Zapier export (`{metadata, zaps: [{nodes}]}`). */
export function isZapierExport(text: string): boolean {
  return /"zaps"\s*:/.test(text) && /"selected_api"\s*:/.test(text);
}

export function parseZapier(_files: VirtualFile[], _nameHint?: string): Project {
  throw new InputError("This is a Zapier export. Get the free Zapier report at https://workflowexit.com/zapier-to-n8n (it runs in your browser).");
}

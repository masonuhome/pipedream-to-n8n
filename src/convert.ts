// The paid conversion is a hosted service and isn't part of the open-source CLI.
import { SERVICE } from "./input";

export async function convert(_pos: string[], _flags: Record<string, string | true>) {
  console.log(`Converting to n8n runs on ${SERVICE}/report (your first workflow converts free).
The full CLI with the convert command can be downloaded from ${SERVICE}/cli/workflow-exit.mjs`);
  process.exitCode = 1;
}

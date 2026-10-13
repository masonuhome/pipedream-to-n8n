import type { ProjectAnalysis } from "../analyze/project";
import type { Level, WorkflowAnalysis } from "../analyze/workflow";

const DOT: Record<Level, string> = { green: "🟢", yellow: "🟡", red: "🔴" };
const LEVEL_TEXT: Record<Level, string> = {
  green: "converts automatically",
  yellow: "converts with AI rewrite or a quick manual check",
  red: "needs manual work",
};

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

export const SHUTDOWN = { stop: "March 31, 2027", deletion: "April 30, 2027" };

export function renderReportMarkdown(pa: ProjectAnalysis, opts: { generatedAt?: string; tool?: string } = {}): string {
  const { totals, levels, project } = pa;
  const L: string[] = [];
  L.push(`# Pipedream migration report: ${project.name}`);
  L.push("");
  L.push(
    `Generated ${opts.generatedAt ?? new Date().toISOString().slice(0, 10)} by ${opts.tool ?? "Pipedream Exit"}. Pipedream Workflows stop running on **${SHUTDOWN.stop}**; all workflow data, including connected accounts, is deleted by **${SHUTDOWN.deletion}**.`,
  );
  L.push("");
  L.push("## Summary");
  L.push("");
  L.push(`| | |`);
  L.push(`|---|---|`);
  L.push(`| Workflows analyzed | ${totals.workflows}${project.skipped.length ? ` (${project.skipped.length} skipped)` : ""} |`);
  L.push(`| ${DOT.green} Convert automatically | ${levels.green} |`);
  L.push(`| ${DOT.yellow} Need AI rewrite or a quick check | ${levels.yellow} |`);
  L.push(`| ${DOT.red} Need manual work | ${levels.red} |`);
  L.push(`| Steps | ${totals.steps} (${totals.codeSteps} code, ${totals.actions} actions, ${totals.mappedActions} with automatic mapping) |`);
  L.push(`| Accounts to reconnect | ${pa.apps.length} app(s) |`);
  L.push(`| Secrets to re-enter | ${totals.secrets} |`);
  L.push(`| Estimated effort by hand | ~${totals.manualHours} h |`);
  L.push(`| Estimated effort with the converter | ~${totals.withToolHours} h |`);
  L.push("");
  L.push("## Recommended destination");
  L.push("");
  L.push(`**${pa.recommendation.platform === "n8n-cloud" ? "n8n Cloud" : "Self-hosted n8n"}**`);
  L.push("");
  for (const r of pa.recommendation.reasons) L.push(`- ${r}`);
  L.push("");

  if (project.warnings.length) {
    L.push("## Input warnings");
    L.push("");
    for (const w of project.warnings) L.push(`- ${w}`);
    L.push("");
  }

  if (pa.blockers.length) {
    L.push("## What needs attention");
    L.push("");
    L.push("| | Issue | Workflows |");
    L.push("|---|---|---|");
    for (const b of pa.blockers) L.push(`| ${DOT[b.level]} | ${esc(b.message)} | ${b.workflows} |`);
    L.push("");
  }

  if (pa.dataStoreWorkflows.length || pa.fileStoreWorkflows.length) {
    L.push(`## Data to save before ${SHUTDOWN.deletion}`);
    L.push("");
    L.push("The Pipedream export does not include data store records or File Store files.");
    L.push("");
    for (const w of pa.workflows.filter((x) => x.usesDataStore)) {
      const ids = (w.dataStores ?? []).map((id) => `\`${id}\``).join(", ");
      L.push(`- Data store used by **${esc(w.workflow.name)}**${ids ? ` (${ids})` : ""}: export the records (key/value) from the Pipedream UI or with a one-off workflow.`);
    }
    for (const n of pa.fileStoreWorkflows) L.push(`- File Store used by **${esc(n)}**: download the files.`);
    L.push("");
  }

  if (pa.apps.length) {
    L.push("## Accounts to reconnect in n8n");
    L.push("");
    L.push("| App | Workflows | n8n node |");
    L.push("|---|---|---|");
    for (const a of pa.apps) L.push(`| ${esc(a.label)} | ${a.workflows} | ${a.n8nNode ? esc(a.n8nNode) : "HTTP Request"} |`);
    L.push("");
  }

  if (pa.envVars.length) {
    L.push("## Environment variables to recreate");
    L.push("");
    L.push("Pipedream does not export environment variable values. Create them as n8n Variables (or env vars on self-hosted n8n):");
    L.push("");
    L.push(pa.envVars.map((e) => `\`${e}\``).join(", "));
    L.push("");
  }

  if (pa.npm.length) {
    L.push("## npm packages used in code steps");
    L.push("");
    L.push("| Package | Workflows | On n8n Cloud |");
    L.push("|---|---|---|");
    const how = { allowed: "Available", builtin: "Replace with built-in helper", sdk: "Rewrite as HTTP calls", hard: "Not available: self-host" };
    for (const p of pa.npm) L.push(`| \`${p.name}\` | ${p.workflows} | ${how[p.cls]} |`);
    L.push("");
  }

  L.push("## Workflows");
  L.push("");
  for (const w of pa.workflows) L.push(...renderWorkflow(w));

  if (project.skipped.length) {
    L.push("## Skipped by the export");
    L.push("");
    for (const s of project.skipped) L.push(`- ${esc(s.name)}: ${s.status.replace(/_/g, " ")}`);
    L.push("");
  }
  return L.join("\n");
}

function renderWorkflow(w: WorkflowAnalysis): string[] {
  const L: string[] = [];
  const wf = w.workflow;
  L.push(`### ${DOT[w.level]} ${esc(wf.name)}`);
  L.push("");
  L.push(
    `${LEVEL_TEXT[w.level][0].toUpperCase()}${LEVEL_TEXT[w.level].slice(1)}.${wf.folder ? ` Folder: \`${wf.folder}\`.` : ""}${wf.inactive ? " Inactive in Pipedream." : ""} Effort: ~${w.manualHours} h by hand, ~${w.withToolHours} h with the converter.`,
  );
  L.push("");
  L.push("| | Step | Pipedream | n8n |");
  L.push("|---|---|---|---|");
  for (const t of w.triggers) L.push(`| ${DOT[t.level]} | trigger | ${esc(t.label)} | ${esc(t.target)} |`);
  for (const s of w.steps) {
    const indent = s.depth ? `${"↳ ".repeat(s.depth)}` : "";
    L.push(`| ${DOT[s.level]} | ${indent}${esc(s.name)} | ${esc(s.label)} | ${esc(s.target)} |`);
  }
  L.push("");
  const notes = w.issues.filter((i) => i.level !== "green");
  if (notes.length) {
    for (const i of notes) L.push(`- ${i.level === "info" ? "ℹ️" : DOT[i.level]} ${i.step ? `**${esc(i.step)}**: ` : ""}${esc(i.message)}`);
    L.push("");
  }
  return L;
}

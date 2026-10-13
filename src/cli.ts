// workflow-exit: free, local migration report for Pipedream Workflows (shutting down March 31, 2027),
// plus helpers to pull workflows through the Pipedream REST API and to run the hosted conversion.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeProject, InputError, loadProject, renderReportMarkdown } from "./core/report";
import { readInput, SERVICE, VERSION } from "./input";

const HELP = `workflow-exit ${VERSION}: move Pipedream workflows to n8n

Usage:
  workflow-exit report <export.zip | folder | files...> [--out REPORT.md]
      Analyze a Pipedream export locally. Nothing leaves your machine.

  workflow-exit pull --org <o_xxx> [--ids <file> | --id <p_xxx>] [--out ./pipedream-workflows]
      Download workflow definitions with the Pipedream REST API (for plans that
      can't use Export Workflows). Needs PIPEDREAM_API_KEY in the environment.
      Without --id/--ids it lists the workspace's workflows itself. IDs can also come
      from Workspace > ... > "Export tree as text" (any text with p_xxx IDs works).

  workflow-exit convert <export> --key <wx_...> [--target n8n-cloud|n8n-self-hosted] [--out ./n8n-migration]
      Convert with your Workflow Exit access key (sends workflow definitions to ${SERVICE}).

Docs: ${SERVICE}/pipedream-to-n8n
`;

function args(argv: string[]) {
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith("--")) flags[k] = argv[++i];
      else flags[k] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

async function report(pos: string[], flags: Record<string, string | true>) {
  if (!pos.length) throw new InputError("Give a path: workflow-exit report project_export-xxx.zip");
  const { files, name } = readInput(pos);
  const project = loadProject(files, name);
  const pa = analyzeProject(project);
  const out = typeof flags.out === "string" ? flags.out : "REPORT.md";
  writeFileSync(out, renderReportMarkdown(pa, { tool: `workflow-exit ${VERSION}` }));
  const { totals, levels } = pa;
  console.log(`\n${project.name}: ${totals.workflows} workflows, ${totals.steps} steps (${totals.codeSteps} code)`);
  console.log(`  🟢 ${levels.green} automatic   🟡 ${levels.yellow} rewrite/check   🔴 ${levels.red} manual`);
  console.log(`  Effort: ~${totals.manualHours} h by hand, ~${totals.withToolHours} h with the converter`);
  console.log(`  Recommended: ${pa.recommendation.platform === "n8n-cloud" ? "n8n Cloud" : "self-hosted n8n"}`);
  for (const b of pa.blockers.slice(0, 5)) console.log(`  ${b.level === "red" ? "🔴" : "🟡"} ${b.message} (${b.workflows})`);
  console.log(`\nFull report: ${out}\nConvert to n8n: ${SERVICE}/report\n`);
}

const API = (process.env.PIPEDREAM_API_URL ?? "https://api.pipedream.com/v1").replace(/\/$/, "");

async function pdGet(path: string, key: string): Promise<{ ok: boolean; status: number; body: unknown; text: string }> {
  const res = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${key}` } });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { ok: res.ok, status: res.status, body, text };
}

/** Workflow IDs of the workspace (undocumented `GET /v1/users/me/workflows`; the shape is read tolerantly). */
async function listWorkflowIds(org: string, key: string): Promise<string[]> {
  const ids = new Set<string>();
  let after: string | undefined;
  for (let page = 0; page < 50; page++) {
    const r = await pdGet(`/users/me/workflows?org_id=${encodeURIComponent(org)}&limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`, key);
    if (!r.ok) {
      if (page === 0) throw new InputError(`Listing workflows failed (${r.status}). Pass IDs with --ids tree.txt (Workspace > ... > "Export tree as text").`);
      break;
    }
    const before = ids.size;
    for (const m of r.text.match(/"p_[A-Za-z0-9]+"/g) ?? []) ids.add(m.slice(1, -1));
    const info = (r.body as { page_info?: { end_cursor?: string; has_more?: boolean } } | undefined)?.page_info;
    if (!info?.end_cursor || info.has_more === false || ids.size === before) break;
    after = info.end_cursor;
  }
  return [...ids];
}

/** Branches of control-flow blocks are separate pipelines: `_controlFlow ... route.pipeline {id, deploymentId}`. */
function branchRoutes(steps: unknown): { pipeline: string; deployment: string }[] {
  const out: { pipeline: string; deployment: string }[] = [];
  const visit = (v: unknown) => {
    if (typeof v === "string" && v.includes("deploymentId")) {
      try {
        visit(JSON.parse(v));
      } catch {
        /* not JSON */
      }
      return;
    }
    if (Array.isArray(v)) return v.forEach(visit);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const p = o.pipeline as Record<string, unknown> | undefined;
      if (p && typeof p.id === "string" && typeof p.deploymentId === "string") out.push({ pipeline: p.id, deployment: p.deploymentId });
      Object.values(o).forEach(visit);
    }
  };
  visit(steps);
  return out;
}

async function pull(flags: Record<string, string | true>) {
  const key = process.env.PIPEDREAM_API_KEY;
  if (!key) throw new InputError("Set PIPEDREAM_API_KEY (Pipedream > Settings > API keys). It is only sent to api.pipedream.com.");
  const org = typeof flags.org === "string" ? flags.org : process.env.PIPEDREAM_ORG_ID;
  if (!org) throw new InputError("Pass --org o_xxx (Workspace settings) or set PIPEDREAM_ORG_ID.");
  let ids: string[] = [];
  if (typeof flags.id === "string") ids = [flags.id];
  if (typeof flags.ids === "string") ids = [...new Set(readFileSync(flags.ids, "utf8").match(/p_[A-Za-z0-9]+/g) ?? [])];
  if (!ids.length) {
    console.log("No --id/--ids given: listing the workspace's workflows…");
    ids = await listWorkflowIds(org, key);
  }
  if (!ids.length) throw new InputError("No workflow IDs. Use --id p_xxx or --ids tree.txt");
  const out = typeof flags.out === "string" ? flags.out : "pipedream-workflows";
  mkdirSync(out, { recursive: true });
  let ok = 0;
  for (const id of ids) {
    const r = await pdGet(`/workflows/${id}?org_id=${encodeURIComponent(org)}`, key);
    if (!r.ok || !r.body) {
      console.log(`✗ ${id}: ${r.status} ${r.text.slice(0, 160)}`);
      continue;
    }
    const body = r.body as Record<string, unknown>;
    const wf = (body.data && typeof body.data === "object" ? body.data : body) as Record<string, unknown>;
    // Fetch branch pipelines (nested blocks too) and keep their steps as `deployments` of this workflow.
    const deployments: { id: string; pipeline: string; steps: unknown }[] = [];
    const queue = branchRoutes(wf.steps);
    const seen = new Set<string>();
    while (queue.length && deployments.length < 200) {
      const route = queue.shift()!;
      if (seen.has(route.deployment) || route.pipeline === id) continue;
      seen.add(route.deployment);
      const b = await pdGet(`/workflows/${route.pipeline}?org_id=${encodeURIComponent(org)}`, key);
      const bw = b.body as Record<string, unknown> | undefined;
      const steps = (bw?.data as Record<string, unknown> | undefined)?.steps ?? bw?.steps;
      if (!b.ok || !Array.isArray(steps)) {
        console.log(`  ! ${id}: branch ${route.pipeline} not readable (${b.status}); the report will list it`);
        continue;
      }
      deployments.push({ id: route.deployment, pipeline: route.pipeline, steps });
      queue.push(...branchRoutes(steps));
      await new Promise((res) => setTimeout(res, 200));
    }
    if (deployments.length) wf.deployments = deployments;
    writeFileSync(join(out, `${id}.json`), JSON.stringify(body, null, 2));
    ok++;
    console.log(`✓ ${id}${deployments.length ? ` (+${deployments.length} branch${deployments.length > 1 ? "es" : ""})` : ""}`);
    await new Promise((res) => setTimeout(res, 200));
  }
  console.log(`\n${ok}/${ids.length} saved to ${out}/. Next: workflow-exit report ${out}`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, flags } = args(rest);
  if (!cmd || cmd === "help" || cmd === "--help" || flags.help) return void console.log(HELP);
  if (cmd === "--version" || cmd === "version") return void console.log(VERSION);
  if (cmd === "report") return report(pos, flags);
  if (cmd === "pull") return pull(flags);
  if (cmd === "convert") return (await import("./convert")).convert(pos, flags);
  console.log(HELP);
  process.exitCode = 1;
}

main().catch((e) => {
  console.error(e instanceof InputError ? `Error: ${e.message}` : e);
  process.exitCode = 1;
});

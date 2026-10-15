import { strFromU8, unzipSync } from "fflate";
import { parse as parseYaml } from "yaml";
import type { Project, SkippedWorkflow, Step, Trigger, VirtualFile, Workflow } from "../ir";
import { DEFAULT_BRANCH, isObj, listOf, normalizeBranch, normalizeSteps, normalizeTrigger, pick, str, type Obj, type StepContext } from "./normalize";
import { inferTrigger } from "./infer";
import { isZapierExport, parseZapier } from "./zapier";

export class InputError extends Error {}

const MAX_FILES = 20_000;
const MAX_TOTAL_BYTES = 300 * 1024 * 1024;

/** Unpacks a ZIP (export archive or zipped GitHub Sync repo) into virtual files. */
export function unzip(data: Uint8Array): VirtualFile[] {
  let entries: Record<string, Uint8Array>;
  // Sizes come from the ZIP directory, so a zip bomb is refused before anything is inflated.
  let count = 0;
  let declared = 0;
  const wanted = (name: string) => /\.(json|ya?ml|js|mjs|cjs|ts|py|sh|go|txt|md)$/i.test(name) || name.endsWith(".workflow.state");
  try {
    entries = unzipSync(data, {
      filter: (f) => {
        if (f.name.endsWith("/") || /(^|\/)(node_modules|\.git)\//.test(f.name) || !wanted(f.name)) return false;
        if (++count > MAX_FILES) throw new InputError("The archive has too many files.");
        declared += f.originalSize;
        if (declared > MAX_TOTAL_BYTES) throw new InputError("The archive is larger than 300 MB once unpacked.");
        return true;
      },
    });
  } catch (e) {
    if (e instanceof InputError) throw e;
    throw new InputError("This file is not a valid ZIP archive.");
  }
  const files: VirtualFile[] = [];
  let total = 0;
  for (const [path, bytes] of Object.entries(entries)) {
    if (files.length >= MAX_FILES) throw new InputError("The archive has too many files.");
    total += bytes.length;
    if (total > MAX_TOTAL_BYTES) throw new InputError("The archive is larger than 300 MB once unpacked.");
    if (!/\.(json|ya?ml|js|mjs|cjs|ts|py|sh|go|txt|md)$/i.test(path) && !path.endsWith(".workflow.state")) continue;
    files.push({ path: path.replace(/\\/g, "/"), text: strFromU8(bytes) });
  }
  return files;
}

const MANIFEST = /(^|\/)manifest\.json$/;
const WORKFLOW_YAML = /(^|\/)workflow\.ya?ml$/;

/** Detects the input format and parses it into a Project. */
export function loadProject(input: VirtualFile[], nameHint = "Pipedream project"): Project {
  // Windows editors and PowerShell write a UTF-8 BOM, which JSON.parse rejects.
  const files = stripCommonRoot(input.map((f) => (f.text.charCodeAt(0) === 0xfeff ? { ...f, text: f.text.slice(1) } : f)));
  const manifests = files.filter((f) => MANIFEST.test(f.path) && f.text.includes("project-export"));
  const zaps = files.filter((f) => /\.json$/i.test(f.path) && isZapierExport(f.text));
  let project: Project;
  if (zaps.length && !manifests.length) project = parseZapier(zaps, nameHint === "Pipedream project" ? "Zapier account" : nameHint);
  else if (manifests.length) project = manifests.length === 1 ? parseExport(files, manifests[0]) : parseExports(files, manifests);
  else if (files.some((f) => isSyncWorkflowFile(f))) project = parseGitSync(files, nameHint);
  else {
    const workflowJsons = files.filter((f) => f.path.endsWith(".json") && looksLikeWorkflowJson(f.text));
    if (!workflowJsons.length) {
      throw new InputError(
        "Could not find Pipedream workflows. Upload the project export ZIP (project_export-*.zip), a GitHub Sync repository, or workflow JSON files.",
      );
    }
    project = parseJsonWorkflows(workflowJsons, nameHint, files);
  }
  uniqueWorkflowIds(project);
  warnIfMostlyRedacted(project);
  return project;
}

/**
 * The export docs say only secrets are `<redacted>`, but a first-hand report says all configured values
 * were. When most values are redacted, say so: the user has to re-enter far more than secrets.
 */
function warnIfMostlyRedacted(project: Project) {
  let total = 0;
  let redacted = 0;
  const count = (steps: Step[]) => {
    for (const s of steps) {
      for (const v of Object.values(s.props)) {
        if (v.t === "app") continue;
        total++;
        if (v.t === "redacted") redacted++;
      }
      if (s.kind === "control") for (const b of s.branches) count(b.steps);
    }
  };
  for (const wf of project.workflows) count(wf.steps);
  if (total >= 10 && redacted / total > 0.6) {
    project.warnings.push(
      `${redacted} of ${total} step settings are <redacted> in this input, not only secrets. Re-enter them in n8n: the converted nodes and CHECKLIST.md name each one.`,
    );
  }
}

function stripCommonRoot(files: VirtualFile[]): VirtualFile[] {
  if (files.length === 0) return files;
  const first = files[0].path.split("/");
  if (first.length < 2) return files;
  const root = first[0] + "/";
  if (files.every((f) => f.path.startsWith(root))) {
    return stripCommonRoot(files.map((f) => ({ ...f, path: f.path.slice(root.length) })));
  }
  return files;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function looksLikeWorkflowJson(text: string): boolean {
  if (/"v"\s*:\s*2/.test(text) && templateOf(safeJson(text))) return true;
  if (!/"steps"|"triggers"/.test(text)) return false;
  const j = safeJson(text);
  const wf = isObj(j) && isObj(j.data) ? j.data : j;
  return isObj(wf) && (Array.isArray(wf.steps) || Array.isArray(wf.triggers));
}

function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

/** Two workflows must never share an id (output file names and report rows are keyed by it). */
function uniqueWorkflowIds(project: Project) {
  const seen = new Set<string>();
  for (const wf of project.workflows) {
    let id = wf.id;
    for (let i = 2; seen.has(id); i++) id = `${wf.id}-${i}`;
    if (id !== wf.id) {
      wf.warnings.push(`Another workflow has the id ${wf.id}; this one is listed as ${id}.`);
      wf.id = id;
    }
    seen.add(id);
  }
}

// ---------------------------------------------------------------------------
// A. Official export: manifest.json + one JSON per workflow

/** Workflow files a manifest lists, resolved to file paths. */
function listedPaths(manifestFile: VirtualFile): string[] {
  const manifest = safeJson(manifestFile.text);
  const base = dirname(manifestFile.path);
  const entries = isObj(manifest) && Array.isArray(manifest.workflows) ? manifest.workflows : [];
  return entries.map((e) => str(pick(e, "path"))).filter((p): p is string => !!p).map((p) => (base ? `${base}/${p}` : p));
}

function parseExport(files: VirtualFile[], manifestFile: VirtualFile, others: { bases: string[]; claimed: Set<string> } = { bases: [], claimed: new Set() }): Project {
  const manifest = safeJson(manifestFile.text);
  if (!isObj(manifest)) throw new InputError(`${manifestFile.path} is not valid JSON.`);
  const base = dirname(manifestFile.path);
  // Unlisted workflow files belong to this export only if no other manifest lists or contains them.
  const inBase = (p: string) =>
    (!base || p.startsWith(base + "/")) && !others.claimed.has(p) && !others.bases.some((o) => o.length > base.length && p.startsWith(o + "/"));
  const rel = (p: string) => (base ? p.slice(base.length + 1) : p);
  const byPath = new Map(files.map((f) => [f.path, f]));
  const project: Project = {
    id: str(manifest.project_hashid),
    name: str(manifest.project_name) ?? str(manifest.project_hashid) ?? "Pipedream project",
    source: "export",
    exportedAt: str(manifest.exported_at),
    truncated: manifest.truncated === true,
    workflows: [],
    skipped: [],
    warnings: [],
  };
  if (project.truncated) {
    project.warnings.push(
      `The export was truncated (${str(manifest.truncated_reason) ?? "limit reached"}). Move some workflows to another project and export it too.`,
    );
  }
  const entries = Array.isArray(manifest.workflows) ? manifest.workflows : [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!isObj(entry)) continue;
    const status = str(entry.status) ?? "exported";
    const name = str(entry.name) ?? str(entry.hashid) ?? "Untitled workflow";
    const path = str(entry.path);
    if (status !== "exported" || !path) {
      project.skipped.push({ id: str(entry.hashid), name, status });
      continue;
    }
    const file = byPath.get(base ? `${base}/${path}` : path) ?? (base ? undefined : byPath.get(path));
    if (!file) {
      project.skipped.push({ id: str(entry.hashid), name, status: "missing_file" });
      continue;
    }
    seen.add(file.path);
    const warnings = Array.isArray(entry.warnings) ? entry.warnings.map(String) : [];
    const wf = safeParse(() =>
      parseWorkflowObject(safeJson(file.text), {
        id: str(entry.hashid),
        name,
        folder: dirname(path),
        warnings,
      }),
    );
    if (wf) project.workflows.push(wf);
    else project.skipped.push({ id: str(entry.hashid), name, status: "unreadable" });
  }
  // Workflow files that the manifest does not list (hand-edited archives).
  for (const f of files) {
    if (seen.has(f.path) || f === manifestFile || !inBase(f.path) || !f.path.endsWith(".json") || !looksLikeWorkflowJson(f.text)) continue;
    const wf = safeParse(() => parseWorkflowObject(safeJson(f.text), { folder: dirname(rel(f.path)), warnings: [], fallbackName: baseName(f.path) }));
    if (wf) project.workflows.push(wf);
    else project.skipped.push({ name: f.path, status: "unreadable" });
  }
  return project;
}

/** Several project exports in one upload: one project; each workflow records the project it came from. */
function parseExports(files: VirtualFile[], manifests: VirtualFile[]): Project {
  const bases = manifests.map((m) => dirname(m.path));
  const listed = manifests.map(listedPaths);
  const parts = manifests.map((m, i) => parseExport(files, m, { bases, claimed: new Set(listed.filter((_, j) => j !== i).flat()) }));
  const project: Project = {
    name: parts.map((p) => p.name).join(" + "),
    source: "export",
    exportedAt: parts.map((p) => p.exportedAt).find(Boolean),
    truncated: parts.some((p) => p.truncated),
    workflows: [],
    skipped: [],
    warnings: [],
  };
  for (const part of parts) {
    for (const wf of part.workflows) project.workflows.push({ ...wf, project: part.name });
    project.skipped.push(...part.skipped.map((s) => ({ ...s, project: part.name })));
    project.warnings.push(...part.warnings.map((w) => `${part.name}: ${w}`));
  }
  project.warnings.push(`${parts.length} project exports were uploaded together: ${parts.map((p) => p.name).join(", ")}.`);
  return project;
}

const baseName = (p: string) => p.split("/").pop()?.replace(/\.json$/i, "");

/** One malformed workflow must not fail the whole project. */
function safeParse(fn: () => Workflow | undefined): Workflow | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// B. REST API payloads (`workflow_definition.json`) or loose workflow JSON files

function parseJsonWorkflows(files: VirtualFile[], nameHint: string, allFiles: VirtualFile[] = files): Project {
  const project: Project = { name: nameHint, source: "api", workflows: [], skipped: [], warnings: [] };
  for (const f of files) {
    let json = safeJson(f.text);
    if (isObj(json) && String(json.schema ?? "").startsWith("workflow.json")) project.source = "export";
    const template = templateOf(json);
    if (template) {
      project.source = "template";
      json = templateWorkflow(template, str(pick(json, "id")));
    }
    const dir = dirname(f.path);
    // toolkit layout: <folder>/<Workflow>/workflow_definition.json
    const isDefinitionFile = /workflow_definition\.json$/.test(f.path);
    const folder = isDefinitionFile ? dirname(dir) : dir;
    const fileBase = isDefinitionFile ? dir.split("/").pop() : baseName(f.path);
    // Sibling step files written by pipedream-toolkit when the payload lacks inline code.
    const readLocal = (p: string) => {
      const clean = p.replace(/^\.\//, "");
      return allFiles.find((x) => x.path === (dir ? `${dir}/${clean}` : clean))?.text;
    };
    // `workflow-exit pull` saves each workflow as <p_id>.json.
    const idFromFile = fileBase?.match(/(?:^|[-_ ])(p_[A-Za-z0-9]+)$/)?.[1] ?? (fileBase && /^p_[A-Za-z0-9]+$/.test(fileBase) ? fileBase : undefined);
    const wf = safeParse(() => parseWorkflowObject(json, { name: undefined, folder, warnings: [], fallbackName: fileBase, fallbackId: idFromFile, readLocal }));
    if (wf) project.workflows.push(wf);
    else project.skipped.push({ name: f.path, status: "unreadable" });
  }
  return project;
}

interface WorkflowMeta {
  id?: string;
  name?: string;
  folder: string;
  warnings: string[];
  fallbackName?: string;
  fallbackId?: string;
  readLocal?: (path: string) => string | undefined;
}

export function parseWorkflowObject(json: unknown, meta: WorkflowMeta): Workflow | undefined {
  let wf = json;
  if (isObj(wf) && isObj(wf.data) && !wf.steps) wf = wf.data;
  if (isObj(wf) && isObj(wf.workflow) && !wf.steps) wf = wf.workflow;
  if (!isObj(wf)) return undefined;

  const warnings = [...meta.warnings];
  const ctx: StepContext = { warn: (m) => warnings.push(m), readLocal: meta.readLocal };
  const triggersRaw = (pick<unknown[]>(wf, "triggers") ?? (pick(wf, "trigger") ? [pick(wf, "trigger")] : [])) as unknown[];
  const triggers: Trigger[] = listOf(triggersRaw).map(normalizeTrigger);
  const steps = normalizeSteps(pick(wf, "steps"), ctx);

  attachDeployments(wf, steps, ctx);
  uniqueStepNames(steps, ctx);
  const nameOf = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const name = nameOf(meta.name) ?? nameOf(wf.name) ?? nameOf(meta.fallbackName) ?? "Untitled workflow";
  const workflow: Workflow = {
    id: meta.id ?? str(pick(wf, "hashid", "id", "workflow_id")) ?? meta.fallbackId ?? slug(name),
    name,
    description: str(wf.description),
    inactive: wf.inactive === true || wf.active === false,
    folder: meta.folder,
    triggers,
    steps,
    settings: isObj(wf.settings) ? (wf.settings as Obj) : undefined,
    warnings,
  };
  // Infer only when the input has no usable trigger; a disabled trigger is kept as it is.
  if (triggers.length === 0 || triggers.every((t) => t.kind === "unknown" && !t.disabled)) inferTrigger(workflow);
  return workflow;
}

const BRANCHING = new Set(["ifelse", "switch", "parallel", "loop", "ai", "unknown"]);

/** A deployment value keyed by block name may hold labelled branches instead of steps. */
const isBranchList = (v: unknown): v is unknown[] =>
  Array.isArray(v) &&
  v.length > 0 &&
  v.every((x) => isObj(x) && (x.steps !== undefined || x.cells !== undefined) && x.type === undefined && x.uses === undefined && x.namespace === undefined && x.component_key === undefined);

/**
 * Export files keep branch steps under `deployments`, one deployment per branch, referenced by the
 * block's `route.pipeline.deploymentId`. Accepts an array of `{id, steps}` or an object keyed by id,
 * and (older guesses) deployments keyed by the block's name with labelled branches.
 */
function attachDeployments(wf: Obj, steps: Step[], ctx: StepContext) {
  const groups = new Map<string, { raw: unknown; used: boolean }>();
  const entries: [string | undefined, unknown][] = Array.isArray(wf.deployments)
    ? wf.deployments.map((d): [string | undefined, unknown] => [str(pick(d, "id", "deploymentId", "deployment_id")) ?? str(pick(d, "parent", "block", "step", "namespace", "name")), d])
    : isObj(wf.deployments)
      ? Object.entries(wf.deployments)
      : [];
  entries.forEach(([id, raw], i) => groups.set(id ?? `deployment_${i + 1}`, { raw, used: false }));

  const topNames = new Set(steps.map((s) => s.name));
  const rawSteps = (raw: unknown) => (isBranchList(raw) ? [] : listOf(Array.isArray(raw) ? raw : pick(raw, "steps", "cells")));
  const stepsOf = (raw: unknown) => normalizeSteps(rawSteps(raw), ctx);
  const rawNames = (raw: unknown) => rawSteps(raw).map((x) => str(pick(x, "namespace", "name", "step_name", "__key", "id")));
  const branchesOf = (raw: unknown): unknown[] => (isBranchList(raw) ? raw : listOf(pick(raw, "branches", "cases", "paths")));
  const blocks: Extract<Step, { kind: "control" }>[] = [];

  const visit = (list: Step[]) => {
    for (const s of list) {
      if (s.kind !== "control") continue;
      blocks.push(s);
      for (const b of s.branches) {
        if (!b.deploymentId || b.steps.length) continue;
        const g = groups.get(b.deploymentId);
        if (g && !g.used) {
          g.used = true;
          b.steps = stepsOf(g.raw);
        } else if (!g && b.deploymentId !== "d__loop") {
          ctx.warn(
            groups.size
              ? `${s.name} → ${b.label}: branch deployment ${b.deploymentId} is missing from the input; rebuild the branch in n8n.`
              : `${s.name} → ${b.label}: the steps of this branch are not in the input; rebuild them in n8n.`,
          );
        }
      }
      // Deployments keyed by the block name, holding labelled branches (or one branch's steps).
      const byName = groups.get(s.name);
      if (byName && !byName.used && BRANCHING.has(s.op)) {
        byName.used = true;
        const list = branchesOf(byName.raw);
        const parsedBranches = list.length ? list.map((rb, i) => normalizeBranch(rb, i, ctx)) : [{ label: s.name, steps: stepsOf(byName.raw) }];
        for (const parsed of parsedBranches) {
          const match = s.branches.find((b) => b.label.toLowerCase() === parsed.label.toLowerCase() && b.steps.length === 0);
          if (match) match.steps = parsed.steps;
          else s.branches.push({ ...parsed, isDefault: DEFAULT_BRANCH.test(parsed.label) || ("isDefault" in parsed && parsed.isDefault === true) });
        }
      }
      for (const b of s.branches) visit(b.steps);
    }
  };
  visit(steps);

  // Leftovers, except the workflow's own top-level deployment, which may be listed too.
  const rest = [...groups.entries()].filter(([, g]) => {
    const names = rawNames(g.raw);
    return !g.used && !(names.length && names.every((n) => n && topNames.has(n)));
  });
  // One branching block without any branch information: its branches are the leftover deployments.
  const bare = blocks.filter((b) => BRANCHING.has(b.op) && b.branches.length === 0);
  if (bare.length === 1 && rest.length && blocks.every((b) => b === bare[0] || b.branches.every((x) => !x.deploymentId))) {
    for (const [key, g] of rest) {
      g.used = true;
      const list = branchesOf(g.raw);
      if (list.length) {
        list.forEach((rb, i) => bare[0].branches.push(normalizeBranch(rb, i, ctx)));
        continue;
      }
      const label = str(pick(g.raw, "label", "name", "n")) ?? key;
      bare[0].branches.push({ label, isDefault: DEFAULT_BRANCH.test(label), steps: stepsOf(g.raw) });
    }
    for (const b of bare[0].branches) visit(b.steps);
  }
  for (const [key, g] of rest) {
    const n = rawNames(g.raw).length + branchesOf(g.raw).length;
    if (g.used || !n) continue;
    ctx.warn(`Deployment ${key} (${n} item${n === 1 ? "" : "s"}) belongs to a branch that could not be matched to a block; rebuild it in n8n.`);
  }
}

/**
 * Step names must be unique in n8n. Pipedream keeps them unique per workflow, but hand-edited inputs
 * may repeat one in two branches: the later one is renamed, with `steps.<name>` references after it updated.
 */
function uniqueStepNames(steps: Step[], ctx: StepContext) {
  const seen = new Set<string>(["trigger"]);
  const rename = (s: Step, map: Map<string, string>) => {
    if (!map.size) return;
    const fix = (text: string) =>
      text.replace(/\bsteps(?:\.([A-Za-z_$][\w$]*)|\[\s*(["'])([^"']+)\2\s*\])/g, (m, dot: string, q: string, br: string) => {
        const to = map.get(dot ?? br);
        return to ? (dot ? `steps.${to}` : `steps[${q}${to}${q}]`) : m;
      });
    if (s.kind === "code") s.code = fix(s.code);
    for (const v of Object.values(s.props)) {
      if ((v.t === "value" || v.t === "lv") && v.value !== undefined) v.value = JSON.parse(fix(JSON.stringify(v.value)));
    }
  };
  const visit = (list: Step[], inherited: Map<string, string>) => {
    const map = new Map(inherited);
    for (const s of list) {
      rename(s, map);
      if (seen.has(s.name)) {
        let n = 2;
        while (seen.has(`${s.name}_${n}`)) n++;
        const to = `${s.name}_${n}`;
        ctx.warn(`Two steps are named ${s.name}; the later one is called ${to} in n8n.`);
        map.set(s.name, to);
        s.name = to;
      }
      seen.add(s.name);
      if (s.kind === "control") for (const b of s.branches) visit(b.steps, map);
    }
  };
  visit(steps, new Map());
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "workflow";
}

// ---------------------------------------------------------------------------
// D. Workflow templates (share links `pipedream.com/new?h=tch_…`, GraphQL `tinyConfigHash`): `{n, v: 2, t, s}`.
// Code steps are references (`sc_…`) without code unless inlined (`c`); registry actions carry `k3`.

/** The `{n, v: 2, t, s}` template inside a `tinyConfigHash` response (or bare). */
function templateOf(j: unknown): Obj | undefined {
  const t = isObj(j) && isObj(j.data) && isObj(j.data.tinyConfigHash) ? j.data.tinyConfigHash : j;
  const inner = isObj(t) && isObj(t.template) ? t.template : t;
  return isObj(inner) && inner.v === 2 && Array.isArray(inner.s) ? inner : undefined;
}

/** "components/slack/actions/send-message/send-message.mjs" -> "slack-send-message" (CI build paths too). */
function keyFromPath(gp: unknown): string | undefined {
  const m = typeof gp === "string" ? gp.match(/components\/([^/]+)\/(?:dist\/)?(?:actions|sources)\/([^/]+)\//) : null;
  return m ? `${m[1]}-${m[2]}` : undefined;
}

/** A template as workflow JSON in the shape the parsers read (GitHub Sync / export field names). */
function templateWorkflow(t: Obj, id?: string): Obj {
  const triggers = listOf(t.t)
    .filter((x): x is Obj => isObj(x) && Object.keys(x).length > 0)
    .map((x) => {
      const common: Obj = { configured_props: isObj(x.cp) ? x.cp : {}, ...(x.d ? { disabled: true } : {}) };
      if (x.n === "h") return { type: "http", ...common };
      if (x.n === "t") return { type: "timer", ...common };
      if (x.n === "e") return { type: "email", ...common };
      if (isObj(x.cp) && x.cp.workflowId) return { id: "sub_template", type: "source", uses: "sc_subscription", ...common };
      const key = keyFromPath(x.gp);
      if (key) return { type: "source", component_key: key, ...common };
      if (x.dc || x.sc) return { id: str(x.dc) ?? "dc_template", type: "source", ...common };
      return common;
    });
  const steps = listOf(t.s)
    .filter(isObj)
    .map((x) => {
      const base: Obj = { namespace: x.n, configured_props: isObj(x.cp) ? x.cp : {}, ...(x.d ? { disabled: true } : {}) };
      if (Array.isArray(x.k3) && typeof x.k3[1] === "string") {
        const [owner, key, version] = x.k3 as [unknown, string, unknown];
        return { ...base, component_key: key, ...(typeof version === "string" ? { version } : {}), ...(typeof owner === "string" ? { component_owner_id: owner } : {}) };
      }
      // A registry component saved as a code step keeps its registry path.
      const key = !x.c ? keyFromPath(x.gp) : undefined;
      if (key) return { ...base, component_key: key };
      return { ...base, type: "code", lang: str(x.l) ?? "nodejs20.x", ...(typeof x.c === "string" ? { code: x.c } : {}) };
    });
  return { ...(id ? { id } : {}), name: str(t.n) ?? "Untitled template", description: str(t.md), triggers, steps };
}

// ---------------------------------------------------------------------------
// C. GitHub Sync: <folder>/<workflow>/workflow.yaml + <step>/entry.js

/** A Pipedream workflow.yaml, not e.g. a GitHub Actions `.github/workflows/workflow.yml`. */
function isSyncWorkflowFile(f: VirtualFile): boolean {
  if (!WORKFLOW_YAML.test(f.path) || /(^|\/)\.github\//.test(f.path)) return false;
  return /schema:\s*["']?workflow\/\d/.test(f.text) || /^\s*-?\s*namespace:/m.test(f.text) || /^\s*-\s*id:\s*["']?(hi|ti|ei|dc|sub)_/m.test(f.text);
}

function parseGitSync(files: VirtualFile[], nameHint: string): Project {
  const project: Project = { name: nameHint, source: "gitsync", workflows: [], skipped: [], warnings: [] };
  const byPath = new Map(files.map((f) => [f.path, f]));
  for (const f of files.filter(isSyncWorkflowFile)) {
    const dir = dirname(f.path);
    let doc: unknown;
    try {
      doc = parseYaml(f.text);
    } catch (e) {
      project.skipped.push({ name: dir || f.path, status: "invalid_yaml" });
      continue;
    }
    if (!isObj(doc)) continue;
    const parts = dir.split("/");
    const state = byPath.get(dir ? `${dir}/.workflow.state` : ".workflow.state")?.text;
    // Without .workflow.state, the folder name still ends with the id: "my-flow-p_AbC123".
    const id = state?.match(/\bid:\s*(p_[A-Za-z0-9]+)/)?.[1] ?? parts[parts.length - 1]?.match(/(?:^|-)(p_[A-Za-z0-9]+)$/)?.[1];
    const readLocal = (p: string) => {
      const clean = p.replace(/^\.\//, "");
      return byPath.get(dir ? `${dir}/${clean}` : clean)?.text;
    };
    const wf = safeParse(() =>
      parseWorkflowObject(
        { ...doc, triggers: gitSyncTriggers(doc as Obj, dir, byPath) },
        {
          id,
          name: str((doc as Obj).name) ?? parts[parts.length - 1] ?? "Untitled workflow",
          folder: parts.slice(0, -1).join("/"),
          warnings: [],
          readLocal,
        },
      ),
    );
    if (wf) project.workflows.push(wf);
    else project.skipped.push({ name: dir || f.path, status: "unreadable" });
  }
  const inferred = project.workflows.filter((w) => w.triggers.some((t) => t.inferred)).length;
  if (inferred) {
    project.warnings.push(
      `GitHub Sync does not store trigger settings (only trigger IDs). Trigger types were inferred from the IDs and from how steps use the event in ${inferred} of ${project.workflows.length} workflows; check them in the report.`,
    );
  }
  return project;
}

/** Trigger ID prefixes used by Pipedream: hi_ HTTP interface, ti_ timer, ei_ email, dc_ deployed source, sub_ subscription. */
const TRIGGER_PREFIX: Record<string, string> = { hi: "http", ti: "timer", ei: "email", dc: "source", sub: "source" };

/**
 * GitHub Sync YAML keeps only trigger IDs (settings stay on Pipedream's servers). The ID prefix
 * still tells the trigger type; trigger files next to workflow.yaml are read if someone added them.
 */
function gitSyncTriggers(doc: Obj, dir: string, byPath: Map<string, VirtualFile>): unknown[] {
  const list = Array.isArray(doc.triggers) ? doc.triggers : [];
  return list.map((t) => {
    if (!isObj(t)) return t;
    const id = str(t.id) ?? "";
    for (const candidate of [`triggers/${id}.yaml`, `triggers/${id}.yml`, `${id}.yaml`]) {
      const file = byPath.get(dir ? `${dir}/${candidate}` : candidate);
      if (!file) continue;
      try {
        const parsed = parseYaml(file.text);
        if (isObj(parsed)) return { id, ...parsed, ...(t.disabled === true ? { disabled: true } : {}) };
      } catch {
        /* fall back to the prefix */
      }
    }
    const type = TRIGGER_PREFIX[id.split("_")[0]];
    if (t.type || t.uses || !type) return t;
    return { ...t, type, settings_missing: true };
  });
}

export type { SkippedWorkflow };

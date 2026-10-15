// Code step check: will a pasted Pipedream code step run on n8n? Browser-safe (analyzer only, no converter), and it
// follows the converter's rules: on n8n Cloud only crypto and moment load, the compatibility layer provides axios,
// node-fetch and @pipedream/platform, and everything else is an AI rewrite task or needs self-hosted n8n.
import type { CodeLang } from "../ir";
import { analyzeCode, N8N_CLOUD_MODULES, NODE_BUILTINS, packageName } from "./code";
import { classifyPackage, classifyPythonPackage, type PackageClass } from "./packages";

/** How a module fares: loads on Cloud, provided by the layer, easy rewrite, API client, or real library logic. */
export type ModuleClass = "allowed" | "shim" | PackageClass;

export interface CheckedModule {
  name: string;
  kind: "npm" | "node" | "python";
  cls: ModuleClass;
}

/** auto: converted by rules; setup: you enter values; ai: AI rewrite (paid plans); manual: you rebuild it. */
export type CheckLevel = "auto" | "setup" | "ai" | "manual";

export type CheckKey =
  | "respond"
  | "exit"
  | "export"
  | "steps"
  | "props"
  | "http"
  | "sendHttp"
  | "dataStore"
  | "env"
  | "appAuth"
  | "python"
  | "delay"
  | "suspend"
  | "rerun"
  | "flowTrigger"
  | "send"
  | "services"
  | "fileStore"
  | "tmp";

export interface CheckItem {
  key: CheckKey;
  level: CheckLevel;
  /** Names to show with the item: env vars, accounts, steps, destinations. */
  items?: string[];
}

export interface CodeCheck {
  lang: "nodejs" | "python";
  parseError?: string;
  /** n8n Cloud: runs as converted, needs the AI rewrite, or is best on self-hosted n8n. */
  cloud: "ready" | "ai" | "selfhost";
  /** Self-hosted n8n: runs as converted, needs module settings, or needs the AI rewrite. */
  selfHosted: "ready" | "config" | "ai";
  modules: CheckedModule[];
  items: CheckItem[];
  /** Self-hosted settings for the modules the step loads. */
  allowBuiltin: string[];
  allowExternal: string[];
}

const SHIMMED = new Set(["axios", "node-fetch", "@pipedream/types", "@pipedreamhq/platform"]);
// Node modules whose use is real I/O or process logic; the rest are easy to rewrite with n8n helpers or plain JS.
const HARD_NODE = new Set(["fs", "child_process", "os", "zlib", "stream", "net", "dns", "tls", "dgram", "cluster", "worker_threads", "vm", "v8", "readline", "perf_hooks", "inspector"]);

/** Python when it looks like a Pipedream Python step (handler(pd) or pd.*) and not like JavaScript. */
export function detectLang(code: string): "nodejs" | "python" {
  const js = /\bexport\s+default\b|\bdefineComponent\s*\(|\bmodule\.exports\b|=>|\bconst\s+\w+\s*=|\bawait\s+\$\./.test(code);
  const py = /^\s*def\s+handler\s*\(|\bpd\.(steps|inputs|export|respond|flow)\b|^\s*(from\s+[\w.]+\s+)?import\s+[\w., ]+\s*$/m.test(code);
  return py && !js ? "python" : "nodejs";
}

export function checkCode(code: string, lang: CodeLang = detectLang(code)): CodeCheck {
  const language = lang === "python" ? "python" : "nodejs";
  const a = analyzeCode({ kind: "code", name: "step", lang: language, code, props: {} });
  const items: CheckItem[] = [];
  const add = (key: CheckKey, level: CheckLevel, list?: string[]) => items.push({ key, level, ...(list?.length ? { items: list } : {}) });
  const modules: CheckedModule[] = [];

  if (language === "python") {
    for (const m of a.npmImports) modules.push({ name: m, kind: "python", cls: classifyPythonPackage(m) });
    for (const m of a.builtinImports) modules.push({ name: m, kind: "python", cls: "builtin" });
    add("python", "ai");
  } else {
    for (const spec of [...a.npmImports, ...a.builtinImports]) {
      const name = packageName(spec.replace(/^node:/, ""));
      if (modules.some((m) => m.name === name)) continue;
      if (NODE_BUILTINS.has(name)) modules.push({ name, kind: "node", cls: N8N_CLOUD_MODULES.has(name) ? "allowed" : HARD_NODE.has(name) ? "hard" : "builtin" });
      else if (SHIMMED.has(name)) modules.push({ name, kind: "npm", cls: "shim" });
      else modules.push({ name, kind: "npm", cls: N8N_CLOUD_MODULES.has(name) ? "allowed" : classifyPackage(name) });
    }
  }

  if (a.usesRespond) add("respond", "auto");
  if (a.usesExit) add("exit", "auto");
  if (a.usesExport) add("export", "auto", a.exports);
  if (a.stepRefs.length) add("steps", "auto", a.stepRefs);
  // Accounts and data stores have their own lines.
  const plainProps = a.props.filter((p) => p.type !== "app" && p.type !== "data_store").map((p) => p.name);
  if (plainProps.length) add("props", "auto", plainProps);
  if (a.usesPlatformAxios || a.httpClients.some((c) => ["axios", "node-fetch", "fetch"].includes(c))) add("http", "auto", a.httpClients);
  if (a.sendDestinations.includes("http")) add("sendHttp", "auto");
  if (a.usesDataStore) add("dataStore", "auto");
  if (a.envVars.length) add("env", "setup", a.envVars);
  const apps = [...new Set([...a.appAuth, ...a.props.filter((p) => p.type === "app").map((p) => p.app ?? p.name)])];
  if (apps.length) add("appAuth", "setup", apps);
  if (a.usesDelay) add("delay", "ai");
  if (a.usesSuspend) add("suspend", "ai");
  if (a.usesRerun) add("rerun", "ai");
  if (a.usesFlowTrigger) add("flowTrigger", "ai");
  const send = a.sendDestinations.filter((d) => d !== "http");
  if (send.length) add("send", "ai", send);
  if (a.usesServices) add("services", "manual");
  if (a.usesFileStore) add("fileStore", "manual");
  if (a.usesTmp) add("tmp", "manual");

  const blocked = modules.filter((m) => m.cls !== "allowed" && m.cls !== "shim");
  const needsAi = language === "python" || items.some((i) => i.level === "ai");
  const cloud: CodeCheck["cloud"] = blocked.some((m) => m.cls === "hard") ? "selfhost" : blocked.length || needsAi ? "ai" : "ready";
  const allowBuiltin = language === "nodejs" ? blocked.filter((m) => m.kind === "node").map((m) => m.name) : [];
  const allowExternal = language === "nodejs" ? blocked.filter((m) => m.kind === "npm").map((m) => m.name) : [];
  const selfHosted: CodeCheck["selfHosted"] = needsAi ? "ai" : allowBuiltin.length || allowExternal.length ? "config" : "ready";

  return { lang: language, ...(a.parseError ? { parseError: a.parseError } : {}), cloud, selfHosted, modules, items, allowBuiltin, allowExternal };
}

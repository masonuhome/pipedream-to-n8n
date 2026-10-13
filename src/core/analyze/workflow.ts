import { actionMapping, appLabel, n8nNodeForApp, normalizeApp, sourceMapping } from "../catalog";
import { builtinActionName } from "../convert/builtinKeys";
import type { CodeLang, Project, PropValue, Step, Trigger, Workflow } from "../ir";
import { analyzeCode, dataStoreIds, isRespondAction, type CodeAnalysis } from "./code";
import { classifyPackage, classifyPythonPackage, type PackageClass } from "./packages";

export type Level = "green" | "yellow" | "red";
export type IssueLevel = Level | "info";

export interface Issue {
  level: IssueLevel;
  code: IssueCode;
  message: string;
  step?: string;
}

export type IssueCode =
  | "TRIGGER_HTTP_URL"
  | "TRIGGER_HTTP_RESPONSE"
  | "TRIGGER_TIMER"
  | "TRIGGER_SOURCE_MAPPED"
  | "TRIGGER_SOURCE_NODE"
  | "TRIGGER_SOURCE_UNMAPPED"
  | "TRIGGER_SOURCE_PRIVATE"
  | "TRIGGER_EMAIL"
  | "TRIGGER_FORM"
  | "TRIGGER_UNKNOWN"
  | "TRIGGER_INFERRED"
  | "TRIGGER_DISABLED"
  | "CODE_NPM_BUILTIN"
  | "CODE_NPM_SDK"
  | "CODE_NPM_HARD"
  | "CODE_PLATFORM_AXIOS"
  | "CODE_RESPOND"
  | "CODE_DELAY"
  | "CODE_SUSPEND"
  | "CODE_RERUN"
  | "CODE_FLOW_TRIGGER"
  | "CODE_SERVICES"
  | "CODE_SEND"
  | "CODE_DATA_STORE"
  | "CODE_FILE_STORE"
  | "CODE_TMP"
  | "CODE_ENV"
  | "CODE_APP_AUTH"
  | "CODE_PYTHON"
  | "CODE_UNSUPPORTED_LANG"
  | "CODE_PARSE_ERROR"
  | "CODE_MISSING"
  | "ACTION_MAPPED"
  | "ACTION_BUILTIN"
  | "ACTION_APP_NODE"
  | "ACTION_NO_NODE"
  | "ACTION_PRIVATE"
  | "CONTROL_BRANCH"
  | "CONTROL_DELAY"
  | "CONTROL_PARALLEL"
  | "CONTROL_LOOP"
  | "CONTROL_AI"
  | "CONTROL_DISABLED"
  | "CONTROL_UNKNOWN"
  | "UNKNOWN_STEP"
  | "SECRET_REDACTED"
  | "ACCOUNT_CONNECT"
  | "INPUT_WARNING";

export interface StepAnalysis {
  name: string;
  kind: Step["kind"];
  /** Depth inside control-flow blocks (0 = root). */
  depth: number;
  branch?: string;
  label: string;
  /** What it becomes in n8n. */
  target: string;
  level: Level;
  issues: Issue[];
  code?: CodeAnalysis;
  /** Code steps: the language. */
  lang?: CodeLang;
  app?: string;
}

export interface TriggerAnalysis {
  trigger: Trigger;
  label: string;
  target: string;
  level: Level;
  issues: Issue[];
}

export interface WorkflowAnalysis {
  workflow: Workflow;
  level: Level;
  triggers: TriggerAnalysis[];
  steps: StepAnalysis[];
  issues: Issue[];
  /**
   * Pipedream app slugs of the connected accounts to recreate as n8n credentials: props holding an
   * account (`authProvisionId`) on steps and triggers, resolved to the declared app; plus SMTP for email actions.
   */
  apps: string[];
  /** "step.prop" (or "step.prop.path") values that were redacted or omitted and must be re-entered. */
  secrets: string[];
  envVars: string[];
  npm: { name: string; cls: PackageClass }[];
  python: { name: string; cls: PackageClass }[];
  usesDataStore: boolean;
  /** Pipedream data store ids (`ds_…`) the workflow uses, when the input names them. */
  dataStores: string[];
  usesFileStore: boolean;
  counts: { steps: number; code: number; actions: number; mappedActions: number; control: number };
  manualHours: number;
  withToolHours: number;
}

const rank: Record<Level, number> = { green: 0, yellow: 1, red: 2 };
export const worst = (levels: Level[]): Level => levels.reduce<Level>((a, b) => (rank[b] > rank[a] ? b : a), "green");

const issueLevel = (issues: Issue[]): Level =>
  worst(issues.map((i) => (i.level === "info" ? "green" : i.level)));

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Pipedream "apps" that never hold an account: built-in utilities and code runtimes. */
const NO_ACCOUNT_APPS = new Set([
  "http",
  "data_stores",
  "formatting",
  "helper_functions",
  "pipedream_utils",
  "utils",
  "rss",
  "schedule",
  "delay",
  "filter",
  "pipedream",
  "python",
  "node",
  "nodejs",
  "bash",
  "go",
  "code",
]);

/** Account prop names that say nothing about the app ("app", "oauth"…), left when nothing else names it. */
const GENERIC_ACCOUNT_PROP = /^(apps?|oauth|auth|account|connection|credentials?)$/i;

/** Label of an "Accounts to reconnect" row. Rows are grouped by it, so slack, slack_bot and slack_v2 are one row. */
export function accountLabel(app: string): string {
  return GENERIC_ACCOUNT_PROP.test(app) ? `Unidentified app (prop "${app}")` : appLabel(app);
}

/** `step send_message: secret prop api_key was omitted from the export…` (manifest warnings). */
const OMITTED_SECRET = /^step (\S+): secret prop (\S+) was omitted/;

export function analyzeWorkflow(wf: Workflow): WorkflowAnalysis {
  const steps: StepAnalysis[] = [];
  const apps = new Set<string>();
  const secrets = new Set<string>();
  const env = new Set<string>();
  const npm = new Map<string, PackageClass>();
  const python = new Map<string, PackageClass>();
  const dataStores = new Set<string>();
  let usesDataStore = false;
  let usesFileStore = false;
  let responds = false;
  let manual = 0.5; // build + test the workflow end to end
  let auto = 0.15; // review and test a converted workflow

  const visit = (list: Step[], depth: number, branch?: string) => {
    for (const s of list) {
      const sa = analyzeStep(s, depth, branch);
      steps.push(sa);
      for (const [prop, v] of Object.entries(s.props)) {
        collectSecrets(`${s.name}.${prop}`, v, secrets);
        for (const id of dataStoreIds(v)) dataStores.add(id);
      }
      for (const a of stepAccounts(s, sa.code)) apps.add(a);
      if (s.kind === "action" && s.app === "data_stores") usesDataStore = true;
      if (isRespondAction(s) || sa.code?.usesRespond) responds = true;
      if (sa.code) {
        for (const e of sa.code.envVars) env.add(e);
        if (sa.code.usesDataStore) usesDataStore = true;
        if (sa.code.usesFileStore) usesFileStore = true;
        const isPy = s.kind === "code" && s.lang === "python";
        for (const p of sa.code.npmImports) (isPy ? python : npm).set(p, isPy ? classifyPythonPackage(p) : classifyPackage(p));
      }

      // Effort model (hours). Deliberately simple and shown to users as an estimate.
      if (s.kind === "code") {
        manual += 0.5 + (sa.code?.npmImports.length ? 0.5 : 0) + (s.lang === "python" ? 0.5 : 0);
        manual += sa.issues.filter((i) => i.level === "yellow").length * 0.25;
      } else if (s.kind === "action") {
        manual += sa.level === "green" ? 0.25 : 0.5;
      } else if (s.kind === "control") {
        manual += 0.5;
      } else manual += 0.5;
      if (sa.level === "red") auto += 0.75;
      else if (sa.level === "yellow") auto += 0.1;

      if (s.kind === "control") for (const b of s.branches) visit(b.steps, depth + 1, `${s.name} → ${b.label}`);
    }
  };
  visit(wf.steps, 0);

  const triggers = wf.triggers.map((t) => analyzeTrigger(t, responds));
  wf.triggers.forEach((t, i) => {
    const name = i === 0 ? "trigger" : `trigger_${i + 1}`;
    for (const [prop, v] of Object.entries(t.props)) {
      collectSecrets(`${name}.${prop}`, v, secrets);
      for (const id of dataStoreIds(v)) dataStores.add(id);
    }
    for (const a of triggerAccounts(t)) apps.add(a);
  });
  for (const t of triggers) {
    manual += t.trigger.kind === "source" ? 0.5 : t.trigger.kind === "timer" ? 0.1 : 0.3;
    if (t.level === "red") auto += 0.5;
    else if (t.level === "yellow") auto += 0.2;
  }
  if (dataStores.size) usesDataStore = true;

  if (usesDataStore) {
    manual += 1;
    auto += 0.5;
  }
  if (usesFileStore) {
    manual += 1;
    auto += 0.75;
  }

  const issues: Issue[] = [...triggers.flatMap((t) => t.issues), ...steps.flatMap((s) => s.issues)];
  for (const w of wf.warnings) {
    // A secret the export omitted is counted below; other input warnings are shown as they are.
    const m = w.match(OMITTED_SECRET);
    if (m) secrets.add(`${m[1]}.${m[2]}`);
    else issues.push({ level: "info", code: "INPUT_WARNING", message: w });
  }
  if (secrets.size) {
    issues.push({
      level: "info",
      code: "SECRET_REDACTED",
      message: `${secrets.size} secret value(s) were redacted by Pipedream and must be re-entered: ${[...secrets].join(", ")}`,
    });
  }
  if (apps.size) {
    issues.push({
      level: "info",
      code: "ACCOUNT_CONNECT",
      message: `Connect these accounts as n8n credentials: ${[...new Set([...apps].map(accountLabel))].join(", ")}`,
    });
  }

  const actions = steps.filter((s) => s.kind === "action");
  return {
    workflow: wf,
    level: worst([...triggers.map((t) => t.level), ...steps.map((s) => s.level)]),
    triggers,
    steps,
    issues,
    apps: [...apps],
    secrets: [...secrets],
    envVars: [...env],
    npm: [...npm].map(([name, cls]) => ({ name, cls })),
    python: [...python].map(([name, cls]) => ({ name, cls })),
    usesDataStore,
    dataStores: [...dataStores],
    usesFileStore,
    counts: {
      steps: steps.length,
      code: steps.filter((s) => s.kind === "code").length,
      actions: actions.length,
      mappedActions: actions.filter((s) => s.level === "green").length,
      control: steps.filter((s) => s.kind === "control").length,
    },
    manualHours: round(manual),
    withToolHours: round(Math.min(auto, manual)),
  };
}

const round = (n: number) => Math.round(n * 4) / 4;

/** Redacted values (`"<redacted>"`, GitHub Sync `{ _enc }`), also nested: `get_orders.httpRequest.auth`. */
function collectSecrets(path: string, v: PropValue, out: Set<string>) {
  if (v.t === "redacted") {
    out.add(path);
    return;
  }
  if (v.t !== "value" && v.t !== "lv") return;
  const visit = (x: unknown, p: string, depth: number) => {
    if (depth > 8) return;
    if (x === "<redacted>") out.add(p);
    else if (Array.isArray(x)) x.slice(0, 200).forEach((y, i) => visit(y, `${p}[${i}]`, depth + 1));
    else if (isObj(x)) {
      if ("_enc" in x) out.add(p);
      else for (const [k, y] of Object.entries(x)) visit(y, `${p}.${k}`, depth + 1);
    }
  };
  if (typeof v.value === "object") visit(v.value, path, 0);
}

/**
 * Accounts a step is connected to: every prop holding an account (`{ authProvisionId }`), named after the
 * app its declaration gives (Python `__configurableProps`, REST `configurableProps`, the code's
 * `props: { x: { type: "app", app } }`), else the registry action's app, else the prop name.
 */
function stepAccounts(s: Step, code: CodeAnalysis | undefined): string[] {
  const declared = new Map<string, string>();
  for (const d of [...(code?.props ?? []), ...(s.declared ?? [])]) if (d.type === "app" && d.app) declared.set(d.name, d.app);
  const out: string[] = [];
  for (const [name, v] of Object.entries(s.props)) {
    if (v.t !== "app") continue;
    out.push(declared.get(name) ?? (s.kind === "action" && !s.private ? s.app : name));
  }
  // With neither code nor configured values in the input (REST GET omits both), the declarations are all
  // there is. Otherwise an app prop without an account was never connected (drafts) and is not listed.
  if (!Object.keys(s.props).length && !(s.kind === "code" && s.code.trim())) {
    for (const d of s.declared ?? []) if (d.type === "app" && d.app) out.push(d.app);
  }
  // Pipedream's email actions need no account, but n8n's Send Email node needs an SMTP credential.
  if (s.kind === "action" && !out.length && actionMapping(s.componentKey)?.type === "n8n-nodes-base.emailSend") out.push("email");
  return out.filter((a) => !NO_ACCOUNT_APPS.has(normalizeApp(a)));
}

/** Accounts a trigger is connected to: registry sources name the app; others (sub_, dc_) only the prop. */
function triggerAccounts(t: Trigger): string[] {
  const registryApp = t.componentKey && !t.private && !/^(sc|dc)_/.test(t.componentKey) ? t.app : undefined;
  return Object.entries(t.props)
    .filter(([, v]) => v.t === "app")
    .map(([name]) => registryApp ?? name)
    .filter((a) => !NO_ACCOUNT_APPS.has(normalizeApp(a)));
}

function analyzeTrigger(t: Trigger, responds: boolean): TriggerAnalysis {
  const issues: Issue[] = [];
  let label = "Unknown trigger";
  let target = "Manual Trigger";
  const raw = isObj(t.raw) ? t.raw : {};
  const id = str(raw.id) ?? "";
  switch (t.kind) {
    case "http":
      label = "HTTP / Webhook";
      target = responds || t.http?.customResponse ? "Webhook + Respond to Webhook" : "Webhook";
      issues.push({
        level: "info",
        code: "TRIGGER_HTTP_URL",
        message: "The webhook URL changes. Update every service that calls the Pipedream URL after switching.",
      });
      if (t.http?.auth && t.http.auth !== "none") {
        issues.push({
          level: "yellow",
          code: "TRIGGER_HTTP_RESPONSE",
          message: `The Pipedream endpoint used ${t.http.auth} authorization. Configure Header Auth on the n8n Webhook node.`,
        });
      }
      break;
    case "timer":
      label = t.cron ? `Schedule (cron ${t.cron})` : t.intervalSeconds ? `Schedule (every ${humanInterval(t.intervalSeconds)})` : "Schedule";
      target = "Schedule Trigger";
      break;
    case "email":
      label = "Email";
      target = "Email Trigger (IMAP) or Gmail Trigger";
      issues.push({
        level: "yellow",
        code: "TRIGGER_EMAIL",
        message: "Pipedream's unique @pipedream.net address goes away. Forward mail to a mailbox n8n can read over IMAP, or use the Gmail Trigger.",
      });
      break;
    case "form":
      label = "Form";
      target = "n8n Form Trigger";
      issues.push({ level: "yellow", code: "TRIGGER_FORM", message: "Recreate the form fields in the n8n Form Trigger; the form URL changes." });
      break;
    case "source": {
      const key = t.componentKey;
      const mapped = key ? sourceMapping(key) : undefined;
      const node = n8nNodeForApp(t.app ?? "");
      if (id.startsWith("sub_")) {
        label = "Subscription to another workflow or source";
        target = "Execute Workflow Trigger or Webhook";
        issues.push({
          level: "yellow",
          code: "TRIGGER_SOURCE_UNMAPPED",
          message: "Listens to events emitted by another workflow or source. In n8n, call this workflow from the emitter with Execute Workflow, or post to its Webhook.",
        });
      } else if (!key) {
        // dc_ triggers: GitHub Sync and the REST API keep the deployed source's ID, not its component.
        const name = str(raw.name);
        label = name ? `Event source "${name}" (type not in the input)` : "Event source (type not in the input)";
        target = "Webhook or Schedule + HTTP Request";
        issues.push({
          level: "yellow",
          code: "TRIGGER_SOURCE_UNMAPPED",
          message: `The input has this event source's ID${id ? ` (${id})` : ""} but not which source it is${t.inferred ? " (GitHub Sync keeps only trigger IDs)" : ""}. Look it up in Pipedream, then use the app's n8n trigger, or a Webhook or a Schedule Trigger that polls the app.`,
        });
      } else if (t.private) {
        label = /^(sc|dc)_/.test(key) ? `Private event source (${key})` : `${appLabel(t.app ?? key)} source (${key})`;
        target = "Rebuild manually";
        issues.push({ level: "red", code: "TRIGGER_SOURCE_PRIVATE", message: `Private event source ${key}: its code is not in the export.` });
      } else if (mapped) {
        label = `${appLabel(t.app ?? key)} source (${key})`;
        target = mapped.type.replace(/^.*\./, "");
        issues.push({ level: "green", code: "TRIGGER_SOURCE_MAPPED", message: `Maps to n8n ${target}.` });
      } else if (node) {
        label = `${appLabel(t.app ?? key)} source (${key})`;
        target = `${node.displayName} trigger or polling`;
        issues.push({
          level: "yellow",
          code: "TRIGGER_SOURCE_NODE",
          message: `No automatic mapping for ${key}. n8n has a ${node.displayName} integration; pick its trigger or poll with a Schedule Trigger.`,
        });
      } else {
        label = `${appLabel(t.app ?? key)} source (${key})`;
        target = "Webhook or Schedule + HTTP Request";
        issues.push({
          level: "yellow",
          code: "TRIGGER_SOURCE_UNMAPPED",
          message: `No n8n trigger for ${key}. Use the app's webhooks with an n8n Webhook node, or poll its API on a schedule.`,
        });
      }
      break;
    }
    default:
      issues.push({ level: "yellow", code: "TRIGGER_UNKNOWN", message: "Trigger type unknown. Choose the n8n trigger manually." });
  }
  // A source without a component key already says that its settings are missing.
  if (t.inferred && t.kind !== "unknown" && !(t.kind === "source" && !t.componentKey)) {
    const why = raw.settings_missing === true ? "GitHub Sync keeps only the trigger ID" : "its type was inferred from how the steps use the trigger event";
    // A missing schedule must be re-entered; other missing settings only need a check.
    const level = t.kind === "timer" && !t.cron && !t.intervalSeconds ? "yellow" : "info";
    const message: Record<string, string> = {
      timer: `The schedule is not in the input (${why}). Copy the cron or interval from Pipedream.`,
      http: `The endpoint's settings are not in the input (${why}). Check its authorization and response settings in Pipedream.`,
      email: `The trigger's settings are not in the input (${why}).`,
      form: `The form's fields are not in the input (${why}).`,
      source: `The source's settings are not in the input (${why}). Check them in Pipedream.`,
    };
    issues.push({ level, code: "TRIGGER_INFERRED", message: message[t.kind] ?? `The trigger's settings are not in the input (${why}).` });
  }
  if (t.disabled) {
    label += " (disabled)";
    issues.push({ level: "info", code: "TRIGGER_DISABLED", message: "This trigger is turned off in Pipedream." });
  }
  return { trigger: t, label, target, level: issueLevel(issues), issues };
}

export function humanInterval(sec: number): string {
  if (sec % 86400 === 0) return `${sec / 86400} day(s)`;
  if (sec % 3600 === 0) return `${sec / 3600} hour(s)`;
  if (sec % 60 === 0) return `${sec / 60} minute(s)`;
  return `${sec} second(s)`;
}

function analyzeStep(s: Step, depth: number, branch?: string): StepAnalysis {
  const issues: Issue[] = [];
  const base = { name: s.name, kind: s.kind, depth, branch };
  const push = (level: IssueLevel, code: IssueCode, message: string) => issues.push({ level, code, message, step: s.name });

  if (s.kind === "code") {
    if (!s.code.trim()) {
      push("red", "CODE_MISSING", "Code is missing from the input.");
      return { ...base, label: `${s.lang} code`, target: "Code", level: "red", issues, lang: s.lang };
    }
    if (s.lang === "bash" || s.lang === "go") {
      push("red", "CODE_UNSUPPORTED_LANG", `${s.lang} steps have no n8n equivalent. Rewrite in JavaScript or use Execute Command on self-hosted n8n.`);
      return { ...base, label: `${s.lang} code`, target: "Code (rewrite)", level: "red", issues, lang: s.lang };
    }
    const a = analyzeCode(s);
    if (a.parseError) push("red", "CODE_PARSE_ERROR", `Could not parse the code: ${a.parseError}`);
    if (s.lang === "python") {
      // n8n Cloud's Python Code node imports nothing, not even the standard library, and no n8n Python
      // node has Pipedream's pd object: the converter hands every Python step to the JavaScript rewrite.
      const third = a.npmImports;
      const std = a.builtinImports;
      push(
        "yellow",
        "CODE_PYTHON",
        third.length
          ? `Python with packages (${third.join(", ")}). n8n Cloud's Python can't import anything: rewrite the step in JavaScript (the AI rewrite does this), or self-host n8n with these packages in the Python task runner.`
          : std.length
            ? `Python importing standard-library modules (${std.join(", ")}). n8n Cloud's Python can't import anything, not even the standard library: rewrite the step in JavaScript (the AI rewrite does this), or self-host n8n with the Python task runner.`
            : "Python step. n8n's Python Code node has nothing like Pipedream's pd object (steps, inputs, export), so the step is rewritten in JavaScript (the AI rewrite does this).",
      );
    } else {
      const builtin = a.npmImports.filter((p) => ["builtin", "allowed"].includes(classifyPackage(p)));
      const sdk = a.npmImports.filter((p) => classifyPackage(p) === "sdk");
      const hard = a.npmImports.filter((p) => classifyPackage(p) === "hard");
      if (a.usesPlatformAxios) push("green", "CODE_PLATFORM_AXIOS", "@pipedream/platform axios is replaced with n8n's built-in HTTP helper.");
      if (builtin.length) push("yellow", "CODE_NPM_BUILTIN", `Packages with n8n built-in equivalents: ${builtin.join(", ")}.`);
      if (sdk.length) push("yellow", "CODE_NPM_SDK", `API SDKs to rewrite as HTTP calls (or allow on self-hosted): ${sdk.join(", ")}.`);
      if (hard.length) push("red", "CODE_NPM_HARD", `Packages n8n Cloud cannot load: ${hard.join(", ")}. Needs self-hosted n8n with NODE_FUNCTION_ALLOW_EXTERNAL.`);
    }
    if (a.usesRespond) push("green", "CODE_RESPOND", "$.respond becomes a Respond to Webhook node.");
    if (a.usesDelay) push("yellow", "CODE_DELAY", "$.flow.delay: the step is split around an n8n Wait node.");
    if (a.usesSuspend) push("yellow", "CODE_SUSPEND", "$.flow.suspend becomes a Wait node that resumes on a webhook call; the resume URL changes.");
    if (a.usesRerun) push("red", "CODE_RERUN", "$.flow.rerun has no n8n equivalent. Rebuild with a Loop or Wait node.");
    if (a.usesFlowTrigger) push("yellow", "CODE_FLOW_TRIGGER", "$.flow.trigger becomes an Execute Workflow node.");
    if (a.usesServices) push("yellow", "CODE_SERVICES", "$.services ran an app on Pipedream's own account (e.g. OpenAI passthrough); in n8n it needs your own API key.");
    if (a.sendDestinations.length) push("yellow", "CODE_SEND", `$.send.${a.sendDestinations.join(", $.send.")} must be replaced with HTTP Request / Send Email nodes.`);
    if (a.usesDataStore) push("yellow", "CODE_DATA_STORE", "Uses a Pipedream data store. Export its data before 30.04.2027 and move it to an n8n Data Table.");
    if (a.usesFileStore) push("red", "CODE_FILE_STORE", "Uses the Pipedream File Store. Download the files and move them to S3, Drive or n8n binary data.");
    if (a.usesTmp) push("yellow", "CODE_TMP", "Writes to /tmp. n8n Code nodes have no persistent /tmp; use binary data instead.");
    if (a.envVars.length) push("info", "CODE_ENV", `Environment variables to recreate as n8n Variables: ${a.envVars.join(", ")}.`);
    if (a.appAuth.length) push("yellow", "CODE_APP_AUTH", `Reads connected-account tokens in code (${a.appAuth.join(", ")}). Move the call to an HTTP Request node with n8n credentials.`);
    return {
      ...base,
      label: s.lang === "python" ? "Python code" : "Node.js code",
      target: "Code",
      level: issueLevel(issues),
      issues,
      code: a,
      lang: s.lang,
    };
  }

  if (s.kind === "action") {
    const node = n8nNodeForApp(s.app);
    const mapped = actionMapping(s.componentKey);
    const label = `${appLabel(s.app)}: ${s.componentKey}`;
    // Utility actions the converter rebuilds as Code nodes through the compatibility layer (data_stores-*).
    if (builtinActionName(s.componentKey) !== undefined) {
      push("green", "ACTION_BUILTIN", "Runs as an n8n Code node with the Pipedream compatibility layer.");
      if (s.app === "data_stores") {
        const ids = [...new Set(Object.values(s.props).flatMap(dataStoreIds))];
        push(
          "info",
          "CODE_DATA_STORE",
          `Uses Pipedream data store ${ids.length ? ids.join(", ") : "(its id is not in the input)"}. Its records are not exported: save them before 30.04.2027 and load them into n8n.`,
        );
      }
      return { ...base, label, target: "Code", level: "green", issues, app: s.app };
    }
    if (s.private) {
      push("red", "ACTION_PRIVATE", `Private component ${s.componentKey}: the export has its key but not its code.`);
      return { ...base, label, target: "Rebuild manually", level: "red", issues, app: s.app };
    }
    if (mapped) {
      push("green", "ACTION_MAPPED", `Maps to n8n ${mapped.type.replace(/^.*\./, "")}.`);
      return { ...base, label, target: node?.displayName ?? mapped.type, level: "green", issues, app: s.app };
    }
    if (node) {
      push("yellow", "ACTION_APP_NODE", `No automatic mapping for ${s.componentKey} yet. n8n has a ${node.displayName} node; the converter builds an HTTP Request from the component source.`);
      return { ...base, label, target: `${node.displayName} or HTTP Request`, level: "yellow", issues, app: s.app };
    }
    push("yellow", "ACTION_NO_NODE", `n8n has no ${appLabel(s.app)} node. The converter builds an HTTP Request from the component source.`);
    return { ...base, label, target: "HTTP Request", level: "yellow", issues, app: s.app };
  }

  if (s.kind === "control") {
    if (s.disabled) {
      push("green", "CONTROL_DISABLED", "Disabled in Pipedream: becomes a disabled pass-through node; its branch steps are kept, not connected.");
      return { ...base, label: `${CONTROL_LABEL[s.op] ?? "Control flow"} (disabled)`, target: "Disabled node", level: "green", issues };
    }
    if (s.op === "delay") {
      push("green", "CONTROL_DELAY", "Delay becomes a Wait node.");
      return { ...base, label: "Delay", target: "Wait", level: "green", issues };
    }
    if (s.op === "ifelse" || s.op === "switch" || s.op === "filter" || s.op === "end") {
      const unparsed = s.op !== "end" && (s.branches.length === 0 || s.branches.some((b) => !b.isDefault && (!b.condition || b.condition.type === "raw")));
      push(unparsed ? "yellow" : "green", "CONTROL_BRANCH", unparsed ? "Branch rules could not be read; set the conditions in n8n." : "Branch rules convert to n8n conditions.");
      const label = CONTROL_LABEL[s.op];
      const rules = s.branches.filter((b) => !b.isDefault).length;
      const target = { ifelse: rules > 1 ? "Switch" : "If", switch: rules > 1 ? "Switch" : "If", filter: "If", end: "Stop" }[s.op];
      return { ...base, label, target, level: issueLevel(issues), issues };
    }
    if (s.op === "parallel") {
      push("green", "CONTROL_PARALLEL", "Branches run one after another in n8n, then a Merge node and a Code node collect each branch's result.");
      return { ...base, label: CONTROL_LABEL.parallel, target: "Branches + Merge", level: "green", issues };
    }
    if (s.op === "loop") {
      push("yellow", "CONTROL_LOOP", "Becomes Loop Over Items. Check how the steps inside the loop read the current item.");
      return { ...base, label: CONTROL_LABEL.loop, target: "Loop Over Items", level: "yellow", issues };
    }
    if (s.op === "ai") {
      push("yellow", "CONTROL_AI", "Becomes an n8n Text Classifier with an OpenAI chat model; connect your OpenAI credential.");
      return { ...base, label: CONTROL_LABEL.ai, target: "Text Classifier", level: "yellow", issues, app: "openai" };
    }
    push("yellow", "CONTROL_UNKNOWN", `Control-flow block "${s.op}" needs manual review.`);
    return { ...base, label: `Control flow (${s.op})`, target: "Manual", level: "yellow", issues };
  }

  push("yellow", "UNKNOWN_STEP", `Unrecognized step type${s.rawType ? ` "${s.rawType}"` : ""}.`);
  return { ...base, label: "Unknown step", target: "Manual", level: "yellow", issues };
}

const CONTROL_LABEL: Record<string, string> = {
  ifelse: "If/Else",
  switch: "Switch",
  filter: "Filter",
  end: "End workflow",
  delay: "Delay",
  parallel: "Parallel branches",
  loop: "Loop",
  ai: "AI branch",
};

export function analyzeProjectWorkflows(p: Project): WorkflowAnalysis[] {
  return p.workflows.map(analyzeWorkflow);
}

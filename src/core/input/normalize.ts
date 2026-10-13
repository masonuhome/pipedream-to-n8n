// Tolerant normalizers shared by the export and REST API parsers. The exact
// `workflow.json/2026.01` shape is not published, so every field is looked up
// under the names seen in the export docs, the REST API and GitHub Sync YAML.
import type {
  ActionStep,
  Branch,
  CodeLang,
  CodeStep,
  Condition,
  ControlOp,
  ControlStep,
  DeclaredProp,
  PropValue,
  Step,
  Trigger,
  TriggerKind,
} from "../ir";

export type Obj = Record<string, unknown>;

export const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export function pick<T = unknown>(o: unknown, ...paths: string[]): T | undefined {
  for (const p of paths) {
    let cur: unknown = o;
    for (const key of p.split(".")) {
      if (!isObj(cur)) {
        cur = undefined;
        break;
      }
      cur = cur[key];
    }
    if (cur !== undefined && cur !== null && cur !== "") return cur as T;
  }
  return undefined;
}

export const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * An array as is, or an object keyed by name/id as an array of its entries (the key kept as `__key`).
 * Exports may key branches, deployments and steps either way.
 */
export function listOf(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (!isObj(v)) return [];
  return Object.entries(v).map(([k, x]) => (isObj(x) ? { __key: k, ...x } : Array.isArray(x) ? { __key: k, steps: x } : { __key: k, value: x }));
}

// ---------------------------------------------------------------------------
// Props

export function normalizeProp(v: unknown): PropValue {
  if (v === "<redacted>") return { t: "redacted" };
  if (isObj(v)) {
    // GitHub Sync keeps secrets encrypted: { _enc: "..." }. Unusable outside Pipedream.
    if ("_enc" in v) return { t: "redacted" };
    if ("authProvisionId" in v) return { t: "app", authProvisionId: str(v.authProvisionId) };
    if (isObj(v.__lv)) return { t: "lv", label: str(v.__lv.label), value: v.__lv.value };
    if (Array.isArray(v.__lv)) {
      return { t: "lv", value: v.__lv.map((x) => (isObj(x) ? x.value : x)) };
    }
  }
  return { t: "value", value: v };
}

export function normalizeProps(raw: unknown): Record<string, PropValue> {
  const out: Record<string, PropValue> = {};
  // REST API payloads carry props as a JSON string (`configured_props_json`).
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return out;
    }
  }
  if (Array.isArray(raw)) {
    // [{ name, value }] style
    for (const p of raw) {
      const name = str(pick(p, "name", "key"));
      if (name) out[name] = normalizeProp(pick(p, "value", "configured_value") ?? null);
    }
    return out;
  }
  if (!isObj(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (k === "__configurableProps") continue; // Python prop declarations (GitHub Sync), not values
    out[k] = normalizeProp(v);
  }
  return out;
}

/** The plain value of a prop (label/value wrappers unwrapped), or undefined for redacted/app props. */
export function propValue(p: PropValue | undefined): unknown {
  if (!p) return undefined;
  if (p.t === "value") return p.value;
  if (p.t === "lv") return p.value;
  return undefined;
}

// ---------------------------------------------------------------------------
// Component keys

/** "slack-send-message@0.1.3" -> { key, version }. Keeps "@workspace/" prefix for private components. */
export function splitComponentRef(ref: string): { key: string; version?: string } {
  const m = ref.match(/^(@[^/]+\/)?([^@]+)(?:@(.+))?$/);
  if (!m) return { key: ref };
  return { key: (m[1] ?? "") + m[2], version: m[3] };
}

export function appFromKey(key: string): string {
  const bare = key.replace(/^@[^/]+\//, "");
  const dash = bare.indexOf("-");
  return dash > 0 ? bare.slice(0, dash) : bare;
}

export const isPrivateKey = (key: string) => key.startsWith("@") || /^~|^sc_|^dc_/.test(key);

// ---------------------------------------------------------------------------
// Code

export function langFromRuntime(runtime: string | undefined, code?: string): CodeLang {
  const r = (runtime ?? "").toLowerCase();
  if (r.includes("python")) return "python";
  if (r.includes("bash") || r === "sh") return "bash";
  if (r.startsWith("go")) return "go";
  if (r.includes("node") || r.includes("js")) return "nodejs";
  if (r.endsWith(".py")) return "python";
  if (code) {
    if (/^[ \t]*def[ \t]+handler[ \t]*\(/m.test(code)) return "python";
    if (/^#!\/bin\/(ba)?sh/.test(code)) return "bash";
    if (/^package\s+main/m.test(code)) return "go";
  }
  return "nodejs";
}

// ---------------------------------------------------------------------------
// Triggers

const TRIGGER_KIND: Record<string, TriggerKind> = {
  http: "http",
  httpinterface: "http",
  webhook: "http",
  timer: "timer",
  schedule: "timer",
  cron: "timer",
  email: "email",
  emailinterface: "email",
  form: "form",
  source: "source",
  eventsource: "source",
};

/** Pipedream trigger ID prefixes: hi_ HTTP interface, ti_ timer, ei_ email, dc_ deployed source, sub_ subscription. */
const ID_PREFIX_KIND: Record<string, TriggerKind> = { hi: "http", ti: "timer", ei: "email", dc: "source", sub: "source" };

/** "slack-new-message", "@ws/github-new-issue@0.1.2" — not an HTTP endpoint key like "eabcdefghiklmnop". */
const looksLikeComponentKey = (k: string | undefined) => !!k && /^(@[\w-]+\/)?[a-z0-9_]+-[a-z0-9-]+(@[\w.-]+)?$/i.test(k);

export function normalizeTrigger(raw: unknown): Trigger {
  const typeRaw = str(pick(raw, "type", "kind", "trigger_type")) ?? "";
  const id = str(pick(raw, "id")) ?? "";
  let kind: TriggerKind = TRIGGER_KIND[typeRaw.toLowerCase().replace(/[^a-z]/g, "")] ?? ID_PREFIX_KIND[id.split("_")[0]] ?? "unknown";
  if (kind === "unknown" && pick(raw, "endpoint_url")) kind = "http";

  // On HTTP/email triggers the REST API's `key` is the endpoint key, not a component key.
  const keyField = str(pick(raw, "key"));
  const keyRef =
    str(pick(raw, "component_key", "componentKey", "savedComponent.key", "component.key", "source.key", "uses")) ??
    ((kind === "unknown" || kind === "source") && looksLikeComponentKey(keyField) ? keyField : undefined);
  if (kind === "unknown" && keyRef) kind = "source";
  // Registry sources for HTTP / schedule are really the built-in triggers.
  let componentKey: string | undefined;
  let bodyOnly = false;
  let version = str(pick(raw, "version", "component_version", "savedComponent.version", "component.version"));
  if (keyRef) {
    const ref = splitComponentRef(keyRef);
    componentKey = ref.key;
    version = version ?? ref.version;
    // HTTP sources that receive requests ("http-watch-url" polls a URL instead).
    if (kind === "source" && /^http-(new-requests|webhook)|^http$/.test(componentKey)) {
      kind = "http";
      if (/payload-only/.test(componentKey)) bodyOnly = true;
    }
    if (kind === "source" && /^(schedule|cron)(-|$)/.test(componentKey)) kind = "timer";
  }

  const props = normalizeProps(pick(raw, "configured_props", "configuredProps", "props", "configs", "configured_props_json"));

  const t: Trigger = { kind, props, raw };
  if (componentKey && kind === "source") {
    t.componentKey = componentKey;
    t.version = version;
    t.app = appFromKey(componentKey);
    t.private = isPrivateKey(componentKey);
  }

  // Schedule settings: several spellings across the docs, API and toolkit.
  const cron = str(
    pick(raw, "cron", "cron_string", "cronExpression", "schedule.cron", "config.cron", "settings.cron", "timer.cron"),
  );
  const interval = pick<number | string>(
    raw,
    "interval_seconds",
    "intervalSeconds",
    "schedule.interval_seconds",
    "config.interval_seconds",
    "timer.interval_seconds",
  );
  const tz = str(pick(raw, "timezone", "tz", "schedule.timezone", "config.timezone", "timer.timezone"));
  // Schedule configured through a "timer" or "cron" prop (registry schedule sources).
  const timerProp = propValue(props.timer ?? props.cron ?? props.schedule);
  if (cron) t.cron = cron;
  else if (isObj(timerProp) && str(timerProp.cron)) t.cron = str(timerProp.cron);
  if (interval !== undefined && !Number.isNaN(Number(interval))) t.intervalSeconds = Number(interval);
  else if (isObj(timerProp) && timerProp.intervalSeconds) t.intervalSeconds = Number(timerProp.intervalSeconds);
  if (tz) t.timezone = tz;
  else if (isObj(timerProp) && str(timerProp.timezone)) t.timezone = str(timerProp.timezone);
  if ((t.cron || t.intervalSeconds) && kind === "unknown") t.kind = "timer";
  // Type known from the trigger ID, settings not exported (GitHub Sync).
  if (pick(raw, "settings_missing") === true) t.inferred = true;
  // sub_ triggers listen to another workflow or source (`uses: sc_...`).
  if (/^sub_/.test(String(pick(raw, "id") ?? "")) && kind === "source") t.private = true;
  if (pick(raw, "disabled") === true || pick(raw, "active") === false) t.disabled = true;

  if (t.kind === "http") {
    // Settings appear as fields (REST API: custom_response) or as configured props (builder: responseType,
    // authorization, staticResponse*), so both are read.
    const cfg: Obj = { ...plainProps(props), ...(isObj(raw) ? raw : {}) };
    const custom = pick(cfg, "custom_response", "customResponse", "config.custom_response", "settings.custom_response");
    const responseType = str(pick(cfg, "responseType", "response_type"))?.toLowerCase();
    const a = pick(cfg, "auth", "auth_type", "authorization", "config.auth", "settings.auth");
    let auth = typeof a === "string" ? a : isObj(a) ? (str(a.type) ?? "custom") : undefined;
    if (!auth && (props.bearerToken?.t === "redacted" || (typeof propValue(props.bearerToken) === "string" && propValue(props.bearerToken) !== ""))) auth = "bearer";
    const methods = pick<unknown>(cfg, "methods", "http_methods", "config.methods");
    t.http = {
      customResponse: custom === true || custom === "true" || responseType === "custom" || responseType === "customresponse",
      auth: auth ?? undefined,
      methods: Array.isArray(methods) ? methods.map(String) : undefined,
    };
    const shape = str(pick(cfg, "emitShape", "emit_shape"))?.toUpperCase();
    if (bodyOnly || shape === "BODY_ONLY") t.http.bodyOnly = true;
    if (responseType === "nocontent") t.http.staticResponse = { status: 204, body: "" };
    if (responseType === "static" || responseType === "staticresponse") {
      const status = Number(pick(cfg, "staticResponseStatus"));
      const headers = pick(cfg, "staticResponseHeaders");
      t.http.staticResponse = {
        status: Number.isFinite(status) && status > 0 ? status : 200,
        headers: isObj(headers) ? Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, String(v)])) : undefined,
        body: str(pick(cfg, "staticResponseBody")),
      };
    }
  }
  return t;
}

/** Plain prop values (secrets and accounts left out), for reading settings stored as props. */
function plainProps(props: Record<string, PropValue>): Obj {
  const out: Obj = {};
  for (const [k, v] of Object.entries(props)) if (v.t === "value" || v.t === "lv") out[k] = v.value;
  return out;
}

// ---------------------------------------------------------------------------
// Steps

const CODE_TYPES = /code|cell$|^nodejs|^python|^bash|^go$/i;
const CONTROL_TYPES: [RegExp, ControlOp][] = [
  [/if.?else|^if$|conditional|branch/i, "ifelse"],
  [/switch/i, "switch"],
  [/delay|wait|sleep/i, "delay"],
  [/filter|continue.?if|exit.?if/i, "filter"],
  [/end.?workflow|terminate|^end$/i, "end"],
  [/parallel/i, "parallel"],
];

/** Built-in Pipedream utility actions that are really control flow. */
export function controlOpForComponent(key: string): ControlOp | undefined {
  const k = key.replace(/^@[^/]+\//, "");
  if (/^delay-/.test(k)) return "delay";
  if (/^filter-/.test(k)) return "filter";
  if (/(^|-)end-workflow$|terminate-workflow|exit-workflow$/.test(k)) return "end";
  return undefined;
}

export interface StepContext {
  /** Resolves a local file path referenced by `uses: ./x/entry.js` (GitHub Sync). */
  readLocal?: (path: string) => string | undefined;
  warn: (msg: string) => void;
}

export function normalizeStep(raw: unknown, index: number, ctx: StepContext): Step {
  const step = buildStep(raw, index, ctx);
  // Every kind keeps `disabled`, control steps included (a disabled filter must not run in n8n).
  if (pick(raw, "disabled") === true) step.disabled = true;
  const declared = declaredProps(raw);
  if (declared) step.declared = declared;
  return step;
}

function buildStep(raw: unknown, index: number, ctx: StepContext): Step {
  const name = str(pick(raw, "namespace", "name", "step_name", "__key", "id")) ?? `step_${index + 1}`;
  const props = normalizeProps(pick(raw, "configured_props", "configuredProps", "props", "params", "configured_props_json"));
  const type = str(pick(raw, "type", "kind", "step_type")) ?? "";
  const runtime = str(pick(raw, "lang", "runtime", "language", "savedComponent.runtime"));
  const uses = str(pick(raw, "uses"));
  const componentKeyField = str(pick(raw, "component_key", "componentKey", "savedComponent.key", "component.key"));
  // REST API code steps: a runtime and a savedComponent, but no component key (code may be omitted).
  const apiCodeStep =
    !!runtime && /node|python|bash|^go/i.test(runtime) && !componentKeyField && !(uses && !uses.startsWith("./")) && pick(raw, "savedComponent") !== undefined;

  // Control-flow blocks of the builder (if/else, switch, parallel, loop, AI): generated code configured by `_controlFlow`.
  const flow = propValue(props._controlFlow);
  if (isObj(flow) && typeof flow.type === "string") return controlFlowStep(flow, name, props);

  // Built-in Filter / End operator: stored as a generated code step with a `_filter` prop.
  const builtinFilter = propValue(props._filter);
  if (isObj(builtinFilter) && (builtinFilter.rules !== undefined || builtinFilter.continue !== undefined)) {
    const step: ControlStep = {
      kind: "control",
      name,
      op: "filter",
      props: {},
      exitWhenTrue: String(builtinFilter.continue) === "false",
      branches: [{ label: "continue", condition: ruleGroup(builtinFilter.rules), steps: [] }],
      config: builtinFilter,
    };
    return step;
  }

  // Control-flow blocks described by type (older or hand-written exports)
  for (const [re, op] of CONTROL_TYPES) {
    if (type && re.test(type) && !CODE_TYPES.test(type)) return controlStep(raw, name, op, props, ctx);
  }
  if (pick(raw, "branches", "cases", "paths", "deployments") && !pick(raw, "code")) {
    return controlStep(raw, name, guessOp(raw), props, ctx);
  }

  // Registry and private actions. The REST API types them "CodeCell" and may include the component's
  // source, so the component key decides before any code check.
  const localCode = !!uses && uses.startsWith("./");
  if (componentKeyField && !localCode) return actionStep(raw, name, props, componentKeyField, ctx);

  // Code
  let code = str(pick(raw, "code", "code_raw", "codeRaw", "source", "savedComponent.code", "component.code", "component.source"));
  if (!code && localCode && ctx.readLocal) code = ctx.readLocal(uses!);
  // pipedream-toolkit layout: code saved next to workflow_definition.json as <namespace>.js / .py.
  if (!code && apiCodeStep && ctx.readLocal) code = ctx.readLocal(`${name}.js`) ?? ctx.readLocal(`${name}.mjs`) ?? ctx.readLocal(`${name}.py`);
  if (!code && apiCodeStep) code = str(pick(raw, "props.code"));
  if (code !== undefined || apiCodeStep || (type && CODE_TYPES.test(type)) || localCode) {
    if (code === undefined) ctx.warn(`step ${name}: code is missing from the input`);
    const step: CodeStep = {
      kind: "code",
      name,
      props,
      lang: langFromRuntime(runtime ?? uses, code),
      runtime,
      code: code ?? "",
    };
    if (localCode) {
      step.path = uses!.replace(/^\.\//, "");
      if (code && ctx.readLocal) {
        const modules = collectModules(code, step.path, ctx.readLocal);
        if (Object.keys(modules).length) step.modules = modules;
      }
    }
    return step;
  }

  // Actions referenced by `uses` (GitHub Sync) or a bare `key`
  const keyRef = uses ?? str(pick(raw, "key"));
  if (keyRef) return actionStep(raw, name, props, keyRef, ctx);

  return { kind: "unknown", name, props, rawType: type || undefined, raw };
}

function actionStep(raw: unknown, name: string, props: Record<string, PropValue>, keyRef: string, ctx: StepContext): Step {
  const ref = splitComponentRef(keyRef);
  const op = controlOpForComponent(ref.key);
  if (op) {
    const cs = controlStep(raw, name, op, props, ctx);
    if (op === "filter") {
      cs.exitWhenTrue = /end|exit|stop/.test(ref.key);
      // Registry filter actions: evaluated exactly like their checkCondition().
      const condition = propValue(props.condition);
      if (typeof condition === "string" && /^[A-Z_]+$/.test(condition)) {
        cs.branches = [
          {
            label: "continue",
            steps: [],
            condition: {
              type: "legacy",
              op: condition,
              left: propValue(props.initialValue),
              right: propValue(props.secondValue),
              caseSensitive: propValue(props.caseSensitive) === true,
              arrayType: typeof propValue(props.arrayType) === "string" ? String(propValue(props.arrayType)) : undefined,
            },
          },
        ];
      }
    }
    return cs;
  }
  const step: ActionStep = {
    kind: "action",
    name,
    props,
    componentKey: ref.key,
    version: ref.version ?? (str(pick(raw, "version", "component_version", "savedComponent.version")) || undefined),
    app: appFromKey(ref.key),
    // A component with an owner is a workspace (private) component; registry components have none.
    private: isPrivateKey(ref.key) || !!str(pick(raw, "component_owner_id", "componentOwnerId")),
  };
  const source = str(pick(raw, "savedComponent.code", "component.code"));
  if (source) step.source = source;
  return step;
}

/** Prop declarations shipped with the step: Python `__configurableProps`, REST `savedComponent.configurableProps`. */
function declaredProps(raw: unknown): DeclaredProp[] | undefined {
  let propsRaw = pick(raw, "configured_props", "configuredProps", "props", "params", "configured_props_json");
  if (typeof propsRaw === "string") {
    try {
      propsRaw = JSON.parse(propsRaw);
    } catch {
      propsRaw = undefined;
    }
  }
  const out: DeclaredProp[] = [];
  for (const list of [pick(propsRaw, "__configurableProps"), pick(raw, "savedComponent.configurableProps", "configurableProps", "component.configurableProps")]) {
    for (const d of listOf(list)) {
      const name = str(pick(d, "name", "__key"));
      if (!name || out.some((o) => o.name === name)) continue;
      const decl: DeclaredProp = { name };
      const type = str(pick(d, "type"));
      const app = str(pick(d, "app"));
      if (type) decl.type = type;
      if (app) decl.app = app;
      if (pick(d, "secret") === true) decl.secret = true;
      out.push(decl);
    }
  }
  return out.length ? out : undefined;
}

/** `route.pipeline.deploymentId` of a control-flow branch: the deployment holding the branch's steps. */
const routeId = (route: unknown) => str(pick(route, "pipeline.deploymentId", "pipeline.deployment_id", "deploymentId", "deployment_id"));

/**
 * A builder control-flow block. Shapes and semantics follow the code Pipedream's builder generates for
 * these blocks: the first matching if/else or switch branch runs,
 * then the workflow continues after the block; parallel branches run by their `continue` mode; a loop runs
 * its branch once per item; the AI block lets a model pick a branch.
 */
function controlFlowStep(flow: Obj, name: string, props: Record<string, PropValue>): ControlStep {
  const type = String(flow.type);
  const cfg = isObj(flow[type]) ? (flow[type] as Obj) : {};
  const rest = Object.fromEntries(Object.entries(props).filter(([k]) => k !== "_controlFlow"));
  const step: ControlStep = { kind: "control", name, op: "unknown", props: rest, branches: [], config: flow };
  const label = (b: unknown, key: string, fallback: string) => str(pick(b, key)) ?? fallback;
  const shown = (b: unknown, fallback: string): Branch[] =>
    isObj(b) && b.shown === true ? [{ label: str(b.n) ?? fallback, isDefault: true, steps: [], deploymentId: routeId(b.route) }] : [];
  switch (type) {
    case "ifelse":
      step.op = "ifelse";
      step.branches = [
        ...listOf(cfg.ifElses).map((b, i): Branch => ({ label: label(b, "n", `condition_${i + 1}`), condition: ruleGroup(pick(b, "rules")), steps: [], deploymentId: routeId(pick(b, "route")) })),
        ...shown(cfg._else, "condition_else"),
      ];
      break;
    case "switch":
      // Every case compares the block's expression with its rules' right-hand values (rules have no `a`).
      step.op = "switch";
      step.expression = cfg.expression;
      step.branches = [
        ...listOf(cfg.cases).map((b, i): Branch => ({
          label: label(b, "n", `case_${i + 1}`),
          condition: ruleGroup(pick(b, "rules"), { left: cfg.expression }),
          steps: [],
          deploymentId: routeId(pick(b, "route")),
        })),
        ...shown(cfg._default, "case_default"),
      ];
      break;
    case "parallel":
      step.op = "parallel";
      step.branches = listOf(cfg.branches).map((b, i): Branch => {
        const mode = String(pick(b, "continue") ?? "never");
        return {
          label: label(b, "n", `branch_${i}`),
          condition: ruleGroup(pick(b, "rules")),
          run: mode === "always" || mode === "true" || mode === "false" ? mode : "never",
          steps: [],
          deploymentId: routeId(pick(b, "route")),
        };
      });
      break;
    case "loop": {
      step.op = "loop";
      step.items = cfg.items;
      const b = isObj(cfg.branch) ? cfg.branch : {};
      // The block falls back to deployment `d_<branchId>` when the route has none (branchId is "_loop").
      step.branches = [{ label: str(b.n) ?? "loop_continue", steps: [], deploymentId: routeId(b.route) ?? "d__loop" }];
      break;
    }
    case "ai":
      step.op = "ai";
      step.branches = [
        ...listOf(cfg.branches).map((b, i): Branch => ({ label: label(b, "choice", `choice_${i + 1}`), steps: [], deploymentId: routeId(pick(b, "route")) })),
        ...(isObj(cfg.idk) && cfg.idk.shown === true ? [{ label: "idk", isDefault: true, steps: [], deploymentId: routeId(cfg.idk.route) }] : []),
      ];
      break;
    default:
      step.branches = [];
  }
  return step;
}

/**
 * Pipedream rule groups (`{t, r: [...]}`), as evaluated by the generated Filter and control-flow code:
 * `t === "and"` is AND, anything else OR; an entry with a `t` is a nested group. Switch rules compare
 * the block's expression instead of `a`.
 */
function ruleGroup(rules: unknown, sw?: { left: unknown }): Condition | undefined {
  if (!isObj(rules)) return undefined;
  const conditions = listOf(rules.r)
    .map((r): Condition | undefined => {
      if (!isObj(r)) return undefined;
      if ("t" in r) return ruleGroup(r, sw);
      return { type: "pdrule", left: sw ? sw.left : r.a, op: String(r.op ?? "exist"), right: r.b, matchCase: r.matchCase === true };
    })
    .filter(Boolean) as Condition[];
  return { type: "group", combinator: rules.t === "and" ? "and" : "or", conditions };
}

/** Reads sibling modules a multi-file code step imports with relative paths (recursively, bounded). */
function collectModules(code: string, entryPath: string, readLocal: (p: string) => string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const queue: [string, string][] = [[code, entryPath]];
  while (queue.length && Object.keys(out).length < 40) {
    const [src, from] = queue.shift()!;
    const dir = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
    for (const m of src.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
      const parts = dir ? dir.split("/") : [];
      for (const seg of m[1].split("/")) {
        if (seg === "." || seg === "") continue;
        if (seg === "..") parts.pop();
        else parts.push(seg);
      }
      const base = parts.join("/");
      for (const candidate of [base, `${base}.mjs`, `${base}.js`, `${base}/index.mjs`, `${base}/index.js`]) {
        if (out[candidate] !== undefined) break;
        const text = readLocal(candidate);
        if (text !== undefined) {
          out[candidate] = text;
          queue.push([text, candidate]);
          break;
        }
      }
    }
  }
  return out;
}

function guessOp(raw: unknown): ControlOp {
  const t = JSON.stringify(pick(raw, "type", "kind", "operator") ?? "");
  for (const [re, op] of CONTROL_TYPES) if (re.test(t)) return op;
  return pick(raw, "cases") ? "switch" : "ifelse";
}

function controlStep(
  raw: unknown,
  name: string,
  op: ControlOp,
  props: Record<string, PropValue>,
  ctx: StepContext,
): ControlStep {
  const step: ControlStep = { kind: "control", name, op, props, branches: [], config: raw };
  if (op === "delay") {
    step.delayMs = delayMsFrom(raw, props);
    return step;
  }
  const rawBranches = listOf(pick(raw, "branches", "cases", "paths", "conditions_branches", "deployments"));
  if (op !== "filter" && op !== "end") step.branches = rawBranches.map((b, i) => normalizeBranch(b, i, ctx));
  if (op === "filter" || op === "end") {
    const cond = normalizeCondition(pick(raw, "condition", "conditions", "rules", "rule") ?? filterFromProps(props));
    if (cond) step.branches = [{ label: op === "end" ? "end" : "continue", condition: cond, steps: [] }];
  }
  return step;
}

function filterFromProps(props: Record<string, PropValue>): unknown {
  const left = propValue(props.initialValue ?? props.firstValue ?? props.value1 ?? props.input);
  const right = propValue(props.secondValue ?? props.value2);
  const operator = propValue(props.condition ?? props.operator);
  if (left === undefined && operator === undefined) return undefined;
  return { left, operator, right };
}

/** Labels that mean "the fallback branch" (anchored: "Defaulted invoices" is a normal branch). */
export const DEFAULT_BRANCH = /^_?(else|default|otherwise)$/i;

export function normalizeBranch(raw: unknown, i: number, ctx: StepContext): Branch {
  const label = str(pick(raw, "label", "name", "title", "n", "key", "__key", "id")) ?? `branch_${i + 1}`;
  const isDefault =
    pick(raw, "default") === true ||
    pick(raw, "is_default") === true ||
    pick(raw, "isDefault") === true ||
    pick(raw, "else") === true ||
    DEFAULT_BRANCH.test(label);
  const steps = normalizeSteps(pick(raw, "steps", "cells", "children", "segment.steps", "flow.steps"), ctx);
  const condition = normalizeCondition(pick(raw, "condition", "conditions", "rules", "rule", "when", "match"));
  const branch: Branch = { label, isDefault, condition, steps };
  const deploymentId = routeId(pick(raw, "route")) ?? str(pick(raw, "deploymentId", "deployment_id"));
  if (deploymentId) branch.deploymentId = deploymentId;
  return branch;
}

/** A list of raw steps (array, or object keyed by step name) in their declared order. */
export function normalizeSteps(raw: unknown, ctx: StepContext): Step[] {
  return listOf(raw)
    .map((s, i) => ({ s, i, order: Number(pick(s, "order") ?? Number.NaN) }))
    .sort((a, b) => (Number.isNaN(a.order) || Number.isNaN(b.order) ? a.i - b.i : a.order - b.order))
    .map(({ s }, j) => normalizeStep(s, j, ctx));
}

export function normalizeCondition(raw: unknown): Condition | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (Array.isArray(raw)) {
    const conditions = raw.map(normalizeCondition).filter(Boolean) as Condition[];
    return conditions.length ? { type: "group", combinator: "and", conditions } : undefined;
  }
  if (!isObj(raw)) return { type: "raw", value: raw };
  const children = pick<unknown[]>(raw, "conditions", "rules", "children", "group");
  if (Array.isArray(children)) {
    const comb = String(pick(raw, "combinator", "operator", "logic", "type") ?? "and").toLowerCase();
    return {
      type: "group",
      combinator: comb.includes("or") ? "or" : "and",
      conditions: children.map(normalizeCondition).filter(Boolean) as Condition[],
    };
  }
  const left = pick(raw, "left", "leftValue", "input", "value1", "lhs", "variable");
  const operator = str(pick(raw, "operator", "op", "operation", "comparison", "condition"));
  const right = pick(raw, "right", "rightValue", "value", "value2", "rhs", "compare_to");
  if (left !== undefined || operator) {
    return {
      type: "rule",
      left: left === undefined ? "" : String(left),
      operator: operator ?? "exists",
      right: right === undefined ? undefined : typeof right === "string" ? right : JSON.stringify(right),
    };
  }
  return { type: "raw", value: raw };
}

function delayMsFrom(raw: unknown, props: Record<string, PropValue>): number | undefined {
  const direct = pick<number | string>(raw, "delay_ms", "delayMs", "ms", "duration_ms");
  if (direct !== undefined && !Number.isNaN(Number(direct))) return Number(direct);
  const value = Number(propValue(props.delayDurationValue ?? props.duration ?? props.value ?? props.amount));
  const unitRaw = String(propValue(props.delayDurationUnit ?? props.unit) ?? "milliseconds").toLowerCase();
  if (Number.isNaN(value)) return undefined;
  const unit: Record<string, number> = {
    millisecond: 1,
    milliseconds: 1,
    ms: 1,
    second: 1000,
    seconds: 1000,
    minute: 60_000,
    minutes: 60_000,
    hour: 3_600_000,
    hours: 3_600_000,
    day: 86_400_000,
    days: 86_400_000,
    week: 604_800_000,
    weeks: 604_800_000,
  };
  return value * (unit[unitRaw] ?? 1);
}

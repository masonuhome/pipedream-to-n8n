import * as acorn from "acorn";
import * as walk from "acorn-walk";
import type { CodeStep, DeclaredProp, PropValue, Step } from "../ir";

export type { DeclaredProp };

export interface CodeAnalysis {
  parseError?: string;
  /** External npm packages (excluding node builtins and @pipedream/platform), without @version. Python: third-party modules. */
  npmImports: string[];
  /** Node builtins; Python: standard-library modules. */
  builtinImports: string[];
  /** Relative imports of sibling files ("./grid.mjs"); the converter inlines them, so they are not packages. */
  localImports: string[];
  usesPlatform: boolean;
  usesPlatformAxios: boolean;
  /** HTTP clients used: axios, got, node-fetch, fetch, request, ... */
  httpClients: string[];
  exports: string[];
  usesExport: boolean;
  usesRespond: boolean;
  usesExit: boolean;
  usesDelay: boolean;
  usesSuspend: boolean;
  usesRerun: boolean;
  usesFlowTrigger: boolean;
  /** `$.services.*`: apps Pipedream ran with its own account (e.g. OpenAI passthrough). */
  usesServices: boolean;
  sendDestinations: string[];
  usesDataStore: boolean;
  usesFileStore: boolean;
  usesTmp: boolean;
  envVars: string[];
  /** Names of prior steps read through `steps.<name>`, excluding "trigger". */
  stepRefs: string[];
  /** Paths read from the trigger event, e.g. "body", "headers", "timezone_configured". */
  triggerFields: string[];
  props: DeclaredProp[];
  /** Props whose `$auth` is read directly (connected accounts used in code). */
  appAuth: string[];
  /** Header names set with $.respond({ headers: { ... } }) (literal keys only). */
  respondHeaders: string[];
  usesMethods: boolean;
}

export const NODE_BUILTINS = new Set(
  "assert async_hooks buffer child_process cluster console constants crypto dgram diagnostics_channel dns domain events fs http http2 https inspector module net os path perf_hooks process punycode querystring readline repl stream string_decoder sys timers tls trace_events tty url util v8 vm wasi worker_threads zlib".split(
    " ",
  ),
);
const HTTP_PACKAGES = new Set(["axios", "got", "node-fetch", "request", "request-promise", "superagent", "ky", "undici", "cross-fetch", "isomorphic-fetch"]);

/** Modules the n8n Cloud Code node can require (docs: n8n_code-node.md). */
export const N8N_CLOUD_MODULES = new Set(["crypto", "moment"]);

const empty = (): CodeAnalysis => ({
  npmImports: [],
  builtinImports: [],
  localImports: [],
  usesPlatform: false,
  usesPlatformAxios: false,
  httpClients: [],
  exports: [],
  usesExport: false,
  usesRespond: false,
  usesExit: false,
  usesDelay: false,
  usesSuspend: false,
  usesRerun: false,
  usesFlowTrigger: false,
  usesServices: false,
  sendDestinations: [],
  usesDataStore: false,
  usesFileStore: false,
  usesTmp: false,
  envVars: [],
  stepRefs: [],
  triggerFields: [],
  props: [],
  appAuth: [],
  respondHeaders: [],
  usesMethods: false,
});

/**
 * An import spec without the npm version Pipedream lets code pin ("axios@0.19.2" -> "axios",
 * "@slack/web-api@6.8.0" -> "@slack/web-api", "lodash@4.17.21/fp" -> "lodash/fp"). Subpaths and "node:" stay.
 */
export function stripImportVersion(spec: string): string {
  return spec.replace(/^((?:node:)?(?:@[^/@]+\/)?[^/@]+)@[^/]*/, "$1");
}

/** The npm package an import spec loads: "node:fs" -> "fs", "@scope/pkg/sub" -> "@scope/pkg", "axios@0.19.2" -> "axios". */
export function packageName(spec: string): string {
  const s = stripImportVersion(spec).replace(/^node:/, "");
  if (s.startsWith("@")) return s.split("/").slice(0, 2).join("/");
  return s.split("/")[0];
}

/** "./grid.mjs", "../lib/util.js", "/abs/path": files next to the step, not packages. */
export const isLocalImport = (spec: string) => /^\.{1,2}(\/|$)|^\//.test(spec);

export function analyzeCode(step: CodeStep): CodeAnalysis {
  let a: CodeAnalysis;
  if (step.lang === "python") a = analyzePython(step.code);
  else if (step.lang !== "nodejs") a = empty();
  else {
    a = analyzeJs(step.code);
    // Sibling modules are inlined by the converter, so their imports are the step's imports.
    for (const [path, source] of Object.entries(step.modules ?? {})) mergeModule(a, path, analyzeJs(source));
  }
  // Data stores declared outside the code: Python `__configurableProps`, REST configurableProps, or a configured store.
  if ((step.declared ?? []).some((d) => d.type === "data_store") || Object.values(step.props ?? {}).some((v) => dataStoreIds(v).length)) a.usesDataStore = true;
  return a;
}

function mergeModule(a: CodeAnalysis, path: string, m: CodeAnalysis) {
  const add = (list: string[], v: string) => {
    if (!list.includes(v)) list.push(v);
  };
  if (m.parseError && !a.parseError) a.parseError = `${path}: ${m.parseError}`;
  for (const p of m.npmImports) add(a.npmImports, p);
  for (const p of m.builtinImports) add(a.builtinImports, p);
  for (const p of m.httpClients) add(a.httpClients, p);
  for (const e of m.envVars) add(a.envVars, e);
  a.usesPlatform ||= m.usesPlatform;
  a.usesPlatformAxios ||= m.usesPlatformAxios;
  a.usesTmp ||= m.usesTmp;
  a.usesFileStore ||= m.usesFileStore;
}

/** Pipedream data store ids (`{ storeId: "ds_…" }`) anywhere inside a prop value (a PropValue or a plain value). */
export function dataStoreIds(v: unknown): string[] {
  const out: string[] = [];
  const visit = (x: unknown, depth: number) => {
    if (depth > 8 || x === null || typeof x !== "object") return;
    if (Array.isArray(x)) {
      for (const y of x.slice(0, 200)) visit(y, depth + 1);
      return;
    }
    const o = x as Record<string, unknown>;
    if (typeof o.storeId === "string" && /^ds_/.test(o.storeId) && !out.includes(o.storeId)) out.push(o.storeId);
    for (const y of Object.values(o)) visit(y, depth + 1);
  };
  const p = v as PropValue;
  visit(p && typeof p === "object" && "t" in p && (p.t === "value" || p.t === "lv") ? p.value : v, 0);
  return out;
}

/** Pipedream's "Return HTTP Response" action: `$.respond()` without code. */
export const isRespondAction = (s: Step) => s.kind === "action" && /^http-return-http-response/.test(s.componentKey);

/**
 * True when a step sends the HTTP response itself: `$.respond()` (also with a renamed `$`), Python
 * `pd.respond()`, or the Return HTTP Response action, inside branches too. The report and the converter
 * both use this to decide between Webhook and Webhook + Respond to Webhook.
 */
export function stepsRespond(steps: Step[]): boolean {
  return steps.some(
    (s) =>
      isRespondAction(s) ||
      (s.kind === "code" && !!s.code.trim() && analyzeCode(s).usesRespond) ||
      (s.kind === "control" && s.branches.some((b) => stepsRespond(b.steps))),
  );
}

type AnyNode = acorn.Node & Record<string, any>;

export function parseJs(code: string): acorn.Program {
  return acorn.parse(code, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    allowImportExportEverywhere: true,
    allowHashBang: true,
  });
}

function memberChain(node: AnyNode): string[] | null {
  if (node.type === "Identifier") return [node.name];
  if (node.type === "ThisExpression") return ["this"];
  if (node.type === "MemberExpression") {
    const base = memberChain(node.object);
    if (!base) return null;
    if (!node.computed && node.property.type === "Identifier") return [...base, node.property.name];
    if (node.computed && node.property.type === "Literal") return [...base, String(node.property.value)];
    return [...base, "*"];
  }
  if (node.type === "ChainExpression") return memberChain(node.expression);
  return null;
}

export function analyzeJs(code: string): CodeAnalysis {
  try {
    return analyzeJsTree(code);
  } catch (e) {
    // Pathological code (a member chain thousands deep...) can overflow the parser or walker stack.
    const a = empty();
    a.parseError = `could not analyze the code: ${(e as Error).message}`;
    for (const m of code.matchAll(/(?:from\s+|require\(\s*|import\(\s*)["']([^"']+)["']/g)) {
      if (isLocalImport(m[1])) continue;
      const pkg = packageName(m[1]);
      if (!pkg || pkg === "@pipedream/platform" || pkg === "@pipedreamhq/platform") continue;
      const list = NODE_BUILTINS.has(pkg) || m[1].startsWith("node:") ? a.builtinImports : a.npmImports;
      if (!list.includes(pkg)) list.push(pkg);
    }
    regexFallback(code, a);
    return a;
  }
}

function analyzeJsTree(code: string): CodeAnalysis {
  const a = empty();
  const add = (list: string[], v: string) => {
    if (v && !list.includes(v)) list.push(v);
  };
  const addImport = (spec: string, specifiers?: AnyNode[]) => {
    if (isLocalImport(spec)) return add(a.localImports, spec);
    const pkg = packageName(spec);
    if (!pkg) return;
    // "@pipedreamhq/platform" is the package's old name.
    if (pkg === "@pipedream/platform" || pkg === "@pipedreamhq/platform") {
      a.usesPlatform = true;
      if (!specifiers || specifiers.some((s) => s.imported?.name === "axios" || s.local?.name === "axios")) a.usesPlatformAxios = true;
      return;
    }
    if (NODE_BUILTINS.has(pkg) || spec.startsWith("node:")) add(a.builtinImports, pkg);
    else add(a.npmImports, pkg);
    if (HTTP_PACKAGES.has(pkg)) add(a.httpClients, pkg);
  };

  let ast: acorn.Program;
  try {
    ast = parseJs(code);
  } catch (e) {
    a.parseError = (e as Error).message;
    for (const m of code.matchAll(/(?:from\s+|require\(\s*|import\(\s*)["']([^"']+)["']/g)) addImport(m[1]);
    regexFallback(code, a);
    return a;
  }

  // run({ steps, $: pd }) or run(ctx) { ctx.$.respond() }: chains are read through these names.
  const component = findComponentObject(ast as AnyNode);
  const canonical = runParamAliases(component);
  const chainOf = (node: AnyNode) => {
    const chain = memberChain(node);
    if (!chain) return chain;
    const root = canonical.get(chain[0]);
    if (root === undefined) return chain;
    return root === "" ? chain.slice(1) : [root, ...chain.slice(1)];
  };
  const collectEnvKeys = (pattern: AnyNode, source: AnyNode | null | undefined) => {
    const chain = source ? chainOf(source) : null;
    if (pattern?.type !== "ObjectPattern" || chain?.length !== 2 || chain[0] !== "process" || chain[1] !== "env") return;
    for (const p of pattern.properties) {
      if (p.type !== "Property") continue;
      const key = p.computed ? (p.key.type === "Literal" ? p.key.value : undefined) : (p.key?.name ?? p.key?.value);
      if (typeof key === "string") add(a.envVars, key);
    }
  };

  walk.ancestor(ast, {
    ImportDeclaration(n: AnyNode) {
      addImport(String(n.source.value), n.specifiers);
    },
    ImportExpression(n: AnyNode) {
      if (n.source.type === "Literal") addImport(String(n.source.value));
    },
    CallExpression(n: AnyNode) {
      if (n.callee.type === "Identifier" && n.callee.name === "require" && n.arguments[0]?.type === "Literal") {
        addImport(String(n.arguments[0].value));
      }
      if (n.callee.type === "Identifier" && n.callee.name === "fetch") add(a.httpClients, "fetch");
      const chain = chainOf(n.callee);
      if (chain?.[0] === "$" && chain[1] === "respond" && n.arguments[0]?.type === "ObjectExpression") {
        const headers = n.arguments[0].properties.find((p: AnyNode) => (p.key?.name ?? p.key?.value) === "headers");
        if (headers?.value?.type === "ObjectExpression") {
          for (const p of headers.value.properties) {
            const key = p.key?.name ?? p.key?.value;
            if (typeof key === "string") add(a.respondHeaders, key);
          }
        }
      }
      if (chain?.[0] === "$" && chain[1] === "export") {
        const arg = n.arguments[0];
        if (arg?.type === "Literal") add(a.exports, String(arg.value));
      }
    },
    // const { API_KEY, BASE_URL: url } = process.env
    VariableDeclarator(n: AnyNode) {
      collectEnvKeys(n.id, n.init);
    },
    AssignmentExpression(n: AnyNode) {
      collectEnvKeys(n.left, n.right);
    },
    Literal(n: AnyNode) {
      if (typeof n.value === "string" && /(^|["'`\s])\/tmp(\/|$)/.test(n.value)) a.usesTmp = true;
    },
    TemplateElement(n: AnyNode) {
      if (/\/tmp(\/|$)/.test(n.value?.raw ?? "")) a.usesTmp = true;
    },
    MemberExpression(n: AnyNode, _state: unknown, ancestors: AnyNode[]) {
      const parent = ancestors[ancestors.length - 2];
      if (parent && parent.type === "MemberExpression" && parent.object === n) return; // only outermost
      const chain = chainOf(n);
      if (!chain) return;
      readChain(chain, a, add);
    },
  });

  // Declared props and methods on the component object.
  if (component) {
    for (const p of component.properties ?? []) {
      const key = p.key?.name ?? p.key?.value;
      if (key === "methods") a.usesMethods = true;
      if (key !== "props" || p.value?.type !== "ObjectExpression") continue;
      for (const prop of p.value.properties) {
        const name = prop.key?.name ?? prop.key?.value;
        if (!name) continue;
        const decl: DeclaredProp = { name: String(name) };
        if (prop.value?.type === "ObjectExpression") {
          for (const f of prop.value.properties) {
            const fk = f.key?.name ?? f.key?.value;
            if (fk === "type" && f.value.type === "Literal") decl.type = String(f.value.value);
            if (fk === "app" && f.value.type === "Literal") decl.app = String(f.value.value);
            if (fk === "secret" && f.value.type === "Literal") decl.secret = f.value.value === true;
          }
        }
        if (decl.type === "data_store") a.usesDataStore = true;
        a.props.push(decl);
      }
    }
  }
  return a;
}

function readChain(chain: string[], a: CodeAnalysis, add: (l: string[], v: string) => void) {
  const [root, second, third] = chain;
  if (root === "$") {
    if (second === "export") a.usesExport = true;
    if (second === "respond") a.usesRespond = true;
    if (second === "flow") {
      if (third === "exit") a.usesExit = true;
      if (third === "delay") a.usesDelay = true;
      if (third === "suspend") a.usesSuspend = true;
      if (third === "rerun") a.usesRerun = true;
      if (third === "trigger") a.usesFlowTrigger = true;
    }
    if (second === "send" && third) add(a.sendDestinations, third);
    if (second === "service" && third === "db") a.usesDataStore = true;
    if (second === "files") a.usesFileStore = true;
    if (second === "services") a.usesServices = true;
  } else if (root === "steps" && second) {
    if (second === "trigger") {
      if (third === "event" && chain[3] && chain[3] !== "*") add(a.triggerFields, chain[3]);
    } else if (second !== "*") add(a.stepRefs, second);
  } else if (root === "process" && second === "env" && third) {
    if (third !== "*") add(a.envVars, third);
  } else if (root === "this" && second) {
    if (chain.includes("$auth")) add(a.appAuth, second);
  }
}

function findComponentObject(ast: AnyNode): AnyNode | undefined {
  for (const node of ast.body as AnyNode[]) {
    if (node.type !== "ExportDefaultDeclaration") continue;
    const d = node.declaration;
    if (d.type === "ObjectExpression") return d;
    if (d.type === "CallExpression" && d.arguments[0]?.type === "ObjectExpression") return d.arguments[0];
  }
  return undefined;
}

/**
 * What run()'s parameter calls Pipedream's `$` and `steps`: `run({ steps, $: pd })` maps "pd" to "$";
 * `run(ctx)` maps "ctx" to "" (so `ctx.$.respond` reads as `$.respond`).
 */
function runParamAliases(component: AnyNode | undefined): Map<string, string> {
  const out = new Map<string, string>();
  const run = component?.properties?.find((p: AnyNode) => p.type === "Property" && (p.key?.name ?? p.key?.value) === "run");
  const fn = run?.value;
  if (!fn || !/Function/.test(fn.type)) return out;
  const param = fn.params?.[0]?.type === "AssignmentPattern" ? fn.params[0].left : fn.params?.[0];
  if (param?.type === "Identifier") {
    if (param.name !== "$" && param.name !== "steps") out.set(param.name, "");
  } else if (param?.type === "ObjectPattern") {
    for (const p of param.properties) {
      if (p.type !== "Property" || p.computed) continue;
      const key = p.key?.name ?? p.key?.value;
      const value = p.value?.type === "AssignmentPattern" ? p.value.left : p.value;
      if ((key === "$" || key === "steps") && value?.type === "Identifier" && value.name !== key) out.set(value.name, key);
    }
  }
  return out;
}

function regexFallback(code: string, a: CodeAnalysis) {
  a.usesExport = /\$\.export\(/.test(code);
  a.usesRespond = /\$\.respond\(/.test(code);
  a.usesExit = /\$\.flow\.exit\(/.test(code);
  a.usesDelay = /\$\.flow\.delay\(/.test(code);
  a.usesSuspend = /\$\.flow\.suspend\(/.test(code);
  a.usesRerun = /\$\.flow\.rerun\(/.test(code);
  a.usesDataStore = /\$\.service\.db|data_store/.test(code);
  a.usesFileStore = /\$\.files\b/.test(code);
  a.usesServices = /\$\.services\b/.test(code);
  const env = (name: string) => {
    if (!a.envVars.includes(name)) a.envVars.push(name);
  };
  for (const m of code.matchAll(/process\.env\.([A-Za-z_][\w]*)/g)) env(m[1]);
  for (const m of code.matchAll(/process\.env\[\s*["']([^"']+)["']\s*\]/g)) env(m[1]);
  for (const m of code.matchAll(/\{([^{}]*)\}\s*=\s*process\.env\b/g)) {
    for (const part of m[1].split(",")) {
      const key = part.split(/[:=]/)[0].trim().replace(/^["']|["']$/g, "");
      if (/^[A-Za-z_][\w]*$/.test(key)) env(key);
    }
  }
  for (const m of code.matchAll(/steps\.([A-Za-z_$][\w$]*)/g)) if (m[1] !== "trigger" && !a.stepRefs.includes(m[1])) a.stepRefs.push(m[1]);
  for (const m of code.matchAll(/\$\.send\.(\w+)/g)) if (!a.sendDestinations.includes(m[1])) a.sendDestinations.push(m[1]);
}

/**
 * Python standard library: `sys.stdlib_module_names` of CPython 3.12 (generated, 300 names), plus the
 * modules 3.12 removed (asynchat asyncore distutils imp smtpd), which older Pipedream runtimes still had.
 */
export const PY_STDLIB = new Set(
  (
    "__future__ _abc _aix_support _ast _asyncio _bisect _blake2 _bz2 _codecs _codecs_cn _codecs_hk _codecs_iso2022 _codecs_jp _codecs_kr " +
    "_codecs_tw _collections _collections_abc _compat_pickle _compression _contextvars _crypt _csv _ctypes _curses _curses_panel _datetime " +
    "_dbm _decimal _elementtree _frozen_importlib _frozen_importlib_external _functools _gdbm _hashlib _heapq _imp _io _json _locale _lsprof " +
    "_lzma _markupbase _md5 _msi _multibytecodec _multiprocessing _opcode _operator _osx_support _overlapped _pickle _posixshmem " +
    "_posixsubprocess _py_abc _pydatetime _pydecimal _pyio _pylong _queue _random _scproxy _sha1 _sha2 _sha3 _signal _sitebuiltins _socket " +
    "_sqlite3 _sre _ssl _stat _statistics _string _strptime _struct _symtable _thread _threading_local _tkinter _tokenize _tracemalloc _typing " +
    "_uuid _warnings _weakref _weakrefset _winapi _zoneinfo abc aifc antigravity argparse array ast asyncio atexit audioop base64 bdb binascii " +
    "bisect builtins bz2 cProfile calendar cgi cgitb chunk cmath cmd code codecs codeop collections colorsys compileall concurrent configparser " +
    "contextlib contextvars copy copyreg crypt csv ctypes curses dataclasses datetime dbm decimal difflib dis doctest email encodings ensurepip " +
    "enum errno faulthandler fcntl filecmp fileinput fnmatch fractions ftplib functools gc genericpath getopt getpass gettext glob graphlib grp " +
    "gzip hashlib heapq hmac html http idlelib imaplib imghdr importlib inspect io ipaddress itertools json keyword lib2to3 linecache locale " +
    "logging lzma mailbox mailcap marshal math mimetypes mmap modulefinder msilib msvcrt multiprocessing netrc nis nntplib nt ntpath nturl2path " +
    "numbers opcode operator optparse os ossaudiodev pathlib pdb pickle pickletools pipes pkgutil platform plistlib poplib posix posixpath " +
    "pprint profile pstats pty pwd py_compile pyclbr pydoc pydoc_data pyexpat queue quopri random re readline reprlib resource rlcompleter " +
    "runpy sched secrets select selectors shelve shlex shutil signal site smtplib sndhdr socket socketserver spwd sqlite3 sre_compile " +
    "sre_constants sre_parse ssl stat statistics string stringprep struct subprocess sunau symtable sys sysconfig syslog tabnanny tarfile " +
    "telnetlib tempfile termios textwrap this threading time timeit tkinter token tokenize tomllib trace traceback tracemalloc tty turtle " +
    "turtledemo types typing unicodedata unittest urllib uu uuid venv warnings wave weakref webbrowser winreg winsound wsgiref xdrlib xml " +
    "xmlrpc zipapp zipfile zipimport zlib zoneinfo " +
    "asynchat asyncore distutils imp smtpd"
  ).split(" "),
);

export function analyzePython(code: string): CodeAnalysis {
  const a = empty();
  // [ \t]* instead of \s*: with the m flag, \s* runs across newlines and goes quadratic on blank lines.
  for (const m of code.matchAll(/^[ \t]*(?:from[ \t]+([\w.]+)[ \t]+import|import[ \t]+([\w., ]+))/gm)) {
    const mods = m[1] ? [m[1]] : m[2].split(",").map((s) => s.trim().split(/\s+as\s+/)[0]);
    for (const mod of mods) {
      const root = mod.split(".")[0];
      if (!root || root === "pipedream") continue;
      const list = PY_STDLIB.has(root) ? a.builtinImports : a.npmImports;
      if (!list.includes(root)) list.push(root);
      if (["requests", "httpx", "aiohttp", "urllib3"].includes(root) && !a.httpClients.includes(root)) a.httpClients.push(root);
    }
  }
  // def handler(pd: "pipedream"): the parameter may have another name.
  const name = code.match(/^[ \t]*def[ \t]+handler[ \t]*\([ \t]*([A-Za-z_]\w*)/m)?.[1] ?? "pd";
  const pd = name.replace(/[$]/g, "[$]");
  const re = (body: string, flags = "") => new RegExp(`\\b${pd}${body}`, flags);
  a.usesExport = re("\\.export\\(").test(code);
  for (const m of code.matchAll(re(`\\.export\\(\\s*["']([^"']+)["']`, "g"))) if (!a.exports.includes(m[1])) a.exports.push(m[1]);
  a.usesRespond = re("\\.respond\\(").test(code);
  a.usesExit = re("\\.flow\\.exit\\(").test(code);
  a.usesDelay = re("\\.flow\\.delay\\(").test(code);
  a.usesSuspend = re("\\.flow\\.suspend\\(").test(code);
  a.usesRerun = re("\\.flow\\.rerun\\(").test(code);
  a.usesDataStore = /data_store/.test(code);
  a.usesTmp = /["']\/tmp/.test(code);
  // os.environ["X"], os.environ.get("X"), os.getenv("X"), and the same after `from os import environ, getenv`.
  for (const m of code.matchAll(/\b(?:os\.)?(?:environ(?:\.get\(\s*|\[\s*)|getenv\(\s*)["']([^"']+)["']/g)) if (!a.envVars.includes(m[1])) a.envVars.push(m[1]);
  for (const m of code.matchAll(re(`\\.steps\\[\\s*["']([^"']+)["']\\s*\\](?:\\[\\s*["']event["']\\s*\\]\\[\\s*["']([^"']+)["']\\])?`, "g"))) {
    if (m[1] === "trigger") {
      if (m[2] && !a.triggerFields.includes(m[2])) a.triggerFields.push(m[2]);
    } else if (!a.stepRefs.includes(m[1])) a.stepRefs.push(m[1]);
  }
  for (const m of code.matchAll(re(`\\.inputs\\[\\s*["']([^"']+)["']\\s*\\]\\[\\s*["']\\$auth["']\\]`, "g"))) if (!a.appAuth.includes(m[1])) a.appAuth.push(m[1]);
  return a;
}

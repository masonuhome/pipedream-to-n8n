import { n8nNodeForApp } from "../catalog";
import type { Project } from "../ir";
import { platformLabel } from "../platform";
import type { PackageClass } from "./packages";
import { accountLabel, analyzeWorkflow, type IssueCode, type Level, type WorkflowAnalysis } from "./workflow";

export type Platform = "n8n-cloud" | "n8n-self-hosted";

export interface ProjectAnalysis {
  project: Project;
  workflows: WorkflowAnalysis[];
  levels: Record<Level, number>;
  totals: {
    workflows: number;
    steps: number;
    codeSteps: number;
    actions: number;
    mappedActions: number;
    secrets: number;
    manualHours: number;
    withToolHours: number;
  };
  /**
   * Accounts to reconnect, one row per label (slack, slack_bot and slack_v2 are one "Slack" row).
   * `app` is the row's most used Pipedream slug; `pdApps` lists every slug in the row.
   */
  apps: { app: string; label: string; workflows: number; n8nNode?: string; pdApps: string[] }[];
  envVars: string[];
  npm: { name: string; cls: PackageClass; workflows: number }[];
  blockers: { code: IssueCode; level: Level; message: string; workflows: number }[];
  dataStoreWorkflows: string[];
  /** Data stores by id (`ds_…`), when the input names them, with the workflows that use each. */
  dataStores: { id: string; workflows: string[] }[];
  fileStoreWorkflows: string[];
  recommendation: { platform: Platform; reasons: string[]; facts: RecommendationFacts };
}

/** The numbers behind the recommendation, so other languages can phrase the reasons themselves. */
export interface RecommendationFacts {
  /** Code steps that import npm packages n8n Cloud can't load, and those packages. */
  hardSteps: number;
  hardPackages: string[];
  /** Workflows with Python steps that import modules, the modules, and whether any is a third-party package. */
  pythonWorkflows: number;
  pythonModules: string[];
  pythonThirdParty: boolean;
  /** Bash or Go steps. */
  otherLangSteps: number;
  /** All npm packages used in code steps. */
  packages: string[];
}

const BLOCKER_TEXT: Partial<Record<IssueCode, string>> = {
  CODE_NPM_HARD: "Code imports packages that n8n Cloud cannot load",
  CODE_NPM_SDK: "Code uses API SDKs that must become HTTP calls on n8n Cloud",
  CODE_NPM_BUILTIN: "Code uses packages with n8n built-in equivalents (axios, date-fns, lodash…)",
  CODE_DATA_STORE: "Pipedream data stores must be exported and moved",
  CODE_FILE_STORE: "Pipedream File Store files must be downloaded and moved",
  CODE_PYTHON: "Python steps to rewrite in JavaScript (n8n Cloud's Python can't import modules)",
  CODE_DELAY: "$.flow.delay inside code",
  CODE_SUSPEND: "$.flow.suspend inside code",
  CODE_RERUN: "$.flow.rerun has no n8n equivalent",
  CODE_APP_AUTH: "Code reads connected-account tokens directly",
  CODE_SEND: "$.send destinations",
  CODE_TMP: "Code writes to /tmp",
  CODE_PARSE_ERROR: "Code that could not be parsed",
  CODE_MISSING: "Code missing from the export",
  CODE_UNSUPPORTED_LANG: "Bash or Go steps",
  ACTION_PRIVATE: "Private components (code not exported)",
  ACTION_APP_NODE: "Actions without an automatic mapping (n8n node exists)",
  ACTION_NO_NODE: "Actions for apps with no n8n node",
  TRIGGER_SOURCE_PRIVATE: "Private event sources",
  TRIGGER_SOURCE_UNMAPPED: "Event sources with no n8n trigger",
  TRIGGER_SOURCE_NODE: "Event sources to re-pick in n8n",
  TRIGGER_EMAIL: "Email triggers (the @pipedream.net address goes away)",
  TRIGGER_FORM: "Form triggers",
  TRIGGER_UNKNOWN: "Unknown trigger types",
  TRIGGER_INFERRED: "Trigger settings missing from the input",
  CONTROL_BRANCH: "Branch conditions to check",
  CONTROL_UNKNOWN: "Unrecognized control-flow blocks",
  CONTROL_LOOP: "Loops: check how steps read the current item",
  CONTROL_AI: "AI branch blocks: connect an OpenAI credential",
  UNKNOWN_STEP: "Unrecognized steps",
};

/** Blocker wording for Zapier accounts where Pipedream's doesn't fit. */
const ZAPIER_BLOCKER_TEXT: Partial<Record<IssueCode, string>> = {
  CODE_DATA_STORE: "Storage by Zapier used from code",
  CODE_PYTHON: "Python Code by Zapier steps to port to JavaScript (n8n Cloud's Python can't import modules)",
  TRIGGER_EMAIL: "Email by Zapier triggers (the @zapiermail.com address goes away)",
  TRIGGER_FORM: "Zapier Interfaces forms to rebuild",
  TRIGGER_SOURCE_UNMAPPED: "App triggers with no n8n trigger",
  TRIGGER_SOURCE_NODE: "App triggers to pick again in n8n",
  ACTION_APP_NODE: "Actions without an automatic mapping yet (n8n node exists)",
  ACTION_NO_NODE: "Zapier-only products and apps with no n8n node",
};

export function analyzeProject(project: Project): ProjectAnalysis {
  const blockerText = (code: IssueCode) => (project.platform === "zapier" ? ZAPIER_BLOCKER_TEXT[code] : undefined) ?? BLOCKER_TEXT[code];
  const workflows = project.workflows.map(analyzeWorkflow);
  const levels: Record<Level, number> = { green: 0, yellow: 0, red: 0 };
  const accounts = new Map<string, { slugs: Map<string, number>; workflows: Set<string> }>();
  const npm = new Map<string, { cls: PackageClass; workflows: number }>();
  const env = new Set<string>();
  const stores = new Map<string, string[]>();
  const blockers = new Map<IssueCode, { level: Level; workflows: Set<string> }>();
  const totals = { workflows: workflows.length, steps: 0, codeSteps: 0, actions: 0, mappedActions: 0, secrets: 0, manualHours: 0, withToolHours: 0 };
  let codeWithHard = 0;
  let otherLangSteps = 0;
  let pythonWithImports = 0;
  const pythonModules = new Set<string>();
  const pythonPackages = new Set<string>();

  for (const w of workflows) {
    levels[w.level]++;
    totals.steps += w.counts.steps;
    totals.codeSteps += w.counts.code;
    totals.actions += w.counts.actions;
    totals.mappedActions += w.counts.mappedActions;
    totals.secrets += w.secrets.length;
    totals.manualHours += w.manualHours;
    totals.withToolHours += w.withToolHours;
    for (const a of w.apps) {
      const label = accountLabel(a);
      const row = accounts.get(label) ?? { slugs: new Map<string, number>(), workflows: new Set<string>() };
      row.slugs.set(a, (row.slugs.get(a) ?? 0) + 1);
      row.workflows.add(w.workflow.id);
      accounts.set(label, row);
    }
    for (const e of w.envVars) env.add(e);
    for (const id of w.dataStores) stores.set(id, [...(stores.get(id) ?? []), w.workflow.name]);
    for (const p of w.npm) {
      const cur = npm.get(p.name);
      npm.set(p.name, { cls: p.cls, workflows: (cur?.workflows ?? 0) + 1 });
    }
    codeWithHard += w.steps.filter((s) => s.issues.some((i) => i.code === "CODE_NPM_HARD")).length;
    otherLangSteps += w.steps.filter((s) => s.issues.some((i) => i.code === "CODE_UNSUPPORTED_LANG")).length;
    // n8n Cloud's Python imports nothing, the standard library included.
    const pyImports = w.steps.filter((s) => s.lang === "python").flatMap((s) => [...(s.code?.npmImports ?? []), ...(s.code?.builtinImports ?? [])]);
    if (pyImports.length) pythonWithImports++;
    for (const m of pyImports) pythonModules.add(m);
    for (const p of w.python) pythonPackages.add(p.name);
    for (const i of w.issues) {
      if (i.level === "info" || i.level === "green") continue;
      if (!BLOCKER_TEXT[i.code]) continue;
      const b = blockers.get(i.code) ?? { level: i.level, workflows: new Set<string>() };
      b.workflows.add(w.workflow.id);
      if (i.level === "red") b.level = "red";
      blockers.set(i.code, b);
    }
  }
  // Every workflow on the "Data to save" list counts, also when the store is used through actions.
  for (const w of workflows.filter((x) => x.usesDataStore)) {
    const b = blockers.get("CODE_DATA_STORE") ?? { level: "yellow" as Level, workflows: new Set<string>() };
    b.workflows.add(w.workflow.id);
    blockers.set("CODE_DATA_STORE", b);
  }
  // Credentials are reconnected once per app, not per workflow.
  totals.manualHours += accounts.size * 0.25;
  totals.withToolHours += accounts.size * 0.25;

  const reasons: string[] = [];
  let platform: Platform = "n8n-cloud";
  const hardPackages = [...npm].filter(([, v]) => v.cls === "hard").map(([k]) => k);
  if (codeWithHard > 0 || pythonWithImports > 0 || otherLangSteps > 0) {
    platform = "n8n-self-hosted";
    if (codeWithHard) {
      reasons.push(
        `${codeWithHard} code step(s) need npm packages n8n Cloud can't load (${hardPackages.slice(0, 6).join(", ")}). Self-hosted n8n can allow them with NODE_FUNCTION_ALLOW_EXTERNAL once they are installed for its task runner.`,
      );
    }
    if (pythonWithImports) {
      reasons.push(
        `${pythonWithImports} workflow(s) have Python steps that import modules (${[...pythonModules].slice(0, 6).join(", ")}), and n8n Cloud's Python can't import anything, not even the standard library. Rewrite them in JavaScript to stay on n8n Cloud, or self-host n8n with the Python task runner (n8nio/runners image) and allow the modules with N8N_RUNNERS_STDLIB_ALLOW${pythonPackages.size ? " and N8N_RUNNERS_EXTERNAL_ALLOW (third-party packages must be installed in the runner image)" : ""}.`,
      );
    }
    if (otherLangSteps) {
      reasons.push(
        `${otherLangSteps} Bash or Go step(s) can't run on n8n Cloud. Self-hosted n8n can run commands with the Execute Command node (disabled by default since n8n 2.0), or rewrite them in JavaScript.`,
      );
    }
  } else {
    reasons.push("Every code step can run on n8n Cloud once npm calls are rewritten to built-in helpers.");
    if (npm.size) reasons.push(`Packages to replace: ${[...npm.keys()].slice(0, 8).join(", ")}.`);
    reasons.push(`No servers to maintain; the closest experience to ${platformLabel(project.platform)}.`);
  }
  const facts: RecommendationFacts = {
    hardSteps: codeWithHard,
    hardPackages: hardPackages.slice(0, 6),
    pythonWorkflows: pythonWithImports,
    pythonModules: [...pythonModules].slice(0, 6),
    pythonThirdParty: pythonPackages.size > 0,
    otherLangSteps,
    packages: [...npm.keys()].slice(0, 8),
  };

  return {
    project,
    workflows,
    levels,
    totals: { ...totals, manualHours: Math.round(totals.manualHours), withToolHours: Math.max(1, Math.round(totals.withToolHours)) },
    apps: [...accounts]
      .map(([label, row]) => {
        const slugs = [...row.slugs].sort((a, b) => b[1] - a[1]).map(([s]) => s);
        return { app: slugs[0], label, workflows: row.workflows.size, n8nNode: n8nNodeForApp(slugs[0])?.displayName, pdApps: slugs };
      })
      .sort((a, b) => b.workflows - a.workflows),
    envVars: [...env].sort(),
    npm: [...npm].sort((a, b) => b[1].workflows - a[1].workflows).map(([name, v]) => ({ name, ...v })),
    blockers: [...blockers]
      .map(([code, b]) => ({ code, level: b.level, message: blockerText(code)!, workflows: b.workflows.size }))
      .sort((a, b) => (a.level === b.level ? b.workflows - a.workflows : a.level === "red" ? -1 : 1)),
    dataStoreWorkflows: workflows.filter((w) => w.usesDataStore).map((w) => w.workflow.name),
    dataStores: [...stores].map(([id, names]) => ({ id, workflows: names })),
    fileStoreWorkflows: workflows.filter((w) => w.usesFileStore).map((w) => w.workflow.name),
    recommendation: { platform, reasons, facts },
  };
}

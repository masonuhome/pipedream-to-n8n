// Internal representation shared by all input formats (Pipedream export ZIP, REST API, GitHub Sync; Zapier exports).
// Workflows from other platforms are expressed with Pipedream's semantics (steps.<name>.$return_value, props).

export type SourceFormat = "export" | "api" | "gitsync" | "template" | "zapier";

/** The platform a workflow comes from. Absent means Pipedream. */
export type Platform = "pipedream" | "zapier";

export interface Project {
  id?: string;
  name: string;
  source: SourceFormat;
  platform?: Platform;
  exportedAt?: string;
  truncated?: boolean;
  workflows: Workflow[];
  skipped: SkippedWorkflow[];
  warnings: string[];
}

export interface SkippedWorkflow {
  id?: string;
  name: string;
  status: string;
  /** Source project, when several project exports were uploaded together. */
  project?: string;
}

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  platform?: Platform;
  inactive?: boolean;
  /** Folder path inside the project, "" for root. */
  folder: string;
  /** Source project, when several project exports were uploaded together. */
  project?: string;
  triggers: Trigger[];
  steps: Step[];
  settings?: Record<string, unknown>;
  /** Warnings that came with the input (manifest warnings, inference notes). */
  warnings: string[];
}

export type TriggerKind = "http" | "timer" | "email" | "form" | "source" | "unknown";

export interface Trigger {
  kind: TriggerKind;
  /** Registry key for source triggers, e.g. "google_sheets-new-row-added". */
  componentKey?: string;
  version?: string;
  app?: string;
  /** Private (workspace-published) component, code not included in exports. */
  private?: boolean;
  cron?: string;
  intervalSeconds?: number;
  timezone?: string;
  /** Raw HTTP trigger settings (custom response, auth, path...). */
  http?: {
    customResponse?: boolean;
    auth?: "none" | "token" | "oauth" | string;
    methods?: string[];
    /** "Return a static response" setting. */
    staticResponse?: { status: number; headers?: Record<string, string>; body?: string };
    /** Event shape "body only": `steps.trigger.event` is the request body itself. */
    bodyOnly?: boolean;
  };
  props: Record<string, PropValue>;
  /** True when the trigger type was inferred rather than read from the input. */
  inferred?: boolean;
  /** Turned off in Pipedream; kept so it is not replaced by an inferred trigger. */
  disabled?: boolean;
  raw?: unknown;
}

export type Step = CodeStep | ActionStep | ControlStep | UnknownStep;

interface BaseStep {
  /** Step namespace as used in `steps.<name>` references. Unique per workflow. */
  name: string;
  disabled?: boolean;
  props: Record<string, PropValue>;
  /** Prop declarations that came with the input (Python `__configurableProps`, REST `savedComponent.configurableProps`). */
  declared?: DeclaredProp[];
}

export interface DeclaredProp {
  name: string;
  type?: string;
  /** App slug for `type: "app"` props, e.g. "slack". */
  app?: string;
  secret?: boolean;
}

export type CodeLang = "nodejs" | "python" | "bash" | "go";

export interface CodeStep extends BaseStep {
  kind: "code";
  lang: CodeLang;
  /** Code by Zapier: JavaScript wrapped as a component (inputData prop), Python kept as written. */
  dialect?: "zapier";
  runtime?: string;
  code: string;
  /** Entry file path relative to the workflow folder (GitHub Sync), e.g. "build_grid/entry.mjs". */
  path?: string;
  /** Sibling modules imported with relative paths, keyed by path relative to the workflow folder. */
  modules?: Record<string, string>;
}

export interface ActionStep extends BaseStep {
  kind: "action";
  /** Component key without version, e.g. "slack-send-message". Private keys keep their "@workspace/" prefix. */
  componentKey: string;
  version?: string;
  app: string;
  private: boolean;
  /** The component's source when the input carries it (REST API `savedComponent.code`, pinned to the version used). */
  source?: string;
  /** Display labels of chosen values by prop (Zapier's `meta.parammap`: sheet and channel names…). */
  labels?: Record<string, string>;
}

export type ControlOp = "ifelse" | "switch" | "delay" | "filter" | "end" | "parallel" | "loop" | "ai" | "unknown";

export interface ControlStep extends BaseStep {
  kind: "control";
  op: ControlOp;
  branches: Branch[];
  /** Delay in milliseconds for op === "delay". */
  delayMs?: number;
  /** Filter semantics: true = end the workflow when the condition holds; false = continue only when it holds. */
  exitWhenTrue?: boolean;
  /** Switch: the value every case compares against (Pipedream template, e.g. "{{steps.trigger.event.plan}}"). */
  expression?: unknown;
  /** Loop: the array to iterate (Pipedream template or literal). */
  items?: unknown;
  config?: unknown;
}

export interface Branch {
  label: string;
  isDefault?: boolean;
  condition?: Condition;
  steps: Step[];
  /** Pipedream deployment that holds the branch's steps (`route.pipeline.deploymentId`). */
  deploymentId?: string;
  /** Parallel branches: when the branch runs, relative to its condition. */
  run?: "always" | "true" | "false" | "never";
}

/** Rule-builder condition (If/Else, Switch, Filter). */
export type Condition =
  | { type: "group"; combinator: "and" | "or"; conditions: Condition[] }
  | { type: "rule"; left: string; operator: string; right?: string }
  /** A rule of Pipedream's built-in Filter, with its exact operator code ("str=", "num>"...). */
  | { type: "pdrule"; left: unknown; op: string; right?: unknown; matchCase?: boolean }
  /** A rule of the registry Filter actions (`filter-*-based-on-condition`), with their operator constant. */
  | { type: "legacy"; op: string; left: unknown; right?: unknown; caseSensitive?: boolean; arrayType?: string }
  /** A rule of a Zapier Filter or Path, with Zapier's match code ("icontains", "igreater"…). */
  | { type: "zapier"; left: string; match: string; right?: string }
  | { type: "raw"; value: unknown };

export interface UnknownStep extends BaseStep {
  kind: "unknown";
  rawType?: string;
  raw?: unknown;
}

export type PropValue =
  | { t: "value"; value: unknown }
  | { t: "redacted" }
  | { t: "app"; authProvisionId?: string }
  | { t: "lv"; label?: string; value: unknown };

/** A file from an uploaded ZIP, folder or single file. */
export interface VirtualFile {
  path: string;
  text: string;
}

// Free report entry point: parsing + analysis + rendering. Safe to ship to the browser
// (does not include the n8n emitter).
export * from "../ir";
export { loadProject, unzip, InputError } from "../input/load";
export { analyzeProject, type ProjectAnalysis, type Platform } from "../analyze/project";
export { analyzeWorkflow, type WorkflowAnalysis, type StepAnalysis, type Issue, type Level } from "../analyze/workflow";
export { analyzeCode, type CodeAnalysis } from "../analyze/code";
export { renderReportMarkdown, SHUTDOWN } from "./markdown";
export { appLabel } from "../catalog";
export { skeleton } from "./skeleton";

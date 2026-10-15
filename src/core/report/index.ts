// Free report entry point: parsing + analysis + rendering. Safe to ship to the browser
// (does not include the n8n emitter).
export * from "../ir";
export { loadProject, unzip, InputError } from "../input/load";
export { analyzeProject, type ProjectAnalysis, type Platform, type RecommendationFacts } from "../analyze/project";
export { analyzeWorkflow, type WorkflowAnalysis, type StepAnalysis, type Issue, type Level } from "../analyze/workflow";
export { analyzeCode, type CodeAnalysis } from "../analyze/code";
export { renderReportMarkdown, SHUTDOWN } from "./markdown";
export { appLabel } from "../catalog";
export { skeleton } from "./skeleton";
export {
  autoMatch, DATA_STORE_EXPORT_FORMAT, dataStoreGroups, dataStoreSlots, dataTableRows, mergeStores, parseDataStoreFile,
  refreshAssign, SEED_MAX_BYTES, storeBytes, storeKey, storesForWorkflow,
  type DataStoreGroup, type DataStorePlan, type DataStoreSlot, type ExportedStore,
} from "../datastores";
export { checkCode, detectLang, type CheckItem, type CheckKey, type CheckLevel, type CheckedModule, type CodeCheck, type ModuleClass } from "../analyze/check";

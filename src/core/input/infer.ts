import type { Step, Trigger, TriggerKind, Workflow } from "../ir";

const HTTP_FIELDS = /steps\.trigger\.event\.(body|headers|query|method|path|url|client_ip)\b|steps\[["']trigger["']\]\[["']event["']\]\[["'](body|headers|query|method|path)/;
const TIMER_FIELDS = /steps\.trigger\.event\.(timezone_configured|timezone_utc|interval_seconds|cron)\b|\[["'](timezone_configured|timezone_utc)["']\]/;
const EMAIL_FIELDS = /steps\.trigger\.event\.(subject|attachments|from|to|html|headers\.subject)\b/;

/** Collects every string in steps (code and props) to sniff how the trigger event is used. */
function collectText(steps: Step[], out: string[] = []): string[] {
  for (const s of steps) {
    if (s.kind === "code") out.push(s.code);
    out.push(JSON.stringify(s.props));
    if (s.kind === "control") for (const b of s.branches) collectText(b.steps, out);
  }
  return out;
}

export function inferTriggerKind(steps: Step[]): TriggerKind {
  const text = collectText(steps).join("\n");
  if (TIMER_FIELDS.test(text)) return "timer";
  if (/\$\.respond\(|pd\.respond\(/.test(text)) return "http";
  if (EMAIL_FIELDS.test(text) && !/event\.body/.test(text)) return "email";
  if (HTTP_FIELDS.test(text)) return "http";
  return "unknown";
}

export function inferTrigger(wf: Workflow): void {
  const kind = inferTriggerKind(wf.steps);
  const base: Trigger = { kind, props: {}, inferred: true };
  if (wf.triggers.length === 0) wf.triggers.push(base);
  else wf.triggers = wf.triggers.map((t) => (t.kind === "unknown" ? { ...t, kind, inferred: true } : t));
  wf.warnings.push(
    kind === "unknown"
      ? "Trigger settings are not in the input and could not be inferred. Pick the trigger in n8n manually."
      : `Trigger settings are not in the input; inferred a ${kind} trigger from how steps use the event. Check its settings in n8n.`,
  );
}

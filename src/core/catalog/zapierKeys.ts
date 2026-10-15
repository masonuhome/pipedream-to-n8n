// Zapier steps the converter rebuilds deterministically. Shared by the report (which must not import the
// converter itself) and the converter.

/** Formatter by Zapier transforms that become n8n expressions. "text." and "string." name the same transforms. */
export const FORMATTER_SUPPORTED = new Set([
  "capitalize",
  "titlecase",
  "upper",
  "lower",
  "trim_space",
  "length",
  "word_count",
  "strip_html",
  "url_encode",
  "url_decode",
  "extract_email",
  "extract_url",
  "extract_number",
  "extract_phone",
  "default_value",
  "math_v2",
  "formatting",
  "manipulate",
  "lookup",
  "choose",
]);

/** "string.strip_html" -> "strip_html"; date and number transforms keep their group. */
export function formatterOp(transform: string): string | undefined {
  const m = transform.match(/^(text|string|number|date|util)\.(\w+)$/);
  if (!m) return undefined;
  const [, group, op] = m;
  if (op === "formatting" && group === "number") return "number_formatting";
  return op;
}

export const formatterSupported = (transform: string): boolean => {
  const op = formatterOp(transform);
  return !!op && FORMATTER_SUPPORTED.has(op);
};

/** Built-in Zapier actions (app key . action) with a deterministic n8n node. */
export const ZAPIER_NATIVE = new Set([
  "WebHook.post",
  "WebHook.get",
  "WebHook.put",
  "WebHook.custom_request",
  "Storage.get_value",
  "Storage.set_value",
  "Storage.increment_value",
  "Storage.remove_value",
  "ZapierMail.outbound",
  "Delay.delay_until",
  "AI.get_completion",
]);

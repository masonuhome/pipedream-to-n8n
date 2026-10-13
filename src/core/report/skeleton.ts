// Value-free structure of an input file, so users can share a format we don't recognize
// without sharing data: keys and types survive, values become type markers.

export function skeleton(value: unknown, depth = 0): unknown {
  if (depth > 10) return "<deep>";
  if (value === null) return null;
  if (Array.isArray(value)) {
    const items = value.slice(0, 3).map((v) => skeleton(v, depth + 1));
    return value.length > 3 ? [...items, `<+${value.length - 3} more>`] : items;
  }
  switch (typeof value) {
    case "string":
      // Keep obvious enum-like markers (schema ids, types) so formats can be told apart.
      if (/^(workflow|project-export)[./]|^[a-z_]{2,24}$|^(hi|ti|ei|dc|sub|c|sc|p|apn)_$/.test(value)) return value;
      if (/^(hi|ti|ei|dc|sub|c|sc|p|apn|proj|o)_[A-Za-z0-9]+$/.test(value)) return value.replace(/_.*/, "_<id>");
      if (/^[a-z0-9_]+-[a-z0-9-]+(@[\d.]+)?$/.test(value)) return value; // registry component keys
      return `<string:${value.length}>`;
    case "number":
      return "<number>";
    case "boolean":
      return value;
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 60)) out[k] = skeleton(v, depth + 1);
      return out;
    }
    default:
      return `<${typeof value}>`;
  }
}

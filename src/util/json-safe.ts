/**
 * JSON-safe normalization for untrusted structured values.
 *
 * Plugins, third-party libraries, and test doubles can hand log records or
 * span attributes arbitrary shapes: circular references, BigInts, functions,
 * symbols, Maps/Sets, and unbounded object graphs. Every one of those breaks
 * `JSON.stringify` — which quietly bricks `/debug/logs`, `/debug/state`, and
 * the spans-YYYY-MM-DD.jsonl persistence path when the debug endpoints or
 * append hit a poisoned object.
 *
 * This module normalizes any `unknown` into something `JSON.stringify` can
 * always emit. It also enforces a per-value size budget so a plugin can't
 * accidentally pin megabytes of state in the in-memory ring buffers by
 * passing a Big Fat Object through `childLogger.info(msg, extra)`.
 *
 * Cheap when the input is already primitive — the hot path is just a
 * `typeof` switch on a string/number/boolean/null — so this is safe to call
 * on every log and span.
 */
export type JsonSafeOptions = {
  /** Max recursion depth; deeper branches become the string "[depth]". */
  maxDepth?: number;
  /** Max entries per array / keys per object; excess trimmed + marked. */
  maxItems?: number;
  /** Max characters per string value; excess truncated + marked. */
  maxString?: number;
};

const DEFAULTS: Required<JsonSafeOptions> = {
  maxDepth: 8,
  maxItems: 100,
  maxString: 4096,
};

/**
 * Convert an unknown value into a JSON-safe tree.
 *
 * Primitives pass through. Objects/arrays are deep-copied with cycles
 * replaced by a "[circular]" marker. BigInts, Dates, Errors, Maps, Sets,
 * functions, and symbols are stringified. Anything that somehow still slips
 * through becomes the string "[unserializable]" rather than throwing.
 */
export function toJsonSafe(value: unknown, opts: JsonSafeOptions = {}): unknown {
  const o = { ...DEFAULTS, ...opts };
  const seen = new WeakSet<object>();
  return normalize(value, o, seen, 0);
}

function normalize(
  value: unknown,
  o: Required<JsonSafeOptions>,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  // Primitives that JSON already handles.
  if (value === null) return null;
  const t = typeof value;
  if (t === "string") {
    const s = value as string;
    return s.length > o.maxString
      ? s.slice(0, o.maxString) + `…[+${s.length - o.maxString}ch]`
      : s;
  }
  if (t === "number") {
    const n = value as number;
    // JSON can't represent ±Infinity or NaN — flatten to strings instead of
    // letting `JSON.stringify` silently emit `null`.
    if (!Number.isFinite(n)) return String(n);
    return n;
  }
  if (t === "boolean") return value;
  if (t === "undefined") return null;

  // Non-JSON primitives.
  if (t === "bigint") return `${String(value)}n`;
  if (t === "symbol") return (value as symbol).toString();
  if (t === "function") {
    const name = (value as { name?: string }).name;
    return `[Function${name ? " " + name : ""}]`;
  }

  // Objects from here on. Guard depth + cycles.
  if (depth >= o.maxDepth) return "[depth]";
  const obj = value as object;
  if (seen.has(obj)) return "[circular]";
  seen.add(obj);

  // Error — expose message/name/stack explicitly, stack length-capped.
  if (value instanceof Error) {
    const stack =
      typeof value.stack === "string"
        ? value.stack.length > o.maxString
          ? value.stack.slice(0, o.maxString) + "…"
          : value.stack
        : undefined;
    return { name: value.name, message: value.message, stack };
  }

  // Date — ISO string is round-trippable and compact.
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "[Invalid Date]" : value.toISOString();
  }

  // Map / Set — JSON has no native form; flatten to arrays.
  if (value instanceof Map) {
    const out: [unknown, unknown][] = [];
    let i = 0;
    for (const [k, v] of value) {
      if (i++ >= o.maxItems) {
        out.push([`…[+${value.size - o.maxItems} more]`, null]);
        break;
      }
      out.push([
        normalize(k, o, seen, depth + 1),
        normalize(v, o, seen, depth + 1),
      ]);
    }
    return { __type: "Map", entries: out };
  }
  if (value instanceof Set) {
    const out: unknown[] = [];
    let i = 0;
    for (const v of value) {
      if (i++ >= o.maxItems) {
        out.push(`…[+${value.size - o.maxItems} more]`);
        break;
      }
      out.push(normalize(v, o, seen, depth + 1));
    }
    return { __type: "Set", values: out };
  }

  // Array — length-capped copy.
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    const len = Math.min(value.length, o.maxItems);
    for (let i = 0; i < len; i++) {
      out.push(normalize(value[i], o, seen, depth + 1));
    }
    if (value.length > o.maxItems) {
      out.push(`…[+${value.length - o.maxItems} more]`);
    }
    return out;
  }

  // Buffer / TypedArray — dump a short preview, not the whole payload.
  if (ArrayBuffer.isView(value)) {
    const anyView = value as ArrayBufferView & { length?: number };
    return `[${(value as object).constructor.name} bytes=${
      typeof anyView.length === "number" ? anyView.length : anyView.byteLength
    }]`;
  }

  // Plain object — iterate own string keys, length-capped.
  const out: Record<string, unknown> = {};
  const keys = Object.keys(obj);
  const kLen = Math.min(keys.length, o.maxItems);
  for (let i = 0; i < kLen; i++) {
    const k = keys[i]!;
    try {
      out[k] = normalize((obj as Record<string, unknown>)[k], o, seen, depth + 1);
    } catch {
      // Getter threw (e.g. proxy); swallow so one bad field doesn't kill the
      // whole payload.
      out[k] = "[unserializable]";
    }
  }
  if (keys.length > o.maxItems) {
    out["…"] = `[+${keys.length - o.maxItems} more keys]`;
  }
  return out;
}

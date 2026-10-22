// L2-15: redaction of any value passed to a log or report (plan §14 row 28, E54). Content redaction before send is L2-07, not this file.
import { redactSecrets } from "../../security_scan/intake.js";

// WHY caps: a log value is untrusted shape; an unbounded walk of a deep or huge structure is a crash or a hang inside the logger.
export const MAX_DEPTH = 20;
export const MAX_NODES = 10_000;

// WHY token only as a whole trailing word: input_tokens and output_tokens are counts that reports must keep, while token and accessToken are secrets.
const SECRET_KEY =
  /passw(or)?d|pwd|secret|api[-_]?key|private[-_]?key|access[-_]?key|authorization|cookie|credential|(^|[-_.])token$|[a-z]Token$/i;
const MARK = "[REDACTED]";

export interface Redactor {
  /** Adds a value that must never appear in output (BR-14 registers the password). */
  register(value: string): void;
  /** A redacted deep copy of `value`; the input is never changed. */
  redact(value: unknown): unknown;
}

export function createRedactor(): Redactor {
  // WHY longest first: with "pass" and "pass-word-long" both registered, replacing "pass" first would leave "-word-long" visible.
  let registered: string[] = [];

  const text = (s: string): string => {
    let out = s;
    for (const v of registered) out = out.split(v).join(MARK);
    return redactSecrets(out).redacted;
  };

  function redact(value: unknown): unknown {
    let nodes = 0;
    const ancestors = new WeakSet<object>();

    const walk = (v: unknown, depth: number): unknown => {
      if (typeof v === "string") return text(v);
      if (v === null || typeof v === "number" || typeof v === "boolean" || v === undefined) return v;
      if (typeof v === "bigint" || typeof v === "symbol") return String(v);
      if (typeof v === "function") return "[Function]";
      const obj = v as object;
      if (ancestors.has(obj)) return "[Circular]";
      if (depth >= MAX_DEPTH) return "[MaxDepth]";
      if (++nodes > MAX_NODES) return "[Truncated]";
      if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? "[Invalid Date]" : obj.toISOString();
      if (ArrayBuffer.isView(obj)) return `[Binary ${obj.byteLength} bytes]`;
      if (obj instanceof ArrayBuffer) return `[Binary ${obj.byteLength} bytes]`;
      ancestors.add(obj);
      try {
        return walkContainer(obj, depth);
      } catch {
        // WHY: a throwing getter or Proxy must not take the logger down; the marker tells the reader the value existed.
        return "[Unreadable]";
      } finally {
        ancestors.delete(obj);
      }
    };

    const list = (items: Iterable<unknown>, each: (x: unknown) => unknown): unknown[] => {
      const out: unknown[] = [];
      for (const x of items) {
        // WHY count every entry here: primitives never reach walk()'s counter, so a flat array of numbers would otherwise be unbounded.
        if (++nodes > MAX_NODES) {
          out.push("[Truncated]");
          break;
        }
        out.push(each(x));
      }
      return out;
    };

    const fields = (src: object, keys: string[], depth: number): Record<string, unknown> => {
      // WHY a null-prototype result: a "__proto__" key from parsed JSON becomes a plain key here and cannot touch any prototype.
      const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const k of keys) {
        if (nodes > MAX_NODES) {
          out["[Truncated]"] = true;
          break;
        }
        let val: unknown;
        try {
          val = (src as Record<string, unknown>)[k];
        } catch {
          out[text(k)] = "[Unreadable]";
          continue;
        }
        out[text(k)] = SECRET_KEY.test(k) ? MARK : walk(val, depth + 1);
      }
      return out;
    };

    const walkContainer = (obj: object, depth: number): unknown => {
      if (Array.isArray(obj)) return list(obj, (x) => walk(x, depth + 1));
      if (obj instanceof Set) return list(obj, (x) => walk(x, depth + 1));
      if (obj instanceof Map) {
        return list(obj.entries(), (e) => {
          const [k, val] = e as [unknown, unknown];
          const key = typeof k === "string" ? k : walk(k, depth + 1);
          return [typeof key === "string" ? text(key) : key, typeof k === "string" && SECRET_KEY.test(k) ? MARK : walk(val, depth + 1)];
        });
      }
      if (obj instanceof Error) {
        // WHY no stack: it embeds absolute paths and message copies; name, message and cause are what a report needs.
        const base: Record<string, unknown> = { name: obj.name, message: text(obj.message) };
        if ("cause" in obj) base.cause = walk(obj.cause, depth + 1);
        return Object.assign(fields(obj, Object.keys(obj).filter((k) => k !== "cause"), depth), base);
      }
      return fields(obj, Object.keys(obj), depth);
    };

    return walk(value, 0);
  }

  return {
    register(value: string): void {
      if (value === "") throw new Error("cannot register an empty value for redaction: it would match everywhere");
      if (!registered.includes(value)) registered = [...registered, value].sort((a, b) => b.length - a.length);
    },
    redact,
  };
}

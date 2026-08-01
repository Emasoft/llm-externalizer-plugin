/**
 * Shorthand parser for `--field 'NAME:TYPE=DESCRIPTION'` CLI args.
 *
 * Supported forms (TYPE may carry one or two parenthesised arg blocks):
 *
 *   name:bool                       → {kind:"bool"}
 *   name:string                     → {kind:"string"}
 *   name:string(120)                → {kind:"string", max_length:120}
 *   name:enum(a,b,c)                → {kind:"enum", values:["a","b","c"]}
 *   name:array                      → {kind:"array_string"}
 *   name:array(5)                   → {kind:"array_string", max_items:5}
 *   name:array_enum(a,b)            → {kind:"array_enum", values:["a","b"]}
 *   name:array_enum(a,b)(5)         → {kind:"array_enum", values:["a","b"], max_items:5}
 *   name:int                        → {kind:"int"}
 *   name:int(1-10)                  → {kind:"int", min:1, max:10}
 *   name:int(0-)                    → {kind:"int", min:0}      (open upper)
 *   name:int(-100)                  → {kind:"int", max:100}    (open lower)
 *   name:number(0.0-1.0)            → {kind:"number", min:0, max:1}
 *
 * Description is everything after the FIRST `=`. The CLI shell handles
 * quoting; we treat the entire post-`=` slice as description (no escapes).
 */

import type { FieldDef, FieldType } from "./fieldset";
import { FIELD_NAME_RE } from "./fieldset";

export class ShorthandParseError extends Error {
  constructor(message: string) {
    super(`[shorthand] ${message}`);
    this.name = "ShorthandParseError";
  }
}

/**
 * Parse one `name:type=description` string into a FieldDef. Throws on any
 * malformed form (caller decides whether to abort or skip).
 */
export function parseShorthand(input: string): FieldDef {
  if (typeof input !== "string" || input.length === 0) {
    throw new ShorthandParseError("input must be a non-empty string");
  }
  const eqIdx = input.indexOf("=");
  if (eqIdx < 0) {
    throw new ShorthandParseError(
      `missing "=" — expected "name:type=description" (got ${JSON.stringify(input)})`,
    );
  }
  const head = input.slice(0, eqIdx);
  const description = input.slice(eqIdx + 1);

  const colonIdx = head.indexOf(":");
  if (colonIdx < 0) {
    throw new ShorthandParseError(
      `missing ":" in "${head}" — expected "name:type"`,
    );
  }
  const name = head.slice(0, colonIdx).trim();
  const typeSpec = head.slice(colonIdx + 1).trim();

  if (!FIELD_NAME_RE.test(name)) {
    throw new ShorthandParseError(
      `name "${name}" must match ${FIELD_NAME_RE}`,
    );
  }

  return {
    name,
    type: parseTypeSpec(typeSpec, name),
    description,
  };
}

/** Parse a list of shorthand strings, propagating per-entry parse errors. */
export function parseShorthands(inputs: string[]): FieldDef[] {
  return inputs.map((s) => parseShorthand(s));
}

// ── type-spec parsing ──────────────────────────────────────────────────

interface TypeTokens {
  kind: string;
  args: string[][]; // each arg-block split by ","
}

function tokeniseTypeSpec(spec: string, fieldName: string): TypeTokens {
  // Match leading identifier
  const idMatch = spec.match(/^[a-z][a-z0-9_]*/);
  if (!idMatch) {
    throw new ShorthandParseError(
      `field "${fieldName}": cannot parse type spec "${spec}"`,
    );
  }
  const kind = idMatch[0];
  let rest = spec.slice(kind.length).trim();
  const args: string[][] = [];
  while (rest.length > 0) {
    if (rest[0] !== "(") {
      throw new ShorthandParseError(
        `field "${fieldName}": unexpected "${rest[0]}" after "${kind}" (expected "(" or end)`,
      );
    }
    const close = rest.indexOf(")");
    if (close < 0) {
      throw new ShorthandParseError(
        `field "${fieldName}": unbalanced "(" in "${spec}"`,
      );
    }
    const inner = rest.slice(1, close);
    args.push(inner.split(",").map((s) => s.trim()));
    rest = rest.slice(close + 1).trim();
  }
  return { kind, args };
}

function parseRange(
  arg: string,
  fieldName: string,
  numeric: "int" | "number",
): { min?: number; max?: number } {
  // Forms: "a-b" | "a-" | "-b". Negative sign on a or b is permitted as
  // part of the number (e.g. "-100-100"); we hand-walk the string to find
  // the SEPARATOR dash so we don't confuse it with a leading minus.
  if (!arg.includes("-")) {
    throw new ShorthandParseError(
      `field "${fieldName}": range "${arg}" must contain "-" (e.g. "1-10")`,
    );
  }
  // Split: skip a leading "-" (negative min), find the next "-".
  let sepIdx = -1;
  for (let i = 1; i < arg.length; i++) {
    if (arg[i] === "-") {
      sepIdx = i;
      break;
    }
  }
  // If sepIdx == -1 the entire arg looked like "-100" → that's "max=100".
  let lo: string;
  let hi: string;
  if (sepIdx < 0) {
    lo = "";
    hi = arg.slice(1); // strip the leading "-"
  } else {
    lo = arg.slice(0, sepIdx);
    hi = arg.slice(sepIdx + 1);
  }

  const out: { min?: number; max?: number } = {};
  const isInt = numeric === "int";

  if (lo.length > 0) {
    const n = Number(lo);
    if (!Number.isFinite(n) || (isInt && !Number.isInteger(n))) {
      throw new ShorthandParseError(
        `field "${fieldName}": ${numeric}-range min "${lo}" not a valid ${numeric}`,
      );
    }
    out.min = n;
  }
  if (hi.length > 0) {
    const n = Number(hi);
    if (!Number.isFinite(n) || (isInt && !Number.isInteger(n))) {
      throw new ShorthandParseError(
        `field "${fieldName}": ${numeric}-range max "${hi}" not a valid ${numeric}`,
      );
    }
    out.max = n;
  }
  if (out.min === undefined && out.max === undefined) {
    throw new ShorthandParseError(
      `field "${fieldName}": ${numeric}-range "${arg}" has no bounds`,
    );
  }
  if (out.min !== undefined && out.max !== undefined && out.min > out.max) {
    throw new ShorthandParseError(
      `field "${fieldName}": ${numeric}-range min ${out.min} > max ${out.max}`,
    );
  }
  return out;
}

function parsePositiveInt(
  arg: string,
  fieldName: string,
  label: string,
): number {
  const n = Number(arg);
  if (!Number.isInteger(n) || n < 1) {
    throw new ShorthandParseError(
      `field "${fieldName}": ${label} "${arg}" must be a positive integer`,
    );
  }
  return n;
}

function parseTypeSpec(spec: string, fieldName: string): FieldType {
  const tokens = tokeniseTypeSpec(spec, fieldName);
  switch (tokens.kind) {
    case "bool":
      if (tokens.args.length > 0) {
        throw new ShorthandParseError(
          `field "${fieldName}": bool takes no args (got ${tokens.args.length})`,
        );
      }
      return { kind: "bool" };

    case "string": {
      if (tokens.args.length === 0) return { kind: "string" };
      if (tokens.args.length !== 1 || tokens.args[0].length !== 1) {
        throw new ShorthandParseError(
          `field "${fieldName}": string takes either no args or (max_length)`,
        );
      }
      return {
        kind: "string",
        max_length: parsePositiveInt(tokens.args[0][0], fieldName, "max_length"),
      };
    }

    case "enum": {
      if (tokens.args.length !== 1 || tokens.args[0].length === 0) {
        throw new ShorthandParseError(
          `field "${fieldName}": enum requires (v1,v2,...)`,
        );
      }
      const values = tokens.args[0].filter((v) => v.length > 0);
      if (values.length === 0) {
        throw new ShorthandParseError(
          `field "${fieldName}": enum has no values`,
        );
      }
      return { kind: "enum", values };
    }

    case "array":
    case "array_string": {
      if (tokens.args.length === 0) return { kind: "array_string" };
      if (tokens.args.length !== 1 || tokens.args[0].length !== 1) {
        throw new ShorthandParseError(
          `field "${fieldName}": array takes either no args or (max_items)`,
        );
      }
      return {
        kind: "array_string",
        max_items: parsePositiveInt(tokens.args[0][0], fieldName, "max_items"),
      };
    }

    case "array_enum": {
      if (tokens.args.length < 1 || tokens.args.length > 2) {
        throw new ShorthandParseError(
          `field "${fieldName}": array_enum requires (v1,v2,...)[(max_items)]`,
        );
      }
      const values = tokens.args[0].filter((v) => v.length > 0);
      if (values.length === 0) {
        throw new ShorthandParseError(
          `field "${fieldName}": array_enum has no values`,
        );
      }
      const out: FieldType = { kind: "array_enum", values };
      if (tokens.args.length === 2) {
        if (tokens.args[1].length !== 1) {
          throw new ShorthandParseError(
            `field "${fieldName}": array_enum second arg must be a single max_items value`,
          );
        }
        out.max_items = parsePositiveInt(
          tokens.args[1][0],
          fieldName,
          "max_items",
        );
      }
      return out;
    }

    case "int": {
      if (tokens.args.length === 0) return { kind: "int" };
      if (tokens.args.length !== 1 || tokens.args[0].length !== 1) {
        throw new ShorthandParseError(
          `field "${fieldName}": int takes either no args or (min-max)`,
        );
      }
      return { kind: "int", ...parseRange(tokens.args[0][0], fieldName, "int") };
    }

    case "number": {
      if (tokens.args.length === 0) return { kind: "number" };
      if (tokens.args.length !== 1 || tokens.args[0].length !== 1) {
        throw new ShorthandParseError(
          `field "${fieldName}": number takes either no args or (min-max)`,
        );
      }
      return {
        kind: "number",
        ...parseRange(tokens.args[0][0], fieldName, "number"),
      };
    }

    default:
      throw new ShorthandParseError(
        `field "${fieldName}": unknown type "${tokens.kind}"`,
      );
  }
}

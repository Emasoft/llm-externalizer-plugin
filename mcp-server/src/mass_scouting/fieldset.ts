/**
 * mass-scouting fieldset DSL — types, parser, compiler, repair.
 *
 * The user defines a fieldset as JSON. compileFieldset() turns that JSON into:
 *   • a strict OpenRouter `response_format.json_schema` payload
 *   • a system prompt that names every field and quotes its description
 *   • a user-prompt builder (FILE + CONTENT envelope)
 *   • a validator (catches the rare provider that returns {} after strict)
 *   • a repair function (truncates over-cap strings, snaps enum drift, clamps
 *     numbers, etc. — see blueprint §3.5)
 *
 * No I/O, no external deps. Pure functions so the compiler is trivially
 * testable and the same compiled artefact can be fed both to the MCP tool
 * and to the regex-bypass search path.
 */
import { readFileSync } from "node:fs";

// ── Regexes / size bounds ──────────────────────────────────────────────

/** Field name: snake_case, ≤ 40 chars, JSON-key-safe, starts with a letter. */
export const FIELD_NAME_RE = /^[a-z][a-z0-9_]{0,39}$/;
/** Fieldset name: kebab or snake, ≤ 64 chars. */
export const FIELDSET_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const DESCRIPTION_MIN = 5;
const DESCRIPTION_MAX = 280;
const NOTES_MAX = 1_000;
const FIELDS_MAX = 64;
const ENUM_VALUE_MAX = 60;
const ARRAY_MAX_ITEMS_HARD = 64;
const STRING_MAX_LENGTH_HARD = 4_096;

// ── Types ──────────────────────────────────────────────────────────────

/**
 * Inner field types that are legal as `item_fields` of an `array_object`.
 * Excludes `array_object` itself (no nesting) to keep repair tractable.
 */
export type InnerFieldType =
  | { kind: "bool" }
  | { kind: "string"; max_length?: number }
  | { kind: "enum"; values: string[] }
  | { kind: "array_string"; max_items?: number }
  | { kind: "array_enum"; values: string[]; max_items?: number }
  | { kind: "int"; min?: number; max?: number }
  | { kind: "number"; min?: number; max?: number };

export interface InnerFieldDef {
  name: string;
  description: string;
  type: InnerFieldType;
  required?: boolean;
}

export type FieldType =
  | { kind: "bool" }
  | { kind: "string"; max_length?: number }
  | { kind: "enum"; values: string[] }
  | { kind: "array_string"; max_items?: number }
  | { kind: "array_enum"; values: string[]; max_items?: number }
  | { kind: "int"; min?: number; max?: number }
  | { kind: "number"; min?: number; max?: number }
  /**
   * `array_object` — positional list of records. Unlike `array_enum` /
   * `array_string`, items are NEVER deduped, so positional semantics
   * survive (e.g., one classification per tweet, in input order).
   * Each item is `{<item_field>: value, ...}` typed by `item_fields`.
   * `exact_items: N` forces minItems=maxItems=N (the model is told
   * exactly how many records to return — useful for per-row tasks).
   */
  | {
      kind: "array_object";
      item_fields: InnerFieldDef[];
      min_items?: number;
      max_items?: number;
      exact_items?: number;
    };

export interface FieldDef {
  name: string;
  description: string;
  type: FieldType;
  required?: boolean;
  examples?: unknown[];
}

export interface ScoutFieldset {
  version: 1;
  fieldset_name: string;
  notes?: string;
  fields: FieldDef[];
}

export interface JsonSchemaProperty {
  type: "boolean" | "string" | "integer" | "number" | "array" | "object";
  description?: string;
  enum?: string[];
  items?: JsonSchemaProperty;
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  maxItems?: number;
  minItems?: number;
  // For `type: "object"` items inside an array_object.
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface CompiledJsonSchema {
  name: string;
  strict: true;
  schema: {
    type: "object";
    additionalProperties: false;
    required: string[];
    properties: Record<string, JsonSchemaProperty>;
  };
}

export interface RepairOutcome {
  repaired: Record<string, unknown>;
  repairs: string[];
}

export interface ValidationOutcome {
  ok: boolean;
  reason?: string;
}

export interface CompiledFieldset {
  fieldset: ScoutFieldset;
  jsonSchema: CompiledJsonSchema;
  systemPrompt: string;
  userPromptFor: (basename: string, body: string) => string;
  validate: (parsed: unknown) => ValidationOutcome;
  repair: (parsed: unknown) => RepairOutcome;
}

// ── Parsing ────────────────────────────────────────────────────────────

class FieldsetParseError extends Error {
  constructor(message: string) {
    super(`[fieldset] ${message}`);
    this.name = "FieldsetParseError";
  }
}

const VALID_KINDS = new Set([
  "bool",
  "string",
  "enum",
  "array_string",
  "array_enum",
  "int",
  "number",
  "array_object",
]);

const VALID_INNER_KINDS = new Set([
  "bool",
  "string",
  "enum",
  "array_string",
  "array_enum",
  "int",
  "number",
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseFieldType(raw: unknown, fieldName: string): FieldType {
  if (!isPlainObject(raw)) {
    throw new FieldsetParseError(
      `field "${fieldName}".type must be an object`,
    );
  }
  const kind = raw.kind;
  if (typeof kind !== "string" || !VALID_KINDS.has(kind)) {
    throw new FieldsetParseError(
      `field "${fieldName}".type.kind must be one of ${[...VALID_KINDS].join(", ")} (got ${JSON.stringify(kind)})`,
    );
  }

  switch (kind) {
    case "bool":
      return { kind };

    case "string": {
      const out: FieldType = { kind };
      if (raw.max_length !== undefined) {
        if (
          typeof raw.max_length !== "number" ||
          !Number.isInteger(raw.max_length) ||
          raw.max_length < 1 ||
          raw.max_length > STRING_MAX_LENGTH_HARD
        ) {
          throw new FieldsetParseError(
            `field "${fieldName}".type.max_length must be an integer 1..${STRING_MAX_LENGTH_HARD}`,
          );
        }
        out.max_length = raw.max_length;
      }
      return out;
    }

    case "enum": {
      const values = raw.values;
      if (!Array.isArray(values) || values.length === 0) {
        throw new FieldsetParseError(
          `field "${fieldName}".type.values must be a non-empty array`,
        );
      }
      const seen = new Set<string>();
      for (const v of values) {
        if (typeof v !== "string" || v.length === 0 || v.length > ENUM_VALUE_MAX) {
          throw new FieldsetParseError(
            `field "${fieldName}".type.values entries must be 1..${ENUM_VALUE_MAX}-char strings`,
          );
        }
        if (seen.has(v)) {
          throw new FieldsetParseError(
            `field "${fieldName}".type.values has duplicate "${v}"`,
          );
        }
        seen.add(v);
      }
      return { kind, values: [...values] as string[] };
    }

    case "array_string": {
      const out: FieldType = { kind };
      if (raw.max_items !== undefined) {
        if (
          typeof raw.max_items !== "number" ||
          !Number.isInteger(raw.max_items) ||
          raw.max_items < 1 ||
          raw.max_items > ARRAY_MAX_ITEMS_HARD
        ) {
          throw new FieldsetParseError(
            `field "${fieldName}".type.max_items must be an integer 1..${ARRAY_MAX_ITEMS_HARD}`,
          );
        }
        out.max_items = raw.max_items;
      }
      return out;
    }

    case "array_enum": {
      const values = raw.values;
      if (!Array.isArray(values) || values.length === 0) {
        throw new FieldsetParseError(
          `field "${fieldName}".type.values must be a non-empty array`,
        );
      }
      const seen = new Set<string>();
      for (const v of values) {
        if (typeof v !== "string" || v.length === 0 || v.length > ENUM_VALUE_MAX) {
          throw new FieldsetParseError(
            `field "${fieldName}".type.values entries must be 1..${ENUM_VALUE_MAX}-char strings`,
          );
        }
        if (seen.has(v)) {
          throw new FieldsetParseError(
            `field "${fieldName}".type.values has duplicate "${v}"`,
          );
        }
        seen.add(v);
      }
      const out: FieldType = { kind, values: [...values] as string[] };
      if (raw.max_items !== undefined) {
        if (
          typeof raw.max_items !== "number" ||
          !Number.isInteger(raw.max_items) ||
          raw.max_items < 1 ||
          raw.max_items > ARRAY_MAX_ITEMS_HARD
        ) {
          throw new FieldsetParseError(
            `field "${fieldName}".type.max_items must be an integer 1..${ARRAY_MAX_ITEMS_HARD}`,
          );
        }
        out.max_items = raw.max_items;
      }
      return out;
    }

    case "int": {
      const out: FieldType = { kind };
      if (raw.min !== undefined) {
        if (typeof raw.min !== "number" || !Number.isInteger(raw.min)) {
          throw new FieldsetParseError(
            `field "${fieldName}".type.min must be an integer`,
          );
        }
        out.min = raw.min;
      }
      if (raw.max !== undefined) {
        if (typeof raw.max !== "number" || !Number.isInteger(raw.max)) {
          throw new FieldsetParseError(
            `field "${fieldName}".type.max must be an integer`,
          );
        }
        out.max = raw.max;
      }
      if (out.min !== undefined && out.max !== undefined && out.min > out.max) {
        throw new FieldsetParseError(
          `field "${fieldName}".type.min (${out.min}) > max (${out.max})`,
        );
      }
      return out;
    }

    case "number": {
      const out: FieldType = { kind };
      if (raw.min !== undefined) {
        if (typeof raw.min !== "number" || !Number.isFinite(raw.min)) {
          throw new FieldsetParseError(
            `field "${fieldName}".type.min must be a finite number`,
          );
        }
        out.min = raw.min;
      }
      if (raw.max !== undefined) {
        if (typeof raw.max !== "number" || !Number.isFinite(raw.max)) {
          throw new FieldsetParseError(
            `field "${fieldName}".type.max must be a finite number`,
          );
        }
        out.max = raw.max;
      }
      if (out.min !== undefined && out.max !== undefined && out.min > out.max) {
        throw new FieldsetParseError(
          `field "${fieldName}".type.min (${out.min}) > max (${out.max})`,
        );
      }
      return out;
    }

    case "array_object": {
      const itemFieldsRaw = raw.item_fields;
      if (!Array.isArray(itemFieldsRaw) || itemFieldsRaw.length === 0) {
        throw new FieldsetParseError(
          `field "${fieldName}".type.item_fields must be a non-empty array of inner-field defs`,
        );
      }
      const seen = new Set<string>();
      const itemFields: InnerFieldDef[] = [];
      for (let i = 0; i < itemFieldsRaw.length; i++) {
        const f = itemFieldsRaw[i];
        if (!isPlainObject(f)) {
          throw new FieldsetParseError(
            `field "${fieldName}".type.item_fields[${i}] must be an object`,
          );
        }
        const subName = f.name;
        if (typeof subName !== "string" || !FIELD_NAME_RE.test(subName)) {
          throw new FieldsetParseError(
            `field "${fieldName}".type.item_fields[${i}].name must match ${FIELD_NAME_RE}`,
          );
        }
        if (seen.has(subName)) {
          throw new FieldsetParseError(
            `field "${fieldName}".type.item_fields has duplicate name "${subName}"`,
          );
        }
        seen.add(subName);
        if (typeof f.description !== "string") {
          throw new FieldsetParseError(
            `field "${fieldName}".type.item_fields[${i}].description must be a string`,
          );
        }
        const innerType = parseFieldType(f.type, `${fieldName}.${subName}`);
        if (!VALID_INNER_KINDS.has(innerType.kind)) {
          throw new FieldsetParseError(
            `field "${fieldName}".type.item_fields[${i}] cannot be array_object (no nesting)`,
          );
        }
        itemFields.push({
          name: subName,
          description: f.description,
          type: innerType as InnerFieldType,
          required: f.required !== false,
        });
      }
      const out: FieldType = { kind, item_fields: itemFields };
      const intRange = (k: "min_items" | "max_items" | "exact_items"): void => {
        const v = raw[k];
        if (v === undefined) return;
        if (
          typeof v !== "number" ||
          !Number.isInteger(v) ||
          v < 0 ||
          v > ARRAY_MAX_ITEMS_HARD
        ) {
          throw new FieldsetParseError(
            `field "${fieldName}".type.${k} must be an integer 0..${ARRAY_MAX_ITEMS_HARD}`,
          );
        }
        out[k] = v;
      };
      intRange("min_items");
      intRange("max_items");
      intRange("exact_items");
      if (
        out.min_items !== undefined &&
        out.max_items !== undefined &&
        out.min_items > out.max_items
      ) {
        throw new FieldsetParseError(
          `field "${fieldName}".type.min_items > max_items`,
        );
      }
      if (out.exact_items !== undefined && (out.min_items !== undefined || out.max_items !== undefined)) {
        throw new FieldsetParseError(
          `field "${fieldName}".type.exact_items is mutually exclusive with min_items/max_items`,
        );
      }
      return out;
    }

    default:
      // Unreachable: VALID_KINDS guards entry. Keeps the compiler honest about
      // exhaustiveness so future kinds can't slip through.
      throw new FieldsetParseError(
        `field "${fieldName}".type.kind unhandled: ${kind}`,
      );
  }
}

function parseFieldDef(raw: unknown, idx: number): FieldDef {
  if (!isPlainObject(raw)) {
    throw new FieldsetParseError(`fields[${idx}] must be an object`);
  }
  const name = raw.name;
  if (typeof name !== "string" || !FIELD_NAME_RE.test(name)) {
    throw new FieldsetParseError(
      `fields[${idx}].name must match ${FIELD_NAME_RE} (got ${JSON.stringify(name)})`,
    );
  }
  const description = raw.description;
  if (
    typeof description !== "string" ||
    description.length < DESCRIPTION_MIN ||
    description.length > DESCRIPTION_MAX
  ) {
    throw new FieldsetParseError(
      `fields[${idx}].description must be a string of ${DESCRIPTION_MIN}..${DESCRIPTION_MAX} chars`,
    );
  }
  const type = parseFieldType(raw.type, name);
  const out: FieldDef = { name, description, type };
  if (raw.required !== undefined) {
    if (typeof raw.required !== "boolean") {
      throw new FieldsetParseError(
        `fields[${idx}].required must be a boolean`,
      );
    }
    out.required = raw.required;
  }
  if (raw.examples !== undefined) {
    if (!Array.isArray(raw.examples)) {
      throw new FieldsetParseError(
        `fields[${idx}].examples must be an array`,
      );
    }
    out.examples = [...raw.examples];
  }
  return out;
}

/**
 * Validate a parsed JSON object as a ScoutFieldset. Throws FieldsetParseError
 * on any structural problem with a clear, single-line reason.
 */
export function parseFieldset(input: unknown): ScoutFieldset {
  if (!isPlainObject(input)) {
    throw new FieldsetParseError("root must be a JSON object");
  }
  if (input.version !== 1) {
    throw new FieldsetParseError(
      `version must be 1 (got ${JSON.stringify(input.version)})`,
    );
  }
  const fsName = input.fieldset_name;
  if (typeof fsName !== "string" || !FIELDSET_NAME_RE.test(fsName)) {
    throw new FieldsetParseError(
      `fieldset_name must match ${FIELDSET_NAME_RE} (got ${JSON.stringify(fsName)})`,
    );
  }
  if (input.notes !== undefined) {
    if (typeof input.notes !== "string" || input.notes.length > NOTES_MAX) {
      throw new FieldsetParseError(
        `notes must be a string ≤ ${NOTES_MAX} chars`,
      );
    }
  }
  const rawFields = input.fields;
  if (!Array.isArray(rawFields) || rawFields.length === 0) {
    throw new FieldsetParseError("fields must be a non-empty array");
  }
  if (rawFields.length > FIELDS_MAX) {
    throw new FieldsetParseError(
      `fields length ${rawFields.length} exceeds limit ${FIELDS_MAX}`,
    );
  }
  const fields: FieldDef[] = [];
  const seenNames = new Set<string>();
  for (let i = 0; i < rawFields.length; i++) {
    const f = parseFieldDef(rawFields[i], i);
    if (seenNames.has(f.name)) {
      throw new FieldsetParseError(`duplicate field name "${f.name}"`);
    }
    seenNames.add(f.name);
    fields.push(f);
  }
  const out: ScoutFieldset = { version: 1, fieldset_name: fsName, fields };
  if (typeof input.notes === "string") out.notes = input.notes;
  return out;
}

/** Read JSON file, then parseFieldset(). Single-pass: file is read once. */
export function loadFieldsetFromFile(path: string): ScoutFieldset {
  const raw = readFileSync(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new FieldsetParseError(`${path}: not valid JSON — ${msg}`);
  }
  return parseFieldset(parsed);
}

// ── Compiler ───────────────────────────────────────────────────────────

function fieldTypeToJsonSchemaProp(
  t: FieldType,
  description: string,
): JsonSchemaProperty {
  switch (t.kind) {
    case "bool":
      return { type: "boolean", description };
    case "string": {
      const p: JsonSchemaProperty = { type: "string", description };
      if (t.max_length !== undefined) p.maxLength = t.max_length;
      return p;
    }
    case "enum":
      return { type: "string", description, enum: [...t.values] };
    case "array_string": {
      const p: JsonSchemaProperty = {
        type: "array",
        description,
        items: { type: "string" },
      };
      if (t.max_items !== undefined) p.maxItems = t.max_items;
      return p;
    }
    case "array_enum": {
      const p: JsonSchemaProperty = {
        type: "array",
        description,
        items: { type: "string", enum: [...t.values] },
      };
      if (t.max_items !== undefined) p.maxItems = t.max_items;
      return p;
    }
    case "int": {
      const p: JsonSchemaProperty = { type: "integer", description };
      if (t.min !== undefined) p.minimum = t.min;
      if (t.max !== undefined) p.maximum = t.max;
      return p;
    }
    case "number": {
      const p: JsonSchemaProperty = { type: "number", description };
      if (t.min !== undefined) p.minimum = t.min;
      if (t.max !== undefined) p.maximum = t.max;
      return p;
    }
    case "array_object": {
      const properties: Record<string, JsonSchemaProperty> = {};
      const required: string[] = [];
      for (const f of t.item_fields) {
        properties[f.name] = fieldTypeToJsonSchemaProp(
          f.type as FieldType,
          f.description,
        );
        if (f.required !== false) required.push(f.name);
      }
      const item: JsonSchemaProperty = {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      };
      const p: JsonSchemaProperty = {
        type: "array",
        description,
        items: item,
      };
      const exact = t.exact_items;
      if (exact !== undefined) {
        p.minItems = exact;
        p.maxItems = exact;
      } else {
        if (t.min_items !== undefined) p.minItems = t.min_items;
        if (t.max_items !== undefined) p.maxItems = t.max_items;
      }
      return p;
    }
  }
}

function renderTypeForPrompt(t: FieldType): string {
  switch (t.kind) {
    case "bool":
      return "boolean";
    case "string":
      return t.max_length ? `string ≤ ${t.max_length} chars` : "string";
    case "enum":
      return `one of: ${t.values.map((v) => JSON.stringify(v)).join(", ")}`;
    case "array_string":
      return t.max_items
        ? `array of strings, max ${t.max_items} items`
        : "array of strings";
    case "array_enum":
      return t.max_items
        ? `array of strings (each one of: ${t.values.map((v) => JSON.stringify(v)).join(", ")}), max ${t.max_items} items`
        : `array of strings (each one of: ${t.values.map((v) => JSON.stringify(v)).join(", ")})`;
    case "int": {
      const range =
        t.min !== undefined && t.max !== undefined
          ? ` in [${t.min}, ${t.max}]`
          : t.min !== undefined
            ? ` ≥ ${t.min}`
            : t.max !== undefined
              ? ` ≤ ${t.max}`
              : "";
      return `integer${range}`;
    }
    case "number": {
      const range =
        t.min !== undefined && t.max !== undefined
          ? ` in [${t.min}, ${t.max}]`
          : t.min !== undefined
            ? ` ≥ ${t.min}`
            : t.max !== undefined
              ? ` ≤ ${t.max}`
              : "";
      return `number${range}`;
    }
    case "array_object": {
      const sub = t.item_fields
        .map((f) => `${f.name}:${renderTypeForPrompt(f.type as FieldType)}`)
        .join(", ");
      const lengthHint =
        t.exact_items !== undefined
          ? `, EXACTLY ${t.exact_items} items`
          : t.min_items !== undefined && t.max_items !== undefined
            ? `, ${t.min_items}..${t.max_items} items`
            : t.max_items !== undefined
              ? `, max ${t.max_items} items`
              : t.min_items !== undefined
                ? `, min ${t.min_items} items`
                : "";
      return `array of objects {${sub}}${lengthHint} — POSITIONAL (no dedup, original order preserved)`;
    }
  }
}

function renderSystemPrompt(fs: ScoutFieldset): string {
  const lines: string[] = [];
  lines.push(
    "You inspect a single file and extract structured information.",
    "",
    "For the file body provided after FILE:, return a JSON object that EXACTLY",
    "matches the schema below. Do not include any other keys. Do not omit",
    "required keys. Output JSON only — no prose, no markdown fences.",
    "",
  );
  if (fs.notes && fs.notes.trim().length > 0) {
    lines.push("NOTES (from the user):", fs.notes.trim(), "");
  }
  lines.push("FIELDS TO EXTRACT:");
  for (const f of fs.fields) {
    lines.push(`- "${f.name}" (${renderTypeForPrompt(f.type)}): ${f.description}`);
    if (f.examples && f.examples.length > 0) {
      const ex = f.examples
        .slice(0, 2)
        .map((e) => JSON.stringify(e))
        .join(", ");
      lines.push(`    examples: ${ex}`);
    }
  }
  lines.push(
    "",
    "If a field describes a property the file does not exhibit:",
    "- bool fields: emit `false`.",
    "- string fields: emit \"\" (empty string).",
    "- array fields: emit [].",
    "- enum fields: pick the listed value that best represents 'absent/none';",
    "  if none exists, pick the most defensible value and lean conservative.",
    "- int/number fields: emit the lowest legal value in range.",
    "",
    "Never invent facts. Read only the provided FILE body.",
  );
  return lines.join("\n");
}

/**
 * Build the user-role message for a single file. The body is sent verbatim
 * (no excerpt) — caller is responsible for the size cap before invoking.
 */
function userPromptFor(basename: string, body: string): string {
  return `FILE: ${basename}\n\nCONTENT:\n${body}`;
}

function jsonSchemaName(fsName: string): string {
  // Preserves snake_case names; replaces hyphens with underscores so the
  // result is a JSON-Schema-friendly identifier on every provider.
  return `mass_scout_${fsName.replace(/-/g, "_")}`;
}

function makeRequiredKeysValidator(
  required: string[],
): (parsed: unknown) => ValidationOutcome {
  return (parsed) => {
    if (!isPlainObject(parsed)) {
      const got = parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed;
      return { ok: false, reason: `expected object, got ${got}` };
    }
    const missing = required.filter((k) => !(k in parsed));
    if (missing.length > 0) {
      return { ok: false, reason: `missing required keys: ${missing.join(", ")}` };
    }
    return { ok: true };
  };
}

// ── Repair (blueprint §3.5 + dynamic-field generalisation) ─────────────

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function defaultForType(t: FieldType): unknown {
  switch (t.kind) {
    case "bool":
      return false;
    case "string":
      return "";
    case "enum":
      return t.values[0];
    case "array_string":
    case "array_enum":
      return [];
    case "int":
    case "number": {
      // Prefer the lower bound (or 0 if unbounded below); but never exceed
      // the upper bound — otherwise a fieldset with only a negative `max`
      // would default outside its own schema range.
      let def = t.min ?? 0;
      if (t.max !== undefined && def > t.max) def = t.max;
      return def;
    }
    case "array_object":
      return [];
  }
}

function coerceBool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["true", "yes", "1", "y"].includes(s)) return true;
    if (["false", "no", "0", "n", ""].includes(s)) return false;
  }
  return undefined;
}

function truncateAtBoundary(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  const cut = s.slice(0, maxLen);
  const wsIdx = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf("\n"));
  return wsIdx > maxLen / 2 ? cut.slice(0, wsIdx) : cut;
}

function snapToEnum(v: string, values: string[]): string | undefined {
  if (values.includes(v)) return v;
  // Case-insensitive match
  const lc = v.toLowerCase();
  for (const cand of values) {
    if (cand.toLowerCase() === lc) return cand;
  }
  // Levenshtein ≤ 2 for tokens of length ≥ 4 (per blueprint §3.10 caveat)
  if (lc.length < 4) return undefined;
  let best: { val: string; d: number } | null = null;
  for (const cand of values) {
    if (cand.length < 4) continue;
    const d = levenshtein(lc, cand.toLowerCase());
    if (d <= 2 && (!best || d < best.d)) best = { val: cand, d };
  }
  return best?.val;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

function repairOneField(
  raw: unknown,
  f: FieldDef,
  repairs: string[],
): unknown {
  const t = f.type;
  switch (t.kind) {
    case "bool": {
      const c = coerceBool(raw);
      if (c === undefined) {
        repairs.push(`${f.name}: not bool-coercible (${typeof raw}) — defaulting to false`);
        return false;
      }
      if (typeof raw !== "boolean") {
        repairs.push(`${f.name}: coerced ${JSON.stringify(raw)} → ${c}`);
      }
      return c;
    }
    case "string": {
      let s: string;
      if (typeof raw === "string") s = raw;
      else if (raw == null) {
        repairs.push(`${f.name}: null/undefined → ""`);
        return "";
      } else {
        s = String(raw);
        repairs.push(`${f.name}: coerced ${typeof raw} → string`);
      }
      if (t.max_length !== undefined && s.length > t.max_length) {
        const trimmed = truncateAtBoundary(s, t.max_length);
        repairs.push(`${f.name}: truncated ${s.length} → ${trimmed.length} chars`);
        return trimmed;
      }
      return s;
    }
    case "enum": {
      if (typeof raw !== "string") {
        repairs.push(`${f.name}: not a string — using "${t.values[0]}"`);
        return t.values[0];
      }
      const snapped = snapToEnum(raw, t.values);
      if (snapped === undefined) {
        repairs.push(
          `${f.name}: ${JSON.stringify(raw)} not in enum — using "${t.values[0]}"`,
        );
        return t.values[0];
      }
      if (snapped !== raw) {
        repairs.push(`${f.name}: snapped ${JSON.stringify(raw)} → "${snapped}"`);
      }
      return snapped;
    }
    case "array_string": {
      if (!Array.isArray(raw)) {
        repairs.push(`${f.name}: not an array — using []`);
        return [];
      }
      const out: string[] = [];
      for (const item of raw) {
        if (typeof item === "string") out.push(item);
        else {
          repairs.push(`${f.name}: dropped non-string item`);
        }
      }
      const seen = new Set<string>();
      const deduped = out.filter((x) => (seen.has(x) ? false : seen.add(x) && true));
      if (deduped.length !== out.length) {
        repairs.push(`${f.name}: removed ${out.length - deduped.length} duplicate(s)`);
      }
      if (t.max_items !== undefined && deduped.length > t.max_items) {
        const trimmed = deduped.slice(0, t.max_items);
        repairs.push(
          `${f.name}: trimmed array ${deduped.length} → ${trimmed.length} items`,
        );
        return trimmed;
      }
      return deduped;
    }
    case "array_enum": {
      if (!Array.isArray(raw)) {
        repairs.push(`${f.name}: not an array — using []`);
        return [];
      }
      const out: string[] = [];
      for (const item of raw) {
        if (typeof item !== "string") {
          repairs.push(`${f.name}: dropped non-string item`);
          continue;
        }
        const snapped = snapToEnum(item, t.values);
        if (snapped === undefined) {
          repairs.push(`${f.name}: dropped ${JSON.stringify(item)} (not in enum)`);
          continue;
        }
        if (snapped !== item) {
          repairs.push(
            `${f.name}: snapped ${JSON.stringify(item)} → "${snapped}"`,
          );
        }
        out.push(snapped);
      }
      const seen = new Set<string>();
      const deduped = out.filter((x) => (seen.has(x) ? false : seen.add(x) && true));
      if (deduped.length !== out.length) {
        repairs.push(`${f.name}: removed ${out.length - deduped.length} duplicate(s)`);
      }
      if (t.max_items !== undefined && deduped.length > t.max_items) {
        const trimmed = deduped.slice(0, t.max_items);
        repairs.push(
          `${f.name}: trimmed array ${deduped.length} → ${trimmed.length} items`,
        );
        return trimmed;
      }
      return deduped;
    }
    case "int": {
      let n: number;
      if (Number.isInteger(raw as number)) {
        n = raw as number;
      } else if (isFiniteNumber(raw)) {
        n = Math.round(raw);
        repairs.push(`${f.name}: rounded ${raw} → ${n}`);
      } else if (typeof raw === "string" && /^-?\d+(\.\d+)?$/.test(raw.trim())) {
        n = Math.round(Number(raw));
        repairs.push(`${f.name}: parsed string ${JSON.stringify(raw)} → ${n}`);
      } else {
        // Use defaultForType so the default also respects an upper bound when
        // `min` is undefined and `max` is negative — otherwise we'd return 0
        // and break the schema's own constraints.
        const def = defaultForType(t) as number;
        repairs.push(`${f.name}: not a number (${typeof raw}) — defaulting to ${def}`);
        return def;
      }
      if (t.min !== undefined && n < t.min) {
        repairs.push(`${f.name}: clamped ${n} → ${t.min}`);
        n = t.min;
      }
      if (t.max !== undefined && n > t.max) {
        repairs.push(`${f.name}: clamped ${n} → ${t.max}`);
        n = t.max;
      }
      return n;
    }
    case "number": {
      let n: number;
      if (isFiniteNumber(raw)) {
        n = raw;
      } else if (typeof raw === "string" && /^-?\d+(\.\d+)?$/.test(raw.trim())) {
        n = Number(raw);
        repairs.push(`${f.name}: parsed string ${JSON.stringify(raw)} → ${n}`);
      } else {
        // Use defaultForType so the default also respects an upper bound when
        // `min` is undefined and `max` is negative — otherwise we'd return 0
        // and break the schema's own constraints.
        const def = defaultForType(t) as number;
        repairs.push(`${f.name}: not a number (${typeof raw}) — defaulting to ${def}`);
        return def;
      }
      if (t.min !== undefined && n < t.min) {
        repairs.push(`${f.name}: clamped ${n} → ${t.min}`);
        n = t.min;
      }
      if (t.max !== undefined && n > t.max) {
        repairs.push(`${f.name}: clamped ${n} → ${t.max}`);
        n = t.max;
      }
      return n;
    }
    case "array_object": {
      // Positional: items keep their original index. NEVER deduped — the
      // whole point of this kind. Per-item: each subfield gets the same
      // repair logic as a top-level field.
      if (!Array.isArray(raw)) {
        repairs.push(`${f.name}: not an array — using []`);
        return [];
      }
      const innerSubfields = t.item_fields.map((sf) => ({
        name: sf.name,
        description: sf.description,
        type: sf.type as FieldType,
        required: sf.required !== false,
      }));
      const items: Record<string, unknown>[] = [];
      for (let i = 0; i < raw.length; i++) {
        const itemRaw = raw[i];
        const obj: Record<string, unknown> = isPlainObject(itemRaw) ? itemRaw : {};
        if (!isPlainObject(itemRaw)) {
          repairs.push(`${f.name}[${i}]: not an object — using {}`);
        }
        const repairedItem: Record<string, unknown> = {};
        for (const sf of innerSubfields) {
          if (!(sf.name in obj)) {
            if (sf.required) {
              const def = defaultForType(sf.type);
              repairs.push(
                `${f.name}[${i}].${sf.name}: missing — defaulting to ${JSON.stringify(def)}`,
              );
              repairedItem[sf.name] = def;
            }
            continue;
          }
          repairedItem[sf.name] = repairOneField(obj[sf.name], sf, repairs);
        }
        items.push(repairedItem);
      }
      // Length enforcement (NO dedup — order matters).
      const exact = t.exact_items;
      if (exact !== undefined) {
        if (items.length > exact) {
          repairs.push(`${f.name}: trimmed ${items.length} → ${exact} items`);
          items.length = exact;
        } else if (items.length < exact) {
          const padCount = exact - items.length;
          for (let i = 0; i < padCount; i++) {
            const padItem: Record<string, unknown> = {};
            for (const sf of innerSubfields) {
              if (sf.required) padItem[sf.name] = defaultForType(sf.type);
            }
            items.push(padItem);
          }
          repairs.push(`${f.name}: padded ${items.length - padCount} → ${exact} with default items`);
        }
      } else {
        if (t.min_items !== undefined && items.length < t.min_items) {
          // Pad with default items so the compiled `minItems` schema bound
          // is satisfied. Mirrors the `exact_items` padding above.
          const padCount = t.min_items - items.length;
          for (let i = 0; i < padCount; i++) {
            const padItem: Record<string, unknown> = {};
            for (const sf of innerSubfields) {
              if (sf.required) padItem[sf.name] = defaultForType(sf.type);
            }
            items.push(padItem);
          }
          repairs.push(
            `${f.name}: padded ${items.length - padCount} → ${t.min_items} with default items`,
          );
        }
        if (t.max_items !== undefined && items.length > t.max_items) {
          repairs.push(
            `${f.name}: trimmed ${items.length} → ${t.max_items} items`,
          );
          items.length = t.max_items;
        }
      }
      return items;
    }
  }
}

function makeRepair(
  fs: ScoutFieldset,
): (parsed: unknown) => RepairOutcome {
  return (parsed) => {
    const repairs: string[] = [];
    const repaired: Record<string, unknown> = {};
    const obj: Record<string, unknown> = isPlainObject(parsed) ? parsed : {};
    if (!isPlainObject(parsed)) {
      const got = parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed;
      repairs.push(`top-level not an object (${got}) — treating as empty`);
    }
    // Detect extra keys not in the fieldset and drop them (additionalProperties: false).
    const allowed = new Set(fs.fields.map((f) => f.name));
    for (const k of Object.keys(obj)) {
      if (!allowed.has(k)) {
        repairs.push(`dropped unknown key "${k}"`);
      }
    }
    for (const f of fs.fields) {
      const required = f.required !== false;
      if (!(f.name in obj)) {
        if (required) {
          const def = defaultForType(f.type);
          repairs.push(`${f.name}: missing — defaulting to ${JSON.stringify(def)}`);
          repaired[f.name] = def;
        }
        continue;
      }
      repaired[f.name] = repairOneField(obj[f.name], f, repairs);
    }
    return { repaired, repairs };
  };
}

/**
 * Compile a ScoutFieldset into the artefacts the scout phase consumes.
 * Pure: same fieldset → identical output every call.
 */
export function compileFieldset(fs: ScoutFieldset): CompiledFieldset {
  const properties: Record<string, JsonSchemaProperty> = {};
  const required: string[] = [];
  for (const f of fs.fields) {
    properties[f.name] = fieldTypeToJsonSchemaProp(f.type, f.description);
    if (f.required !== false) required.push(f.name);
  }
  const jsonSchema: CompiledJsonSchema = {
    name: jsonSchemaName(fs.fieldset_name),
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required,
      properties,
    },
  };
  return {
    fieldset: fs,
    jsonSchema,
    systemPrompt: renderSystemPrompt(fs),
    userPromptFor,
    validate: makeRequiredKeysValidator(required),
    repair: makeRepair(fs),
  };
}

export { FieldsetParseError };

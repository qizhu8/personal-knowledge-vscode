import { createHash } from "crypto";
import { canonicalJson } from "../workflow-contracts";

export const WORKFLOW_VALUE_TYPES = ["object", "array", "string", "boolean", "int64", "decimal", "null", "artifact", "secret-handle"] as const;
export type WorkflowValueType = typeof WORKFLOW_VALUE_TYPES[number];

export interface WorkflowPortDescriptor {
  type: WorkflowValueType;
  required: boolean;
  nullable: boolean;
  schema: WorkflowValueSchema;
  default?: unknown;
}

export type WorkflowValueSchema =
  | Record<string, never>
  | { properties: Record<string, WorkflowPortDescriptor> }
  | { items: WorkflowPortDescriptor; minItems?: number; maxItems?: number };

export interface ArtifactReference {
  evidenceId: string;
  digest: string;
}

export interface SecretHandle {
  secretId: string;
  versionId: string;
}

export class WorkflowValueError extends Error {
  constructor(readonly code: string, readonly pointer: string, message: string) {
    super(message);
    this.name = "WorkflowValueError";
  }
}

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;
const INT64 = /^(0|-[1-9][0-9]*|[1-9][0-9]*)$/;
const DECIMAL = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const INT64_MIN = -9223372036854775808n;
const INT64_MAX = 9223372036854775807n;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[], pointer: string): void {
  const unknown = Object.keys(value).find(key => !allowed.includes(key));
  if (unknown) throw new WorkflowValueError("unknown-field", `${pointer}/${unknown}`, `Unknown field ${unknown}.`);
}

function normalizeText(value: unknown, pointer: string): string {
  if (typeof value !== "string") throw new WorkflowValueError("type", pointer, "Expected string.");
  const normalized = value.normalize("NFC");
  if (/([\uD800-\uDBFF](?![\uDC00-\uDFFF]))|((?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/.test(normalized)) {
    throw new WorkflowValueError("unicode", pointer, "Lone Unicode surrogate.");
  }
  return normalized;
}

export function normalizeInt64(value: unknown, pointer = ""): string {
  if (typeof value !== "string" || !INT64.test(value)) throw new WorkflowValueError("int64-lexical", pointer, "Invalid int64 lexical form.");
  const parsed = BigInt(value);
  if (parsed < INT64_MIN || parsed > INT64_MAX) throw new WorkflowValueError("int64-range", pointer, "int64 is outside the signed 64-bit range.");
  return value;
}

export function normalizeDecimal(value: unknown, pointer = ""): string {
  if (typeof value !== "string" || !DECIMAL.test(value)) throw new WorkflowValueError("decimal-lexical", pointer, "Invalid decimal lexical form.");
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [integer, fraction = ""] = unsigned.split(".");
  const trimmed = fraction.replace(/0+$/, "");
  const normalized = trimmed ? `${integer}.${trimmed}` : integer;
  return /^0(?:\.0*)?$/.test(normalized) ? "0" : negative ? `-${normalized}` : normalized;
}

export function normalizePortDescriptor(value: unknown, pointer = ""): WorkflowPortDescriptor {
  if (!isRecord(value)) throw new WorkflowValueError("type", pointer, "Expected port descriptor.");
  assertKeys(value, ["type", "required", "nullable", "schema", "default"], pointer);
  if (!WORKFLOW_VALUE_TYPES.includes(value.type as WorkflowValueType)) throw new WorkflowValueError("value-type", `${pointer}/type`, "Unknown workflow value type.");
  if (typeof value.required !== "boolean") throw new WorkflowValueError("type", `${pointer}/required`, "Expected boolean.");
  if (typeof value.nullable !== "boolean") throw new WorkflowValueError("type", `${pointer}/nullable`, "Expected boolean.");
  if (!isRecord(value.schema)) throw new WorkflowValueError("type", `${pointer}/schema`, "Expected schema object.");
  const type = value.type as WorkflowValueType;
  const schema = normalizeValueSchema(type, value.schema, `${pointer}/schema`);
  const descriptor: WorkflowPortDescriptor = { type, required: value.required, nullable: value.nullable, schema };
  if (Object.prototype.hasOwnProperty.call(value, "default")) descriptor.default = normalizeTypedValue(descriptor, value.default, `${pointer}/default`);
  return descriptor;
}

function normalizeValueSchema(type: WorkflowValueType, value: Record<string, unknown>, pointer: string): WorkflowValueSchema {
  if (type === "object") {
    assertKeys(value, ["properties"], pointer);
    if (!isRecord(value.properties)) throw new WorkflowValueError("type", `${pointer}/properties`, "Expected property map.");
    const properties: Record<string, WorkflowPortDescriptor> = {};
    for (const key of Object.keys(value.properties).sort()) {
      const normalizedKey = normalizeText(key, `${pointer}/properties`);
      if (!IDENTIFIER.test(normalizedKey)) throw new WorkflowValueError("identifier", `${pointer}/properties/${key}`, "Invalid property identifier.");
      properties[normalizedKey] = normalizePortDescriptor(value.properties[key], `${pointer}/properties/${key}`);
    }
    return { properties };
  }
  if (type === "array") {
    assertKeys(value, ["items", "minItems", "maxItems"], pointer);
    const items = normalizePortDescriptor(value.items, `${pointer}/items`);
    const minItems = normalizeBound(value.minItems, `${pointer}/minItems`);
    const maxItems = normalizeBound(value.maxItems, `${pointer}/maxItems`);
    if (minItems !== undefined && maxItems !== undefined && minItems > maxItems) throw new WorkflowValueError("array-bounds", pointer, "minItems exceeds maxItems.");
    return { items, ...(minItems === undefined ? {} : { minItems }), ...(maxItems === undefined ? {} : { maxItems }) };
  }
  if (Object.keys(value).length) throw new WorkflowValueError("scalar-schema", pointer, "Scalar schema must be empty.");
  return {};
}

function normalizeBound(value: unknown, pointer: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new WorkflowValueError("array-bound", pointer, "Expected a non-negative safe integer.");
  return value as number;
}

export function normalizeTypedValue(descriptor: WorkflowPortDescriptor, value: unknown, pointer = ""): unknown {
  if (value === null) {
    if (descriptor.type !== "null" && !descriptor.nullable) throw new WorkflowValueError("null", pointer, "Null is not allowed.");
    return null;
  }
  switch (descriptor.type) {
    case "null": throw new WorkflowValueError("type", pointer, "Expected null.");
    case "string": return normalizeText(value, pointer);
    case "boolean":
      if (typeof value !== "boolean") throw new WorkflowValueError("type", pointer, "Expected boolean.");
      return value;
    case "int64": return normalizeInt64(value, pointer);
    case "decimal": return normalizeDecimal(value, pointer);
    case "artifact": return normalizeReference(value, ["evidenceId", "digest"], pointer);
    case "secret-handle": return normalizeReference(value, ["secretId", "versionId"], pointer);
    case "array": return normalizeArray(descriptor.schema as Extract<WorkflowValueSchema, { items: WorkflowPortDescriptor }>, value, pointer);
    case "object": return normalizeObject(descriptor.schema as Extract<WorkflowValueSchema, { properties: Record<string, WorkflowPortDescriptor> }>, value, pointer);
  }
}

function normalizeReference<Key extends string>(value: unknown, keys: readonly Key[], pointer: string): { [Property in Key]: string } {
  if (!isRecord(value)) throw new WorkflowValueError("type", pointer, "Expected reference object.");
  assertKeys(value, keys, pointer);
  const result: Record<string, string> = {};
  for (const key of keys) {
    const text = normalizeText(value[key], `${pointer}/${key}`);
    if (!text) throw new WorkflowValueError("reference", `${pointer}/${key}`, "Reference value is required.");
    result[key] = text;
  }
  return result as { [Property in Key]: string };
}

function normalizeArray(schema: Extract<WorkflowValueSchema, { items: WorkflowPortDescriptor }>, value: unknown, pointer: string): unknown[] {
  if (!Array.isArray(value)) throw new WorkflowValueError("type", pointer, "Expected array.");
  if (schema.minItems !== undefined && value.length < schema.minItems) throw new WorkflowValueError("array-min", pointer, "Array is too short.");
  if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new WorkflowValueError("array-max", pointer, "Array is too long.");
  return value.map((item, index) => normalizeTypedValue(schema.items, item, `${pointer}/${index}`));
}

function normalizeObject(schema: Extract<WorkflowValueSchema, { properties: Record<string, WorkflowPortDescriptor> }>, value: unknown, pointer: string): Record<string, unknown> {
  if (!isRecord(value)) throw new WorkflowValueError("type", pointer, "Expected object.");
  assertKeys(value, Object.keys(schema.properties), pointer);
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(schema.properties).sort()) {
    const port = schema.properties[key];
    if (Object.prototype.hasOwnProperty.call(value, key)) result[key] = normalizeTypedValue(port, value[key], `${pointer}/${key}`);
    else if (port.default !== undefined) result[key] = port.default;
    else if (port.required) throw new WorkflowValueError("required", `${pointer}/${key}`, "Required value is missing.");
  }
  return result;
}

export function requiredInputDigest(value: {
  portSchemaDigests: Record<string, string>;
  values: Record<string, unknown>;
  artifactDigests: Record<string, string>;
  secretVersionIds: Record<string, string>;
  configurationSnapshotIds: Record<string, string>;
}): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
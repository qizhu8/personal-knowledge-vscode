import { createHash } from "node:crypto";
import { ACTION_COMPILER_LIMITS as L } from "../action-compiler-contracts.js";
import { ORIGINAL_ACTION_COMPILER_CAPTURE as C } from "./action-compiler-original.js";
import { ACTION_SOURCE_IDENTITY } from "./action-source-identity.js";
import { actionModuleFileBytes, nativeActionModuleSourceProtocol, type ActionModuleFileContent } from "../action-module-bytes.js";

export type JsonRecord = Record<string, unknown>;
export type ActionDiagnostic = {
  path: string; code: string; message: string; allowed_values?: string[]; missing_field?: string;
};
export type ActionModuleSnapshot = {
  kind: "moduleSet"; manifest: unknown; files: Record<string, ActionModuleFileContent>; enabled?: boolean;
  fileEncoding?: typeof nativeActionModuleSourceProtocol;
};
export type LoadedModuleSet = {
  manifest: JsonRecord;
  definitions: Map<string, JsonRecord>;
  projection: JsonRecord;
};

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const definitionSchema = C.schema as unknown as JsonRecord;
const componentDefinitions = C.componentDefinitions as unknown as Record<string, JsonRecord>;
const capturedBuiltins = C.builtinDefinitions as unknown as Record<string, JsonRecord>;
const implementationKinds = ["program", "pipeline", "mcp"] as const;
const builtinActionIds = new Set([
  "core.date.parse", "core.cast.integer-to-string", "core.cast.string-to-integer",
  "core.cast.string-to-float", "core.artifact.write", "core.artifact.copy", "core.delay",
  "core.ask-user", "core.chatroom-alias",
]);
const runnablePureBuiltins = new Set(["core.cast.string-to-float"]);
const runnableArtifactBuiltins = new Set(["core.artifact.copy"]);
const actionIdPattern = /^[a-z][a-z0-9_.-]{2,100}$/;
const digestPattern = /^[a-f0-9]{64}$/;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pyString(value: string): string {
  let result = '"';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22) result += '\\"';
    else if (code === 0x5c) result += "\\\\";
    else if (code === 0x08) result += "\\b";
    else if (code === 0x09) result += "\\t";
    else if (code === 0x0a) result += "\\n";
    else if (code === 0x0c) result += "\\f";
    else if (code === 0x0d) result += "\\r";
    else if (code < 0x20 || code > 0x7e) result += `\\u${code.toString(16).padStart(4, "0")}`;
    else result += value[index];
  }
  return result + '"';
}

function pyRepr(value: unknown): string {
  if (typeof value === "string") {
    const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
    let result = quote;
    for (const character of value) {
      if (character === "\\") result += "\\\\";
      else if (character === quote) result += `\\${quote}`;
      else if (character === "\n") result += "\\n";
      else if (character === "\r") result += "\\r";
      else if (character === "\t") result += "\\t";
      else result += character;
    }
    return result + quote;
  }
  if (value === null) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
  if (isRecord(value)) return `{${Object.entries(value).map(([key, item]) => `${pyRepr(key)}: ${pyRepr(item)}`).join(", ")}}`;
  return String(value);
}

function comparePythonStrings(left: string, right: string): number {
  const a = Array.from(left, item => item.codePointAt(0)!);
  const b = Array.from(right, item => item.codePointAt(0)!);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return a.length - b.length;
}

function pythonNumber(value: number): string {
  if (!Number.isFinite(value)) throw new TypeError("Action JSON cannot contain non-finite numbers.");
  if (Number.isSafeInteger(value)) return String(value);
  const absolute = Math.abs(value);
  let rendered = value.toString();
  if ((absolute >= 1e16 || absolute < 1e-4) && !rendered.includes("e")) rendered = value.toExponential();
  if (absolute >= 1e-4 && absolute < 1e16 && rendered.includes("e")) {
    const [mantissa, exponentText] = rendered.split("e");
    const exponent = Number(exponentText);
    const negative = mantissa!.startsWith("-");
    const digits = mantissa!.replace("-", "").replace(".", "");
    const point = (mantissa!.replace("-", "").indexOf(".") < 0 ? mantissa!.replace("-", "").length
      : mantissa!.replace("-", "").indexOf(".")) + exponent;
    const body = point <= 0 ? `0.${"0".repeat(-point)}${digits}`
      : point >= digits.length ? `${digits}${"0".repeat(point - digits.length)}`
        : `${digits.slice(0, point)}.${digits.slice(point)}`;
    rendered = `${negative ? "-" : ""}${body}`;
  } else if (rendered.includes("e")) {
    const [mantissa, exponentText] = rendered.split("e");
    const exponent = Number(exponentText);
    rendered = `${mantissa}e${exponent >= 0 ? "+" : "-"}${String(Math.abs(exponent)).padStart(2, "0")}`;
  }
  return rendered;
}

export function pythonCanonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "string") return pyString(value);
  if (typeof value === "number") return pythonNumber(value);
  if (Array.isArray(value)) return `[${value.map(pythonCanonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort(comparePythonStrings)
      .map(key => `${pyString(key)}:${pythonCanonicalJson(value[key])}`).join(",")}}`;
  }
  throw new TypeError("Value is not JSON.");
}

export function originalDigest(value: unknown): string {
  return sha256(pythonCanonicalJson(value));
}

export function portableActionDefinition(value: JsonRecord): JsonRecord {
  return Object.fromEntries(Object.entries(value).filter(([key]) =>
    !["content_hash", "implementation_hash", "source_id"].includes(key)));
}

export function originalDefinitionValue(value: JsonRecord): JsonRecord {
  const actionId = value.action_id;
  if (typeof actionId !== "string") throw new TypeError("Action ID must be a string.");
  const knowledgeId = typeof value.knowledgeId === "string" && value.knowledgeId
    ? value.knowledgeId : `action_${originalDigest(actionId).slice(0, 24)}`;
  const sourceHashes = ACTION_SOURCE_IDENTITY.sourceHashes as unknown as Record<string, string>;
  const implementationHash = originalDigest({
    module: sourceHashes["resources/action_modules.py"],
    run_store: sourceHashes["resources/action_run_store.py"],
    recovery: sourceHashes["resources/action_recovery.py"],
    components: ACTION_SOURCE_IDENTITY.componentEngineHash,
    worker: sourceHashes["resources/recipe_runtime.py"],
  });
  const result: JsonRecord = {
    ...portableActionDefinition(value),
    knowledgeId,
    source_id: `pkm://knowledge/${knowledgeId}`,
    implementation_hash: implementationHash,
  };
  result.content_hash = originalDigest(result);
  const builtin = capturedBuiltins[actionId];
  if (builtin
    && originalDigest(portableActionDefinition({ ...value, knowledgeId })) === originalDigest(portableActionDefinition(builtin))) {
    // Python builtin literals retain int64 bounds and 150.0; JS JSON cannot reconstruct those bytes.
    result.content_hash = (ACTION_SOURCE_IDENTITY.builtinContentHashes as Record<string, string>)[actionId];
  }
  return result;
}

function exactBuiltin(value: unknown, ids: Set<string>): boolean {
  if (!isRecord(value) || typeof value.action_id !== "string" || !ids.has(value.action_id)) return false;
  const captured = capturedBuiltins[value.action_id];
  if (!captured) return false;
  const metadata = ["knowledgeId", "source_id", "implementation_hash", "content_hash"];
  const base = (record: JsonRecord) => Object.fromEntries(Object.entries(record).filter(([key]) => !metadata.includes(key)));
  const expected = base(captured);
  if (originalDigest(base(value)) !== originalDigest(expected)) return false;
  const derived = originalDefinitionValue(expected);
  return metadata.every(key => !Object.hasOwn(value, key) || value[key] === derived[key]);
}

export function exactRunnablePureBuiltin(value: unknown): boolean {
  return exactBuiltin(value, runnablePureBuiltins);
}

export function exactRunnableArtifactBuiltin(value: unknown): boolean {
  return exactBuiltin(value, runnableArtifactBuiltins);
}

export function runnablePureBuiltinSourceHash(actionId: string): string | undefined {
  const definition = runnablePureBuiltins.has(actionId) || runnableArtifactBuiltins.has(actionId)
    ? builtinActionDefinitions().get(actionId) : undefined;
  const hashes = ACTION_SOURCE_IDENTITY.sourceHashes as unknown as Record<string, string>;
  return typeof definition?.content_hash === "string" && typeof hashes["resources/action_modules.py"] === "string"
    ? originalDigest({ definition: definition.content_hash, source: hashes["resources/action_modules.py"] }) : undefined;
}

function pointer(parts: Array<string | number>): string {
  return "/" + parts.map(part => String(part).replaceAll("~", "~0").replaceAll("/", "~1")).join("/");
}

function pythonType(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (Array.isArray(value)) return "array";
  if (isRecord(value)) return "object";
  return "undefined";
}

function typeError(value: unknown, expected: string | string[]): string | undefined {
  const actual = pythonType(value);
  const types = Array.isArray(expected) ? expected : [expected];
  if (types.some(type => type === actual || type === "number" && actual === "integer")) return undefined;
  const shown = types.map(type => `'${type}'`).join(", ");
  return `${pyRepr(value)} is not of type ${shown}`;
}

function equal(left: unknown, right: unknown): boolean {
  try { return pythonCanonicalJson(left) === pythonCanonicalJson(right); }
  catch { return false; }
}

function schemaDocumentDiagnostics(schemaValue: unknown, path: Array<string | number>): ActionDiagnostic[] {
  if (typeof schemaValue === "boolean") return [];
  if (!isRecord(schemaValue)) return [{ path: pointer(path), code: "type", message: "is not of type 'object'" }];
  const diagnostics: ActionDiagnostic[] = [];
  const schema = schemaValue;
  const expectedType = (value: unknown, expected: string, key: string) => {
    const actual = pythonType(value);
    if (expected === "object" ? !isRecord(value) : actual !== expected) {
      diagnostics.push({ path: pointer([...path, key]), code: "type",
        message: `${pyRepr(value)} is not of type '${expected}'` });
      return false;
    }
    return true;
  };
  const nonnegativeIntegerKeywords = [
    "minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties",
    "minContains", "maxContains",
  ];
  for (const key of nonnegativeIntegerKeywords) {
    if (schema[key] !== undefined) {
      const value = schema[key];
      if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        diagnostics.push({ path: pointer([...path, key]), code: "type", message: `${pyRepr(value)} is not of type 'integer'` });
      } else if (value < 0) {
        diagnostics.push({ path: pointer([...path, key]), code: "minimum", message: `${value} is less than the minimum of 0` });
      }
    }
  }
  for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"]) {
    if (schema[key] !== undefined && (typeof schema[key] !== "number" || !Number.isFinite(schema[key]))) {
      diagnostics.push({ path: pointer([...path, key]), code: "type", message: `${pyRepr(schema[key])} is not of type 'number'` });
    }
  }
  if (schema.multipleOf !== undefined) {
    if (typeof schema.multipleOf !== "number" || !Number.isFinite(schema.multipleOf)) {
      diagnostics.push({ path: pointer([...path, "multipleOf"]), code: "type", message: `${pyRepr(schema.multipleOf)} is not of type 'number'` });
    } else if (schema.multipleOf <= 0) {
      diagnostics.push({ path: pointer([...path, "multipleOf"]), code: "exclusiveMinimum", message: "0 is less than or equal to the minimum of 0" });
    }
  }
  for (const key of ["$schema", "$id", "$ref", "$anchor", "$dynamicRef", "$dynamicAnchor", "$comment", "title", "description", "format", "contentEncoding", "contentMediaType"]) {
    if (schema[key] !== undefined && typeof schema[key] !== "string") {
      diagnostics.push({ path: pointer([...path, key]), code: "type", message: `${pyRepr(schema[key])} is not of type 'string'` });
    }
  }
  if (schema.type !== undefined) {
    const supported = new Set(["array", "boolean", "integer", "null", "number", "object", "string"]);
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.length || types.some(type => typeof type !== "string" || !supported.has(type))) {
      diagnostics.push({ path: pointer([...path, "type"]), code: "anyOf",
        message: `${typeof schema.type === "string" ? pyRepr(schema.type) : pythonCanonicalJson(schema.type)} is not valid under any of the given schemas` });
    } else if (new Set(types).size !== types.length) {
      diagnostics.push({ path: pointer([...path, "type"]), code: "uniqueItems", message: "contains duplicate types" });
    }
  }
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required)) diagnostics.push({ path: pointer([...path, "required"]), code: "type", message: `${pyRepr(schema.required)} is not of type 'array'` });
    else {
      if (schema.required.some(item => typeof item !== "string")) diagnostics.push({ path: pointer([...path, "required"]), code: "type", message: "items must be strings" });
      if (new Set(schema.required).size !== schema.required.length) diagnostics.push({ path: pointer([...path, "required"]), code: "uniqueItems", message: "contains duplicate items" });
    }
  }
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum)) diagnostics.push({ path: pointer([...path, "enum"]), code: "type", message: `${pyRepr(schema.enum)} is not of type 'array'` });
    else {
      const enumValues = schema.enum as unknown[];
      if (!enumValues.length) diagnostics.push({ path: pointer([...path, "enum"]), code: "minItems", message: "[] should be non-empty" });
      for (let index = 0; index < enumValues.length; index += 1) {
        if (enumValues.slice(0, index).some(item => equal(item, enumValues[index]))) {
          diagnostics.push({ path: pointer([...path, "enum"]), code: "uniqueItems", message: "contains duplicate items" });
          break;
        }
      }
    }
  }
  for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
    if (schema[key] !== undefined) {
      if (!Array.isArray(schema[key])) diagnostics.push({ path: pointer([...path, key]), code: "type", message: `${pyRepr(schema[key])} is not of type 'array'` });
      else {
        const values = schema[key] as unknown[];
        if (key !== "prefixItems" && values.length === 0) diagnostics.push({ path: pointer([...path, key]), code: "minItems", message: "[] should be non-empty" });
        values.forEach((child, index) => diagnostics.push(...schemaDocumentDiagnostics(child, [...path, key, index])));
      }
    }
  }
  for (const key of ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]) {
    if (schema[key] !== undefined) {
      if (!isRecord(schema[key])) diagnostics.push({ path: pointer([...path, key]), code: "type", message: `${pyRepr(schema[key])} is not of type 'object'` });
      else for (const [name, child] of Object.entries(schema[key])) {
        if (key === "patternProperties") {
          try { new RegExp(name); } catch { diagnostics.push({ path: pointer([...path, key, name]), code: "regex", message: "is not a valid regular expression" }); }
        }
        diagnostics.push(...schemaDocumentDiagnostics(child, [...path, key, name]));
      }
    }
  }
  for (const key of ["items", "additionalProperties", "unevaluatedItems", "unevaluatedProperties", "contains", "propertyNames", "not", "if", "then", "else", "contentSchema"]) {
    if (schema[key] !== undefined) {
      if (typeof schema[key] !== "boolean" && !isRecord(schema[key])) {
        diagnostics.push({ path: pointer([...path, key]), code: "type", message: `${pyRepr(schema[key])} is not of type 'object', 'boolean'` });
      } else diagnostics.push(...schemaDocumentDiagnostics(schema[key], [...path, key]));
    }
  }
  if (schema.dependentRequired !== undefined) {
    if (!isRecord(schema.dependentRequired)) diagnostics.push({ path: pointer([...path, "dependentRequired"]), code: "type", message: `${pyRepr(schema.dependentRequired)} is not of type 'object'` });
    else for (const [key, value] of Object.entries(schema.dependentRequired)) {
      if (!Array.isArray(value) || value.some(item => typeof item !== "string")) diagnostics.push({
        path: pointer([...path, "dependentRequired", key]), code: "type", message: "must be an array of strings",
      });
    }
  }
  for (const key of ["pattern", "patternProperties"]) {
    if (key === "pattern" && schema.pattern !== undefined) {
      expectedType(schema.pattern, "string", "pattern");
      try { new RegExp(schema.pattern as string); } catch { diagnostics.push({ path: pointer([...path, "pattern"]), code: "regex", message: "is not a valid regular expression" }); }
    }
  }
  return diagnostics;
}

function schemaDiagnostics(schemaValue: unknown, value: unknown, path: Array<string | number> = []): ActionDiagnostic[] {
  if (typeof schemaValue === "boolean") {
    return schemaValue ? [] : [{ path: pointer(path), code: "false schema", message: "The schema is false." }];
  }
  if (!isRecord(schemaValue)) return [];
  const schema = schemaValue;
  if (schema.$ref === "https://json-schema.org/draft/2020-12/schema") {
    return schemaDocumentDiagnostics(value, path);
  }
  if (schema.oneOf !== undefined && Array.isArray(schema.oneOf)) {
    const branches = schema.oneOf.map(branch => schemaDiagnostics(branch, value, path));
    if (branches.filter(errors => errors.length === 0).length === 1) return [];
    if (isRecord(value)) {
      const kind = value.kind;
      const kinds = [...implementationKinds];
      if (!kinds.includes(kind as typeof implementationKinds[number])) {
        return [{ path: pointer([...path, "kind"]), code: "enum",
          message: "Choose a supported implementation kind.", allowed_values: kinds }];
      }
      const selected = schema.oneOf.find(branch => isRecord(branch) && isRecord(branch.properties)
        && isRecord(branch.properties.kind) && branch.properties.kind.const === kind);
      if (selected) return schemaDiagnostics(selected, value, path);
    }
    return [{ path: pointer(path), code: "oneOf", message: "is not valid under exactly one schema" }];
  }
  if (schema.type !== undefined) {
    const message = typeError(value, schema.type as string | string[]);
    if (message) return [{ path: pointer(path), code: "type", message }];
  }
  if (schema.const !== undefined && !equal(value, schema.const)) {
    return [{ path: pointer(path), code: "const", message: `${pyRepr(schema.const)} was expected` }];
  }
  if (Array.isArray(schema.enum) && !schema.enum.some(item => equal(item, value))) {
    return [{ path: pointer(path), code: "enum", message: `${pyRepr(value)} is not one of ${pyRepr(schema.enum)}`,
      ...(schema.enum.every(item => typeof item === "string") ? { allowed_values: schema.enum as string[] } : {}) }];
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && Array.from(value).length < schema.minLength) {
      return [{ path: pointer(path), code: "minLength", message: `${pyString(value)} is too short` }];
    }
    if (typeof schema.maxLength === "number" && Array.from(value).length > schema.maxLength) {
      return [{ path: pointer(path), code: "maxLength", message: `${pyString(value)} is too long` }];
    }
    if (typeof schema.pattern === "string") {
      let matches = false;
      try { matches = new RegExp(schema.pattern).test(value); } catch { /* Invalid patterns are rejected by schema checking. */ }
      if (!matches) return [{ path: pointer(path), code: "pattern", message: `${pyRepr(value)} does not match ${pyRepr(schema.pattern)}` }];
    }
  }
  if (Array.isArray(value)) {
    const diagnostics: ActionDiagnostic[] = [];
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      diagnostics.push({ path: pointer(path), code: "minItems",
        message: value.length === 0 ? `${pyRepr(value)} should be non-empty` : `has fewer than ${schema.minItems} items` });
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      diagnostics.push({ path: pointer(path), code: "maxItems", message: `has more than ${schema.maxItems} items` });
    }
    if (schema.items !== undefined) {
      for (let index = 0; index < value.length; index += 1) {
        diagnostics.push(...schemaDiagnostics(schema.items, value[index], [...path, index]));
      }
    }
    if (diagnostics.length) return diagnostics;
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return [{ path: pointer(path), code: "minimum", message: `${value} is less than the minimum of ${schema.minimum}` }];
    if (typeof schema.maximum === "number" && value > schema.maximum) return [{ path: pointer(path), code: "maximum", message: `${value} is greater than the maximum of ${schema.maximum}` }];
  }
  if (isRecord(value)) {
    const diagnostics: ActionDiagnostic[] = [];
    if (Array.isArray(schema.required)) {
      const missing = (schema.required as unknown[]).filter(key => typeof key === "string" && !(key in value));
      if (missing.length) {
        diagnostics.push(...missing.map(key => ({ path: pointer([...path, key as string]), code: "required",
          message: "Required field is missing.", missing_field: key as string })));
      }
    }
    const knownProperties = isRecord(schema.properties) ? schema.properties : {};
    if (schema.additionalProperties === false && isRecord(schema.properties)) {
      const extras = Object.keys(value).filter(key => !(key in knownProperties));
      if (extras.length) diagnostics.push({ path: pointer(path), code: "additionalProperties",
        message: `Additional properties are not allowed (${extras.map(pyRepr).join(", ")} ${extras.length === 1 ? "was" : "were"} unexpected)` });
    } else if (isRecord(schema.additionalProperties)) {
      for (const key of Object.keys(value)) if (!(key in knownProperties)) {
        diagnostics.push(...schemaDiagnostics(schema.additionalProperties, value[key], [...path, key]));
      }
    }
    if (isRecord(schema.properties)) {
      for (const [key, child] of Object.entries(knownProperties)) {
        if (key in value) {
          diagnostics.push(...schemaDiagnostics(child, value[key], [...path, key]));
        }
      }
    }
    return diagnostics;
  }
  return [];
}

export function actionDefinitionDiagnostics(value: unknown): ActionDiagnostic[] {
  if (exactRunnablePureBuiltin(value) || exactRunnableArtifactBuiltin(value)) return [];
  return schemaDiagnostics(definitionSchema, value);
}

export function safeModuleMember(member: string): boolean {
  if (!member || member.includes("\\") || member.includes(":") || /[\x00-\x1f\x7f]/.test(member)) return false;
  const parts = member.split("/");
  if (parts.some(part => !part || part === "." || part === ".." || part.endsWith(" ") || part.endsWith(".")
    || /[<>"|?*]/.test(part) || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/i.test(part))) return false;
  return true;
}

export function validResourceReference(reference: unknown): boolean {
  if (typeof reference !== "string") return false;
  if (/^pkm:\/\/script\/script_[a-f0-9]{24}$/.test(reference)
    || /^pkm:\/\/knowledge\/(?:knowledge_[a-f0-9]{24}|action_(?:[a-f0-9]{24}|[a-f0-9]{32}))$/.test(reference)
    || /^pkm:\/\/actions\/[a-z][a-z0-9_.-]{2,100}$/.test(reference)
    || /^pkm:\/\/recipes\/recipe_[A-Za-z0-9_-]+$/.test(reference)) return true;
  const memberSafe = (raw: string, minimumParts: number): boolean => {
    try {
      if (/%(?![a-fA-F0-9]{2})/.test(raw) || raw.includes("?") || raw.includes("#")) return false;
      const parts = raw.split("/").map(part => decodeURIComponent(part));
      return parts.length >= minimumParts && parts.every(part => !part.includes("/")) && safeModuleMember(parts.join("/"));
    } catch { return false; }
  };
  if (reference.startsWith("pkm://recipes/")) {
    return memberSafe(reference.slice("pkm://recipes/".length), 1);
  }
  if (reference.startsWith("pkm://packages/")) {
    return memberSafe(reference.slice("pkm://packages/".length), 2);
  }
  if (reference.startsWith("pkm://scripts/")) {
    try {
      const parsed = new URL(reference);
      if (parsed.hostname !== "scripts" || parsed.search || parsed.hash || reference.includes("?") || reference.includes("#")) return false;
      const raw = parsed.pathname.slice(1);
      if (/%(?![a-fA-F0-9]{2})/.test(raw)) return false;
      const parts = raw.split("/").map(part => decodeURIComponent(part));
      return parts.every(part => !part.includes("/")) && safeModuleMember(parts.join("/"));
    } catch { return false; }
  }
  return false;
}

export function loadModuleSet(source: ActionModuleSnapshot): LoadedModuleSet {
  if (!isRecord(source.manifest) || !isRecord(source.files)) throw new TypeError("Invalid explicit ModuleSet snapshot.");
  if (source.fileEncoding !== undefined && source.fileEncoding !== nativeActionModuleSourceProtocol)
    throw new TypeError("Unsupported explicit ModuleSet file encoding.");
  const manifest = source.manifest;
  if (manifest.schema !== "pkm.action.module-set/v1"
    || typeof manifest.module_set_id !== "string" || !actionIdPattern.test(manifest.module_set_id)
    || !Number.isSafeInteger(manifest.version) || Number(manifest.version) < 1
    || typeof manifest.package_hash !== "string" || !digestPattern.test(manifest.package_hash)) {
    throw new TypeError("Invalid installed ModuleSet manifest/hash.");
  }
  const unsigned = Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== "package_hash"));
  if (originalDigest(unsigned) !== manifest.package_hash) throw new TypeError("Invalid installed ModuleSet manifest/hash.");
  if (!Array.isArray(manifest.actions) || manifest.actions.length > L.moduleActions
    || !isRecord(manifest.files) || Object.keys(manifest.files).length > L.moduleFiles - 1
    || Object.keys(source.files).length !== Object.keys(manifest.files).length) {
    throw new TypeError("Invalid ModuleSet file/action inventory.");
  }
  const fileDigests = manifest.files as JsonRecord;
  const names = Object.keys(source.files);
  if (manifest.executables !== undefined && (!Array.isArray(manifest.executables)
    || manifest.executables.some(member => typeof member !== "string" || !member.startsWith("assets/") || !names.includes(member))
    || new Set(manifest.executables).size !== manifest.executables.length))
    throw new TypeError("Invalid declared ModuleSet executable inventory.");
  const folded = new Set<string>();
  for (const name of ["manifest.json", ...names]) {
    if (!safeModuleMember(name)) throw new TypeError("Unsafe relative Action resource member.");
    const key = name.normalize("NFC").toLocaleLowerCase("en-US");
    if (folded.has(key)) throw new TypeError("Case-insensitive package member collision: " + name);
    folded.add(key);
    if (name === "manifest.json") continue;
    if (typeof source.files[name] !== "string" && source.fileEncoding !== nativeActionModuleSourceProtocol
      || typeof fileDigests[name] !== "string"
      || !digestPattern.test(fileDigests[name] as string)) throw new TypeError("Invalid ModuleSet file digest: " + name);
    const bytes = actionModuleFileBytes(source.files[name]!);
    if (bytes.length > L.moduleFileBytes) throw new RangeError(`ModuleSet file exceeds ${L.moduleFileBytes} bytes.`);
    if (sha256(bytes) !== fileDigests[name]) throw new TypeError("Installed ModuleSet file hash mismatch: " + name);
  }
  const totalBytes = names.reduce((total, name) => total + actionModuleFileBytes(source.files[name]!).length, 0);
  if (totalBytes > L.moduleBytes) throw new RangeError("ModuleSet exceeds 32 MiB.");
  const memberSet = new Set(["manifest.json", ...names].map(name => name.normalize("NFC").toLocaleLowerCase("en-US")));
  for (const name of names) {
    const parts = name.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      if (memberSet.has(parts.slice(0, index).join("/").normalize("NFC").toLocaleLowerCase("en-US"))) {
        throw new TypeError("Package file/directory collision: " + name);
      }
    }
  }
  const definitions = new Map<string, JsonRecord>();
  const actions = new Set<string>();
  for (const actionId of manifest.actions) {
    if (typeof actionId !== "string" || !actionIdPattern.test(actionId) || actions.has(actionId)
      || builtinActionIds.has(actionId) || actionId in componentDefinitions) {
      throw new TypeError("Invalid/reserved packaged Action ID.");
    }
    actions.add(actionId);
    const member = `definitions/${actionId}.json`;
    const text = source.files[member];
    if (typeof text !== "string") throw new TypeError("Packaged Action definition is missing.");
    let value: unknown;
    try { value = JSON.parse(text); }
    catch { throw new TypeError("Invalid packaged Action definition JSON: " + member); }
    if (!isRecord(value) || value.action_id !== actionId || value.schema !== "pkm.action.definition/v1"
      || !value.knowledgeId) throw new TypeError("Invalid packaged Action identity.");
    for (const field of ["input_schema", "output_schema"]) {
      if (schemaDocumentDiagnostics(value[field], []).length) {
        throw new TypeError("Invalid packaged Action JSON Schema: " + member);
      }
    }
    definitions.set(actionId, originalDefinitionValue(value));
  }
  const resources = manifest.resources ?? {};
  if (!isRecord(resources)) throw new TypeError("Invalid packaged resource bindings.");
  for (const [actionId, bindings] of Object.entries(resources)) {
    if (!actions.has(actionId) || !isRecord(bindings)) throw new TypeError("Invalid packaged resource Action.");
    for (const [reference, member] of Object.entries(bindings)) {
      if (!validResourceReference(reference)) throw new TypeError("Unsupported or invalid PKM resource URL: " + reference);
      if (typeof member !== "string" || !member.startsWith("assets/") || !(member in fileDigests)) {
        throw new TypeError("Packaged resource must name a declared asset.");
      }
      if (!safeModuleMember(member)) throw new TypeError("Unsafe relative Action resource member.");
    }
  }
  const expectedDefinitionFiles = [...actions].map(actionId => `definitions/${actionId}.json`);
  if (expectedDefinitionFiles.some(name => !(name in source.files))) throw new TypeError("Packaged Action definition is missing.");
  const projection = {
    module_set_id: manifest.module_set_id,
    version: manifest.version,
    name: typeof manifest.name === "string" ? manifest.name : manifest.module_set_id,
    actions: [...manifest.actions] as string[],
    package_hash: manifest.package_hash,
    provenance: manifest.provenance ?? {},
    enabled: source.enabled === true,
  };
  return { manifest, definitions, projection };
}

function semantic(message: string): ActionDiagnostic[] {
  return [{ path: "/", code: "semantic", message }];
}

export function validateActionDefinition(value: unknown, available: Map<string, JsonRecord>): ActionDiagnostic[] {
  if (exactRunnablePureBuiltin(value) || exactRunnableArtifactBuiltin(value)) return [];
  const diagnostics = actionDefinitionDiagnostics(value);
  if (diagnostics.length) return diagnostics;
  if (!isRecord(value)) return semantic("Action definition must be an object.");
  if ("reconciler" in value) {
    const reconciler = value.reconciler;
    const kinds = new Set(["manual", "file-hash", "process-status", "remote-resource", "message-order"]);
    if (!isRecord(reconciler) || !kinds.has(String(reconciler.kind))) {
      return semantic("Reconciler must declare a supported registry kind.");
    }
    if (reconciler.kind === "file-hash") {
      const path = reconciler.path;
      const member = typeof path === "string" ? path.split(/[\\/]/) : [];
      if (typeof path !== "string" || !path || path.startsWith("/") || /^[a-zA-Z]:/.test(path)
        || member.includes("..") || typeof reconciler.sha256 !== "string" || !digestPattern.test(reconciler.sha256)
        || !("output" in reconciler)) {
        return semantic("File reconciler requires a relative workspace path, pinned SHA-256 and typed output.");
      }
    } else if (reconciler.kind === "remote-resource" || reconciler.kind === "message-order") {
      if (typeof reconciler.lookup_action_id !== "string" || typeof reconciler.lookup_revision !== "string"
        || !isRecord(reconciler.inputs) || typeof reconciler.success_field !== "string"
        || !("success_value" in reconciler) || !("output" in reconciler)) {
        return semantic("Remote reconciler requires a pinned read-only lookup Action and exact success predicate/output.");
      }
    }
  }
  const name = value.action_id;
  if (typeof name !== "string" || !actionIdPattern.test(name) || builtinActionIds.has(name) || name in componentDefinitions) {
    return semantic("Invalid or reserved Action ID.");
  }
  if (value.schema !== "pkm.action.definition/v1" || !Number.isSafeInteger(value.version)) {
    return semantic("A versioned Action definition is required.");
  }
  for (const key of ["input_schema", "output_schema"]) {
    const errors = schemaDocumentDiagnostics(value[key], []);
    if (errors.length) return semantic("Invalid JSON Schema at " + errors[0]!.path + ": " + errors[0]!.message);
  }
  const dependencies = isRecord(value.dependencies) ? value.dependencies : {};
  const effects = Array.isArray(value.effects) ? value.effects : [];
  const implementations = Array.isArray(value.implementations) ? value.implementations : [];
  for (const implementation of implementations) {
    if (!isRecord(implementation)) continue;
    if (!implementationKinds.includes(implementation.kind as typeof implementationKinds[number]) || !Array.isArray(implementation.platforms)
      || implementation.platforms.length === 0) return semantic("Declare a supported implementation kind and platforms.");
    if (implementation.kind === "program") {
      const args = implementation.args ?? [];
      if (!Array.isArray(args) || args.some(arg => typeof arg !== "string")) {
        return semantic("Program args must be a string array, never a shell command.");
      }
      const build = implementation.build;
      if (build !== undefined) {
        if (!isRecord(build) || typeof build.program !== "string" || !Array.isArray(build.source_files)
          || !build.source_files.length || !Array.isArray(build.outputs) || !build.outputs.length) {
          return semantic("Build requires a compiler, source_files and outputs.");
        }
        if (!Array.isArray(build.args) || build.args.some(arg => typeof arg !== "string")) {
          return semantic("Build args must be an argv array.");
        }
        for (const output of build.outputs) {
          if (typeof output !== "string" || !output || output.startsWith("/") || /^[a-zA-Z]:/.test(output)
            || output.split(/[\\/]/).includes("..") || output.includes("\\") || output.includes(":")) {
            return semantic("Build outputs must be safe relative paths.");
          }
        }
      }
    }
    if (implementation.kind === "pipeline") {
      try {
        const effectsFound = validatePipelineSteps(implementation.steps, dependencies);
        if ([...effectsFound].some(effect => !effects.includes(effect))) {
          return semantic("Basic component effects must be declared by the parent Action.");
        }
      } catch (error) {
        return semantic(error instanceof Error ? error.message : "Invalid component pipeline.");
      }
    }
  }
  const visited = new Set<string>();
  const visit = (pins: JsonRecord, ancestry: string[]): void => {
    if (ancestry.length > L.dependencyDepth || visited.size > L.dependencyCount) {
      throw new Error("Nested Action dependency budget exceeded.");
    }
    for (const [child, pin] of Object.entries(pins)) {
      if (ancestry.includes(child)) throw new Error("Nested Action cycle: " + [...ancestry, child].join(" -> "));
      const definition = available.get(child);
      if (!definition) throw new Error("Action is not registered or its ModuleSet is not loaded: " + child);
      if (definition.content_hash !== pin) throw new Error("Dependency is not pinned to the current contract: " + child);
      if (visited.has(child)) continue;
      const childDependencies = isRecord(definition.dependencies) ? definition.dependencies : {};
      visit(childDependencies, [...ancestry, child]);
      visited.add(child);
    }
  };
  try { visit(dependencies, [name]); }
  catch (error) { return semantic(error instanceof Error ? error.message : "Invalid Action dependency graph."); }
  return [];
}

function validatePipelineSteps(stepsValue: unknown, dependencies: JsonRecord, depth = 0, budget = { count: 0 }): Set<string> {
  if (!Array.isArray(stepsValue) || depth > L.pipelineDepth) {
    throw new Error("Basic component body must be a list with nesting depth at most 12.");
  }
  const identifiers = new Set<string>();
  const effects = new Set<string>();
  for (const step of stepsValue) {
    budget.count += 1;
    if (budget.count > L.pipelineSteps || !isRecord(step)
      || Object.keys(step).some(key => !["id", "action_id", "content_hash", "component", "implementation", "inputs", "output_schema"].includes(key))) {
      throw new Error("Invalid component step or structural budget exceeded.");
    }
    const identifier = step.id;
    if (typeof identifier !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(identifier) || identifiers.has(identifier)) {
      throw new Error("Invalid or duplicate component step ID.");
    }
    identifiers.add(identifier);
    if ("output_schema" in step && schemaDocumentDiagnostics(step.output_schema, []).length) {
      throw new Error("Invalid component output schema.");
    }
    const inputs = step.inputs;
    if (("action_id" in step) === ("component" in step) || !isRecord(inputs)) {
      throw new Error("Each step must declare exactly one Action or basic component and its inputs.");
    }
    if ("action_id" in step) {
      const actionId = step.action_id;
      if (typeof actionId !== "string" || !(actionId in dependencies)
        || (step.content_hash !== undefined && step.content_hash !== dependencies[actionId])) {
        throw new Error("Body Action is not declared and pinned: " + String(actionId));
      }
      continue;
    }
    const component = componentDefinitions[String(step.component)];
    if (!component) throw new Error("Unknown basic component.");
    const implementations = component.component_implementations as Array<JsonRecord> | undefined;
    if (step.implementation !== undefined && !implementations?.some(item => item.id === step.implementation)) {
      throw new Error("Unsupported implementation for " + String(step.component) + ": " + String(step.implementation)
        + ". Python, JavaScript and TypeScript are available for stateless components; control-flow components run in the host.");
    }
    const inputSchema = component.input_schema as JsonRecord;
    const properties = isRecord(inputSchema.properties) ? inputSchema.properties : {};
    const required = Array.isArray(inputSchema.required) ? inputSchema.required : [];
    if (Object.keys(inputs).some(key => !(key in properties)) || required.some(key => !(key in inputs))) {
      throw new Error("Missing or unknown basic component inputs: " + identifier);
    }
    if (Array.isArray(component.effects)) for (const effect of component.effects) effects.add(String(effect));
    if (step.component === "core.sleep" && !isRecord(inputs.seconds)) {
      if (typeof inputs.seconds !== "number" || !Number.isFinite(inputs.seconds) || inputs.seconds < 0 || inputs.seconds > 300) {
        throw new Error("Sleep seconds must be a finite number between 0 and 300.");
      }
    }
    if (["core.for", "core.while", "core.poll", "core.monitor"].includes(String(step.component))) {
      const limit = inputs.max_iterations;
      if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 1000) {
        throw new Error("Loops require an explicit integer max_iterations between 1 and 1000.");
      }
    }
    for (const key of ["then_steps", "else_steps", "default_steps", "body"]) {
      if (key in inputs) for (const effect of validatePipelineSteps(inputs[key], dependencies, depth + 1, budget)) effects.add(effect);
    }
    if ("cases" in inputs) {
      const cases = inputs.cases;
      if (!Array.isArray(cases) || cases.length > 100) throw new Error("Switch requires at most 100 cases.");
      const matches = new Set<string>();
      for (const item of cases) {
        if (!isRecord(item) || Object.keys(item).some(key => !["match", "steps", "value"].includes(key))
          || !("match" in item) || !("value" in item)) throw new Error("Switch cases require explicit match and value.");
        const marker = pythonCanonicalJson(item.match);
        if (matches.has(marker)) throw new Error("Duplicate switch case.");
        matches.add(marker);
        for (const effect of validatePipelineSteps(item.steps ?? [], dependencies, depth + 1, budget)) effects.add(effect);
      }
    }
  }
  return effects;
}

export function validateDefinitionOrThrow(value: unknown, available: Map<string, JsonRecord>): ActionDiagnostic[] {
  return validateActionDefinition(value, available);
}

export function actionComponents(): Record<string, JsonRecord> {
  return componentDefinitions;
}

export function componentDigest(definition: JsonRecord): string {
  return originalDigest({ definition, engine: ACTION_SOURCE_IDENTITY.componentEngineHash });
}

export function moduleSnapshotDefinitions(sources: ActionModuleSnapshot[]): Map<string, JsonRecord> {
  const available = builtinActionDefinitions();
  for (const source of sources) {
    const set = loadModuleSet(source);
    for (const [actionId, definition] of set.definitions) {
      if (available.has(actionId) || builtinActionIds.has(actionId) || actionId in componentDefinitions) {
        throw new TypeError("Ambiguous Action provider: " + actionId);
      }
      available.set(actionId, definition);
    }
  }
  return available;
}

export function builtinActionDefinitions(): Map<string, JsonRecord> {
  return new Map(Object.entries(capturedBuiltins).map(([id, definition]) => [
    id, originalDefinitionValue(definition),
  ]));
}

export function actionIdValid(value: unknown): value is string {
  return typeof value === "string" && actionIdPattern.test(value);
}

export function actionBuiltinId(value: string): boolean {
  return builtinActionIds.has(value);
}

export function actionDigestPattern(value: unknown): value is string {
  return typeof value === "string" && digestPattern.test(value);
}

export function schemaValueErrors(schema: unknown, value: unknown): ActionDiagnostic[] {
  return schemaDiagnostics(schema, value);
}

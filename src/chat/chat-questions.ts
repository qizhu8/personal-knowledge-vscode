export interface QuestionField {
  type: "string" | "boolean" | "integer" | "number" | "array";
  title?: string;
  description?: string;
  enum?: Array<string | number | boolean>;
  items?: { type: "string"; enum?: string[] };
  default?: unknown;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  pattern?: string;
}
const aliasPattern = "^\\S(?:[^\\x00-\\x1f\\x7f]*\\S)?$";

export interface QuestionSchema {
  type: "object";
  properties: Record<string, QuestionField>;
  required?: string[];
  additionalProperties?: false;
}

export function questionSchema(value: unknown): QuestionSchema {
  if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(value).length > 32_000) throw new Error("Provide a bounded object answer schema.");
  const schema = value as QuestionSchema;
  if (schema.type !== "object" || !schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)
    || Object.keys(schema.properties).length < 1 || Object.keys(schema.properties).length > 24
    || schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(key => typeof key !== "string" || !Object.prototype.hasOwnProperty.call(schema.properties, key)))) throw new Error("Use 1-24 named form fields and declared required fields.");
  for (const [name, field] of Object.entries(schema.properties)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name) || !field || !["string", "boolean", "integer", "number", "array"].includes(field.type)
      || field.type === "array" && field.items?.type !== "string"
      || field.items !== undefined && Object.keys(field.items).some(key => !["type", "enum"].includes(key))
      || field.enum !== undefined && (!Array.isArray(field.enum) || !field.enum.length || field.enum.length > 100
        || field.enum.some(item => !["string", "number", "boolean"].includes(typeof item) || typeof item === "string" && item.length > 4000))
      || field.items?.enum !== undefined && (!Array.isArray(field.items.enum) || field.items.enum.length > 100 || field.items.enum.some(item => typeof item !== "string" || item.length > 4000))
      || field.pattern !== undefined && field.pattern !== aliasPattern
      || Object.keys(field).some(key => !["type", "title", "description", "enum", "items", "default", "minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems", "uniqueItems", "pattern"].includes(key))
      || ["minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems"].some(key => {
        const limit = field[key as keyof QuestionField]; return limit !== undefined && (typeof limit !== "number" || !Number.isFinite(limit));
      })) throw new Error(`Unsupported form field: ${name}. Use text, choices, booleans, numbers or string arrays with supported limits.`);
  }
  return schema;
}

export function validateQuestionAnswer(schema: QuestionSchema, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(value).length > 32_000) throw new Error("Submit a bounded answer object.");
  const answer = value as Record<string, unknown>;
  if (Object.keys(answer).some(key => !Object.prototype.hasOwnProperty.call(schema.properties, key))) throw new Error("The answer contains an unknown field.");
  for (const [name, field] of Object.entries(schema.properties)) {
    const input = answer[name];
    if (input === undefined) {
      if (schema.required?.includes(name)) throw new Error(`Answer required: ${field.title || name}.`);
      continue;
    }
    const invalid = field.type === "array" ? !Array.isArray(input) || input.length > 100 || input.some(item => typeof item !== "string" || item.length > 4000 || field.items?.enum && !field.items.enum.includes(item))
      : field.type === "integer" ? typeof input !== "number" || !Number.isSafeInteger(input)
      : field.type === "number" ? typeof input !== "number" || !Number.isFinite(input)
      : typeof input !== field.type;
    if (invalid || field.enum && !field.enum.includes(input as string | number | boolean)) throw new Error(`Invalid answer: ${field.title || name}.`);
    if (typeof input === "string" && (input.length < (field.minLength ?? 0) || input.length > Math.min(field.maxLength ?? 4000, 4000) || /[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(input))) throw new Error(`Text length or characters are invalid: ${field.title || name}.`);
    if (typeof input === "string" && field.pattern === aliasPattern && (!input.trim() || input.trim() !== input || /[\x00-\x1f\x7f]/.test(input))) throw new Error(`Invalid alias: ${field.title || name}.`);
    if (Array.isArray(input) && (input.length < (field.minItems ?? 0) || input.length > (field.maxItems ?? 100) || field.uniqueItems && new Set(input).size !== input.length)) throw new Error(`Invalid selection count: ${field.title || name}.`);
    if (typeof input === "number" && (field.minimum !== undefined && input < field.minimum || field.maximum !== undefined && input > field.maximum)) throw new Error(`Number is outside the allowed range: ${field.title || name}.`);
  }
  return answer;
}

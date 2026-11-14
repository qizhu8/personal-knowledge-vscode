import { createHash } from "node:crypto";
import { z } from "zod";
import { CoreError } from "../contracts.js";
import type { ToolApprovalBinding, ToolGatewayResult } from "../tool-gateway-contracts.js";

export function toolCanonicalJson(value: unknown): string {
  let count = 0;
  const visit = (item: unknown, depth: number): unknown => {
    if (++count > 8192 || depth > 16) throw new CoreError("INVALID_ARGUMENT", "Tool arguments exceed structural bounds.");
    if (item === null || typeof item === "boolean" || typeof item === "string") return item;
    if (typeof item === "number" && Number.isFinite(item)) return Object.is(item, -0) ? 0 : item;
    if (Array.isArray(item)) return item.map(entry => visit(entry, depth + 1));
    if (typeof item !== "object" || !item || ![Object.prototype, null].includes(Object.getPrototypeOf(item)))
      throw new CoreError("INVALID_ARGUMENT", "Expected portable JSON.");
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(item).sort()) {
      const property = Object.getOwnPropertyDescriptor(item, key);
      if (!property || !("value" in property)) throw new CoreError("INVALID_ARGUMENT", "Expected data properties.");
      result[key] = visit(property.value, depth + 1);
    }
    return result;
  };
  return JSON.stringify(visit(value, 0));
}
export const toolArgumentsDigest = (args: unknown): string =>
  createHash("sha256").update(toolCanonicalJson(args)).digest("hex");
export const toolApprovalDigest = (binding: ToolApprovalBinding): string => toolArgumentsDigest(binding);

const catalogItem = z.strictObject({
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,199}$/),
  operation: z.string().min(1).max(200), version: z.literal(1),
  description: z.string().max(32_768), parameters: z.record(z.string(), z.json()),
  readOnly: z.boolean(), execution: z.enum(["parallel-read", "exclusive"]), approvalRequired: z.boolean(),
});
const catalogPage = z.strictObject({
  schema: z.literal("pkm.tool-catalog/v1"), revision: z.string().regex(/^[a-f0-9]{64}$/),
  items: z.array(catalogItem).max(10), total: z.number().int().min(0).max(1024),
  nextOffset: z.number().int().min(0).max(1024).nullable(),
});
function canonicalCatalogItem(item: unknown): string {
  const canonical = toolCanonicalJson(item);
  if (Buffer.byteLength(canonical) > 131_072 || !catalogItem.safeParse(JSON.parse(canonical)).success)
    throw new CoreError("INVALID_RESULT", "Invalid bounded tool catalog entry.");
  return canonical;
}

/** Catalog size grows independently of model argument limits; each descriptor remains bounded. */
export function toolCatalogDigest(items: readonly unknown[]): string {
  if (!Array.isArray(items) || items.length > 1024) throw new CoreError("INVALID_RESULT", "Tool catalog exceeds entry bounds.");
  const hash = createHash("sha256").update("[");
  let bytes = 2;
  for (const [index, item] of items.entries()) {
    const canonical = canonicalCatalogItem(item);
    bytes += Buffer.byteLength(canonical) + (index ? 1 : 0);
    if (bytes > 16_777_216) throw new CoreError("INVALID_RESULT", "Tool catalog exceeds byte bounds.");
    if (index) hash.update(",");
    hash.update(canonical);
  }
  return hash.update("]").digest("hex");
}

export function validateToolCatalogPage<T extends { items: readonly unknown[] }>(page: T): T {
  for (const item of page.items) canonicalCatalogItem(item);
  const validated = catalogPage.safeParse(page);
  if (!validated.success || Buffer.byteLength(JSON.stringify(validated.data)) > 131_072)
    throw new CoreError("INVALID_RESULT", "Tool catalog page exceeds validated output bounds.");
  return freezeToolJson(page);
}

export function freezeToolJson<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) freezeToolJson(entry);
    Object.freeze(value);
  }
  return value;
}

export function redactToolOutput(value: unknown): unknown {
  let count = 0;
  const visit = (item: unknown, depth: number): unknown => {
    if (++count > 8192 || depth > 16) throw new CoreError("INVALID_RESULT", "Tool output exceeds structural bounds.");
    if (typeof item === "string") return item
      .replace(/\b(Bearer\s+)[^\s"'<>]+/gi, "$1[REDACTED]")
      .replace(/\b((?:api[_-]?key|password|secret|access[_-]?token|authorization)\s*[:=]\s*)[^\s,;"']+/gi, "$1[REDACTED]")
      .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1[REDACTED]@")
      .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[REDACTED]");
    if (item === null || typeof item === "boolean" || typeof item === "number") return item;
    if (Array.isArray(item)) return item.map(entry => visit(entry, depth + 1));
    if (!item || typeof item !== "object") throw new CoreError("INVALID_RESULT", "Expected portable tool output.");
    return Object.fromEntries(Object.entries(item).map(([key, entry]) =>
      [key, /password|secret|token|authorization|credential|api[_-]?key|private[_-]?key/i.test(key) ? "[REDACTED]" : visit(entry, depth + 1)]));
  };
  return visit(value, 0);
}

export function toolResultContent(result: ToolGatewayResult): string {
  if (result.status === "complete") return typeof result.result === "string" ? result.result : JSON.stringify(result.result);
  return JSON.stringify({ error: result.error, effect: result.effect, retry: result.retry });
}

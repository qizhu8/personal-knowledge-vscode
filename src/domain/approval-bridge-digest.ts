import { createHash } from "node:crypto";
import type { ApprovalBridgeContext } from "../approval-bridge-contracts.js";
import type { ExecutionRecord } from "../execution-state.js";

export function approvalBridgeJSON(value: unknown): string {
  const ancestors = new Set<object>();
  const encode = (item: unknown): string => {
    if (item === null || typeof item === "boolean" || typeof item === "string") return JSON.stringify(item);
    if (typeof item === "number" && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== "object" || !item || ancestors.has(item)) throw new Error("Expected finite, acyclic JSON.");
    if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item)))
      throw new Error("Expected plain JSON.");
    ancestors.add(item);
    let result: string;
    if (Array.isArray(item)) {
      if (Object.keys(item).length !== item.length) throw new Error("Expected dense JSON array.");
      result = `[${item.map(encode).join(",")}]`;
    } else {
      result = `{${Object.keys(item).sort().map(key => {
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
        if (!("value" in descriptor)) throw new Error("JSON accessors are not supported.");
        return `${JSON.stringify(key)}:${encode(descriptor.value)}`;
      }).join(",")}}`;
    }
    ancestors.delete(item);
    return result;
  };
  return encode(value);
}
export function approvalBridgeDigest(value: unknown): string {
  return createHash("sha256").update(approvalBridgeJSON(value)).digest("hex");
}
export function approvalBridgeRecordDigest(workspaceId: string, record: ExecutionRecord, context: ApprovalBridgeContext, operationId: string): string {
  return approvalBridgeDigest({ workspaceId, record, context, operationId });
}
export function approvalBridgeFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) approvalBridgeFreeze(child);
    Object.freeze(value);
  }
  return value;
}

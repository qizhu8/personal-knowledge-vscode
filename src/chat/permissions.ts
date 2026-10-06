import { createHash } from "crypto";

export interface ToolSafetyHints { readOnlyHint?: boolean; destructiveHint?: boolean; }

export function toolPermissionScope(source: string, name: string, hints?: ToolSafetyHints): string {
  if (hints?.readOnlyHint === true && hints.destructiveHint !== true) return "read-only";
  if (hints?.destructiveHint === false) return "non-destructive";
  return "tool:" + createHash("sha256").update(JSON.stringify([source, name])).digest("hex");
}
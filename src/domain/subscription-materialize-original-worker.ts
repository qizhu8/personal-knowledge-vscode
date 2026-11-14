import { createHash } from "node:crypto";

export function hash(value: Buffer | string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function safeRelativePath(...parts: unknown[]): string {
  const cleaned = parts.flatMap(part => String(part || "").replace(/\\/g, "/").split("/"))
    .map(part => part.trim().replace(/[<>:"|?*\u0000-\u001f]/g, "-")).filter(part => part && part !== "." && part !== "..");
  return cleaned.length ? cleaned.join("/") : "untitled";
}

import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { CoreError, type StorageRequest } from "./contracts.js";
import { syncPlanHash } from "./sync-plan.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const pinSchema = z.strictObject({
  actorId: z.string().min(1).max(256), operationId: z.string().uuid(),
  operation: z.string().min(1).max(256), bodySha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type BrowserMutationPin = z.infer<typeof pinSchema>;
export type BrowserMutationReceipt = { state: "pending" | "unknown" }
  | BrowserMutationPin & { state: "committed"; receiptSha256: string };
export type BrowserMutationReceiptControl = {
  bind: { request: StorageRequest; bodySha256: string; receiptMode: "worker" | "unknown" };
} | { read: BrowserMutationPin };

export function initializeBrowserMutationPins(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS browser_mutation_pins (
    actor_id TEXT NOT NULL, operation_id TEXT NOT NULL, operation TEXT NOT NULL,
    body_sha256 TEXT NOT NULL, receipt_fingerprint TEXT,
    PRIMARY KEY(actor_id,operation_id,operation,body_sha256)
  )`);
}

/** Transport-body pins and worker receipt fingerprints are distinct hash domains. */
export function storageMutationFingerprint(request: StorageRequest, kind: "standard" | "batch04" | "todo" = "standard") {
  const { operation, actorId, args } = request;
  if (kind === "todo") return digest(JSON.stringify(request));
  if (kind === "batch04") return syncPlanHash({ operation, actorId, args,
    ...(operation.startsWith("collaboration.state.") ? { collaborationKind: request.collaborationKind ?? "agent" } : {}) });
  return digest(JSON.stringify({ operation, actorId, args }));
}

export function bindBrowserMutationPin(db: DatabaseSync, request: StorageRequest, bodySha256: string, fingerprint: string | null) {
  const pin = pinSchema.parse({ actorId: request.actorId, operation: request.operation,
    operationId: request.args.operationId ?? request.args.operation_id, bodySha256 });
  const receipt = db.prepare("SELECT actor_id,operation,fingerprint FROM receipts WHERE operation_id=?").get(pin.operationId);
  if (fingerprint !== null && receipt && (receipt.actor_id !== pin.actorId || receipt.operation !== pin.operation
    || receipt.fingerprint !== fingerprint))
    throw new CoreError("CONFLICT", "operationId belongs to a different request or actor.");
  const prior = db.prepare(`SELECT receipt_fingerprint FROM browser_mutation_pins
    WHERE actor_id=? AND operation_id=? AND operation=? AND body_sha256=?`)
    .get(pin.actorId, pin.operationId, pin.operation, pin.bodySha256);
  if (prior && prior.receipt_fingerprint !== fingerprint)
    throw new CoreError("CONFLICT", "The operation pin belongs to another dispatch context.");
  if (!prior) db.prepare("INSERT INTO browser_mutation_pins VALUES(?,?,?,?,?)")
    .run(pin.actorId, pin.operationId, pin.operation, pin.bodySha256, fingerprint);
}

export function readBrowserMutationReceipt(db: DatabaseSync, value: BrowserMutationPin): BrowserMutationReceipt {
  const pin = pinSchema.parse(value);
  const binding = db.prepare(`SELECT receipt_fingerprint FROM browser_mutation_pins
    WHERE actor_id=? AND operation_id=? AND operation=? AND body_sha256=?`)
    .get(pin.actorId, pin.operationId, pin.operation, pin.bodySha256);
  if (typeof binding?.receipt_fingerprint !== "string") return { state: "unknown" };
  const receipt = db.prepare(`SELECT operation_id,actor_id,operation,fingerprint,result,committed_at
    FROM receipts WHERE operation_id=? AND actor_id=? AND operation=? AND fingerprint=?`)
    .get(pin.operationId, pin.actorId, pin.operation, binding.receipt_fingerprint);
  if (receipt) return { state: "committed", ...pin, receiptSha256: digest(JSON.stringify({
    operationId: receipt.operation_id, actorId: receipt.actor_id, operation: receipt.operation,
    fingerprint: receipt.fingerprint, resultSha256: digest(String(receipt.result)), committedAt: receipt.committed_at,
  })) };
  for (const table of ["pending_write", "pending_todo", "pending_resource", "pending_document_lifecycle", "pending_project_mutation"]) {
    if (db.prepare(`SELECT 1 FROM ${table} WHERE operation_id=? AND actor_id=? AND operation=? AND fingerprint=?`)
      .get(pin.operationId, pin.actorId, pin.operation, binding.receipt_fingerprint)) return { state: "pending" };
  }
  return { state: "unknown" };
}

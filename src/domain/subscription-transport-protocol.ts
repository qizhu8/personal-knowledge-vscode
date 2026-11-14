import { z } from "zod";
import { CoreError } from "../contracts.js";
import { subscriptionMaterializeLimits } from "../subscription-materialize-contracts.js";
import { verifyShareSummary } from "./subscription-transport-original-summary.js";

export const transportDigest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const transportSummarySchema = z.strictObject({
  shareId: z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/), name: z.string().min(1).max(256),
  revision: z.number().int().safe().nonnegative(), collectionHash: transportDigest,
  updatedAt: z.string().datetime(), counts: z.record(z.string(), z.number().int().nonnegative()),
  topics: z.array(z.string().max(256)).max(100), tags: z.array(z.string().max(256)).max(100),
  itemCount: z.number().int().nonnegative(), snapshotBytes: z.number().int().positive().max(subscriptionMaterializeLimits.snapshotBytes),
  metadataOnly: z.literal(true), secretProtected: z.boolean().optional(), secretSalt: z.string().optional(),
  signature: z.string().regex(/^[A-Za-z0-9_-]+$/).max(1024),
});
export const transportTicketSchema = z.strictObject({
  brokerUrl: z.string().max(2048), ticket: z.string().regex(/^[A-Za-z0-9_-]{16,256}$/),
  expiresAt: z.string().datetime(), revision: z.number().int().safe().nonnegative(), collectionHash: transportDigest,
});
export type TransportSummary = z.infer<typeof transportSummarySchema>;
export function transportError(code: string, message: string): never { throw new CoreError(code, message); }
export function signedTransportSummary(value: unknown, publicKey: string, nodeId: string, shareId: string): TransportSummary {
  // Do not parse/reorder before original signature verification: JSON insertion order is part of the wire signature.
  try { verifyShareSummary(value, publicKey, nodeId, shareId); }
  catch { transportError("ACCESS_DENIED", "Subscription publisher signature/identity is invalid."); }
  const parsed = transportSummarySchema.safeParse(value);
  if (!parsed.success) transportError("INVALID_ARGUMENT", "Unsupported or malformed gateway summary.");
  if (parsed.data.secretProtected) transportError("UNSUPPORTED", "Secret-protected encrypted snapshots are not supported by this transport.");
  return parsed.data;
}

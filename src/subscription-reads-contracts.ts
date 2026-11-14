import { z } from "zod";

const text = z.string().max(2048);
const identity = z.string().min(1).max(256).refine(value => !/[\/\\\0]/.test(value) && value !== "." && value !== "..");
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const pin = { expectedRevision: revision.optional() };
const counts = z.record(text, z.number().int().safe().nonnegative());
export const subscriptionMetadata = z.strictObject({
  id: identity, alias: text, priority: z.enum(["normal", "high", "highest"]), brokerName: text,
  nodeId: identity, publisher: text, publisherUser: text, publisherHost: text, shareId: identity,
  revision: z.number().int().safe().nonnegative(), collectionHash: text,
  topics: z.array(text).max(4096), tags: z.array(text).max(4096), counts,
  itemCount: z.number().int().safe().nonnegative(),
  lastChecked: text.optional(), lastUpdated: text.optional(),
  status: z.enum(["new", "current", "updating", "offline", "error"]),
});
const listInput = z.strictObject({
  ...pin, offset: z.number().int().safe().nonnegative().default(0),
  limit: z.number().int().min(1).max(100).default(50),
});
const getInput = z.strictObject({ ...pin, id: identity });
const aclInput = z.strictObject({
  ...pin, shareId: identity, action: z.string().min(1).max(128),
  sourceIp: z.string().max(256),
});
const policy = z.strictObject({
  shareId: identity, accountMode: z.enum(["open", "block-list", "white-list"]),
  accountRules: z.array(text).max(128), networkMode: z.enum(["block-list", "white-list"]),
  ipRules: z.array(text).max(128), automaticBlocks: z.array(text).max(128),
});
export const subscriptionReadDefinitions = [
  {
    id: "subscription.list", readOnly: true,
    description: "List redacted persisted local subscription metadata from an isolated snapshot; no remote reads or writes.",
    input: listInput,
    output: z.strictObject({
      revision, total: z.number().int().nonnegative(), items: z.array(subscriptionMetadata),
      nextOffset: z.number().int().nonnegative().nullable(),
    }),
  },
  {
    id: "subscription.get", readOnly: true,
    description: "Get one redacted persisted local subscription by id; missing records are NOT_FOUND.",
    input: getInput,
    output: z.strictObject({ revision, subscription: subscriptionMetadata }),
  },
  {
    id: "subscription.acl.evaluate", readOnly: true,
    description: "Evaluate original persisted broker ACL for the trusted actorId. Pure policy simulation, not a remote authorization grant or secret/proof check.",
    input: aclInput,
    output: z.strictObject({
      revision, shareId: identity, actorId: z.string().min(1).max(256),
      action: z.string(), sourceIp: z.string(), allowed: z.boolean(),
      policy, evaluationOnly: z.literal(true),
    }),
  },
  {
    id: "subscription.identity.get", readOnly: true,
    description: "Read receipt-bound public subscription identity and authoritative external native reference. No signing, grants, broker or provider restoration.",
    input: z.strictObject({}),
    output: z.strictObject({
      nodeId: revision, publicKey: z.string().max(16384), secretRef: text, authorityId: text,
      signing: z.literal("unavailable"), grants: z.literal("unavailable"),
      broker: z.literal("unavailable"), provider: z.literal("unavailable"),
    }),
  },
] as const;

export type SubscriptionReadRequest = {
  operation: string;
  args: Record<string, unknown>;
  actorId: string;
};

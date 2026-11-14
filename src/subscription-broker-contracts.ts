import { z } from "zod";

const text = z.string().max(2048);
const identity = z.string().min(1).max(256).refine(value => !/[\/\\\0]/.test(value) && value !== "." && value !== "..");
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const scalar = z.union([text, z.number(), z.boolean(), z.null()]);
const item = z.looseObject({
  name: scalar.optional(), slug: scalar.optional(), project: scalar.optional(), task: scalar.optional(),
  path: scalar.optional(), category: scalar.optional(), file: scalar.optional(), recipeId: scalar.optional(),
  topic: scalar.optional(), metadata: z.looseObject({ category: scalar.optional() }).nullable().optional(),
}).catchall(z.json());
const marker = z.strictObject({
  brokers: z.array(z.strictObject({ id: identity, name: text, published: z.boolean() })),
});

export const subscriptionBrokerDefinitions = [{
  id: "subscription.broker.share-markers", readOnly: true,
  description: "Calculate local broker share markers for supplied content projections from the authorized isolated subscription snapshot; no remote transport or secret access.",
  input: z.strictObject({
    type: z.enum(["skills", "notes", "papers", "prompts", "scripts", "packages", "recipes", "servers"]),
    items: z.array(item).max(4096),
    expectedRevision: revision.optional(),
  }).refine(value => Buffer.byteLength(JSON.stringify(value.items)) <= 1024 * 1024),
  output: z.strictObject({
    revision, items: z.record(text, marker), folders: z.record(text, marker),
  }),
}] as const;

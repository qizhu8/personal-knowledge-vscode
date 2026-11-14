import { z } from "zod";
import { documentPath } from "./document-path.js";
import { skillRecord } from "./skill-contracts.js";

export const SKILL_ROUTING_MAX_RECORDS = 4096;
export const SKILL_ROUTING_MAX_SNAPSHOT_BYTES = 33_554_432;
export const SKILL_ROUTING_MAX_RESULT_BYTES = 262_144;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const text = z.string().max(4096).refine(value => Buffer.byteLength(value, "utf8") <= 8192
  && Buffer.from(value, "utf8").toString("utf8") === value, "Valid UTF-8, maximum 8192 bytes.");
const sourcePriority = z.array(z.string().min(1).max(500)).max(100).default([]);
const pin = { snapshotRevision: digest.optional() };
const paging = { offset: count.max(1_000_000).default(0), limit: count.min(1).max(100).default(20) };
const adapter = z.strictObject({ id: z.string(), available: z.literal(false), reason: z.string() });
const common = { snapshotRevision: digest, adapters: z.array(adapter) };
const address = z.strictObject({ documentId: z.string(), path: documentPath, documentSha256: digest });
const selection = z.strictObject({
  id: z.string(), label: z.string(), sourceId: z.string(), sourceRevision: z.string(), contentHash: digest,
  content: z.string().optional(), reason: z.string(), address,
});
const sources = z.array(z.strictObject({
  id: z.string(), label: z.string(), kind: z.enum(["personal", "native", "subscriber"]), detail: z.string(),
}));
const selected = z.array(z.strictObject({ id: z.string().min(1).max(500), documentSha256: digest.optional() })).max(20);
const message = z.strictObject({ role: z.enum(["system", "user", "assistant", "tool"]), content: z.string() });
const linkage = z.strictObject({
  recipe_required: z.boolean(), recipe_hint: z.string(), related_skills: z.array(z.string()), related_recipes: z.array(z.never()),
  next_action: z.strictObject({
    kind: z.literal("search_or_create_recipe"), search_query: z.string(), search_tool: z.literal("recipe_search"),
    create_tool: z.literal("recipe_create_from_skill"), instruction: z.string(),
  }).optional(),
});
const contextItem = z.strictObject({
  skill_id: z.string(), name: z.string(), description: z.string(), category: z.string().optional(), tags: z.array(z.string()).optional(),
  source_project: z.string().nullable().optional(), source: z.literal("local"), read_only: z.boolean(),
  source_key: z.literal("pkm-personal"), source_rank: count, skill_priority: z.enum(["normal", "high", "highest"]),
  content_hash: digest, score: z.number().optional(), task_coverage: z.number(), priority: z.enum(["required", "recommended"]),
  match_reason: z.array(z.string()), linkage, address,
});
export const skillRoutingDefinitions = [
  {
    id: "knowledge.skill.routing.sources", readOnly: true,
    description: "Original fixed PKM Personal / Agent Native source defaults and priority normalization. All routing queries pin the entire active Skill snapshot (raw SHA, projected metadata/body, stable identities and mtime), bounded to 4096 records, 32 MiB raw and 32 MiB serialized pins. Results cap 256 KiB UTF-8 without prefixes/partial results. Host-native/subscription/Recipe/retrieval adapters are unavailable.",
    input: z.strictObject({ sourcePriority, ...pin }),
    output: z.strictObject({ sources, sourcePriority: z.array(z.string()), ...common }),
  },
  {
    id: "knowledge.skill.routing.context", readOnly: true,
    description: "Original MCP metadata-threshold fallback: task anchors/coverage, 12/8/8/6/10 weights, body/context tie-breakers, high/highest boosts, protected exact IDs, original 1–5 selection cap, compact/full candidate detail and Recipe linkage guidance. Boundary retrieval/subscription/Recipe state are unavailable, never inferred empty or executed.",
    input: z.strictObject({ task: text.refine(value => !!value.trim(), "task is required"), workspace: text.default(""),
      files: z.array(text).max(100).default([]), diagnostics: text.default(""), limit: count.min(1).max(5).default(3),
      detail: z.enum(["compact", "full"]).default("compact"), sourcePriority, ...pin }),
    output: z.strictObject({ items: z.array(contextItem), count, noMatch: z.boolean(),
      sourcePriority: z.array(z.string()), sourcePolicy: z.string(), ...common }),
  },
  {
    id: "knowledge.skill.routing.select", readOnly: true,
    description: "Captured original Chat fallback automaticChatSkills: score JSON body-free Skill metadata using original Unicode memoryTerms/memoryMatchScore, stable descending score ties, cap 20, skip empty bodies. Exact original category/tag filters and category/name ordering precede selection. Page with snapshotRevision; no semantic worker/model invoked.",
    input: z.strictObject({ query: text, category: z.string().max(2048).optional(), tag: z.string().max(500).optional(),
      ...paging, ...pin }),
    output: z.strictObject({ items: z.array(selection), total: count, nextOffset: count.nullable(), ...common }),
  },
  {
    id: "knowledge.skill.routing.project", readOnly: true,
    description: "Project up to 20 explicitly selected local Skills in supplied order (stable document/knowledge IDs or exact unambiguous names), preserving full body, metadata, recipe hints and SHA pins. Optional routerId renders the original pkm-managed SKILL.md text from raw isolated source; returns text only, never installs or executes.",
    input: z.strictObject({ selected, routerId: z.string().min(1).max(500).optional(),
      target: z.enum(["copilot", "agents", "claude", "custom"]).default("agents"),
      extensionVersion: z.string().max(100).default("unknown"), ...pin }),
    output: z.strictObject({ items: z.array(skillRecord.extend({ address, linkage })),
      projection: z.strictObject({ content: z.string(), sourceHash: digest, address }).nullable(), ...common }),
  },
  {
    id: "knowledge.skill.routing.prompt", readOnly: true,
    description: "Captured exact original pre-answer relevance prompt and ranked knowledgeCandidatePriority for selected local sources (1–8 unique), optionally parse supplied JSON judgments (true/false/unknown). Prompt projection only; no model call, automatic learning, permissions or execution.",
    input: z.strictObject({ query: text, selected: selected.min(1).max(8),
      judgments: z.string().max(8000).optional(), ...pin }),
    output: z.strictObject({ messages: z.array(message), sourceIds: z.array(z.string()),
      priorities: z.array(z.strictObject({ id: z.string(), priority: z.number() })),
      selection: z.strictObject({ relevant: z.array(z.string()), judged: z.array(z.string()) }).nullable(), ...common }),
  },
] as const;

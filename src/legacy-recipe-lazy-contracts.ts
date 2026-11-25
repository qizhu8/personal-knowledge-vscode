import { z } from "zod";

const text = z.string().max(262144);
const detail = z.string().max(64);
const run = z.string().max(256);
export const legacyRecipeLazyInputs = {
  "mcp.tool.recipe_run_start": z.strictObject({
    recipe_id: run, command_id: text, inputs_json: text.default("{}"), project_id: run.default(""),
    expected_revision: z.number().int().default(0), expected_digest: text.default(""),
    detail: detail.default("compact"), autonomous: z.boolean().default(false),
    max_auto_nodes: z.number().int().min(1).max(1000).default(100),
    max_auto_seconds: z.number().int().min(1).max(3600).default(300),
  }),
  "mcp.tool.recipe_run_get": z.strictObject({ run_id: run, detail: detail.default("full") }),
  "mcp.tool.recipe_run_next": z.strictObject({
    run_id: run, command_id: text, detail: detail.default("compact"),
  }),
  "mcp.tool.recipe_run_progress": z.strictObject({
    run_id: run, node_id: run, command_id: text, progress_json: text.default("{}"), detail: detail.default("compact"),
  }),
  "mcp.tool.recipe_run_report": z.strictObject({
    run_id: run, node_id: run, outcome: text, command_id: text, result_json: text.default("null"),
    error: text.default(""), usage_json: text.default("null"), detail: detail.default("compact"),
  }),
  "mcp.tool.recipe_run_submit_input": z.strictObject({
    run_id: run, node_id: run, challenge_id: text, response_json: text,
    command_id: text, detail: detail.default("compact"),
  }),
} as const;
export type LegacyRecipeLazyOperation = keyof typeof legacyRecipeLazyInputs;
export const legacyRecipeLazyOperations = new Set<string>(Object.keys(legacyRecipeLazyInputs));
export const legacyRecipeLazyDefinitions = Object.entries(legacyRecipeLazyInputs).map(([id, input]) => ({
  id, input, readOnly: false as const, output: z.record(z.string(), z.json()),
  description: id.endsWith("_get")
    ? "Original lazy Recipe inspection synchronizes durable execution/terminal state and may mutate; requires explicit host authority, never a read-only alias."
    : id.endsWith("_submit_input")
      ? "Submit explicit current user input to the exact waiting human gate challenge; ordinary Recipe reports cannot replace this evidence."
      : "Original controlled Recipe lifecycle; lazy by default, bounded autonomous command/Script dispatch only with exact pinned host adapters; durable receipts and explicit report/human boundaries, never arbitrary executables.",
}));

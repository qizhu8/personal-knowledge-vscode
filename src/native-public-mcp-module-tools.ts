import type { Tool } from "@modelcontextprotocol/sdk/types.js";

interface Operation {
  id: string;
  transportName: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown> | null;
  readOnly: boolean;
}
const shortcuts = [
  ["skill_read", "get_skill", "Read stored Skill content. This does not execute the Skill or a Recipe."],
  ["skill_write", "add_skill", "Create/upsert a Skill using add_skill semantics; an existing name may be overwritten. Use skill_modify for partial updates."],
  ["skill_modify", "update_skill", "Modify an existing Skill. Unspecified fields retain their existing meaning."],
  ["skill_list", "list_skills", "List Skills using the canonical filters and limits."],
  ["skill_search", "search_skills", "Search Skill content, not PKM actions. Use this when the Skill name or ID is unknown."],
  ["note_read", "get_note", "Read stored Note content by its canonical ID or slug."],
  ["note_write", "add_note", "Create a Note. Existing-note conflicts are preserved; use note_modify to update."],
  ["note_modify", "update_note", "Modify an existing Note using its slug and the canonical update fields."],
  ["note_list", "list_notes", "List Notes using the canonical filters and limits."],
  ["note_search", "search_notes", "Search Note content, not PKM actions. Use this when the Note slug or ID is unknown."],
  ["paper_read", "get_paper", "Read stored Paper/Research content by its canonical ID or slug."],
  ["paper_write", "add_paper", "Create a Paper/Research entry. Existing-entry conflicts are preserved; use paper_modify to update."],
  ["paper_modify", "update_paper", "Modify an existing Paper/Research entry using the canonical update fields."],
  ["paper_list", "list_papers", "List Papers/Research entries using the canonical filters and limits."],
  ["paper_search", "search_papers", "Search Paper/Research content, not PKM actions."],
  ["script_read", "get_script", "Read Script content by source ID. This never executes the Script."],
  ["script_search", "search_scripts", "Search Script content and obtain a source ID for script_read. This never executes a Script."],
  ["retrieval_search", "search_knowledge", "Search content across the typed knowledge index. This is not capability/action discovery."],
] as const;

export interface DirectModuleTool {
  readonly tool: Tool;
  readonly operationId: string;
  readonly readOnly: boolean;
}

export function directModuleTools(operations: readonly Operation[], admitted: ReadonlySet<string>,
  writable: boolean): DirectModuleTool[] {
  const byName = new Map(operations.map(operation => [operation.transportName, operation]));
  const result: DirectModuleTool[] = [];
  for (const [name, canonical, description] of shortcuts) {
    const operation = byName.get(canonical);
    if (!operation) throw new Error(`INVALID_CONFIGURATION: Direct module tool has no canonical release contract: ${canonical}`);
    if (!admitted.has(operation.id) || !writable && !operation.readOnly) continue;
    if (operation.inputSchema.type !== "object" || operation.outputSchema && operation.outputSchema.type !== "object")
      throw new Error(`INVALID_CONFIGURATION: Direct module tool requires canonical object schemas: ${canonical}`);
    const module = name.split("_")[0]!;
    const tool: Tool = {
      name, description: `${description} Same permissions and results as ${operation.id}.`,
      inputSchema: { ...operation.inputSchema, type: "object" },
      ...(operation.outputSchema ? { outputSchema: { ...operation.outputSchema, type: "object" as const } } : {}),
      annotations: { readOnlyHint: operation.readOnly, destructiveHint: !operation.readOnly, openWorldHint: true },
      _meta: { pkm: { module, canonicalOperationId: operation.id } },
    };
    result.push({ tool, operationId: operation.id, readOnly: operation.readOnly });
  }
  return result;
}

export function directModuleInstructions(tools: readonly DirectModuleTool[]): string {
  const modules = new Map<string, string[]>();
  for (const { tool } of tools) {
    const module = tool.name.split("_")[0]!, entries = modules.get(module) ?? [];
    entries.push(tool.name);
    modules.set(module, entries);
  }
  return [
    "Use the visible module tools directly for common content tasks; no discovery call is required first.",
    ...[...modules].map(([module, names]) => `${module}: ${names.join(", ")}.`),
    "Content search (*_search) finds documents. capabilities_search discovers PKM actions and their exact contracts.",
    "For less common actions, search using a module and a verb, for example 'recipe run', 'action validate', or 'chat send'.",
    "If you do not know what to search, browse capabilities_list and follow nextOffset; do not invent operation IDs.",
    "Execute discovered readOnly=true operations with capability_read, mutations with capability_call, and pin version 1.",
    "Direct tools are aliases of those same operations, not extra authority. Discovery never executes a function or grants permission.",
    "skill_write preserves add_skill create/upsert behavior; use skill_modify for targeted partial changes.",
  ].join("\n");
}

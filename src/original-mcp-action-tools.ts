export const originalMcpActionAuthoringTools = Object.freeze([
  "action_register", "action_graph_save", "action_template_create", "action_proposals", "action_retrieve",
  "action_capabilities", "action_definition_check", "action_graph_check",
  "action_module_sets", "action_module_set_import", "action_module_set_load", "action_module_set_remove", "action_module_set_export",
  "action_artifact_import", "action_artifact_export",
] as const);
export const originalMcpActionRuntimeTools = Object.freeze([
  "action_run_events", "action_run_cancel", "action_run_wait", "action_run_checkpoints", "action_checkpoint_respond",
  "action_run_wake", "action_run_recover", "action_run_safety_scan", "action_implementation_select",
  "action_validate", "action_validation_enqueue", "action_validation_status", "action_validation_cancel", "action_validation_resume",
  "action_run_get", "action_get", "action_module_sets", "action_run_reconcile", "action_call",
  "action_run_gc", "action_cosmos_configure",
] as const);
export const originalMcpActionAuthoringOperationIds: readonly string[] = Object.freeze(
  originalMcpActionAuthoringTools.map(tool => `mcp.tool.${tool}`));
export const originalMcpActionOperationIds: readonly string[] = Object.freeze(
  originalMcpActionRuntimeTools.map(tool => `mcp.tool.${tool}`));
export function originalMcpActionAuthoringTool(tool: string): boolean {
  return (originalMcpActionAuthoringTools as readonly string[]).includes(tool);
}

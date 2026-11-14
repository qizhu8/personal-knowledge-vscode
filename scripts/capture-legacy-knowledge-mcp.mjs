import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const mode = process.argv[2];
if (process.argv.length !== 3 || !["--check", "--capture"].includes(mode))
  throw new Error("Usage: node scripts/capture-legacy-knowledge-mcp.mjs --check|--capture");
const source = ts.createSourceFile("mcp.ts", await readFile(resolve(root, "legacy/src/mcp/mcp.ts"), "utf8"),
  ts.ScriptTarget.Latest, true);
let template;
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(source) === "fs.writeFileSync"
    && node.arguments[0]?.getText(source) === "serverPy" && node.arguments[1] && ts.isTemplateExpression(node.arguments[1])
    && node.arguments[1].head.text.includes("PKM MCP Server")) {
    if (template !== undefined) throw new Error("Ambiguous original MCP generator.");
    template = node.arguments[1].head.text + node.arguments[1].templateSpans
      .map(span => `__CAPTURE_ONLY__${span.literal.text}`).join("");
  }
  ts.forEachChild(node, visit);
}
visit(source);
if (template === undefined) throw new Error("Original MCP Python generator was not found.");
const helpers = ["_now", "_parse", "_name_of", "_cat_of", "_walk", "_mtime", "_arr", "_year", "_norm_cites",
  "_paper", "_all_papers", "_paper_get", "_paper_resolver", "_citation_counts", "_knowledge_read_key", "_canonical_knowledge_id",
  "_mcp_system_path", "_note", "_all_notes", "_note_get", "_note_hash", "_skill_priority", "_skill",
  "_skill_image_assets", "_all_skills", "_skill_id", "_skill_by_id", "_skill_hash", "_skill_linkage",
  "_skill_source_key", "_skill_source_rank", "_index", "_search_typed_knowledge", "_search_papers_legacy",
  "_router_config", "_router_source_priority", "_enabled_router_solutions", "_disabled_router_response",
  "_skill_terms", "_subscription_records", "_find_skill", "_assert_mcp_writable", "_matches_retrieval_types", "_retrieval_hit_linkage"];
const tools = ["list_papers", "list_research", "get_research", "get_paper", "paper_graph", "get_note", "list_skills",
  "get_skill", "search_notes", "search_skills", "search_research", "search_papers", "list_subscriptions",
  "search_subscribed_content", "get_subscribed_content", "get_subscribed_content_by_path",
  "add_note", "update_note", "add_skill", "update_skill", "add_paper", "update_paper",
  "skill_capabilities", "skill_context", "delete_note", "delete_skill", "delete_paper",
  "get_knowledge", "get_script", "search_knowledge", "search_scripts", "skill_feedback", "propose_skill_update", "retrieval_status", "retrieval_feedback"];
const nativeTools = ["note_work_items", "note_work_item_notes", "note_work_item_command", "note_work_item_upsert", "todo_board_create"];
const agentTools = ["agent_session_capabilities", "agent_session_snapshot_list", "agent_session_snapshot_read"];
const recipeTools = ["recipe_search", "recipe_usage_summary"];
const trashTools = ["knowledge_file_trash"];
const assetClassificationTools = ["asset_classify_preview", "asset_classify_apply", "asset_classify_rollback"];
const recoveryTools = ["knowledge_recovery_preview", "knowledge_recovery_apply"];
const snapshotTools = ["knowledge_snapshot_status", "knowledge_snapshot_create", "knowledge_snapshot_configure",
  "knowledge_snapshot_restore_preview", "knowledge_snapshot_restore_apply"];
const actionTools = ["action_definition_check", "action_graph_check", "action_templates", "action_template_create", "action_register", "action_proposals", "action_graph_save", "action_get",
  "action_module_sets", "action_module_set_import", "action_module_set_load", "action_module_set_remove",
  "action_artifact_import", "action_artifact_export"];
const extracted = spawnSync("python3", ["-c", `
import ast, json, sys
payload = json.load(sys.stdin)
tree = ast.parse(payload["template"])
functions = {node.name: node for node in tree.body if isinstance(node, ast.FunctionDef)}
names = payload["helpers"] + payload["tools"]
parts = ["import datetime, hashlib, json, re, urllib.parse, mimetypes, sqlite3, time, uuid\\nfrom pathlib import Path\\nfrom urllib.parse import quote\\nfrom typing import Optional, List\\n"]
recipes = ast.parse(payload["recipes"])
for name in ["_recipe_summary", "related_recipes"]:
    node, = [node for node in recipes.body if isinstance(node, ast.FunctionDef) and node.name == name]
    parts.append(ast.get_source_segment(payload["recipes"], node))
contracts = {}
for node in tree.body:
    if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "_SKILL_STOP_WORDS" for target in node.targets):
        parts.append(ast.get_source_segment(payload["template"], node))
for name in names:
    node = functions[name]
    parts.append(ast.get_source_segment(payload["template"], node))
    if name in payload["tools"]:
        decorator, = node.decorator_list
        if not isinstance(decorator, ast.Call) or not isinstance(decorator.func, ast.Name) or decorator.func.id != "_feature_tool":
            raise ValueError("Unexpected original tool registration: " + name)
        read_only = next((ast.literal_eval(item.value) for item in decorator.keywords if item.arg == "read_only"), False)
        contracts[name] = {"readOnly": read_only, **({"trash": True} if name.startswith("delete_") else {})}
native_tree = ast.parse(payload["nativeSource"])
for name in payload["trashTools"]:
    node, = [node for node in ast.walk(native_tree) if isinstance(node, ast.FunctionDef) and node.name == name]
    parts.append(ast.get_source_segment(payload["nativeSource"], node))
    contracts[name] = {"readOnly": False, "dictionary": True, "trash": True}
for name in payload["nativeTools"]:
    node, = [node for node in ast.walk(native_tree) if isinstance(node, ast.FunctionDef) and node.name == name]
    parts.append(ast.get_source_segment(payload["nativeSource"], node))
    annotations = ast.literal_eval(next(keyword.value for keyword in node.decorator_list[0].keywords if keyword.arg == "annotations"))
    contracts[name] = {"readOnly": annotations["readOnlyHint"], "native": True}
recovery_tree = ast.parse(payload["recoverySource"])
for name in payload["recoveryTools"]:
    node, = [node for node in ast.walk(recovery_tree) if isinstance(node, ast.FunctionDef) and node.name == name]
    parts.append(ast.get_source_segment(payload["recoverySource"], node))
    annotations = ast.literal_eval(next(keyword.value for keyword in node.decorator_list[0].keywords if keyword.arg == "annotations"))
    contracts[name] = {"readOnly": annotations["readOnlyHint"], "dictionary": True, "recovery": True}
action_tree = ast.parse(payload["actionSource"])
for name in payload["actionTools"]:
    node, = [node for node in ast.walk(action_tree) if isinstance(node, ast.FunctionDef) and node.name == name]
    parts.append(ast.get_source_segment(payload["actionSource"], node))
    parts.append(name + ".__annotations__['return'] = dict")
    contracts[name] = {"readOnly": name not in {"action_template_create", "action_register", "action_graph_save", "action_module_set_import", "action_module_set_load", "action_module_set_remove", "action_artifact_import", "action_artifact_export"},
                       "dictionary": True, "action": True}
snapshot_tree = ast.parse(payload["snapshotSource"])
for name in payload["snapshotTools"]:
    node, = [node for node in ast.walk(snapshot_tree) if isinstance(node, ast.FunctionDef) and node.name == name]
    parts.append(ast.get_source_segment(payload["snapshotSource"], node))
    annotations = ast.literal_eval(next(keyword.value for keyword in node.decorator_list[0].keywords if keyword.arg == "annotations"))
    contracts[name] = {"readOnly": annotations["readOnlyHint"], "dictionary": True,
                       "snapshot": True, "annotations": annotations,
                       **({"unavailable": "An actual separately authorized live native scheduler is not attached to this MCP host."}
                          if name == "knowledge_snapshot_configure" else {})}
asset_tree = ast.parse(payload["assetSource"])
for name in payload["assetClassificationTools"]:
    node, = [node for node in ast.walk(asset_tree) if isinstance(node, ast.FunctionDef) and node.name == name]
    parts.append(ast.get_source_segment(payload["assetSource"], node))
    annotations = ast.literal_eval(next(keyword.value for keyword in node.decorator_list[0].keywords if keyword.arg == "annotations"))
    contracts[name] = {"readOnly": annotations["readOnlyHint"], "dictionary": True,
                       "assetClassification": True, "annotations": annotations,
                       "unavailable": "Asset classification native ownership and recovery integration is not yet qualified."}
agent_tree = ast.parse(payload["agentSource"])
for name in payload["agentTools"]:
    node, = [node for node in ast.walk(agent_tree) if isinstance(node, ast.FunctionDef) and node.name == name]
    parts.append(ast.get_source_segment(payload["agentSource"], node))
    contracts[name] = {"readOnly": True, "dictionary": True}
recipe_functions = {node.name: node for node in recipes.body if isinstance(node, ast.FunctionDef)}
recipe_constants = {target.id: node for node in recipes.body if isinstance(node, ast.Assign)
    for target in node.targets if isinstance(target, ast.Name)}
recipe_nodes = {}
for name in payload["recipeTools"]:
    node, = [node for node in ast.walk(recipes) if isinstance(node, ast.FunctionDef) and node.name == name]
    decorator, = node.decorator_list
    if not isinstance(decorator, ast.Name) or decorator.id != "typed_read_only_tool":
        raise ValueError("Unexpected original Recipe read registration: " + name)
    recipe_nodes[name] = node
    contracts[name] = {"readOnly": True, "typed": True}
pending = list(recipe_nodes.values())
while pending:
    node = pending.pop()
    for child in ast.walk(node):
        if not isinstance(child, ast.Name) or not isinstance(child.ctx, ast.Load):
            continue
        name = child.id
        if name == "_project_recipes":
            continue
        dependency = recipe_functions.get(name) or recipe_constants.get(name)
        if dependency is None or name in recipe_nodes:
            continue
        if name in {"_atomic_write", "_compile_definition", "_commit_run", "_file_lock"}:
            raise ValueError("Unsafe dependency in immutable Recipe reads: " + name)
        recipe_nodes[name] = dependency
        pending.append(dependency)
for node in sorted(recipe_nodes.values(), key=lambda node: node.lineno):
    if isinstance(node, ast.FunctionDef) and node.name == "_recipe_summary":
        continue
    parts.append(ast.get_source_segment(payload["recipes"], node))
parts.append("TOOLS = " + repr(contracts))
print("\\n\\n".join(parts) + "\\n")
`], { input: JSON.stringify({ template, helpers, tools,
  recipes: await readFile(resolve(root, "legacy/resources/recipe_runtime.py"), "utf8"),
  nativeSource: await readFile(resolve(root, "legacy/resources/knowledge_mutations.py"), "utf8"), nativeTools,
  recoverySource: await readFile(resolve(root, "legacy/resources/knowledge_recovery.py"), "utf8"), recoveryTools,
  actionSource: await readFile(resolve(root, "legacy/resources/action_runtime.py"), "utf8"), actionTools,
  snapshotSource: await readFile(resolve(root, "legacy/resources/knowledge_snapshots.py"), "utf8"), snapshotTools,
  assetSource: await readFile(resolve(root, "legacy/resources/asset_classification.py"), "utf8"), assetClassificationTools,
  agentSource: await readFile(resolve(root, "legacy/resources/agent_session_runtime.py"), "utf8"), agentTools, recipeTools, trashTools }),
  encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
if (extracted.status !== 0) throw new Error(`Original Python extraction failed: ${extracted.stderr}`);
const target = resolve(root, "compat/legacy-knowledge-captured.py");
const agentTarget = resolve(root, "compat/legacy-agent-captured.py");
const agentSource = await readFile(resolve(root, "legacy/resources/agent_session_runtime.py"), "utf8");
if (mode === "--capture") await writeFile(agentTarget, agentSource);
else if (await readFile(agentTarget, "utf8") !== agentSource)
  throw new Error("Legacy Agent snapshot source capture changed; re-capture and qualify the original tools.");
if (mode === "--capture") await writeFile(target, extracted.stdout);
else if (await readFile(target, "utf8") !== extracted.stdout)
  throw new Error("Legacy Knowledge MCP source capture changed; re-capture and qualify the original tools.");
console.log(`Legacy Knowledge MCP: ${tools.length + nativeTools.length + agentTools.length + recipeTools.length + trashTools.length + recoveryTools.length + actionTools.length + snapshotTools.length + assetClassificationTools.length} exact original tool definitions (${mode}); runtime coverage is assessed separately.`);

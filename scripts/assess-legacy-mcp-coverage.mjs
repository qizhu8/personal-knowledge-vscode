import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const repository = resolve(root, "legacy");
const source = ts.createSourceFile("mcp.ts", await readFile(resolve(repository, "src/mcp/mcp.ts"), "utf8"),
  ts.ScriptTarget.Latest, true);
let template;
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(source) === "fs.writeFileSync"
    && node.arguments[0]?.getText(source) === "serverPy" && ts.isTemplateExpression(node.arguments[1])
    && node.arguments[1].head.text.includes("PKM MCP Server"))
    template = node.arguments[1].head.text + node.arguments[1].templateSpans
      .map(span => `__CAPTURE_ONLY__${span.literal.text}`).join("");
  ts.forEachChild(node, visit);
}
visit(source);
if (!template) throw new Error("Original generated MCP source unavailable.");
const modules = ["knowledge_recovery.py", "knowledge_mutations.py", "knowledge_snapshots.py", "asset_classification.py",
  "agent_session_runtime.py", "api_chat_control.py", "recipe_runtime.py", "action_runtime.py", "todo_api.py",
  "capability_api.py", "chat_server.py.template"];
const sources = { "src/mcp/mcp.ts#serverPy": template };
for (const name of modules) sources[`resources/${name}`] = await readFile(resolve(repository, "resources", name), "utf8");
const assessment = spawnSync("python3", ["-c", `
import ast, hashlib, json, sys
payload = json.load(sys.stdin)
captured = ast.parse(payload["captured"])
contracts = ast.literal_eval(next(node.value for node in captured.body if isinstance(node, ast.Assign)
    and any(isinstance(target, ast.Name) and target.id == "TOOLS" for target in node.targets)))
implemented = {name for name, contract in contracts.items() if not contract.get("unavailable")} | {"list_notes"}
partial = {"add_note", "update_note", "add_skill", "update_skill", "add_paper", "update_paper",
    "search_notes", "search_skills", "search_research", "search_papers", "get_note", "get_skill", "get_paper", "get_research", "skill_context",
    "agent_session_snapshot_list", "agent_session_snapshot_read", "retrieval_status", "retrieval_feedback",
    "delete_note", "delete_skill", "delete_paper", "knowledge_file_trash", "note_work_item_command", "note_work_item_upsert",
    "get_knowledge", "get_script", "search_knowledge", "search_scripts", "todo_board_create",
    "knowledge_recovery_preview", "knowledge_recovery_apply", "action_definition_check", "action_graph_check", "action_template_create",
    "action_register", "action_proposals", "action_graph_save", "action_get", "action_module_sets", "action_module_set_import",
    "action_module_set_load", "action_module_set_remove", "action_artifact_import", "action_artifact_export",
    "knowledge_snapshot_status", "knowledge_snapshot_create",
    "knowledge_snapshot_restore_preview", "knowledge_snapshot_restore_apply", "recipe_run_get",
    "asset_classify_preview", "asset_classify_apply", "asset_classify_rollback",
    "api_chat_capabilities", "api_chat_models", "api_chat_list", "api_chat_get", "api_chat_request_get",
    "recipe_capabilities", "action_capabilities", "action_run_get", "action_retrieve"}
rows = {}
for origin, source in payload["sources"].items():
    tree = ast.parse(source)
    tools = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for decorator in node.decorator_list:
                target = decorator.func if isinstance(decorator, ast.Call) else decorator
                if ((isinstance(target, ast.Attribute) and target.attr == "tool" and isinstance(target.value, ast.Name) and target.value.id == "mcp")
                    or (isinstance(target, ast.Name) and target.id in {"_feature_tool", "typed_tool", "typed_read_only_tool"})):
                    tools.append(node)
        if origin.endswith("action_runtime.py") and isinstance(node, ast.Assign) and any(
                isinstance(target, ast.Name) and target.id == "tools" for target in node.targets) and isinstance(node.value, ast.List):
            names = [entry.id for entry in node.value.elts if isinstance(entry, ast.Name)]
            functions = {item.name: item for item in ast.walk(tree) if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef))}
            tools.extend(functions[name] for name in names)
    for node in tools:
        name = node.name
        if name in rows: raise ValueError("Duplicate original tool name: " + name)
        original_todo = origin.endswith("/todo_api.py")
        capability = origin.endswith("/capability_api.py")
        managed = name in {"check_version", "mcp_lifecycle_status", "mcp_lifecycle_quiesce", "knowledge_snapshot_configure"}
        status = "partial" if name in partial else "implemented" if name in implemented or original_todo or capability else "managed-experimental-only" if managed else "unimplemented"
        if status == "unimplemented":
            blocker = ("resources/action_runtime.py ActionRuntime.configure_cosmos requires operator-approved private host/VC/account bindings, owner-only cosmos-bindings.json and revocation of existing policy.json path grants before rebinding. No native host-bound admission/revocation adapter exists; caller bindings cannot substitute authority or host credentials."
                if name == "action_cosmos_configure" else
                "resources/action_runtime.py ActionRuntime.call/_authorize/_call requires original definition/environment validation, operator policy.json path grants, private Cosmos bindings, Azure CLI host credentials and durable launch/idempotency reconciliation. Effectful Module Actions additionally require original trusted-host one-invocation consent. No generic native action.runtime.create substitution preserves this authority/result contract."
                if name == "action_call" else
                str(contracts[name]["unavailable"]) if name in contracts and contracts[name].get("unavailable") else
                "Original indexed retrieval protocol/model/source-revision adapter is not wired." if name in {
                "get_knowledge","get_script","search_knowledge","search_scripts","retrieval_status","retrieval_feedback"}
                else "Original atomic write/Trash result and deletion-intent adapter is not wired." if name.startswith(("delete_note","delete_skill","delete_paper","knowledge_file_trash"))
                else "Native leaf exists or needs authority/provider configuration, but original MCP signature/result/actor adapter is not wired.")
        elif status == "partial":
            blocker = ("Actual original private-Git create/status/preview/approved restore uses a separately host-admitted fixed actor, canonical workspace/private repository and explicit allowed tool set. Original Git objects/inventories are preserved; portable standalone Markdown restore performs original safety snapshots and native Trash with preview corpus CAS. No workspace-backup or encrypted Snapshot substitution; runtime, Chat, Actions and Recipes are excluded. Boards, Memory, paired assets, unsupported content restore and unapproved scheduling remain unavailable."
                if name in {"knowledge_snapshot_status", "knowledge_snapshot_create", "knowledge_snapshot_restore_preview", "knowledge_snapshot_restore_apply"} else
                "Original portable ModuleSet import/list/selection/removal uses explicitly host-approved fixed source workspace/path/ZIP digest before access. Native immutable ZIP/snapshot admissions and catalog events preserve disabled import and no replacement of enabled versions. Enabled definitions report the next-server runtime as unavailable; this is not a GPT-review gate. Loaded definitions participate in graph/dependency diagnostics but never gain approval, qualification, host trust or execution. UTF-8 bounded portable packages only; arbitrary path grants, export destinations, existing catalog migration and runtime authority remain unavailable."
                if name in {"action_module_sets", "action_module_set_import", "action_module_set_load", "action_module_set_remove"} else
                "Original borrowed artifact import and exclusive export require separately approved exact source and destination paths in one selected workspace, exact source pin/digest and native owner reconciliation of uncertain effects. Linux descriptor-relative paths only; historical artifacts and non-Linux hosts remain unavailable."
                if name in {"action_artifact_import", "action_artifact_export"} else
                "Original poll and monitor templates create pending-only proposals from pinned builtins or selected host-admitted ModuleSets, with validated read-only query and bounded settings. Azure DevOps host-specific template, execution, qualification and approval remain unavailable."
                if name == "action_template_create" else
                "Original classification preview and explicitly selected metadata changes are available only after the separate --allow-asset-classification opt-in in addition to --allow-writes. Admission is immutable and bound to the exact workspace path and actor; apply uses a session-local preview and durable exact-owner journal. Backup restore to a relocated root does not transfer authority, and recovery/rebind remain fenced."
                if name in {"asset_classify_preview", "asset_classify_apply", "asset_classify_rollback"} else
                "Only the isolated native workspace and actor-private Chat records/local VS Code model profiles are exposed; generation, external providers, legacy Hosts, request submission/replay and group membership are unavailable. Request polling fails closed without a native original API Chat receipt store."
                if name in {"api_chat_capabilities", "api_chat_models", "api_chat_list", "api_chat_get", "api_chat_request_get"} else
                "Exposes bounded native Recipe metadata and static workflow compiler limits only. Original Recipe search/create/run lifecycle and provider/autonomous execution are not implemented; compiler results are not runnable."
                if name == "recipe_capabilities" else
                "Only a limited projection of deterministic native Action compiler metadata is available. The original host, registry, scheduler, settings, provider and execution capability fields are unavailable; this does not enable Action runtime or mutation."
                if name == "action_capabilities" else
                "Original retrieval scoring, ordering, ambiguity, limits and candidate shapes are preserved for pinned builtins and selected native-admitted ModuleSets. Availability is explicitly blocked with the native runtime-unavailable reason; no selected Action or execution authority is fabricated. Original installed catalogs, enabled platform Actions and runtime readiness remain unavailable."
                if name == "action_retrieve" else
                "Only native-owned Action run status metadata is exposed, with source, inputs, outputs, credentials and execution fields omitted. Legacy run records and monitor notifications/checkpoints are unavailable; this read does not grant run or cancellation authority."
                if name == "action_run_get" else
                "Original inline definition diagnostics, graph structure/exact dependency-pin checks and pending-only proposal receipts are preserved. Graph authorship does not wait for child GPT validation. No original installed catalog or ModuleSet authority is inferred. Native immutable actor/workspace-bound pending proposals survive restart/backup; caller runtime identities are refused. Original next_action text is protocol parity, not evidence that a background preparer or approval host exists. Formal approval, background preparation, catalog migration, external dependencies, qualification and execution remain unavailable."
                if name in {"action_definition_check", "action_graph_check", "action_register", "action_proposals", "action_graph_save"} else
                "Only selected native-admitted portable ModuleSet definitions with no dependencies are readable, with the original execution contract and explicit next-server-runtime-unavailable blocked result, independent of GPT review. Builtins, original installed catalogs, dependencies, execution and validation authority remain unavailable; no readiness is fabricated."
                if name == "action_get" else
                "Only host-admitted, already-finalized terminal runs are readable from the immutable native run snapshot; compact/full projections and usage are source-oracle checked. Active, unfinalized, inconsistent, or identity-mismatched runs fail closed because original reconciliation, command results, subflows, and health authority are unavailable."
                if name == "recipe_run_get" else
                "Original byte-preserving missing-only recovery works for portable non-System Note/Skill Markdown through explicit native host-approved fixed evidence/audit roots, exact plan SHA and actor. Source plan plus named blobs are immutable/pinned, not root-scanned; public paths/digests never grant authority. Original preview/results/external audit coexist with immutable native admission/receipts and exclusive raw-byte publication. Existing files are preserved, source races deny, pending effects block startup/backup until exact-owner reconciliation, and relocated receipts never remap external authority. Assets, Boards, invalid/nonportable metadata and plans above bounded native limits remain unavailable. This is not private-Git knowledge snapshot restore."
                if name in {"knowledge_recovery_preview", "knowledge_recovery_apply"} else
                "Real original Exact/BM25 reads and native-admitted subscriber caches work with source-fenced shared-SQL generations. All ten original portable safetensors package architectures execute actual offline original operators with independent original full/scoped ranking parity, including PCA, hybrid lexical fusion and token MaxSim/compression. Explicit closed original learner/selection/all-package import preserves exact salt/history/user precedence with native immutable genesis, no fabricated historical feedback authority, and exact selected/null state. Exact predecessor column prefixes upgrade only through the actual original in-memory initializer, including base9/11 missing query judgments. Evaluated original frozen releases for the selected portable package retain exact envelope/config/weights identity through import, source removal, restart and relocated backup. Native actor/source/model receipts fence feedback. The compliant isolated CPU runtime is provisioned; tiny random BERT proves execution only, not real relevance. Frozen null/inactive selection, nonportable reranker/graph artifacts, unknown historical schemas and remaining original metrics/management branches remain unavailable; System/Memory scope is never widened."
                if name in {"get_knowledge", "get_script", "search_knowledge", "search_scripts"} else
                "Actual persistent original worker/status/process measurements and all ten portable model architectures are wired with native data-only receipts and original shared-SQL learning, including approved closed-state/history/selection migration, exact original in-memory predecessor upgrades and selected portable frozen serving with immutable original release identity. Nonportable reranker/graph artifacts and remaining original metrics/management branches are unavailable. Compliant isolated CPU model dependencies and prior model-enabled managed staging are separately verified; original captures and fixture execution never substitute real relevance acceptance."
                if name == "retrieval_status" else
                "Exact original feedback and learner execute only in fixed-table in-memory SQLite; native shared-SQL immutable versions and actor/workspace/source/model receipts fence publication and user provenance requires native authority. All ten portable model architectures, independent original feedback/state parity, precedence, duplicates, disabled behavior, restart and relocated backup work. Explicit current/prefix original history import preserves salt/full state through immutable genesis without minting feedback envelopes for old48hex calls; actual original initializer supplies deterministic predecessor upgrades and original user-query precedence survives successor calls. Selected portable frozen serving retains exact release identity and relocated native feedback; unknown schemas, missing salt, nonportable frozen artifacts and remaining metrics branches remain unavailable. No raw query/task or authoritative Python filesystem learning database is persisted."
                if name == "retrieval_feedback" else
                "Native Markdown/exclusive paired assets use original numeric-hex IDs, results and transactional ordered deletion history; path-derived IDs retain exact original bytes and restore only to their pinned original paths. Authenticated imported/native Trash coexistence is supported. Shared/legacy assets, protected descriptors and non-Markdown targets remain unavailable."
                if name in {"delete_note", "delete_skill", "delete_paper", "knowledge_file_trash"} else
                "Original full-snapshot worker mutation uses native exact-effect preflight, durable admission, journal and actor-bound receipts; imported native-backed Notes retain a frozen initial snapshot with fresh native reads. Inline/unadmitted Boards, non-equivalent edits and worker tokens remain unavailable; no accept/reopen privilege."
                if name in {"note_work_item_command", "note_work_item_upsert"} else
                "Original title/category contract and result create a native authoritative Board and descriptor with durable paired recovery and fixed external actor. Unsafe or unsupported names and source layouts are refused; not all original filesystem layouts are admitted."
                if name == "todo_board_create" else
                "Approved preserve-identities divergence: native CAS and atomic content/path/paired-asset moves, Skill overwrite preserve IDs, prior aliases, links, history, created and unknown metadata; revision increments once. Original path-derived native IDs are explicitly pinned as documentId; only missing canonical identity fields are added. Original destructive replacement is not reproduced. Nonportable/invalid metadata, unsupported shared/legacy assets and protected descriptors remain refused."
                if name.startswith(("add_", "update_")) else
                "Current encrypted immutable Snapshot reads work; original implicit plaintext/legacy encryption migration is refused without a durable native migration adapter."
                if name.startswith("agent_session_snapshot_") else
                "Original metadata-threshold fallback and standard indexed retrieval work under the original unconfigured-provider context; configured frozen serving boundaries, model execution and online learning remain unavailable."
                if name == "skill_context" else
                "Original offline/slug/name paths and indexed stable-ID/standard/semantic-off reads work, including actually imported native-admitted subscriber caches; configured models/feedback remain unavailable.")
        elif status == "managed-experimental-only" and name == "knowledge_snapshot_configure":
            blocker = ("A live explicitly opted-in isolated managed host and an existing exact-root native enrollment authorizing configure and create are required. The durable native scheduler runs only while that host is active and catches up on restart; it installs no autonomous OS service. Default profiles omit this tool.")
        else: blocker = None
        rows[name] = {"name": name, "source": origin, "sourceSha256": hashlib.sha256(source.encode()).hexdigest(),
            "signature": ast.unparse(node.args), "status": status, "blocker": blocker}
result = {"schema": "pkm.legacy-mcp-coverage/v1", "migrationReady": False, "acceptanceEvidence": False,
    "scope": "Source-derived original tool registration inventory; implementation evidence only, never acceptance.",
    "tools": sorted(rows.values(), key=lambda row: row["name"])}
result["counts"] = {status: sum(row["status"] == status for row in rows.values()) for status in [
    "implemented","partial","managed-experimental-only","unimplemented"]}
result["missingTools"] = [row["name"] for row in result["tools"] if row["status"] == "unimplemented"]
result["partialTools"] = sorted(partial)
print(json.dumps(result, indent=2))
`], { encoding: "utf8", input: JSON.stringify({ sources,
  captured: await readFile(resolve(root, "compat/legacy-knowledge-captured.py"), "utf8") }), maxBuffer: 8 * 1024 * 1024 });
if (assessment.status !== 0) throw new Error(assessment.stderr || "Original MCP inventory failed.");
process.stdout.write(assessment.stdout);

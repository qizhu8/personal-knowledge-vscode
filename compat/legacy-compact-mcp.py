import argparse
import asyncio
import json
import os
import re
from pathlib import Path
import sys
from typing import Any, Optional

from fastmcp import Client, FastMCP
from fastmcp.client.transports import StdioTransport

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PACKAGE_ROOT.parent / "resources"))
import capability_api
from todo_api import register_todo_api_tools
from mcp_call_guard import ManagedMcpLifecycle, McpDiagnosticsMiddleware, run_managed_stdio
from diagnostic_log import DiagnosticLog
import importlib.util

knowledge_spec = importlib.util.spec_from_file_location(
    "legacy_knowledge_mcp", Path(__file__).with_name("legacy-knowledge-mcp.py"))
knowledge = importlib.util.module_from_spec(knowledge_spec)
knowledge_spec.loader.exec_module(knowledge)
diagnostics_spec = importlib.util.spec_from_file_location(
    "legacy_mcp_diagnostics", Path(__file__).with_name("legacy-mcp-diagnostics.py"))
diagnostics = importlib.util.module_from_spec(diagnostics_spec)
diagnostics_spec.loader.exec_module(diagnostics)


async def main():
    parser = argparse.ArgumentParser(description="Isolated legacy Knowledge/Todo/Memory MCP compatibility experiment")
    parser.add_argument("--data", required=True, type=Path)
    parser.add_argument("--node", default="node")
    parser.add_argument("--allow-writes", action="store_true",
                        help="Explicitly allow Todo mutations, partial canonical Knowledge CAS/Trash writes and pending Memory proposals in the isolated workspace")
    parser.add_argument("--allow-asset-classification", action="store_true",
                        help="Explicitly admit original asset-classification preview/apply/rollback for this workspace; requires --allow-writes")
    parser.add_argument("--managed-generation", type=Path,
                        help="Existing isolated experimental generation directory for Chat handshake/drain testing")
    parser.add_argument("--diagnostics-directory", type=Path,
                        help="Existing host-owned private directory outside the workspace for process-scoped MCP diagnostics")
    parser.add_argument("--diagnostics-history", action="store_true",
                        help="Also grant MCP clients read access to all writer logs in the selected diagnostic directory")
    parser.add_argument("--experimental-managed-snapshot-scheduler",
                        help="Exact existing native scheduler enrollment digest in the managed generation")
    options = parser.parse_args()
    if not options.data.is_absolute():
        parser.error("--data must be an absolute isolated workspace path")
    if options.diagnostics_history and options.diagnostics_directory is None:
        parser.error("--diagnostics-history requires --diagnostics-directory")
    if options.diagnostics_directory is not None:
        directory = options.diagnostics_directory
        try:
            if (not directory.is_absolute() or directory.resolve(strict=True) != directory
                    or not directory.is_dir() or directory.is_relative_to(options.data.resolve())):
                raise ValueError("directory must be canonical, existing and outside the workspace")
            stat = directory.stat()
            if os.name != "posix":
                raise ValueError("private diagnostic directory authorization is supported only on POSIX")
            if stat.st_uid != os.getuid() or stat.st_mode & 0o077:
                raise ValueError("directory must be owned by this user and private")
        except (OSError, ValueError) as error:
            parser.error(f"invalid diagnostics directory: {error}")
    if os.environ.get("PKM_CAPABILITY_PROFILE", "compact") not in {"compact", "legacy"}:
        parser.error("PKM_CAPABILITY_PROFILE must be compact or legacy")
    if options.allow_asset_classification and not options.allow_writes:
        parser.error("--allow-asset-classification requires --allow-writes")
    lifecycle = None
    scheduler = options.experimental_managed_snapshot_scheduler
    if scheduler is not None:
        if (not re.fullmatch(r"[a-f0-9]{64}", scheduler) or not options.allow_writes
                or options.managed_generation is None or not options.managed_generation.is_absolute()):
            parser.error("native snapshot scheduling requires writable managed generation enrollment")
        try:
            launch = json.loads((options.managed_generation / "launch.json").read_text(encoding="utf-8"))
            marker = json.loads((options.data / ".pkm-next-workspace").read_text(encoding="utf-8"))
            enrollment = launch["snapshotScheduler"]
            if (set(enrollment) != {"schema", "workspaceId", "actorId", "admissionSha256"}
                    or enrollment["schema"] != "pkm.native-snapshot-scheduler/v1"
                    or enrollment["actorId"] != "mcp:external" or enrollment["workspaceId"] != marker["id"]
                    or enrollment["admissionSha256"] != scheduler or launch["data"] != str(options.data)
                    or launch["allowWrites"] is not True):
                raise ValueError("scheduler enrollment mismatch")
        except (OSError, KeyError, TypeError, ValueError):
            parser.error("managed generation snapshot scheduler enrollment does not match")
    if options.managed_generation is not None:
        if not options.managed_generation.is_absolute():
            parser.error("--managed-generation must be absolute")
        manifest = json.loads((options.managed_generation / "manifest.json").read_text(encoding="utf-8"))
        if (manifest.get("version") != "0.1.0"
                or manifest.get("enabledFeatureDomains") != []
                or manifest.get("components") != {
                    "knowledge": "0.1.0", "chat": "0.1.0", "recipes": "0.1.0", "agent_sessions": "0.1.0"}):
            parser.error("experimental generation cannot claim production versions or complete feature domains")
        lifecycle = ManagedMcpLifecycle.from_directory(options.managed_generation)
        if lifecycle is None:
            parser.error("--managed-generation requires an existing experimental manifest")
    transport = StdioTransport(options.node, [
        str(PACKAGE_ROOT / "dist" / "cli.js"), "mcp", "--data", str(options.data),
        "--experimental-legacy-mcp",
    ] + ([] if options.allow_writes else ["--read-only"])
    + (["--experimental-managed-snapshot-scheduler", scheduler] if scheduler is not None else [])
    + (["--allow-asset-classification"] if options.allow_asset_classification else []),
        env={"ELECTRON_RUN_AS_NODE": "1"} if os.environ.get("ELECTRON_RUN_AS_NODE") == "1" else None)
    async with Client(transport) as backend:
        mcp = FastMCP("pkm-legacy-compat-experiment")
        if options.diagnostics_directory is not None:
            log = DiagnosticLog(options.diagnostics_directory)
            log.record("runtime.started", component="unified-mcp", parentPid=os.getppid())
            mcp.add_middleware(McpDiagnosticsMiddleware(log))

            @mcp.tool(annotations={"readOnlyHint": True})
            def diagnostics_latest(limit: int = 100) -> dict:
                """Read 1-1000 recent metadata-only diagnostic events from this MCP process; not chat transcripts."""
                if not 1 <= limit <= 1000:
                    raise ValueError("limit must be between 1 and 1000; use local diagnostic_log.py export for 100000 rows")
                return {"ok": True, "writer_id": log.writer_id, "directory": str(log.directory),
                        "max_rows": log.max_rows, "dropped_records": log.dropped, "records": log.latest(limit)}

            @mcp.tool(annotations={"readOnlyHint": True})
            def diagnostics_page(limit: int = 100, cursor: Optional[str] = None) -> dict:
                """Page this process's actual diagnostic records newest-first; cursors cannot cross process restarts."""
                return diagnostics.page(log, limit, cursor)

            if options.diagnostics_history:
                @mcp.tool(annotations={"readOnlyHint": True})
                def diagnostics_writers(offset: int = 0, limit: int = 50, revision: Optional[str] = None) -> dict:
                    """List writer IDs in the host-authorized diagnostics directory; pin revision when paging."""
                    return diagnostics.writers(log.directory, offset, limit, revision)

                @mcp.tool(annotations={"readOnlyHint": True})
                def diagnostics_history_page(writer_id: str, limit: int = 100, cursor: Optional[str] = None) -> dict:
                    """Read actual records for an authorized writer, newest-first, including after process restart."""
                    return diagnostics.history_page(log.directory, writer_id, limit, cursor)

        if lifecycle is not None:
            mcp.add_middleware(lifecycle)
            backend_closed = False
            backend_close_lock = asyncio.Lock()

            async def drained_status():
                nonlocal backend_closed
                status = lifecycle.status()
                if status["controlError"]:
                    raise RuntimeError("Managed lifecycle control is unavailable; drain is unverified.")
                if (not status["acceptingNewCalls"] and status["inFlight"] == 0
                        and status["uncertainCalls"] == 0):
                    async with backend_close_lock:
                        if not backend_closed:
                            # A drain receipt also closes the owned native workspace
                            # lease before the outer stdio client's shutdown deadline.
                            await backend.close()
                            backend_closed = True
                return lifecycle.status()

            @mcp.tool(annotations={"readOnlyHint": True})
            def check_version() -> dict:
                """Report this isolated experimental generation, not production MCP compatibility."""
                return {"name": "pkm-legacy-compat-experiment", "version": "0.1.0",
                        "components": lifecycle.manifest["components"],
                        "enabled_feature_domains": [], "capabilities": ["managed-lifecycle-v1"],
                        "experimental": True, "runtime": lifecycle.status()}

            @mcp.tool(annotations={"readOnlyHint": True})
            async def mcp_lifecycle_status() -> dict:
                """Read actual admission and in-flight state for the isolated process."""
                return await drained_status()

            @mcp.tool(annotations={"readOnlyHint": False})
            async def mcp_lifecycle_quiesce() -> dict:
                """Fence new calls and observe drain; never replay effects or cancel tools."""
                lifecycle.quiesce()
                return await drained_status()

        @mcp.tool(annotations={"readOnlyHint": True})
        async def list_notes(type: Optional[str] = None, directory: Optional[str] = None,
                             recursive: bool = True, offset: int = 0, limit: int = 50,
                             inventory_revision: Optional[str] = None) -> Any:
            """Read-only Note inventory. limit defaults to 50; limit=0 returns all matches.

            directory accepts a Notes-relative folder or copied pkm://notes/<folder>/ path;
            recursive includes subfolders. Returns stable knowledge_id/source_id
            when present, identity completeness, total, next_offset and inventory_revision.
            Follow next_offset until null and pass the first revision on every later page;
            concurrent changes fail explicitly. Legacy notes without IDs are marked missing,
            never assigned fake stable IDs. Hidden/asset/Trash folders are excluded.
            Positive limit sets the maximum number returned, with no fixed upper cap.
            Every call returns the same inventory envelope. type: general/todo/done/observation/data-path.
            """
            result = await backend.call_tool("list_notes", {
                "type": type, "directory": directory, "recursive": recursive,
                "offset": offset, "limit": limit, "inventory_revision": inventory_revision,
            })
            if not isinstance(result.structured_content, dict):
                raise ValueError("The isolated Note server returned an invalid result.")
            return result.structured_content

        original_contract = capability_api._contract

        def experiment_contract(tool):
            contract = original_contract(tool)
            contract["authorization"] = "Isolated workspace with fixed native actor; original MCP middleware is not active."
            contract["result"] = "Legacy result from the isolated next-server adapter."
            if tool.name in {"add_note", "update_note", "add_skill", "update_skill", "add_paper", "update_paper"}:
                contract["result"] = ("Approved preserve-identities compatibility policy: native CAS updates "
                                      "and atomic rename/category moves preserve IDs, prior aliases, links, history, "
                                      "created and unknown frontmatter; revision increments once, new path alias is added, "
                                      "paired asset bytes move with rebased owner references. Original frontmatter replacement "
                                      "is deliberately not reproduced. Original path-derived native IDs are pinned "
                                      "as documentId; only missing canonical identity fields are added, never replaced. "
                                      "Skill overwrite preserves existing identity. "
                                      "Nonportable/invalid metadata and unsupported source/resource layouts still fail closed.")
            if tool.name in {"note_work_item_command", "note_work_item_upsert"}:
                contract["result"] = ("Original full-snapshot worker result through the existing native Todo "
                                      "journal and immutable exact-effect receipt binding. Explicit experimental "
                                      "Note admission pins descriptor, initial native Board snapshot, workspace and "
                                      "actor; every later read uses fresh native authority. Inline/unadmitted Boards, "
                                      "non-equivalent edits and worker_token authentication remain unavailable; "
                                      "accept/reopen and caller role escalation are never granted.")
            if tool.name == "skill_capabilities":
                contract["result"] = ("Original Skill workflow metadata. Native receipt-bound skill_feedback and "
                                      "reviewable propose_skill_update preserve imported original artifacts; "
                                      "neither modifies formal Skills nor sends an external collector request.")
            if tool.name in {"skill_feedback", "propose_skill_update"}:
                contract["result"] = ("Original advisory result and exact UTF-8 artifact bytes, with immutable native "
                                      "actor-bound receipts, deterministic committed-only crash recovery, imported "
                                      "genesis preservation and restart/relocated backup verification. Raw task text "
                                      "is not retained; external collector transmission is not authorized.")
            if tool.name == "retrieval_status":
                contract["result"] = ("Actual owned original persistent retrieval worker PID, engine/runtime, corpus "
                                      "generation, build state and process measurements. Native source delta snapshots "
                                      "are rebuilt by original functions; worker exit requires explicit reconnect. "
                                      "Configured models and retrieval learning receipts remain unavailable.")
            if tool.name == "skill_context":
                contract["result"] = ("Original metadata-threshold fallback only. Indexed boundary ranking, frozen "
                                      "serving and online learning are unavailable; separately selected router policy is preserved.")
            if tool.name in {"get_knowledge", "get_script", "search_knowledge", "search_scripts"}:
                contract["result"] = ("Original indexed source revisions and Exact/BM25 lexical/graph/hybrid results "
                                      "from current isolated native Knowledge and Scripts. Generations publish atomically "
                                      "in shared SQLite after source revalidation; no persistent Python authority DB. "
                                      "Unconfigured semantic/dual paths report semantic_status=off. "
                                      "Native subscriber membership and cached content project exact original read-only provenance. "
                                      "Imported subscription caches retain exact source ownership through restart and backup. "
                                      "Configured models and feedback/learning remain unavailable; "
                                      "System/Memory authority is not widened.")
            if tool.name in {"delete_note", "delete_skill", "delete_paper", "knowledge_file_trash"}:
                contract["result"] = ("Byte-preserving native journal with original numeric-hex Trash IDs and original results. "
                                      "Native Markdown, including path-derived IDs with exact-original-path restore, "
                                      "and exclusive paired assets are supported; no identity metadata is manufactured. "
                                      "Authenticated imported/native Trash coexistence is supported. Shared/legacy assets, "
                                      "Board/System descriptors and non-Markdown targets remain explicitly unavailable.")
            if tool.name in {"agent_session_snapshot_list", "agent_session_snapshot_read"}:
                contract["result"] = ("Original encrypted immutable Snapshot projection. Plaintext or old encryption "
                                      "requiring implicit migration is refused; Recovery Session history requires its separate migration.")
            if tool.name in {"knowledge_recovery_preview", "knowledge_recovery_apply"}:
                contract["result"] = ("Original missing-only plan results and exact raw Markdown bytes, limited to portable "
                                      "non-System Notes/Skills. Native host admission must separately approve fixed evidence "
                                      "and external audit roots, exact plan SHA and actor before named plan/blob reads. "
                                      "MCP path/digest strings never grant filesystem authority. Native durable intent/audit "
                                      "receipts preserve existing files; unknown effects require explicit native-owner recovery. "
                                      "Assets, Boards and unsupported metadata remain unavailable; no snapshot-domain substitution.")
            if tool.name in {"action_definition_check", "action_graph_check", "action_register", "action_proposals", "action_graph_save"}:
                contract["result"] = ("Original inline diagnostics, built-in-only graph contracts and immutable pending-only "
                                      "proposal receipts. No installed catalog, ModuleSet, approval, qualification, background "
                                      "preparation or execution authority is inferred. Original next_action text is protocol "
                                      "parity only; no automatic preparer is provided. Runtime identity injection is refused.")
            if tool.name == "action_template_create":
                contract["result"] = ("Original bounded poll and monitor templates create pending-only proposals from pinned "
                                      "builtins or selected host-admitted ModuleSets. No execution, qualification or approval "
                                      "is inferred. Host-specific Azure DevOps template remains unavailable.")
            if tool.name in {"asset_classify_preview", "asset_classify_apply", "asset_classify_rollback"}:
                contract["result"] = ("Original asset stewardship requires existing native host admission. Previews are "
                                      "session-local; apply requires an explicit approved subset and rollback an exact journal. "
                                      "Uncertain effects require native-owner reconciliation.")
            if tool.name == "action_get":
                contract["result"] = ("Only selected native-admitted portable ModuleSet Actions with no dependencies "
                                      "are returned, with the original execution contract and blocked missing-admission "
                                      "result. Builtins, migrated catalog/admission state, execution and validation "
                                      "remain unavailable; no readiness is inferred.")
            if tool.name == "action_capabilities":
                contract["result"] = ("Explicit limited projection, not the original runtime capability contract. "
                                      "Deterministic native compiler limits only; runtimeStatus is not-runnable-here. "
                                      "Unavailable original host, registry, scheduler, settings and provider fields "
                                      "are enumerated, never fabricated. No discovery, mutation or execution.")
            if tool.name in {"action_module_sets", "action_module_set_import", "action_module_set_load", "action_module_set_remove"}:
                contract["result"] = ("Original portable ModuleSet results from native immutable ZIP/snapshot admissions. "
                                      "The native host must approve an exact fixed source workspace, package path and ZIP digest "
                                      "before source access; public local_path never grants authority. Import is disabled; "
                                      "selection makes definitions visible to diagnostics only, never grants Action admission, "
                                      "qualification, host trust or execution. UTF-8 bounded packages only; export destinations, "
                                      "original catalog migration and runtime authority remain unavailable.")
            if tool.name in {"action_artifact_import", "action_artifact_export"}:
                contract["result"] = ("Original borrowed artifact import and exclusive export on Linux only. "
                                      "The native host must separately approve exact source and destination paths within "
                                      "the same selected workspace before access; public paths never grant authority. "
                                      "Source identity and digest are pinned, exports never overwrite, and uncertain "
                                      "publication requires explicit native reconciliation. No runtime execution authority.")
            if tool.name.startswith("knowledge_snapshot_"):
                contract["result"] = ("Actual original private-Git snapshot objects and inventories, not workspace backups "
                                      "or encrypted Agent snapshots. A prior native host admission fixes actor, workspace, "
                                      "private repository identity and allowed tools. Portable standalone non-System Markdown "
                                      "restore uses exact preview approval, safety snapshot and native Trash; runtime, Chat, "
                                      "Actions and Recipes are excluded. Paired assets, Boards, Memory and unsupported content "
                                      "restore remain unavailable. Persistent scheduling is not exposed without an actual "
                                      "separately approved native scheduler.")
                if tool.name == "knowledge_snapshot_configure":
                    contract["result"] = ("Actual durable isolated host schedule from the exact immutable native enrollment. "
                                          "No OS service, arbitrary root or implicit grant; jobs run only while the managed host is active.")
            return contract

        capability_api._contract = experiment_contract

        async def canonical_request(_operation, _slug, *, api, args, workerToken=None):
            if api == "call" and not options.allow_writes:
                raise ValueError("ACCESS_DENIED: This isolated MCP process is read-only.")
            result = await backend.call_tool(
                "legacy_capability_call" if api == "call" else "legacy_capability_read",
                {"action": api, "args": args, **({"workerToken": workerToken} if workerToken is not None else {})},
            )
            if not isinstance(result.structured_content, dict):
                raise ValueError("The isolated canonical server returned an invalid result.")
            return result.structured_content

        operations = {}
        offset = 0
        revision = None
        while offset is not None:
            page = await canonical_request("capability", "_capabilities", api="search",
                                           args={"path": "todo", "query": "", "offset": offset, "limit": 10,
                                                 **({"revision": revision} if revision else {})})
            for operation in page["operations"]:
                operations[operation["transportName"]] = operation
            offset, revision = page["nextOffset"], page["revision"]

        loop = asyncio.get_running_loop()

        def todo_request(_operation, _slug, *, api, args, workerToken=None):
            operation = operations.get(api)
            if operation is None:
                raise ValueError("NOT_AVAILABLE: Todo operation is not in this actor's catalog.")
            future = asyncio.run_coroutine_threadsafe(canonical_request(
                "capability", "_capabilities", api="read" if operation["readOnly"] else "call",
                args={"operation": operation["id"], "version": 1, "arguments": args}, workerToken=workerToken,
            ), loop)
            return future.result()["result"]

        register_todo_api_tools(mcp, todo_request)
        knowledge_writes = {"add_note", "update_note", "add_skill", "update_skill", "add_paper", "update_paper"}
        skill_maintenance = {"skill_feedback", "propose_skill_update"}
        indexed_reads = {"get_knowledge", "get_script", "search_knowledge", "search_scripts", "retrieval_status"}
        action_catalog = {"action_module_sets", "action_module_set_import", "action_module_set_load", "action_module_set_remove"}
        action_artifacts = {"action_artifact_import", "action_artifact_export"}
        def register_knowledge_tool(name, contract):
            function = getattr(knowledge.captured, name)

            async def invoke(**arguments):
                indexed = (name in indexed_reads or
                           (name in {"get_note", "get_skill", "get_paper", "get_research"} and
                            str(arguments.get("id") or arguments.get("slug") or arguments.get("name") or "").startswith(
                                ("pkm://knowledge/", "pkm://script/", "pkm://subscriptions/", "knowledge_", "script_"))) or
                           (name in {"search_notes", "search_skills", "search_research", "search_papers"} and
                            (arguments.get("detail") == "standard" or arguments.get("route", "lexical") != "lexical")))
                result = await backend.call_tool("legacy_knowledge_trash" if contract.get("trash") else
                                                 "legacy_asset_classification_preview" if contract.get("assetClassification") and contract["readOnly"] else
                                                 "legacy_asset_classification_write" if contract.get("assetClassification") else
                                                 "legacy_action_artifact_write" if name in action_artifacts else
                                                 "legacy_action_catalog_read" if name in action_catalog and contract["readOnly"] else
                                                 "legacy_action_catalog_write" if name in action_catalog else
                                                 "legacy_snapshot_read" if contract.get("snapshot") and contract["readOnly"] else
                                                 "legacy_snapshot_write" if contract.get("snapshot") else
                                                 "legacy_action_read" if contract.get("action") and contract["readOnly"] else
                                                 "legacy_action_write" if contract.get("action") else
                                                 "legacy_knowledge_recovery_preview" if contract.get("recovery") and contract["readOnly"] else
                                                 "legacy_knowledge_recovery_apply" if contract.get("recovery") else
                                                 "legacy_indexed_knowledge_feedback" if name == "retrieval_feedback" else
                                                 "legacy_native_write" if contract.get("native") and not contract["readOnly"] else
                                                 "legacy_native_read" if contract.get("native") else
                                                 "legacy_knowledge_write" if name in knowledge_writes else
                                                 "legacy_skill_maintenance" if name in skill_maintenance else
                                                 "legacy_indexed_knowledge_read" if indexed else "legacy_knowledge_read",
                                                 {"tool": name, "arguments": arguments})
                if contract.get("native"):
                    if not isinstance(result.structured_content, dict) or "value" not in result.structured_content:
                        raise ValueError("The isolated native read server returned an invalid result.")
                    return result.structured_content["value"]
                if not isinstance(result.structured_content, dict) or not isinstance(result.structured_content.get("text"), str):
                    raise ValueError("The isolated Knowledge server returned an invalid result.")
                if contract.get("dictionary") or contract.get("typed"):
                    return result.structured_content["value"]
                text = result.structured_content["text"]
                return json.dumps(json.loads(text)) if name in knowledge_writes else text

            invoke.__name__ = name
            invoke.__doc__ = function.__doc__
            result_type = function.__annotations__.get("return", Any) if contract.get("native") or contract.get("dictionary") else Any
            invoke.__signature__ = knowledge.inspect.signature(function).replace(return_annotation=result_type)
            invoke.__annotations__ = {**function.__annotations__, "return": result_type}
            mcp.tool(annotations=contract.get("annotations", {"readOnlyHint": contract["readOnly"]}))(invoke)

        for name, contract in knowledge.captured.TOOLS.items():
            if contract.get("unavailable") and not (
                    contract.get("assetClassification") and options.allow_asset_classification
                    or name == "knowledge_snapshot_configure" and scheduler is not None):
                continue
            register_knowledge_tool(name, contract)

        @mcp.tool(annotations={"readOnlyHint": True})
        async def subscription_broker_share_markers(type: str, items: list[dict],
                                                    expectedRevision: Optional[str] = None) -> dict:
            """Calculate local broker share markers against the admitted snapshot; no broker connection or secret material."""
            result = await backend.call_tool("legacy_subscription_share_markers", {
                "type": type, "items": items,
                **({"expectedRevision": expectedRevision} if expectedRevision is not None else {}),
            })
            envelope = result.structured_content
            if not isinstance(envelope, dict):
                raise ValueError("The native Subscription server returned an invalid result.")
            if result.is_error or "error" in envelope:
                error = envelope.get("error")
                if isinstance(error, dict):
                    raise ValueError(f"{error.get('code', 'INTERNAL')}: {error.get('message', 'Subscription read failed.')} "
                                     f"(effect: {error.get('effect', 'unknown')})")
                raise ValueError("The native Subscription read failed.")
            if not isinstance(envelope.get("result"), dict):
                raise ValueError("The native Subscription server returned an invalid result.")
            return envelope["result"]

        @mcp.tool(annotations={"readOnlyHint": True})
        async def action_capabilities() -> dict:
            """Read a limited Action compiler capability projection, not live runtime/provider capabilities. No mutation or execution."""
            result = await backend.call_tool("legacy_action_capabilities_read",
                                             {"tool": "action_capabilities", "arguments": {}})
            if not isinstance(result.structured_content, dict) or not isinstance(result.structured_content.get("value"), dict):
                raise ValueError("The isolated Action capabilities server returned an invalid result.")
            return result.structured_content["value"]

        @mcp.tool(annotations={"readOnlyHint": True})
        async def action_run_get(run_id: str) -> dict:
            """Read a durable Action run; submission is not transfer verification."""
            result = await backend.call_tool("legacy_action_read", {
                "tool": "action_run_get", "arguments": {"run_id": run_id},
            })
            if result.is_error:
                detail = "\n".join(item.text for item in result.content if hasattr(item, "text"))
                raise ValueError(detail or "The isolated Action runtime read is unavailable.")
            if not isinstance(result.structured_content, dict) or not isinstance(result.structured_content.get("value"), dict):
                raise ValueError("The isolated Action runtime returned an invalid redacted run view.")
            return result.structured_content["value"]

        @mcp.tool(annotations={"readOnlyHint": True})
        async def action_retrieve(task: str, limit: int = 1) -> dict:
            """Find admitted or built-in Actions without granting execution; all native candidates remain blocked."""
            result = await backend.call_tool("legacy_action_read", {
                "tool": "action_retrieve", "arguments": {"task": task, "limit": limit},
            })
            if result.is_error:
                detail = "\n".join(item.text for item in result.content if hasattr(item, "text"))
                raise ValueError(detail or "The isolated Action retrieval is unavailable.")
            if not isinstance(result.structured_content, dict) or not isinstance(result.structured_content.get("value"), dict):
                raise ValueError("The isolated Action server returned an invalid retrieval result.")
            return result.structured_content["value"]

        if not options.allow_writes:
            mcp.disable(names={tool.name for tool in await mcp.list_tools()
                               if tool.name != "mcp_lifecycle_quiesce"
                               and (tool.annotations is None or tool.annotations.readOnlyHint is not True)},
                        components={"tool"})
        capability_api.register_capability_tools(mcp, canonical_request)
        descriptions = {
            "capabilities_inventory": "Inventory exposed tools in this isolated Knowledge/Todo/Memory experiment.",
            "capabilities_list": "List captured Knowledge operations; path todo or memory lists canonical operations.",
            "capabilities_search": "Search captured Knowledge operations; path todo or memory searches canonical contracts.",
            "capabilities_describe": "Read an exact captured Knowledge or canonical Todo/Memory operation contract and explicit write restrictions.",
            "capability_read": "Read Knowledge/Todo/Memory through the isolated next-server adapter; original MCP middleware is not active.",
            "capability_call": "Mutate isolated Todo, use identity-preserving Knowledge CAS/atomic rename/overwrite and partial original-ID Trash writes or propose pending Memory only with explicit --allow-writes. Original destructive identity replacement is deliberately not reproduced; unsupported source/resource layouts fail closed. Board worker tokens retain Board-scoped identity, not human decision authority.",
        }
        for name, description in descriptions.items():
            tool = await mcp.get_tool(name)
            if tool is None:
                raise RuntimeError(f"Required compatibility tool was not registered: {name}")
            tool.description = description
        capability_api.apply_capability_profile(mcp)
        if lifecycle is None:
            await mcp.run_async(transport="stdio", show_banner=False)
        else:
            await run_managed_stdio(mcp, lifecycle)


if __name__ == "__main__":
    asyncio.run(main())

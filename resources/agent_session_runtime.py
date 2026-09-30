"""Opt-in Agent Session registration and managed PKM activity tracking."""

import contextlib
import base64
import datetime
import hashlib
import json
import os
import re
import secrets
import time
import uuid
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastmcp import Context
from fastmcp.server.middleware import Middleware


AGENT_SESSION_SCHEMA_VERSION = "1.7.6"
SESSION_SCHEMA = "pkm.agent.session/v1"
SESSION_LEASE_SECONDS = 300
SNAPSHOT_SCHEMA = "pkm.agent.snapshot/v1"
SNAPSHOT_PAYLOAD_ALGORITHM = "A256GCM-PKM-LOCAL-OBFUSCATION/v1"
LEGACY_SNAPSHOT_PAYLOAD_ALGORITHM = "A256GCM-PKM-INTERNAL/v1"
SNAPSHOT_PAYLOAD_KEY = hashlib.sha256(b"uone").digest()
LEGACY_SNAPSHOT_PAYLOAD_KEY = hashlib.sha256(b"uone:agent-snapshot:payload:v1").digest()
SNAPSHOT_MAGIC_CODE_PATTERN = re.compile(
    r"PKM-SNAP-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}")
TODO_TERMINAL_STATES = {"succeeded", "failed", "skipped"}
TODO_RECEIPT_BYTE_LIMIT = 262144
TODO_TITLE_CHARACTER_LIMIT = 240
TODO_DETAILS_CHARACTER_LIMIT = 2000
TODO_SUMMARY_CHARACTER_LIMIT = 1000
SESSION_SUMMARY_CHARACTER_LIMIT = 1000


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _touch_liveness(session, transport_key, now=None):
    heartbeat = now or datetime.datetime.now(datetime.timezone.utc)
    previous = session.get("liveness") if isinstance(session.get("liveness"), dict) else {}
    session["liveness"] = {
        "owner": {
            "transportId": transport_key,
            "hostSessionId": str(session.get("hostSessionId") or ""),
        },
        "heartbeatAt": heartbeat.isoformat(),
        "leaseSeconds": SESSION_LEASE_SECONDS,
        "leaseExpiresAt": (heartbeat + datetime.timedelta(seconds=SESSION_LEASE_SECONDS)).isoformat(),
        "heartbeatSequence": int(previous.get("heartbeatSequence") or 0) + 1,
    }


def _atomic_write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + str(os.getpid()) + "." + uuid.uuid4().hex + ".tmp")
    with open(temporary, "x", encoding="utf-8") as handle:
        handle.write(_json(value))
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


@contextlib.contextmanager
def _file_lock(path, timeout=5.0):
    path.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + timeout
    while True:
        try:
            descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            os.close(descriptor)
            break
        except FileExistsError:
            try:
                if time.time() - path.stat().st_mtime > 30:
                    path.unlink(missing_ok=True)
                    continue
            except FileNotFoundError:
                continue
            if time.monotonic() >= deadline:
                raise RuntimeError("agent session lock timeout")
            time.sleep(0.025)
    try:
        yield
    finally:
        path.unlink(missing_ok=True)


def _transport_key(context):
    return hashlib.sha256(context.session_id.encode("utf-8")).hexdigest()


def _paths(store, session_id):
    directory = store / ".pkm" / "state" / "agent-sessions"
    return directory / (session_id + ".json"), directory / (session_id + ".lock")


def _active_path(store, transport_key):
    return store / ".pkm" / "state" / "agent-sessions" / "active" / (transport_key + ".json")


def _projected_session_status(session):
    status = str(session.get("status") or "unknown")
    todos = session.get("todos") if isinstance(session.get("todos"), list) else []
    if status == "running" and todos and all(
            isinstance(todo, dict) and str(todo.get("status") or "") in {"succeeded", "failed", "skipped"}
            for todo in todos):
        return "completed"
    return status


def _compact_todo(todo):
    if not isinstance(todo, dict):
        return None
    keys = (
        "todoId", "title", "status", "actionType", "resumeTodoId", "recipeRunId",
        "recipeRunIds", "createdAt", "startedAt", "updatedAt", "completedAt",
    )
    return {key: todo[key] for key in keys if key in todo}


def _todo_projection(todo, detail="compact"):
    if todo is None or detail == "full":
        return todo
    return _compact_todo(todo)


def _validate_detail(detail):
    normalized = str(detail or "compact").strip().lower()
    if normalized not in {"compact", "full"}:
        raise ValueError("detail must be compact or full.")
    return normalized


def _bounded_text(value, field, maximum):
    text = str(value or "").strip()
    if len(text) > maximum:
        raise ValueError("{} must be at most {} characters.".format(field, maximum))
    return text


def _compact_session(session):
    todos = [todo for todo in (session.get("todos") or []) if isinstance(todo, dict)]
    current = next(
        (todo for todo in todos if str(todo.get("status") or "") in {"running", "paused"}),
        None,
    )
    counts = {
        status: sum(str(todo.get("status") or "") == status for todo in todos)
        for status in ("pending", "running", "paused", "succeeded", "failed", "skipped")
    }
    checkpoints = [
        checkpoint for checkpoint in (session.get("checkpoints") or [])
        if isinstance(checkpoint, dict)
    ]
    latest = checkpoints[-1] if checkpoints else None
    latest_checkpoint = None
    if latest:
        state = latest.get("state") if isinstance(latest.get("state"), dict) else {}
        latest_checkpoint = {
            "checkpointId": str(latest.get("checkpointId") or ""),
            "sequence": int(latest.get("sequence") or len(checkpoints)),
            "reason": str(latest.get("reason") or ""),
            "createdAt": str(latest.get("createdAt") or ""),
            "summary": str(state.get("summary") or "")[:2000],
        }
    return {
        "sessionId": str(session.get("sessionId") or ""),
        "status": _projected_session_status(session),
        "task": str(session.get("task") or ""),
        "projectId": str(session.get("projectId") or ""),
        "hostSessionId": str(session.get("hostSessionId") or ""),
        "traversalStrategy": str(session.get("traversalStrategy") or ""),
        "agent": session.get("agent") or {},
        "currentTodo": _compact_todo(current),
        "todoCounts": counts,
        "recipeRunIds": [str(value) for value in (session.get("recipeRunIds") or [])],
        "latestCheckpoint": latest_checkpoint,
        "lastActivity": session.get("lastActivity"),
        "liveness": session.get("liveness"),
        "createdAt": str(session.get("createdAt") or ""),
        "updatedAt": str(session.get("updatedAt") or ""),
    }


def _clear_active_session_mappings(store, session_id):
    directory = store / ".pkm" / "state" / "agent-sessions" / "active"
    if not directory.exists():
        return 0
    removed = 0
    for path in directory.glob("*.json"):
        try:
            mapping = json.loads(path.read_text(encoding="utf-8"))
            if str(mapping.get("sessionId") or "") != session_id:
                continue
            path.unlink(missing_ok=True)
            removed += 1
        except (json.JSONDecodeError, OSError):
            continue
    return removed


def _snapshot_directory(store):
    return store / ".pkm" / "state" / "agent-snapshots"


def _snapshot_magic_code():
    value = secrets.token_hex(8).upper()
    return "PKM-SNAP-" + "-".join(value[index:index + 4] for index in range(0, len(value), 4))


def _snapshot_recovery_prompt(magic_code):
    normalized = _normalize_snapshot_magic_code(magic_code)
    return (
        "Call the PKM MCP function agent_session_snapshot_recover with "
        + '{"magic_code":"' + normalized + '"}.'
    )


def _normalize_snapshot_magic_code(magic_code):
    normalized = str(magic_code or "").strip().upper()
    if not SNAPSHOT_MAGIC_CODE_PATTERN.fullmatch(normalized):
        raise ValueError(
            "Invalid Agent Snapshot Magic Code. Call agent_session_snapshot_recover with exactly "
            'one recovery argument shaped like {"magic_code":"PKM-SNAP-XXXX-XXXX-XXXX-XXXX"}. '
            "Do not pass tool-discovery fields such as serverName or toolName.")
    return normalized


def _snapshot_b64encode(value):
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _snapshot_b64decode(value):
    text = str(value or "")
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _snapshot_aad(snapshot_id, magic_code):
    return (SNAPSHOT_SCHEMA + ":" + str(snapshot_id) + ":" + str(magic_code)).encode("utf-8")


def _snapshot_encrypt_payload(payload, snapshot_id, magic_code):
    iv = secrets.token_bytes(12)
    encrypted = AESGCM(SNAPSHOT_PAYLOAD_KEY).encrypt(
        iv, json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        _snapshot_aad(snapshot_id, magic_code))
    return {
        "algorithm": SNAPSHOT_PAYLOAD_ALGORITHM,
        "iv": _snapshot_b64encode(iv),
        "ciphertext": _snapshot_b64encode(encrypted[:-16]),
        "tag": _snapshot_b64encode(encrypted[-16:]),
    }


def _snapshot_payload_key(payload):
    if not isinstance(payload, dict):
        return None
    algorithm = payload.get("algorithm")
    if algorithm == SNAPSHOT_PAYLOAD_ALGORITHM:
        return SNAPSHOT_PAYLOAD_KEY
    if algorithm == LEGACY_SNAPSHOT_PAYLOAD_ALGORITHM:
        return LEGACY_SNAPSHOT_PAYLOAD_KEY
    return None


def _snapshot_decrypt_envelope(payload, snapshot):
    key = _snapshot_payload_key(payload)
    if key is None:
        return payload
    encrypted = _snapshot_b64decode(payload.get("ciphertext")) + _snapshot_b64decode(payload.get("tag"))
    plaintext = AESGCM(key).decrypt(
        _snapshot_b64decode(payload.get("iv")), encrypted,
        _snapshot_aad(snapshot.get("snapshotId"), snapshot.get("magicCode")))
    return json.loads(plaintext.decode("utf-8"))


def _snapshot_decrypt_payload(snapshot):
    payload = snapshot.get("payload")
    for _ in range(4):
        if _snapshot_payload_key(payload) is None:
            return payload or {}
        payload = _snapshot_decrypt_envelope(payload, snapshot)
    if _snapshot_payload_key(payload) is not None:
        raise ValueError("Agent Snapshot payload contains too many nested encryption envelopes.")
    return payload or {}


def _snapshot_payload_is_canonical(payload):
    return (
        isinstance(payload, dict)
        and isinstance(payload.get("session"), dict)
        and isinstance(payload.get("recipeRuns"), list)
    )


def _snapshot_encrypt_legacy(path, snapshot):
    stored_payload = snapshot.get("payload") or {}
    if isinstance(stored_payload, dict) and stored_payload.get("algorithm") == SNAPSHOT_PAYLOAD_ALGORITHM:
        decrypted = _snapshot_decrypt_envelope(stored_payload, snapshot)
        if _snapshot_payload_key(decrypted) is None:
            if not _snapshot_payload_is_canonical(decrypted):
                raise ValueError("Agent Snapshot payload is not a canonical Session capture.")
            return snapshot
    payload = _snapshot_decrypt_payload(snapshot)
    if not _snapshot_payload_is_canonical(payload):
        raise ValueError("Agent Snapshot payload is not a canonical Session capture.")
    snapshot["capture"] = _snapshot_capture(payload)
    snapshot["payload"] = _snapshot_encrypt_payload(
        payload, snapshot.get("snapshotId"), snapshot.get("magicCode"))
    snapshot.pop("recovery", None)
    _atomic_write(path, snapshot)
    return snapshot


def _snapshot_payload(store, session):
    runs = []
    for run_id in session.get("recipeRunIds") or []:
        run_path = store / ".pkm" / "state" / "recipe-runs" / (str(run_id) + ".json")
        if not run_path.exists():
            continue
        run = json.loads(run_path.read_text(encoding="utf-8"))
        run.pop("receipts", None)
        runs.append(run)
    session_copy = json.loads(_json(session))
    session_copy.pop("todoCommandReceipts", None)
    session_copy.pop("liveness", None)
    return {"session": session_copy, "recipeRuns": runs}


def _snapshot_capture(payload):
    payload_session = (payload or {}).get("session") or {}
    checkpoints = payload_session.get("checkpoints") or []
    latest = checkpoints[-1] if checkpoints else None
    return {
        "recipeRunCount": len((payload or {}).get("recipeRuns") or []),
        "todoCount": len(payload_session.get("todos") or []),
        "checkpoint": {
            "checkpointId": str(latest.get("checkpointId") or ""),
            "sequence": int(latest.get("sequence") or len(checkpoints)),
            "createdAt": str(latest.get("createdAt") or ""),
            "reason": str(latest.get("reason") or ""),
        } if latest else None,
    }


def _snapshot_continuation_todo(session, session_id, now):
    todos = session.get("todos") if isinstance(session.get("todos"), list) else []
    if any(str(todo.get("status") or "") in {"pending", "running", "paused"}
           for todo in todos if isinstance(todo, dict)):
        return None
    checkpoints = session.get("checkpoints") if isinstance(session.get("checkpoints"), list) else []
    latest = checkpoints[-1] if checkpoints and isinstance(checkpoints[-1], dict) else {}
    state = latest.get("state") if isinstance(latest.get("state"), dict) else {}
    summary = str(state.get("summary") or session.get("summary") or
                  "Continue from the recovered Agent Snapshot.").strip()
    next_actions = state.get("next_actions")
    if not isinstance(next_actions, list):
        next_actions = state.get("nextInfrastructurePriority")
    actions = [str(value).strip() for value in (next_actions or [])
               if str(value).strip()][:12]
    details = summary
    if actions:
        details += "\n\nNext actions:\n" + "\n".join("- " + action for action in actions)
    return {
        "todoId": "todo_" + hashlib.sha256(
            (session_id + ":resume-snapshot").encode("utf-8")).hexdigest()[:20],
        "title": "Continuing recovered Agent Snapshot",
        "details": details[:12000],
        "actionType": "resume_snapshot",
        "status": "pending",
        "createdAt": now,
        "updatedAt": now,
    }


def _snapshot_summary(snapshot, recovery_count=0):
    capture = snapshot.get("capture") or _snapshot_capture(snapshot.get("payload") or {})
    return {
        "snapshotId": str(snapshot.get("snapshotId") or ""),
        "magicCode": str(snapshot.get("magicCode") or ""),
        "sourceSessionId": str(snapshot.get("sourceSessionId") or ""),
        "sourceHostSessionId": str(snapshot.get("sourceHostSessionId") or ""),
        "task": str(snapshot.get("task") or "Agent Session snapshot"),
        "projectId": str(snapshot.get("projectId") or ""),
        "agent": snapshot.get("agent") or {"name": "Agent", "product": ""},
        "reason": str(snapshot.get("reason") or ""),
        "createdAt": str(snapshot.get("createdAt") or ""),
        "recipeRunCount": int(capture.get("recipeRunCount") or 0),
        "todoCount": int(capture.get("todoCount") or 0),
        "checkpoint": capture.get("checkpoint"),
        "recoveryCount": recovery_count,
    }


def _load_snapshot_by_magic(store, magic_code):
    normalized = str(magic_code or "").strip().upper()
    if not normalized.startswith("PKM-SNAP-"):
        raise ValueError("Agent Snapshot magic code is invalid.")
    directory = _snapshot_directory(store)
    if directory.exists():
        for path in directory.glob("*.json"):
            try:
                snapshot = json.loads(path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                continue
            if snapshot.get("schema") == SNAPSHOT_SCHEMA and snapshot.get("magicCode") == normalized:
                return _snapshot_encrypt_legacy(path, snapshot)
    raise ValueError(
        "Agent Snapshot was not found in the current Knowledge Root. "
        "The Magic Code identifies the Snapshot but does not contain its locally obfuscated "
        "payload. Restore the "
        "Agent Snapshot record from its origin Knowledge Root or an explicitly configured "
        "GitHub Sync backup, then retry.")


def _active_session_id(store, transport_key):
    path = _active_path(store, transport_key)
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        session_id = str(value.get("sessionId") or "")
        session_path, _ = _paths(store, session_id)
        session = json.loads(session_path.read_text(encoding="utf-8"))
        if session.get("schema") != SESSION_SCHEMA or session.get("status") != "running":
            path.unlink(missing_ok=True)
            return ""
        return session_id
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        path.unlink(missing_ok=True)
        return ""


def _load_session(store, session_id):
    if not session_id.startswith("agent_session_") or not all(
            character.isalnum() or character in "_-" for character in session_id):
        raise ValueError("Invalid Agent Session identity.")
    path, _ = _paths(store, session_id)
    if not path.exists():
        raise ValueError("Agent Session was not found.")
    session = json.loads(path.read_text(encoding="utf-8"))
    if session.get("schema") != SESSION_SCHEMA:
        raise ValueError("Agent Session schema is unsupported.")
    return session


def _read_result_json(result):
    try:
        content = getattr(result, "content", None) or []
        text = getattr(content[0], "text", "") if content else ""
        value = json.loads(text)
        return value if isinstance(value, dict) else {}
    except (json.JSONDecodeError, TypeError, IndexError):
        return {}


def _checkpoint_package_payload(store, session, checkpoint):
    run_ids = [str(value) for value in session.get("recipeRunIds") or []]
    runs = []
    recipe_ids = set()
    for run_id in run_ids:
        run_path = store / ".pkm" / "state" / "recipe-runs" / (run_id + ".json")
        if not run_path.exists():
            continue
        run = json.loads(run_path.read_text(encoding="utf-8"))
        run.pop("receipts", None)
        runs.append(run)
        recipe_ids.update(str(value) for value in run.get("ancestry") or [] if value)
        recipe_ids.add(str(run.get("recipeId") or ""))
        for node in ((run.get("definition") or {}).get("spec") or {}).get("nodes") or []:
            if node.get("kind") == "pkm.subflow/v1" and node.get("config", {}).get("recipeId"):
                recipe_ids.add(str(node["config"]["recipeId"]))
    recipes = []
    projects_path = store / ".pkm" / "state" / "projects.json"
    if projects_path.exists():
        envelope = json.loads(projects_path.read_text(encoding="utf-8"))
        candidates = ((envelope.get("payload") or {}).get("state") or {}).get("recipes") or []
        recipes = [recipe for recipe in candidates if str(recipe.get("recipeId") or "") in recipe_ids]
    return {
        "schema": "pkm.agent.checkpoint-package/v1",
        "exportedAt": _now(),
        "source": {"sessionId": session["sessionId"], "checkpointId": checkpoint["checkpointId"]},
        "session": {key: value for key, value in session.items()
                    if key not in {"sessionId", "recipeRunIds", "checkpoints", "lastActivity", "liveness"}},
        "checkpoint": checkpoint,
        "recipeRuns": runs,
        "recipes": recipes,
    }


def _package_path(store, package_name):
    package_name = str(package_name or "").strip()
    if not package_name or any(character not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-" for character in package_name):
        raise ValueError("package_name must use only letters, digits, dot, underscore, or hyphen.")
    packages = (store / "packages").resolve()
    target = (packages / package_name).resolve()
    if target.parent != packages:
        raise ValueError("Checkpoint Package path escapes the Knowledge Root.")
    return target


def _update_managed_session(store, transport_key, tool_name, result):
    session_id = _active_session_id(store, transport_key)
    if not session_id:
        return
    path, lock = _paths(store, session_id)
    if not path.exists():
        return
    response = _read_result_json(result)
    with _file_lock(lock):
        session = json.loads(path.read_text(encoding="utf-8"))
        if session.get("status") != "running":
            return
        run_id = str(response.get("run_id") or "")
        if run_id.startswith("recipe_run_") and run_id not in session["recipeRunIds"]:
            session["recipeRunIds"].append(run_id)
            running_todo = next((todo for todo in session.get("todos") or []
                                 if todo.get("status") == "running"), None)
            if running_todo is not None:
                linked_run_ids = running_todo.setdefault("recipeRunIds", [])
                legacy_run_id = str(running_todo.get("recipeRunId") or "")
                if legacy_run_id and legacy_run_id not in linked_run_ids:
                    linked_run_ids.append(legacy_run_id)
                if run_id not in linked_run_ids:
                    linked_run_ids.append(run_id)
                if not legacy_run_id:
                    running_todo["recipeRunId"] = run_id
                running_todo["updatedAt"] = _now()
            run_path = store / ".pkm" / "state" / "recipe-runs" / (run_id + ".json")
            run_lock = run_path.with_suffix(".lock")
            if run_path.exists():
                with _file_lock(run_lock):
                    run = json.loads(run_path.read_text(encoding="utf-8"))
                    run["agentSessionId"] = session_id
                    _atomic_write(run_path, run)
        session["lastActivity"] = {
            "tool": tool_name,
            "ok": response.get("ok") is not False,
            "at": _now(),
        }
        _touch_liveness(session, transport_key)
        session["updatedAt"] = session["lastActivity"]["at"]
        _atomic_write(path, session)
        _atomic_write(_active_path(store, transport_key), {
            "sessionId": session_id,
            "heartbeatAt": session["liveness"]["heartbeatAt"],
        })


class AgentSessionMiddleware(Middleware):
    def __init__(self, store):
        self.store = Path(store)

    async def on_call_tool(self, context, call_next):
        tool_name = str(getattr(context.message, "name", "") or "")
        result = await call_next(context)
        fastmcp_context = context.fastmcp_context
        if fastmcp_context is not None:
            _update_managed_session(self.store, _transport_key(fastmcp_context), tool_name, result)
        return result


def register_agent_session_tools(mcp, store):
    store = Path(store)

    @mcp.tool(annotations={"readOnlyHint": True})
    def agent_session_capabilities() -> dict:
        """Discover durable Agent Session management for substantial mutating work.

        Use when edits or operations need durable progress, recovery, handoff, or
        continuation across turns. Read-only diagnosis does not need a Session.
        """
        return {
            "schema": SESSION_SCHEMA,
            "version": AGENT_SESSION_SCHEMA_VERSION,
            "registration": "explicit-opt-in",
            "proactive": True,
            "use_when": [
                "substantial mutating multi-step task",
                "mutating work requiring validation or recovery",
                "mutating work that may continue across turns",
            ],
            "do_not_use_when": [
                "read-only diagnosis or assessment",
                "quick answer",
                "trivial one-command request",
            ],
            "next_tool": "agent_session_start",
            "first_managed_action": "agent_session_start",
            "tools": ["agent_session_start", "agent_session_status", "agent_session_checkpoint",
                      "agent_session_load", "agent_session_resume", "agent_session_export_checkpoint",
                      "agent_session_import_checkpoint", "agent_session_snapshot_create",
                      "agent_session_snapshot_list",
                      "agent_session_snapshot_recover", "agent_session_todo_append",
                      "agent_session_todo_replan", "agent_session_todo_next", "agent_session_todo_report",
                      "agent_session_stop", "agent_session_end"],
            "host_session_grouping": "Pass the current host chat/session ID to agent_session_start when available so related managed tasks are grouped together.",
            "recipe_progress": "Recipe runs started after registration are projected as a live task graph.",
            "todo_queue": {
                "policy": "FIFO by default; explicit user redirects may atomically pause current work and insert an interrupt action before it.",
                "additive_instruction": "Append non-conflicting new work with agent_session_todo_append. Do not abandon or reorder unfinished todos.",
                "redirect_instruction": "Use agent_session_todo_replan for explicit user redirects, including report_status before continuing current work.",
                "completion_instruction": "After reporting the final todo, validate and checkpoint as needed, then call agent_session_end when next_action.kind is call_agent_session_end.",
                "example_todos_json": '[{"title":"Implement change","details":"Preserve existing behavior"},{"title":"Validate","details":"Run focused tests"}]',
            },
            "handoff": "checkpoint/load/resume persists agent-authored recovery context; Agent Snapshots use a Magic Code to clone a new independent Session while the locally obfuscated payload remains in the Knowledge Root; hidden model state is not inspectable.",
        }

    @mcp.tool()
    def agent_session_start(task: str, command_id: str, project_id: str = "",
                            agent_name: str = "GitHub Copilot", host_session_id: str = "",
                            traversal_strategy: str = "",
                            ctx: Context = None) -> dict:
        """Start durable management for a substantial task before its first substantive mutation.

        Pass the host chat/session ID when available, then append an actionable todo plan.
        Use proactively based on task complexity; explicit user mention is not required.
        """
        if ctx is None:
            raise ValueError("MCP request context is required.")
        task = str(task or "").strip()
        command_id = str(command_id or "").strip()
        host_session_id = str(host_session_id or "").strip()
        traversal_strategy = str(traversal_strategy or "").strip().lower()
        traversal_strategy = {"bfs": "breadth-first", "dfs": "depth-first"}.get(
            traversal_strategy, traversal_strategy)
        if not task or not command_id:
            raise ValueError("task and command_id are required.")
        if traversal_strategy not in {"", "breadth-first", "depth-first"}:
            raise ValueError("traversal_strategy must be breadth-first, depth-first, bfs, or dfs.")
        if len(host_session_id) > 256:
            raise ValueError("host_session_id must be at most 256 characters.")
        session_id = "agent_session_" + hashlib.sha256(command_id.encode("utf-8")).hexdigest()[:24]
        path, lock = _paths(store, session_id)
        transport_key = _transport_key(ctx)
        active_session_id = _active_session_id(store, transport_key)
        if active_session_id and active_session_id != session_id:
            active_path, _ = _paths(store, active_session_id)
            if active_path.exists():
                active_session = json.loads(active_path.read_text(encoding="utf-8"))
                if _projected_session_status(active_session) == "running":
                    raise ValueError(
                        "This transport already has a different running Agent Session. "
                        "End, stop, or explicitly hand off that Session before starting another.")
        with _file_lock(lock):
            if path.exists():
                session = json.loads(path.read_text(encoding="utf-8"))
                if (session.get("task") != task
                    or session.get("projectId", "") != str(project_id or "")
                    or session.get("hostSessionId", "") != host_session_id
                    or session.get("traversalStrategy", "") != traversal_strategy):
                    raise ValueError("command_id was reused with different Agent Session parameters.")
            else:
                now = _now()
                session = {
                    "schema": SESSION_SCHEMA,
                    "sessionId": session_id,
                    "status": "running",
                    "task": task,
                    "projectId": str(project_id or ""),
                    "hostSessionId": host_session_id,
                    "traversalStrategy": traversal_strategy,
                    "agent": {"name": str(agent_name or "GitHub Copilot"), "product": "GitHub Copilot"},
                    "recipeRunIds": [],
                    "todos": [],
                    "todoCommandReceipts": {},
                    "checkpoints": [],
                    "lastActivity": {"tool": "agent_session_start", "ok": True, "at": now},
                    "createdAt": now,
                    "updatedAt": now,
                }
            _touch_liveness(session, transport_key)
            _atomic_write(path, session)
        _atomic_write(_active_path(store, transport_key), {
            "sessionId": session_id,
            "heartbeatAt": session["liveness"]["heartbeatAt"],
        })
        return {"ok": True, "schema": SESSION_SCHEMA, "session_id": session_id,
            "status": session["status"], "task": session["task"],
            "host_session_id": session.get("hostSessionId", ""),
            "traversal_strategy": session.get("traversalStrategy", "")}

    @mcp.tool(annotations={"readOnlyHint": True})
    def agent_session_status(detail: str = "compact", ctx: Context = None) -> dict:
        """Return compact active Session state, or the complete record when detail is full."""
        if ctx is None:
            raise ValueError("MCP request context is required.")
        detail = _validate_detail(detail)
        session_id = _active_session_id(store, _transport_key(ctx))
        if not session_id:
            return {"ok": True, "managed": False}
        path, _ = _paths(store, session_id)
        session = json.loads(path.read_text(encoding="utf-8"))
        return {
            "ok": True,
            "managed": session.get("status") == "running",
            "detail": detail,
            "session": session if detail == "full" else _compact_session(session),
        }

    @mcp.tool()
    def agent_session_stop(session_id: str, reason: str = "user-requested", summary: str = "",
                           ctx: Context = None) -> dict:
        """Stop one running Agent Session without representing unfinished work as completed."""
        if ctx is None:
            raise ValueError("MCP request context is required.")
        session_id = str(session_id or "").strip()
        if not session_id.startswith("agent_session_") or not all(
                character.isalnum() or character in "_-" for character in session_id):
            raise ValueError("Invalid Agent Session identity.")
        path, lock = _paths(store, session_id)
        with _file_lock(lock):
            session = _load_session(store, session_id)
            if session.get("status") != "running":
                raise ValueError("Only a running Agent Session can be stopped.")
            now = _now()
            session["status"] = "stopped"
            session["stopReason"] = str(reason or "user-requested")
            bounded_summary = _bounded_text(
                summary, "summary", SESSION_SUMMARY_CHARACTER_LIMIT)
            if bounded_summary:
                session["summary"] = bounded_summary
            else:
                session.pop("summary", None)
            session["stoppedAt"] = now
            session["updatedAt"] = now
            _atomic_write(path, session)
        cleared = _clear_active_session_mappings(store, session_id)
        return {"ok": True, "managed": False, "session_id": session_id,
                "status": "stopped", "cleared_active_mappings": cleared}

    @mcp.tool()
    def agent_session_checkpoint(state_json: str, reason: str = "manual", ctx: Context = None) -> dict:
        """Persist complete recovery context before interruption: summary, work, decisions, files, validation, and next actions."""
        if ctx is None:
            raise ValueError("MCP request context is required.")
        try:
            state = json.loads(state_json or "{}")
        except json.JSONDecodeError as error:
            raise ValueError("state_json must be valid JSON: " + str(error)) from error
        if not isinstance(state, dict) or not state:
            raise ValueError("state_json must be a non-empty JSON object.")
        transport_key = _transport_key(ctx)
        session_id = _active_session_id(store, transport_key)
        if not session_id:
            raise ValueError("No active managed Agent Session. Call agent_session_start first.")
        path, lock = _paths(store, session_id)
        with _file_lock(lock):
            session = _load_session(store, session_id)
            sequence = len(session.get("checkpoints") or []) + 1
            checkpoint_id = "checkpoint_" + hashlib.sha256(
                (session_id + ":" + str(sequence) + ":" + _json(state)).encode("utf-8")
            ).hexdigest()[:20]
            checkpoint = {"checkpointId": checkpoint_id, "sequence": sequence,
                          "reason": str(reason or "manual"), "state": state, "createdAt": _now()}
            session.setdefault("checkpoints", []).append(checkpoint)
            if len(session["checkpoints"]) > 50:
                session["checkpoints"] = session["checkpoints"][-50:]
            session["updatedAt"] = checkpoint["createdAt"]
            _atomic_write(path, session)
        return {"ok": True, "session_id": session_id, "checkpoint_id": checkpoint_id,
                "sequence": sequence, "recipe_run_ids": session.get("recipeRunIds") or []}

    @mcp.tool(annotations={"readOnlyHint": True})
    def agent_session_load(session_id: str) -> dict:
        """Load a durable Agent Session handoff in a new conversation without activating it."""
        session = _load_session(store, str(session_id or ""))
        checkpoints = session.get("checkpoints") or []
        return {"ok": True, "schema": SESSION_SCHEMA, "session": session,
                "latest_checkpoint": checkpoints[-1] if checkpoints else None,
                "resume_instruction": "Call agent_session_resume, then recipe_run_get for each non-terminal Recipe run."}

    @mcp.tool()
    def agent_session_resume(session_id: str, ctx: Context = None) -> dict:
        """Adopt a durable managed Agent Session from a new MCP transport and continue its existing Recipe runs."""
        if ctx is None:
            raise ValueError("MCP request context is required.")
        session_id = str(session_id or "")
        if not session_id.startswith("agent_session_") or not all(
                character.isalnum() or character in "_-" for character in session_id):
            raise ValueError("Invalid Agent Session identity.")
        path, lock = _paths(store, session_id)
        with _file_lock(lock):
            session = _load_session(store, session_id)
            if session.get("status") == "completed":
                raise ValueError("Completed Agent Sessions are immutable and cannot be resumed.")
            session["status"] = "running"
            session.pop("stoppedAt", None)
            session.pop("stopReason", None)
            session["resumeCount"] = int(session.get("resumeCount") or 0) + 1
            session["resumedAt"] = _now()
            _touch_liveness(session, _transport_key(ctx))
            session["updatedAt"] = session["resumedAt"]
            _atomic_write(path, session)
        _atomic_write(_active_path(store, _transport_key(ctx)), {
            "sessionId": session_id,
            "heartbeatAt": session["liveness"]["heartbeatAt"],
        })
        checkpoints = session.get("checkpoints") or []
        return {"ok": True, "managed": True, "session_id": session_id,
                "latest_checkpoint": checkpoints[-1] if checkpoints else None,
                "recipe_run_ids": session.get("recipeRunIds") or []}

    @mcp.tool()
    def agent_session_snapshot_create(reason: str = "manual", state_json: str = "",
                                      ctx: Context = None) -> dict:
        """Create an immutable Agent Snapshot and return a reusable Magic Code recovery prompt.

        Use before closing a resource-heavy conversation. In a new conversation, paste the
        Magic Code recovery prompt so the Agent can call agent_session_snapshot_recover.
        """
        if ctx is None:
            raise ValueError("MCP request context is required.")
        transport_key = _transport_key(ctx)
        session_id = _active_session_id(store, transport_key)
        if not session_id:
            raise ValueError("No active managed Agent Session. Call agent_session_start or agent_session_resume first.")
        path, lock = _paths(store, session_id)
        with _file_lock(lock):
            session = _load_session(store, session_id)
            if state_json:
                try:
                    state = json.loads(state_json)
                except json.JSONDecodeError as error:
                    raise ValueError("state_json must be valid JSON: " + str(error)) from error
                if not isinstance(state, dict) or not state:
                    raise ValueError("state_json must be a non-empty JSON object.")
                sequence = len(session.get("checkpoints") or []) + 1
                checkpoint_id = "checkpoint_" + hashlib.sha256(
                    (session_id + ":" + str(sequence) + ":" + _json(state)).encode("utf-8")
                ).hexdigest()[:20]
                checkpoint = {
                    "checkpointId": checkpoint_id,
                    "sequence": sequence,
                    "reason": str(reason or "snapshot"),
                    "state": state,
                    "createdAt": _now(),
                }
                session.setdefault("checkpoints", []).append(checkpoint)
                if len(session["checkpoints"]) > 50:
                    session["checkpoints"] = session["checkpoints"][-50:]
                session["updatedAt"] = checkpoint["createdAt"]
                _atomic_write(path, session)
            payload = _snapshot_payload(store, session)
        magic_code = _snapshot_magic_code()
        created_at = _now()
        snapshot_id = "agent_snapshot_" + hashlib.sha256(
            (magic_code + ":" + session_id + ":" + created_at).encode("utf-8")
        ).hexdigest()[:24]
        snapshot = {
            "schema": SNAPSHOT_SCHEMA,
            "snapshotId": snapshot_id,
            "magicCode": magic_code,
            "sourceSessionId": session_id,
            "sourceHostSessionId": str(session.get("hostSessionId") or ""),
            "task": str(session.get("task") or "Managed task"),
            "projectId": str(session.get("projectId") or ""),
            "agent": session.get("agent") or {"name": "Agent", "product": ""},
            "reason": str(reason or "manual"),
            "createdAt": created_at,
            "capture": _snapshot_capture(payload),
            "payload": _snapshot_encrypt_payload(payload, snapshot_id, magic_code),
        }
        snapshot_path = _snapshot_directory(store) / (snapshot_id + ".json")
        if snapshot_path.exists():
            raise ValueError("Agent Snapshot identity collision.")
        _atomic_write(snapshot_path, snapshot)
        return {
            "ok": True,
            "snapshot": _snapshot_summary(snapshot),
            "recovery_prompt": _snapshot_recovery_prompt(magic_code),
            "warning": (
                "The Snapshot payload uses the fixed local 'uone' obfuscation key only to avoid "
                "plaintext storage; it is not credential protection. Recovery requires this "
                "Snapshot record to remain in the current Knowledge Root or be restored from "
                "an explicitly configured GitHub Sync backup."
            ),
        }

    @mcp.tool(annotations={"readOnlyHint": True})
    def agent_session_snapshot_list() -> dict:
        """List immutable Agent Snapshots without exposing recovery verifiers or captured payloads."""
        directory = _snapshot_directory(store)
        recoveries = {}
        sessions_directory = store / ".pkm" / "state" / "agent-sessions"
        if sessions_directory.exists():
            for path in sessions_directory.glob("agent_session_*.json"):
                try:
                    session = json.loads(path.read_text(encoding="utf-8"))
                    snapshot_id = str((session.get("provenance") or {}).get("snapshotId") or "")
                    if snapshot_id:
                        recoveries[snapshot_id] = recoveries.get(snapshot_id, 0) + 1
                except (json.JSONDecodeError, OSError):
                    continue
        snapshots = []
        if directory.exists():
            for path in directory.glob("agent_snapshot_*.json"):
                try:
                    snapshot = json.loads(path.read_text(encoding="utf-8"))
                    if snapshot.get("schema") == SNAPSHOT_SCHEMA:
                        snapshot = _snapshot_encrypt_legacy(path, snapshot)
                        snapshots.append(_snapshot_summary(
                            snapshot, recoveries.get(str(snapshot.get("snapshotId") or ""), 0)))
                except (json.JSONDecodeError, OSError):
                    continue
        snapshots.sort(key=lambda item: item["createdAt"], reverse=True)
        return {"ok": True, "snapshots": snapshots}

    @mcp.tool()
    def agent_session_snapshot_recover(magic_code: str, host_session_id: str = "",
                                       ctx: Context = None) -> dict:
        """Recover a pasted Agent Snapshot into a new independent managed Session.

        The source Session and immutable Snapshot remain unchanged, so the same recovery
        Magic Code may intentionally create multiple Sessions with the same starting state.
        """
        magic_code = _normalize_snapshot_magic_code(magic_code)
        if ctx is None:
            raise ValueError("MCP request context is required.")
        snapshot = _load_snapshot_by_magic(store, magic_code)
        transport_key = _transport_key(ctx)
        active_session_id = _active_session_id(store, transport_key)
        if active_session_id:
            active_path, _ = _paths(store, active_session_id)
            if active_path.exists():
                active_session = json.loads(active_path.read_text(encoding="utf-8"))
                if active_session.get("status") == "running":
                    raise ValueError(
                        "This transport already has a different running Agent Session. "
                        "End, stop, or explicitly hand off that Session before recovering a Snapshot.")
        payload = _snapshot_decrypt_payload(snapshot)
        source_session = (payload.get("session") or {})
        source_runs = (payload.get("recipeRuns") or [])
        recovery_key = uuid.uuid4().hex
        session_id = "agent_session_" + hashlib.sha256(
            (str(snapshot["snapshotId"]) + ":" + recovery_key).encode("utf-8")
        ).hexdigest()[:24]
        run_id_map = {
            str(run.get("runId") or ""): "recipe_run_" + hashlib.sha256(
                (str(run.get("runId") or "") + ":" + recovery_key).encode("utf-8")
            ).hexdigest()[:24]
            for run in source_runs if run.get("runId")
        }
        recovered_runs = []
        for source_run in source_runs:
            run = json.loads(_json(source_run))
            old_run_id = str(run.get("runId") or "")
            if old_run_id not in run_id_map:
                continue
            run["runId"] = run_id_map[old_run_id]
            run["agentSessionId"] = session_id
            run["receipts"] = {}
            if isinstance(run.get("parent"), dict):
                run["parent"]["runId"] = run_id_map.get(str(run["parent"].get("runId") or ""), "")
            for node_id, record in (run.get("nodes") or {}).items():
                if record.get("state") == "running":
                    reset_record = {"state": "pending"}
                    if record.get("childRunId"):
                        reset_record["childRunId"] = run_id_map.get(str(record["childRunId"]), "")
                    if record.get("childRecipeId"):
                        reset_record["childRecipeId"] = record["childRecipeId"]
                    run["nodes"][node_id] = reset_record
                    record = run["nodes"][node_id]
                elif record.get("childRunId"):
                    record["childRunId"] = run_id_map.get(str(record["childRunId"]), "")
            recovered_runs.append(run)
        now = _now()
        session = json.loads(_json(source_session))
        session.update({
            "schema": SESSION_SCHEMA,
            "sessionId": session_id,
            "status": "running",
            "hostSessionId": str(host_session_id or ""),
            "recipeRunIds": [run_id_map[run_id] for run_id in source_session.get("recipeRunIds") or []
                             if run_id in run_id_map],
            "todoCommandReceipts": {},
            "lastActivity": {"tool": "agent_session_snapshot_recover", "ok": True, "at": now},
            "provenance": {
                "kind": "agent-snapshot",
                "snapshotId": str(snapshot["snapshotId"]),
                "magicCode": str(snapshot["magicCode"]),
                "sourceSessionId": str(snapshot.get("sourceSessionId") or ""),
            },
            "createdAt": now,
            "updatedAt": now,
            "recoveredAt": now,
        })
        _touch_liveness(session, transport_key)
        for todo in session.get("todos") or []:
            if todo.get("status") in {"running", "paused"}:
                todo["status"] = "pending"
                for field in ("startedAt", "pausedAt", "pauseReason", "resumedAt"):
                    todo.pop(field, None)
                todo["updatedAt"] = now
            if todo.get("recipeRunId"):
                todo["recipeRunId"] = run_id_map.get(str(todo["recipeRunId"]), "")
            if isinstance(todo.get("recipeRunIds"), list):
                todo["recipeRunIds"] = [run_id_map[run_id] for run_id in todo["recipeRunIds"]
                                        if run_id in run_id_map]
        continuation_todo = _snapshot_continuation_todo(session, session_id, now)
        if continuation_todo:
            session.setdefault("todos", []).append(continuation_todo)
        session_path, session_lock = _paths(store, session_id)
        active_path = _active_path(store, transport_key)
        run_paths = [
            store / ".pkm" / "state" / "recipe-runs" / (run["runId"] + ".json")
            for run in recovered_runs
        ]
        created_paths = []
        try:
            with _file_lock(session_lock):
                if session_path.exists() or any(path.exists() for path in run_paths):
                    raise ValueError("Recovered Agent Session identity collision.")
                for run_path, run in zip(run_paths, recovered_runs):
                    _atomic_write(run_path, run)
                    created_paths.append(run_path)
                _atomic_write(session_path, session)
                created_paths.append(session_path)
                _atomic_write(active_path, {
                    "sessionId": session_id,
                    "heartbeatAt": session["liveness"]["heartbeatAt"],
                })
        except Exception:
            try:
                if active_path.exists():
                    mapping = json.loads(active_path.read_text(encoding="utf-8"))
                    if str(mapping.get("sessionId") or "") == session_id:
                        active_path.unlink(missing_ok=True)
            except (json.JSONDecodeError, OSError):
                pass
            for created_path in reversed(created_paths):
                created_path.unlink(missing_ok=True)
            raise
        checkpoints = session.get("checkpoints") or []
        return {
            "ok": True,
            "managed": True,
            "session_id": session_id,
            "snapshot_id": snapshot["snapshotId"],
            "latest_checkpoint": checkpoints[-1] if checkpoints else None,
            "recipe_run_ids": session["recipeRunIds"],
            "recovery_todo_created": continuation_todo is not None,
            "next_action": {
                "kind": "call_agent_session_todo_next",
                "reason": "Claim the recovered continuation or unfinished todo.",
            },
            "resume_instruction": "Continue the restored todos, then call recipe_run_get for each non-terminal Recipe run.",
        }

    def active_session_for_todo(ctx):
        if ctx is None:
            raise ValueError("MCP request context is required.")
        session_id = _active_session_id(store, _transport_key(ctx))
        if not session_id:
            raise ValueError("No active managed Agent Session. Call agent_session_start or agent_session_resume first.")
        return session_id

    def todo_receipt(session, command_id, operation, arguments):
        command_id = str(command_id or "").strip()
        if not command_id or len(command_id) > 256:
            raise ValueError("command_id is required and must be at most 256 characters.")
        fingerprint = hashlib.sha256(_json({"operation": operation, "arguments": arguments}).encode("utf-8")).hexdigest()
        existing = (session.get("todoCommandReceipts") or {}).get(command_id)
        if existing:
            if existing.get("fingerprint") != fingerprint:
                raise ValueError("command_id was reused with different todo parameters.")
            replay = dict(existing.get("result") or {})
            if isinstance(arguments, dict) and arguments.get("detail") == "full":
                todos_by_id = {
                    todo.get("todoId"): todo
                    for todo in (session.get("todos") or [])
                    if isinstance(todo, dict)
                }
                for key in ("todo", "resumed_todo"):
                    compact = replay.get(key)
                    if isinstance(compact, dict) and compact.get("todoId") in todos_by_id:
                        replay[key] = todos_by_id[compact["todoId"]]
            return command_id, fingerprint, replay
        return command_id, fingerprint, None

    def save_todo_receipt(session, command_id, fingerprint, result):
        receipts = session.setdefault("todoCommandReceipts", {})
        for receipt in receipts.values():
            stored_result = receipt.get("result")
            if isinstance(stored_result, dict):
                stored_result.pop("todos", None)
                for key in ("todo", "resumed_todo"):
                    if isinstance(stored_result.get(key), dict):
                        stored_result[key] = _compact_todo(stored_result[key])
        compact_result = dict(result)
        compact_result.pop("todos", None)
        for key in ("todo", "resumed_todo"):
            if isinstance(compact_result.get(key), dict):
                compact_result[key] = _compact_todo(compact_result[key])
        receipts[command_id] = {"fingerprint": fingerprint, "result": compact_result}
        while len(receipts) > 200:
            del receipts[next(iter(receipts))]
        while len(receipts) > 1 and len(_json(receipts).encode("utf-8")) > TODO_RECEIPT_BYTE_LIMIT:
            del receipts[next(iter(receipts))]

    @mcp.tool()
    def agent_session_todo_append(todos_json: str, command_id: str, detail: str = "compact",
                                  ctx: Context = None) -> dict:
        """Append todos and return compact IDs by default; use detail full to include the queue."""
        session_id = active_session_for_todo(ctx)
        detail = _validate_detail(detail)
        try:
            raw_todos = json.loads(todos_json or "[]")
        except json.JSONDecodeError as error:
            raise ValueError("todos_json must be a JSON array: " + str(error)) from error
        if not isinstance(raw_todos, list) or not raw_todos:
            raise ValueError("todos_json must be a non-empty JSON array.")
        normalized = []
        for value in raw_todos:
            item = {"title": value, "details": ""} if isinstance(value, str) else value
            if not isinstance(item, dict) or not str(item.get("title") or "").strip():
                raise ValueError("Each todo must be a title string or an object with a non-empty title.")
            normalized.append({
                "title": _bounded_text(
                    item["title"], "todo title", TODO_TITLE_CHARACTER_LIMIT),
                "details": _bounded_text(
                    item.get("details"), "todo details", TODO_DETAILS_CHARACTER_LIMIT),
            })
        path, lock = _paths(store, session_id)
        with _file_lock(lock):
            session = _load_session(store, session_id)
            command_id, fingerprint, prior = todo_receipt(session, command_id, "append", normalized)
            if prior is not None:
                return prior
            now = _now()
            todos = session.setdefault("todos", [])
            added = []
            for index, item in enumerate(normalized):
                todo_id = "todo_" + hashlib.sha256(
                    (session_id + ":" + command_id + ":" + str(index)).encode("utf-8")).hexdigest()[:20]
                todo = {"todoId": todo_id, **item, "status": "pending", "createdAt": now, "updatedAt": now}
                todos.append(todo)
                added.append(todo_id)
            session["updatedAt"] = now
            result = {"ok": True, "session_id": session_id, "added_todo_ids": added,
                      "queue_length": len(todos)}
            if detail == "full":
                result["todos"] = todos
            save_todo_receipt(session, command_id, fingerprint, result)
            _atomic_write(path, session)
            return result

    @mcp.tool()
    def agent_session_todo_replan(operation_json: str, command_id: str,
                                  session_id: str = "", detail: str = "compact",
                                  ctx: Context = None) -> dict:
        """Apply an explicit user-directed todo change without adopting another Session transport.

        Use type=interrupt to pause the running todo and insert a report_status or work action
        immediately before it. Use type=update or type=cancel only for pending/paused todos.
        """
        try:
            operation = json.loads(operation_json or "{}")
        except json.JSONDecodeError as error:
            raise ValueError("operation_json must be a JSON object: " + str(error)) from error
        if not isinstance(operation, dict):
            raise ValueError("operation_json must be a JSON object.")
        detail = _validate_detail(detail)
        target_session_id = str(session_id or "").strip() or active_session_for_todo(ctx)
        path, lock = _paths(store, target_session_id)
        with _file_lock(lock):
            session = _load_session(store, target_session_id)
            if session.get("status") != "running":
                raise ValueError("Only a running Agent Session can be replanned.")
            command_id, fingerprint, prior = todo_receipt(session, command_id, "replan", operation)
            if prior is not None:
                return prior
            todos = session.setdefault("todos", [])
            operation_type = str(operation.get("type") or "").strip()
            now = _now()
            affected = []
            if operation_type == "interrupt":
                running = next((todo for todo in todos if todo.get("status") == "running"), None)
                target_id = str(operation.get("target_todo_id") or "")
                if running is None or (target_id and running.get("todoId") != target_id):
                    raise ValueError("The requested running todo was not found.")
                if any(todo.get("status") == "paused" for todo in todos):
                    raise ValueError("A todo is already paused for an outstanding interrupt action.")
                action_type = str(operation.get("action_type") or "report_status").strip()
                if action_type not in {"report_status", "work"}:
                    raise ValueError("action_type must be report_status or work.")
                title = str(operation.get("title") or ("Report current status" if action_type == "report_status" else "Handle user redirect")).strip()
                if not title:
                    raise ValueError("Interrupt title is required.")
                running.update({"status": "paused", "pausedAt": now, "updatedAt": now,
                                "pauseReason": str(operation.get("reason") or operation.get("details") or "User redirect").strip()})
                interrupt_id = "todo_" + hashlib.sha256(
                    (target_session_id + ":" + command_id + ":interrupt").encode("utf-8")).hexdigest()[:20]
                interrupt = {"todoId": interrupt_id, "title": title,
                             "details": str(operation.get("details") or "").strip(),
                             "actionType": action_type, "resumeTodoId": running["todoId"],
                             "status": "pending", "createdAt": now, "updatedAt": now}
                todos.insert(todos.index(running), interrupt)
                affected = [interrupt_id, running["todoId"]]
            elif operation_type == "update":
                target_id = str(operation.get("todo_id") or "").strip()
                todo = next((item for item in todos if item.get("todoId") == target_id), None)
                if todo is None or todo.get("status") not in {"pending", "paused"}:
                    raise ValueError("Only a pending or paused todo can be updated.")
                if "title" in operation:
                    title = str(operation.get("title") or "").strip()
                    if not title:
                        raise ValueError("Updated todo title cannot be empty.")
                    todo["title"] = title
                if "details" in operation:
                    todo["details"] = str(operation.get("details") or "").strip()
                todo["updatedAt"] = now
                affected = [target_id]
            elif operation_type == "cancel":
                target_id = str(operation.get("todo_id") or "").strip()
                todo = next((item for item in todos if item.get("todoId") == target_id), None)
                if todo is None or todo.get("status") not in {"pending", "paused"}:
                    raise ValueError("Only a pending or paused todo can be cancelled.")
                todo.update({"status": "skipped", "summary": str(operation.get("reason") or "Cancelled by user redirect"),
                             "completedAt": now, "updatedAt": now})
                affected = [target_id]
            else:
                raise ValueError("type must be interrupt, update, or cancel.")
            session["updatedAt"] = now
            result = {"ok": True, "session_id": target_session_id, "operation": operation_type,
                      "affected_todo_ids": affected, "queue_length": len(todos)}
            if detail == "full":
                result["todos"] = todos
            save_todo_receipt(session, command_id, fingerprint, result)
            _atomic_write(path, session)
            return result

    @mcp.tool()
    def agent_session_todo_next(command_id: str, detail: str = "compact",
                                ctx: Context = None) -> dict:
        """Claim the first pending Todo; compact output avoids echoing its instructions."""
        session_id = active_session_for_todo(ctx)
        detail = _validate_detail(detail)
        path, lock = _paths(store, session_id)
        with _file_lock(lock):
            session = _load_session(store, session_id)
            command_id, fingerprint, prior = todo_receipt(
                session, command_id, "next", {"detail": detail})
            if prior is not None:
                return prior
            todos = session.setdefault("todos", [])
            todo = next((item for item in todos if item.get("status") == "running"), None)
            claimed = False
            if todo is None:
                todo = next((item for item in todos if item.get("status") == "pending"), None)
                if todo is not None:
                    todo["status"] = "running"
                    todo["startedAt"] = _now()
                    todo["updatedAt"] = todo["startedAt"]
                    claimed = True
            result = {
                "ok": True,
                "session_id": session_id,
                "claimed": claimed,
                "todo": _todo_projection(todo, detail),
            }
            save_todo_receipt(session, command_id, fingerprint, result)
            session["updatedAt"] = _now()
            _atomic_write(path, session)
            return result

    @mcp.tool()
    def agent_session_todo_report(todo_id: str, status: str, command_id: str,
                                  summary: str = "", detail: str = "compact",
                                  ctx: Context = None) -> dict:
        """Finish a running Todo; use a concise durable outcome and compact output."""
        session_id = active_session_for_todo(ctx)
        todo_id = str(todo_id or "").strip()
        status = str(status or "").strip()
        detail = _validate_detail(detail)
        if status not in TODO_TERMINAL_STATES:
            raise ValueError("status must be succeeded, failed, or skipped.")
        arguments = {
            "todo_id": todo_id,
            "status": status,
            "summary": _bounded_text(
                summary, "summary", TODO_SUMMARY_CHARACTER_LIMIT),
            "detail": detail,
        }
        path, lock = _paths(store, session_id)
        with _file_lock(lock):
            session = _load_session(store, session_id)
            command_id, fingerprint, prior = todo_receipt(session, command_id, "report", arguments)
            if prior is not None:
                return prior
            todo = next((item for item in session.get("todos") or [] if item.get("todoId") == todo_id), None)
            if todo is None:
                raise ValueError("Agent Session todo was not found.")
            if todo.get("status") != "running":
                raise ValueError("Only the running Agent Session todo can be reported.")
            now = _now()
            todo.update({"status": status, "summary": arguments["summary"], "completedAt": now, "updatedAt": now})
            resumed_todo = None
            resume_todo_id = str(todo.get("resumeTodoId") or "")
            if resume_todo_id:
                resumed_todo = next((item for item in session.get("todos") or []
                                     if item.get("todoId") == resume_todo_id), None)
                if resumed_todo is not None and resumed_todo.get("status") == "paused":
                    resumed_todo.update({"status": "pending", "resumedAt": now, "updatedAt": now})
            session["updatedAt"] = now
            unfinished = [item for item in session.get("todos") or []
                          if item.get("status") in {"pending", "running", "paused"}]
            if resumed_todo is not None:
                next_action = {
                    "kind": "call_agent_session_todo_next",
                    "reason": "The interrupted todo is ready to resume.",
                }
            elif unfinished:
                next_action = {
                    "kind": "call_agent_session_todo_next",
                    "reason": "The Agent Session still has unfinished todos.",
                }
            else:
                next_action = {
                    "kind": "call_agent_session_end",
                    "reason": "All Session todos are terminal. Validate the overall outcome, checkpoint if useful, then end the Session.",
                }
            result = {
                "ok": True,
                "session_id": session_id,
                "todo": _todo_projection(todo, detail),
                "resumed_todo": _todo_projection(resumed_todo, detail),
                "next_action": next_action,
            }
            save_todo_receipt(session, command_id, fingerprint, result)
            _atomic_write(path, session)
            return result

    @mcp.tool()
    def agent_session_export_checkpoint(checkpoint_id: str = "", package_name: str = "",
                                        ctx: Context = None) -> dict:
        """Export an immutable checkpoint Package for explicit publication through PKM Share/Subscribe."""
        if ctx is None:
            raise ValueError("MCP request context is required.")
        session_id = _active_session_id(store, _transport_key(ctx))
        if not session_id:
            raise ValueError("No active managed Agent Session. Call agent_session_start or agent_session_resume first.")
        session = _load_session(store, session_id)
        checkpoints = session.get("checkpoints") or []
        checkpoint = next((item for item in checkpoints if item.get("checkpointId") == checkpoint_id), None) if checkpoint_id else (checkpoints[-1] if checkpoints else None)
        if not checkpoint:
            raise ValueError("Agent Session checkpoint was not found.")
        default_name = "agent-checkpoint-" + str(checkpoint["checkpointId"]).removeprefix("checkpoint_")
        target = _package_path(store, package_name or default_name)
        if target.exists():
            raise ValueError("Checkpoint Package already exists and is immutable.")
        payload = _checkpoint_package_payload(store, session, checkpoint)
        payload_json = _json(payload)
        digest = hashlib.sha256(payload_json.encode("utf-8")).hexdigest()
        staging = target.with_name("." + target.name + "." + str(os.getpid()) + "." + uuid.uuid4().hex + ".tmp")
        try:
            staging.mkdir(parents=True)
            (staging / "README.md").write_text(
                "# Agent Checkpoint\n\nImmutable PKM Agent Session checkpoint package. Import with `agent_session_import_checkpoint`.\n",
                encoding="utf-8")
            (staging / "manifest.json").write_text(_json({
                "schema": "pkm.agent.checkpoint-package-manifest/v1", "payload": "checkpoint.json",
                "sha256": digest, "source": payload["source"],
            }), encoding="utf-8")
            (staging / "checkpoint.json").write_text(payload_json, encoding="utf-8")
            target.parent.mkdir(parents=True, exist_ok=True)
            os.replace(staging, target)
        except Exception:
            if staging.exists():
                import shutil
                shutil.rmtree(staging, ignore_errors=True)
            raise
        return {"ok": True, "package_name": target.name, "package_path": str(target.relative_to(store)),
                "sha256": digest, "share_instruction": "Publish this Package with the existing PKM Share controls."}

    @mcp.tool()
    def agent_session_import_checkpoint(package_name: str) -> dict:
        """Verify and import a local or subscribed-fork checkpoint Package as a new resumable Agent Session."""
        package = _package_path(store, package_name)
        manifest = json.loads((package / "manifest.json").read_text(encoding="utf-8"))
        payload_text = (package / "checkpoint.json").read_text(encoding="utf-8")
        if manifest.get("schema") != "pkm.agent.checkpoint-package-manifest/v1":
            raise ValueError("Checkpoint Package manifest schema is unsupported.")
        if hashlib.sha256(payload_text.encode("utf-8")).hexdigest() != manifest.get("sha256"):
            raise ValueError("Checkpoint Package digest is invalid.")
        payload = json.loads(payload_text)
        if payload.get("schema") != "pkm.agent.checkpoint-package/v1":
            raise ValueError("Checkpoint Package payload schema is unsupported.")
        import_key = uuid.uuid4().hex
        session_id = "agent_session_" + hashlib.sha256((manifest["sha256"] + import_key).encode("utf-8")).hexdigest()[:24]
        run_id_map = {str(run.get("runId")): "recipe_run_" + hashlib.sha256(
            (str(run.get("runId")) + ":" + import_key).encode("utf-8")).hexdigest()[:24]
                      for run in payload.get("recipeRuns") or []}
        embedded_recipes = payload.get("recipes") or []
        for source_run in payload.get("recipeRuns") or []:
            run = dict(source_run)
            old_run_id = str(run.get("runId") or "")
            run["runId"] = run_id_map[old_run_id]
            run["agentSessionId"] = session_id
            run["receipts"] = {}
            run["embeddedRecipes"] = embedded_recipes
            if isinstance(run.get("parent"), dict):
                run["parent"] = {**run["parent"], "runId": run_id_map.get(str(run["parent"].get("runId") or ""), "")}
            for record in (run.get("nodes") or {}).values():
                if record.get("childRunId"):
                    record["childRunId"] = run_id_map.get(str(record["childRunId"]), "")
            run_path = store / ".pkm" / "state" / "recipe-runs" / (run["runId"] + ".json")
            _atomic_write(run_path, run)
        now = _now()
        source_session = payload.get("session") or {}
        checkpoint = payload.get("checkpoint") or {}
        session = {
            **source_session,
            "schema": SESSION_SCHEMA, "sessionId": session_id, "status": "checkpointed",
            "task": str(source_session.get("task") or "Imported Agent checkpoint"),
            "projectId": str(source_session.get("projectId") or ""),
            "agent": source_session.get("agent") or {"name": "Imported Agent", "product": "PKM Share"},
            "recipeRunIds": list(run_id_map.values()), "checkpoints": [checkpoint],
            "todoCommandReceipts": {},
            "provenance": {"kind": "checkpoint-package", "packageName": package.name,
                           "source": payload.get("source") or {}, "sha256": manifest["sha256"]},
            "createdAt": now, "updatedAt": now,
        }
        for todo in session.get("todos") or []:
            if todo.get("recipeRunId"):
                todo["recipeRunId"] = run_id_map.get(str(todo["recipeRunId"]), "")
            if isinstance(todo.get("recipeRunIds"), list):
                todo["recipeRunIds"] = [run_id_map[run_id] for run_id in todo["recipeRunIds"]
                                        if run_id in run_id_map]
        session_path, _ = _paths(store, session_id)
        _atomic_write(session_path, session)
        return {"ok": True, "session_id": session_id, "status": "checkpointed",
                "recipe_run_ids": session["recipeRunIds"],
                "resume_instruction": "Call agent_session_load to inspect, then agent_session_resume to continue."}

    @mcp.tool()
    def agent_session_end(summary: str = "", ctx: Context = None) -> dict:
        """End the Session; omit summary when Todo outcomes already contain the evidence."""
        if ctx is None:
            raise ValueError("MCP request context is required.")
        transport_key = _transport_key(ctx)
        session_id = _active_session_id(store, transport_key)
        if not session_id:
            return {"ok": True, "managed": False}
        path, lock = _paths(store, session_id)
        with _file_lock(lock):
            session = json.loads(path.read_text(encoding="utf-8"))
            session["status"] = "completed"
            bounded_summary = _bounded_text(
                summary, "summary", SESSION_SUMMARY_CHARACTER_LIMIT)
            if bounded_summary:
                session["summary"] = bounded_summary
            else:
                session.pop("summary", None)
            session["updatedAt"] = _now()
            _atomic_write(path, session)
        _active_path(store, transport_key).unlink(missing_ok=True)
        return {"ok": True, "managed": False, "session_id": session_id, "status": "completed"}

    mcp.add_middleware(AgentSessionMiddleware(store))
    return {name: value for name, value in locals().items() if name.startswith("agent_session_")}
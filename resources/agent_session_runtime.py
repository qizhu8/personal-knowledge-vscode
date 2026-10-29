"""Read-only Agent Snapshot access for any agent; Agent Sessions themselves are owned by PKM Chat."""

import contextlib
import base64
import hashlib
import json
import os
import secrets
import time
import uuid
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


AGENT_SESSION_SCHEMA_VERSION = "2.0.0"
SESSION_SCHEMA = "pkm.agent.session/v1"
SNAPSHOT_SCHEMA = "pkm.agent.snapshot/v1"
SNAPSHOT_PAYLOAD_ALGORITHM = "A256GCM-PKM-LOCAL-OBFUSCATION/v1"
LEGACY_SNAPSHOT_PAYLOAD_ALGORITHM = "A256GCM-PKM-INTERNAL/v1"
SNAPSHOT_PAYLOAD_KEY = hashlib.sha256(b"uone").digest()
LEGACY_SNAPSHOT_PAYLOAD_KEY = hashlib.sha256(b"uone:agent-snapshot:payload:v1").digest()
SESSION_SUMMARY_CHARACTER_LIMIT = 1000


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


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


def _snapshot_directory(store):
    return store / ".pkm" / "state" / "agent-snapshots"


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


def _snapshot_summary(snapshot, recovery_count=0):
    capture = snapshot.get("capture") or _snapshot_capture(snapshot.get("payload") or {})
    return {
        "snapshotId": str(snapshot.get("snapshotId") or ""),
        "magicCode": str(snapshot.get("magicCode") or ""),
        "sourceSessionId": str(snapshot.get("sourceSessionId") or ""),
        "sourceHostSessionId": str(snapshot.get("sourceHostSessionId") or ""),
        "sourceHostKind": str(snapshot.get("sourceHostKind") or ""),
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


def _snapshot_text(value, limit):
    text = str(value or "")
    return text if len(text) <= limit else text[:limit] + "\n[truncated]"


def _snapshot_read_projection(snapshot, payload, message_limit):
    session = payload.get("session") if isinstance(payload.get("session"), dict) else {}
    runs = [run for run in (payload.get("recipeRuns") or []) if isinstance(run, dict)]
    pkm = session.get("origin") == "pkm-native" and session.get("hostKind") == "pkm"
    checkpoints = [item for item in (session.get("checkpoints") or []) if isinstance(item, dict)]
    latest = checkpoints[-1] if checkpoints else None
    todos = []
    for todo in session.get("todos") or []:
        if not isinstance(todo, dict):
            continue
        item = {key: todo.get(key) for key in ("todoId", "title", "status", "actionType", "updatedAt") if todo.get(key) is not None}
        if todo.get("details"):
            item["details"] = _snapshot_text(todo.get("details"), 2000)
        if todo.get("summary"):
            item["summary"] = _snapshot_text(todo.get("summary"), 1000)
        run_ids = todo.get("recipeRunIds") if isinstance(todo.get("recipeRunIds"), list) else [todo.get("recipeRunId")] if todo.get("recipeRunId") else []
        if run_ids:
            item["recipeRunIds"] = [str(run_id) for run_id in run_ids]
        todos.append(item)
    result = {
        "ok": True,
        "read_only": True,
        "snapshot": _snapshot_summary(snapshot),
        "source": "pkm-chat" if pkm else "external-agent",
        "task": str(session.get("task") or snapshot.get("task") or ""),
        "status": str(session.get("status") or ""),
        "summary": _snapshot_text(session.get("summary"), SESSION_SUMMARY_CHARACTER_LIMIT),
        "project_id": str(session.get("projectId") or ""),
        "todos": todos,
        "checkpoints": [{key: item.get(key) for key in ("checkpointId", "sequence", "createdAt", "reason")} for item in checkpoints],
        "latest_checkpoint_state": latest.get("state") if latest else None,
        "note": ("Read-only view; no Agent Session was created. Agent Sessions belong to PKM Chat: to continue "
                 "inside PKM, recover this Snapshot into a new PKM Chat from the Agent Snapshots panel. Any agent "
                 "may continue the work in its own context from this state."),
    }
    # Only PKM Chat Snapshots carry Recipe runs; external agent Snapshots have none.
    if runs:
        result["recipe_runs"] = [{
            "runId": str(run.get("runId") or ""),
            "recipeId": str(run.get("recipeId") or ""),
            "recipeName": str(run.get("recipeName") or ""),
            "status": str(run.get("status") or ""),
            "nodes": {str(node_id): str((record or {}).get("state") or "") for node_id, record in (run.get("nodes") or {}).items()
                      if isinstance(record, dict)},
        } for run in runs]
    native = session.get("nativeChat") if pkm and isinstance(session.get("nativeChat"), dict) else None
    if native is not None:
        messages = [message for message in (native.get("messages") or []) if isinstance(message, dict)]
        result["conversation"] = {
            "message_count": len(messages),
            "recent_messages": [{
                "role": str(message.get("role") or ""),
                "status": str(message.get("status") or ""),
                "content": _snapshot_text(message.get("content"), 4000),
            } for message in messages[-message_limit:]] if message_limit else [],
        }
    return result


def register_agent_session_tools(mcp, store):
    """Register read-only Agent Snapshot access.

    Agent Sessions are owned by PKM Chat; external agents can no longer create or manage them. Any
    agent may still read Snapshot state (task, todos, checkpoints, and Recipe runs when present).
    """
    store = Path(store)

    @mcp.tool(annotations={"readOnlyHint": True})
    def agent_session_capabilities() -> dict:
        """Explain PKM Agent Sessions: owned by PKM Chat; any agent may read Agent Snapshots."""
        return {
            "schema": SESSION_SCHEMA,
            "version": AGENT_SESSION_SCHEMA_VERSION,
            "owner": "pkm-chat",
            "external_sessions": "unsupported",
            "proactive": False,
            "tools": ["agent_session_snapshot_list", "agent_session_snapshot_read"],
            "use_when": [
                "the user pastes an Agent Snapshot Magic Code (PKM-SNAP-...)",
                "the user asks to continue or inspect work captured in an Agent Snapshot",
            ],
            "snapshot_read": "Read-only. Returns task, todos, checkpoints, the latest checkpoint state, Recipe run "
                             "states (PKM Chat Snapshots only) and recent conversation (PKM Chat Snapshots only). "
                             "It never creates an Agent Session.",
            "recovery": "To continue inside PKM, recover a Snapshot into a new PKM Chat from the Agent Snapshots panel.",
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

    @mcp.tool(annotations={"readOnlyHint": True})
    def agent_session_snapshot_read(magic_code: str, recent_messages: int = 12) -> dict:
        """Read an Agent Snapshot's captured state by Magic Code without creating an Agent Session.

        Returns task, todos, checkpoints, latest checkpoint state, Recipe run states when present (PKM
        Chat Snapshots) and up to 0-50 recent conversation messages (PKM Chat Snapshots only).
        """
        if not 0 <= int(recent_messages) <= 50:
            raise ValueError("recent_messages must be between 0 and 50.")
        snapshot = _load_snapshot_by_magic(store, magic_code)
        payload = _snapshot_decrypt_payload(snapshot)
        if not _snapshot_payload_is_canonical(payload):
            raise ValueError("Agent Snapshot payload is not a canonical Session capture.")
        return _snapshot_read_projection(snapshot, payload, int(recent_messages))

    return {name: value for name, value in locals().items() if name.startswith("agent_session_")}

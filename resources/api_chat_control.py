"""Agent-to-Extension-Host PKM Chat requests; no model execution in MCP."""

import hashlib
import json
import re
import time
import uuid

from agent_session_runtime import _atomic_write, _file_lock


SCHEMA_VERSION = "1.0.0"


def _host_id(value):
    if not isinstance(value, str) or str(uuid.UUID(value)) != value:
        raise ValueError("Use an exact host_id returned by api_chat_capabilities.")
    return value


def _read(path):
    if path.stat().st_size > 1024 * 1024:
        raise ValueError("PKM Chat control record exceeds the supported size.")
    record = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(record, dict):
        raise ValueError("PKM Chat control records must be objects.")
    return record


def _host(root, host_id):
    host_id = _host_id(host_id)
    try:
        record = _read(root / "hosts" / (host_id + ".json"))
    except OSError as error:
        raise ValueError("The selected PKM Chat Host is offline; no request was sent.") from error
    if (record.get("schema") != "pkm.api-chat.host/v1" or record.get("hostId") != host_id
            or not 0 <= time.time() * 1000 - record.get("updatedAt", 0) < 15000):
        raise ValueError("The selected PKM Chat Host is offline or invalid; no request was sent.")
    return record


def _receipt(root, host_id, request_id):
    _host_id(host_id)
    if not isinstance(request_id, str) or not re.fullmatch(r"[a-f0-9]{64}", request_id):
        raise ValueError("Use an exact request_id returned by a PKM Chat tool.")
    record = _read(root / "requests" / host_id / (request_id + ".json"))
    if (record.get("schema") != "pkm.api-chat.request/v1" or record.get("hostId") != host_id
            or record.get("requestId") != request_id):
        raise ValueError("PKM Chat request identity is invalid.")
    status = record.get("status")
    if status in {"queued", "running"}:
        try:
            _host(root, host_id)
        except (OSError, ValueError, TypeError):
            status = "outcome_unknown"
    return {"ok": True, "host_id": host_id, "request_id": request_id, "status": status,
            "result": record.get("result"), "error": record.get("error"),
            "next_action": "Inspect the existing receipt; never automatically replay an uncertain request."
            if status == "outcome_unknown" else "Call api_chat_request_get for this request_id."
            if status in {"queued", "running"} else None}


def _submit(root, host_id, operation, arguments, command_id):
    _host_id(host_id)
    if not isinstance(command_id, str) or not command_id.strip() or len(command_id) > 128:
        raise ValueError("command_id must contain 1-128 characters and identify one explicit request.")
    payload = {"operation": operation, "arguments": arguments, "commandId": command_id}
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()
    request_id = hashlib.sha256(json.dumps([host_id, command_id]).encode("utf-8")).hexdigest()
    destination = root / "requests" / host_id / (request_id + ".json")
    with _file_lock(destination.with_suffix(".submit.lock")):
        if destination.exists():
            if _read(destination).get("payloadHash") != digest:
                raise ValueError("This command_id already belongs to a different request; no action was repeated.")
            return _receipt(root, host_id, request_id)
        _host(root, host_id)
        _atomic_write(destination, {**payload, "schema": "pkm.api-chat.request/v1", "hostId": host_id,
                      "requestId": request_id, "payloadHash": digest, "status": "queued",
                      "createdAt": time.time() * 1000, "expiresAt": time.time() * 1000 + 30000})
    return _receipt(root, host_id, request_id)


def register_api_chat_tools(mcp, store):
    root = store / ".pkm/state/api-chat-control"

    @mcp.tool(annotations={"readOnlyHint": True})
    def api_chat_capabilities() -> dict:
        """Discover online PKM Chat Hosts/workspaces and programmable Chat API; never starts a model."""
        hosts = []
        for path in sorted((root / "hosts").glob("*.json")):
            try:
                record = _host(root, path.stem)
                hosts.append({"host_id": record["hostId"], "workspace_paths": record.get("workspacePaths", []),
                              "machine": record.get("machine"), "build": record.get("build"),
                              "operations": record.get("operations", [])})
            except (OSError, ValueError, TypeError):
                continue
        return {"ok": True, "schema_version": SCHEMA_VERSION, "hosts": hosts[:32], "truncated": len(hosts) > 32,
                "tools": ["api_chat_models", "api_chat_list", "api_chat_create", "api_chat_send", "api_chat_get",
                          "api_chat_cancel", "api_chat_request_get"],
                "policy": "Select a Host explicitly. Chats are visible and Group-only; no automatic Tasks. Sends use real selected models and Chat permissions, can incur credits, and are never retried automatically."}

    @mcp.tool(annotations={"readOnlyHint": True})
    def api_chat_models(host_id: str, command_id: str) -> dict:
        """Request the Host's actual callable VS Code model catalog; poll its returned request_id."""
        return _submit(root, host_id, "models", {}, command_id)

    @mcp.tool(annotations={"readOnlyHint": True})
    def api_chat_list(host_id: str, command_id: str) -> dict:
        """List up to 100 non-Trash Chats in the selected Host's workspace, without conversation bodies."""
        return _submit(root, host_id, "list", {}, command_id)

    @mcp.tool(annotations={"readOnlyHint": False, "destructiveHint": False, "idempotentHint": True})
    def api_chat_create(host_id: str, title: str, command_id: str, model_id: str = "") -> dict:
        """Create and display a named Group-only Chat. Optional exact native model_id, otherwise remembered defaults; does not send or create a Task."""
        if not title.strip() or len(title.strip()) > 120 or re.search(r"[\x00-\x1f]", title):
            raise ValueError("title must contain 1-120 characters without control characters.")
        if len(model_id) > 512:
            raise ValueError("model_id exceeds the supported length.")
        return _submit(root, host_id, "create", {"title": title, "modelId": model_id}, command_id)

    @mcp.tool(annotations={"readOnlyHint": False, "destructiveHint": False, "idempotentHint": True, "openWorldHint": True})
    def api_chat_send(host_id: str, chat_id: str, prompt: str, command_id: str) -> dict:
        """Send an explicit prompt through the real owning PKM Chat Host; can incur model/tool charges. Returns a pollable request_id, never auto-retries, resumes or changes permissions."""
        _host_id(chat_id)
        if not prompt.strip() or len(prompt) > 16000:
            raise ValueError("prompt must contain 1-16000 characters.")
        return _submit(root, host_id, "send", {"chatId": chat_id, "prompt": prompt}, command_id)

    @mcp.tool(annotations={"readOnlyHint": True})
    def api_chat_get(host_id: str, chat_id: str, command_id: str) -> dict:
        """Read Chat status and the latest bounded assistant answer, actual tool statuses and usage. No hidden reasoning; missing public API credits remain null."""
        _host_id(chat_id)
        return _submit(root, host_id, "get", {"chatId": chat_id}, command_id)

    @mcp.tool(annotations={"readOnlyHint": False, "destructiveHint": False, "idempotentHint": True})
    def api_chat_cancel(host_id: str, chat_id: str, command_id: str) -> dict:
        """Explicitly cancel this Host's current Chat response, preserving partial output; does not pause, stop a Task or delete history."""
        _host_id(chat_id)
        return _submit(root, host_id, "cancel", {"chatId": chat_id}, command_id)

    @mcp.tool(annotations={"readOnlyHint": True})
    def api_chat_request_get(host_id: str, request_id: str) -> dict:
        """Read the existing request receipt without submitting or replaying it. A completed receipt is not proof that reply.status is complete; inspect model/tool results."""
        return _receipt(root, host_id, request_id)

    return {"api_chat_capabilities": api_chat_capabilities, "api_chat_models": api_chat_models,
            "api_chat_list": api_chat_list, "api_chat_create": api_chat_create, "api_chat_send": api_chat_send,
            "api_chat_get": api_chat_get, "api_chat_cancel": api_chat_cancel, "api_chat_request_get": api_chat_request_get}
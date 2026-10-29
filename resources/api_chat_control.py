"""Agent-to-Extension-Host PKM Chat requests; no model execution in MCP."""

import hashlib
import json
import re
import time
import uuid
from pathlib import Path
from urllib.parse import urlsplit

from agent_session_runtime import _atomic_write, _file_lock


SCHEMA_VERSION = "1.0.0"


def _host_id(value, field="host_id"):
    try:
        valid = isinstance(value, str) and str(uuid.UUID(value)) == value
    except (ValueError, TypeError, AttributeError):
        valid = False
    if not valid:
        if field == "host_id":
            raise ValueError("Use an exact host_id returned by api_chat_capabilities (canonical UUID).")
        raise ValueError(f"{field} must be a canonical UUID.")
    return value


def _chat_locator(value):
    if isinstance(value, str) and value.startswith("pkm://"):
        parsed = urlsplit(value)
        match = re.fullmatch(r"/[a-f0-9]{16}/([a-f0-9-]{36})", parsed.path)
        if parsed.netloc != "chats" or parsed.query or parsed.fragment or not match:
            raise ValueError("Use a PKM Chat URL returned by api_chat_list: pkm://chats/<workspace>/<Chat UUID>.")
        _host_id(match.group(1), "chat_id")
        return value
    try:
        return _host_id(value, "chat_id")
    except (ValueError, TypeError, AttributeError) as error:
        raise ValueError("Use a PKM Chat URL returned by api_chat_list; legacy Chat UUIDs are also accepted.") from error


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
    destination = root / "requests" / host_id / (request_id + ".json")
    if not destination.exists():
        destination = _portal_directory(_host(root, host_id)) / (request_id + ".json")
    record = _read(destination)
    if (record.get("schema") != "pkm.api-chat.request/v1" or record.get("hostId") != host_id
            or record.get("requestId") != request_id):
        raise ValueError("PKM Chat request identity is invalid.")
    status = record.get("status")
    if record.get("operation") == "portal":
        if destination.parent != _portal_directory(_host(root, host_id)):
            raise ValueError("Legacy Portal receipts are not restored. Open a fresh temporary pairing.")
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


def _portal_directory(host):
    directory = Path(host.get("portalRequestDirectory", ""))
    if not directory.is_absolute() or not directory.name.startswith("pkm-portal-ipc-") or directory.is_symlink():
        raise ValueError("This Host does not support temporary Portal IPC. Upgrade the Host and pair again.")
    return directory


def _submit(root, host_id, operation, arguments, command_id):
    _host_id(host_id)
    if not isinstance(command_id, str) or not command_id.strip() or len(command_id) > 128:
        raise ValueError("command_id must contain 1-128 characters and identify one explicit request.")
    payload = {"operation": operation, "arguments": arguments, "commandId": command_id}
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()
    request_id = hashlib.sha256(json.dumps([host_id, command_id]).encode("utf-8")).hexdigest()
    directory = _portal_directory(_host(root, host_id)) if operation == "portal" else root / "requests" / host_id
    destination = directory / (request_id + ".json")
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
                          "api_chat_cancel", "api_chat_request_get", "portal_control"],
                "policy": "Select a Host explicitly. Chats are visible and Group-only; no automatic Tasks. Sends use real selected models and Chat permissions, can incur credits, and are never retried automatically."}

    @mcp.tool(annotations={"readOnlyHint": True})
    def api_chat_models(host_id: str, command_id: str = "") -> dict:
        """Request the Host's actual callable VS Code model catalog; poll its returned request_id. Select host_id from api_chat_capabilities; command_id is optional for this read."""
        return _submit(root, host_id, "models", {}, command_id or str(uuid.uuid4()))

    @mcp.tool(annotations={"readOnlyHint": True})
    def api_chat_list(host_id: str, command_id: str = "") -> dict:
        """List up to 100 non-Trash Chats with chatUrl PKM URLs in the selected Host's workspace, without conversation bodies. Select host_id from api_chat_capabilities; command_id is optional for this read."""
        return _submit(root, host_id, "list", {}, command_id or str(uuid.uuid4()))

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
        """Send an explicit prompt to a chatUrl from api_chat_list (legacy UUID accepted) through its owning Host; can incur model/tool charges. Returns a request_id, never auto-retries, resumes or changes permissions."""
        chat_id = _chat_locator(chat_id)
        if not prompt.strip() or len(prompt) > 16000:
            raise ValueError("prompt must contain 1-16000 characters.")
        return _submit(root, host_id, "send", {"chatId": chat_id, "prompt": prompt}, command_id)

    @mcp.tool(annotations={"readOnlyHint": True})
    def api_chat_get(host_id: str, chat_id: str, command_id: str = "") -> dict:
        """Read a full pkm://chats/<workspace>/<UUID> URL (legacy UUID accepted): status, bounded answer, tool statuses, usage and compact context costs/source counts. Full hashes/manifests stay local in the Chat retrieval inspector. Select host_id from api_chat_capabilities; command_id is optional for this read. No hidden reasoning; missing public API credits remain null."""
        chat_id = _chat_locator(chat_id)
        return _submit(root, host_id, "get", {"chatId": chat_id}, command_id or str(uuid.uuid4()))

    @mcp.tool(annotations={"readOnlyHint": False, "destructiveHint": False, "idempotentHint": True})
    def api_chat_cancel(host_id: str, chat_id: str, command_id: str) -> dict:
        """Explicitly cancel this Host's response for a chatUrl from api_chat_list (legacy UUID accepted), preserving partial output; does not pause, stop a Task or delete history."""
        chat_id = _chat_locator(chat_id)
        return _submit(root, host_id, "cancel", {"chatId": chat_id}, command_id)

    @mcp.tool(annotations={"readOnlyHint": True})
    def api_chat_request_get(host_id: str, request_id: str) -> dict:
        """Read the existing request receipt without submitting or replaying it. A completed receipt is not proof that reply.status is complete; inspect model/tool results."""
        return _receipt(root, host_id, request_id)

    @mcp.tool(annotations={"readOnlyHint": False, "destructiveHint": False, "idempotentHint": True, "openWorldHint": True})
    def portal_control(host_id: str, operation: str, command_id: str, context_id: str = "",
                       prompt: str = "", request_id: str = "", file_paths: list[str] | None = None,
                       command: dict | None = None, requirements: dict | None = None) -> dict:
        """Use a temporary Portal or an explicitly configured saved endpoint.

        connections lists local saved endpoints and live temporary connections.
        A saved endpoint id can be used as context_id after separate local external-access
        approval. Configure and pair named endpoints in Portal Connections on both Hosts.
        Named endpoints reconnect across restarts without replaying tasks; each side
        independently enables incoming control and grants revocable local permissions.
        Replacing or deleting a bound Chat clears its grants and stops old execution.
        The following open workflow creates a temporary Portal, not a saved endpoint.

        First open without context_id: native VS Code UI asks only Controller or Controlled.
        Controller automatically resolves the endpoint and copies a private code; Controlled
        pastes it locally and approves control. No name, create/accept or address configuration.
        Private codes never enter tool arguments. No PKM Chat is created.
        Poll api_chat_request_get for the local receipt and keep contextId in this conversation.
        status/send/command/get/attempts/cancel/disconnect/switch/permissions/files require that handle.
        command executes a structured {program, arguments, cwd?, timeoutSeconds?} directly
        on the executing Host without any LLM. Only that Host grants code execution.
        route selects exactly one already-connected, authorized-direction Host matching
        requirements {platform?: win32|linux|darwin, programs?: [cmd|powershell|bash|...]}.
        route may omit context_id; ambiguity or missing capabilities fails without execution.
        Routing never copies credentials, pairs silently or automatically replays commands.
        get/cancel use the returned contextId and original request_id for either mode.
        get always reads the original attempt, not the latest Chat message. attempts
        requests explicit executing-user consent to share linked manual rerun results,
        separately from the immutable original receipt; never replays the task.
        Both Hosts must advertise commands-v1; older Hosts require upgrading and pairing again.
        Brief transport loss keeps the pairing for 2 minutes (status=reconnecting) while it reconnects;
        disconnect, Host restart or a longer outage ends it: open and pair again,
        never reattach or replay tasks. Pairing credentials, connection history and remote-task
        receipts are not persisted; same-connection duplicates are suppressed in memory.
        Task history belongs to controller/controlled Chats; Copilot records only tool
        information it actually receives. Local controlled execution requires selecting an
        existing PKM Chat for each task, never auto-creation. send needs a stable UUID
        request_id; get polls the ORIGINAL remote task while connected. permissions opens
        local timed authorization. files offers one batch of local file_paths, or a picker
        when omitted; every batch ALWAYS needs controlled-user consent, even under Allow All.
        Both Hosts must support transfers. External access requires local consent or an
        unexpired connection grant; MCP cannot authenticate individual Copilot conversations.
        open completes after pairing, link expiry or void (at most 10 minutes); its receipt
        state is connected/awaiting-peer/disconnected. endpointScope=forwarded-localhost means
        loopback on the VS Code UI computer, not proof the peer is unreachable. After pairing,
        the local user is offered one fixed-deadline external grant bound to this pairing/
        direction. No automatic replay, role escalation, SSH or NAT traversal.
        """
        if operation not in {"open", "connections", "status", "send", "command", "route", "get", "attempts", "cancel", "disconnect", "switch", "permissions", "files"}:
            raise ValueError("Unsupported Portal operation.")
        if context_id:
            _host_id(context_id, "context_id")
        elif operation not in {"open", "route", "connections"}:
            raise ValueError("Use the contextId from this conversation's Portal open receipt.")
        if not isinstance(prompt, str) or len(prompt) > 16000:
            raise ValueError("Portal prompt must contain at most 16000 characters.")
        if operation in {"send", "command", "route", "get", "attempts", "cancel"}:
            _host_id(request_id, "request_id")
        if operation == "send" and not prompt.strip():
            raise ValueError("Portal send requires an explicit nonempty instruction.")
        if operation in {"command", "route"}:
            if not isinstance(command, dict) or not isinstance(command.get("program"), str) or not command["program"].strip():
                raise ValueError("Portal command requires an explicit program.")
            arguments = command.get("arguments")
            if (not isinstance(arguments, list) or len(arguments) > 32
                    or any(not isinstance(value, str) or "\0" in value for value in arguments)
                    or len(json.dumps(command)) > 16000):
                raise ValueError("Portal command requires bounded string arguments.")
        elif command is not None:
            raise ValueError("command is only valid for command/route.")
        if operation == "route" and not isinstance(requirements, dict):
            raise ValueError("Portal route requires explicit capability requirements.")
        if operation != "route" and requirements is not None:
            raise ValueError("requirements is only valid for route.")
        if file_paths is not None and (operation != "files" or not file_paths or len(file_paths) > 64
                                       or any(not isinstance(value, str) or not value or len(value) > 4096 for value in file_paths)):
            raise ValueError("file_paths requires 1-64 bounded local paths and operation=files.")
        return _submit(root, host_id, "portal", {"operation": operation, "contextId": context_id,
                       "prompt": prompt, "requestId": request_id, **({"paths": file_paths} if file_paths is not None else {}),
                       **({"command": command} if command is not None else {}),
                       **({"requirements": requirements} if requirements is not None else {})}, command_id)

    return {"api_chat_capabilities": api_chat_capabilities, "api_chat_models": api_chat_models,
            "api_chat_list": api_chat_list, "api_chat_create": api_chat_create, "api_chat_send": api_chat_send,
            "api_chat_get": api_chat_get, "api_chat_cancel": api_chat_cancel, "api_chat_request_get": api_chat_request_get,
            "portal_control": portal_control}
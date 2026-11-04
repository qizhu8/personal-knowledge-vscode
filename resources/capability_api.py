"""Bounded hierarchical pilot capabilities; leaf authority stays in the TS service."""
import os
import hashlib
import json


def register_capability_tools(mcp, request):
    def call(action, args, worker_token=None):
        values = {"api": action, "args": args}
        if worker_token is not None:
            values["workerToken"] = worker_token
        return request("capability", "_capabilities", **values)

    read = {"readOnlyHint": True, "openWorldHint": False}

    @mcp.tool(annotations=read)
    async def capabilities_inventory(offset: int = 0, limit: int = 20) -> dict:
        """Inventory actually exposed MCP tools without executing them. Returns names,
        read-only hints and schema byte counts, not full schemas or provider tokens.
        Compact profile intentionally exposes pilot routing only."""
        if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 50:
            raise ValueError("Inventory requires offset >= 0 and limit from 1 to 50")
        tools = sorted(await mcp.list_tools(), key=lambda tool: tool.name)
        definitions = [tool.to_mcp_tool().model_dump(mode="json") for tool in tools]
        encoded = json.dumps(definitions, sort_keys=True, ensure_ascii=False).encode("utf-8")
        return {"schema": "pkm.capability-inventory/v1", "total": len(tools), "offset": offset,
                "nextOffset": offset + limit if offset + limit < len(tools) else None,
                "revision": hashlib.sha256(encoded).hexdigest(), "schemaBytes": len(encoded),
                "measurement": "Serialized exposed MCP schemas; not provider tokens or invocation latency.",
                "tools": [{"name": tool.name,
                           "readOnly": bool(tool.annotations and tool.annotations.readOnlyHint),
                           "schemaBytes": len(json.dumps(definition, ensure_ascii=False).encode("utf-8"))}
                          for tool, definition in zip(tools, definitions)][offset:offset + limit]}

    @mcp.tool(annotations=read)
    def capabilities_list(path: str = "", offset: int = 0, limit: int = 10, revision: str | None = None) -> dict:
        """List pilot domain.object.operation capabilities. Discovery is not authorization.
        Paginate with nextOffset and pin revision. Legacy tools remain compatible."""
        return call("list", {**{"path": path, "offset": offset, "limit": limit},
                             **({"revision": revision} if revision is not None else {})})

    @mcp.tool(annotations=read)
    def capabilities_search(query: str, path: str = "", offset: int = 0, limit: int = 3,
                            revision: str | None = None) -> dict:
        """Find pilot operations by keywords; returns up to 3 complete contracts by
        default, at most 10. Cache unchanged versions instead of rediscovering."""
        return call("search", {**{"query": query, "path": path, "offset": offset, "limit": limit},
                               **({"revision": revision} if revision is not None else {})})

    @mcp.tool(annotations=read)
    def capabilities_describe(operation: str) -> dict:
        """Read exact pilot input schema, version, permissions, errors and legacy alias.
        No operation executes; unavailable operations fail explicitly."""
        return call("describe", {"operation": operation})

    @mcp.tool(annotations=read)
    def capability_read(operation: str, version: int, arguments: dict,
                        worker_token: str | None = None) -> dict:
        """Execute a discovered read-only pilot operation under authenticated leaf policy.
        Obtain its schema first. Mutation operations are rejected."""
        return call("read", {"operation": operation, "version": version, "arguments": arguments}, worker_token)

    @mcp.tool(annotations={"readOnlyHint": False, "openWorldHint": False})
    def capability_call(operation: str, version: int, arguments: dict,
                        worker_token: str | None = None) -> dict:
        """Execute a discovered mutating pilot operation with its original schema,
        Board identity, digest-CAS, owner/reviewer authority and audit. No role override.
        Failure is not safe to retry blindly; reconcile original effects."""
        return call("call", {"operation": operation, "version": version, "arguments": arguments}, worker_token)


def apply_capability_profile(mcp):
    profile = os.environ.get("PKM_CAPABILITY_PROFILE", "legacy")
    if profile not in ("legacy", "compact"):
        raise ValueError("PKM_CAPABILITY_PROFILE must be legacy or compact")
    if profile == "compact":
        enable = getattr(mcp, "enable", None)
        if enable is None:
            raise RuntimeError("Compact capability profile requires FastMCP with public enable(names, only) support")
        enable(names={"capabilities_inventory", "capabilities_list", "capabilities_search", "capabilities_describe",
                      "capability_read", "capability_call", "check_version"}, only=True, components={"tool"})

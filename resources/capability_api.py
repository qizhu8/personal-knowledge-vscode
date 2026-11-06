"""Bounded discovery over the original MCP executors and canonical pilot service."""
import os
import hashlib
import json
from contextvars import ContextVar
from typing import Annotated
from pydantic import Field


_FULL_CATALOG = ContextVar("pkm_full_tool_catalog", default=False)
_CORE_TOOLS = {"capabilities_inventory", "capabilities_list", "capabilities_search", "capabilities_describe",
               "capability_read", "capability_call", "check_version",
               "mcp_lifecycle_status", "mcp_lifecycle_quiesce"}


async def _catalog(mcp):
    token = _FULL_CATALOG.set(True)
    try:
        tools = await mcp.list_tools()
    finally:
        _FULL_CATALOG.reset(token)
    return sorted((tool for tool in tools if tool.name not in _CORE_TOOLS), key=lambda tool: tool.name)


def _contract(tool):
    definition = tool.to_mcp_tool().model_dump(mode="json")
    return {"id": "mcp.tool." + tool.name, "version": 1, "transportName": tool.name,
            "description": definition.get("description") or "", "inputSchema": definition["inputSchema"],
            "outputSchema": definition.get("outputSchema"),
            "readOnly": bool(tool.annotations and tool.annotations.readOnlyHint is True),
            "authorization": "Original MCP tool, middleware and target-specific checks. Discovery grants no access.",
            "result": "Original MCP content and structured result, not a pilot envelope.",
            "lifecycle": {"legacyAlias": tool.name}}


async def _discover(mcp, values, search=False):
    offset, limit = values["offset"], values["limit"]
    path, query, revision = values.get("path", ""), values.get("query", ""), values.get("revision")
    if (type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 10
            or not isinstance(query, str) or len(query) > 200 or not isinstance(path, str) or len(path) > 200):
        raise ValueError("Provide bounded discovery arguments: offset >= 0, limit 1-10, query <= 200 characters")
    contracts = [_contract(tool) for tool in await _catalog(mcp)]
    digest = hashlib.sha256(json.dumps(contracts, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()
    if revision is not None and revision != digest:
        raise ValueError("CONFLICT: Tool catalog changed; restart discovery")
    words = query.lower().split()
    matches = [item for item in contracts if (not path or item["id"] == path or item["id"].startswith(path + "."))
               and all(word in (item["id"] + " " + item["description"]).lower() for word in words)]
    matches.sort(key=lambda item: (item["transportName"].lower() != query.strip().lower(), item["id"]))
    result = {"schema": "pkm.capabilities/v1", "revision": digest, "total": len(matches), "offset": offset,
              "nextOffset": None, "children": ["mcp.tool"] if matches else [], "operations": []}
    for item in matches[offset:offset + limit]:
        entry = item if search else {key: item[key] for key in ("id", "version", "transportName", "description", "readOnly")}
        if not search:
            entry["description"] = entry["description"][:200]
        if len(json.dumps({**result, "operations": [*result["operations"], entry]}, ensure_ascii=False).encode("utf-8")) > 15000:
            if not result["operations"]:
                raise ValueError("Tool contract exceeds discovery result limit; no schema was truncated")
            break
        result["operations"].append(entry)
    next_offset = offset + len(result["operations"])
    result["nextOffset"] = next_offset if next_offset < len(matches) else None
    return result


async def _dispatch(mcp, operation, version, arguments, read_only, worker_token):
    if type(version) is not int or version != 1 or not isinstance(arguments, dict):
        raise ValueError("INVALID_ARGUMENT: Pin version 1 and provide object arguments")
    tool = next((tool for tool in await _catalog(mcp) if "mcp.tool." + tool.name == operation), None)
    if tool is None:
        raise ValueError("NOT_AVAILABLE: Operation is not in the enabled catalog")
    if bool(tool.annotations and tool.annotations.readOnlyHint is True) != read_only:
        raise ValueError("ACCESS_DENIED: Choose the matching read or mutation entry point")
    args = dict(arguments)
    if worker_token is not None:
        if "worker_token" not in tool.parameters.get("properties", {}):
            raise ValueError("INVALID_ARGUMENT: This operation has no worker_token argument")
        if "worker_token" in args and args["worker_token"] != worker_token:
            raise ValueError("INVALID_ARGUMENT: Conflicting worker tokens")
        args["worker_token"] = worker_token
    return await mcp.call_tool(tool.name, args)


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
        Compact advertises discovery/core schemas; all enabled leaves remain discoverable."""
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
    async def capabilities_list(path: str = "", offset: int = 0, limit: int = 10, revision: str | None = None) -> dict:
        """List enabled operations without full schemas. Compact covers all MCP domains
        as mcp.tool.<legacy_name>. Pin revision when paging. Discovery grants no access."""
        if getattr(mcp, "pkm_capability_profile", "legacy") == "compact" and not path.startswith(("todo", "memory")):
            return await _discover(mcp, {"path": path, "offset": offset, "limit": limit, "revision": revision})
        return call("list", {**{"path": path, "offset": offset, "limit": limit},
                             **({"revision": revision} if revision is not None else {})})

    @mcp.tool(annotations=read)
    async def capabilities_search(query: str, path: str = "", offset: int = 0, limit: int = 3,
                            revision: str | None = None) -> dict:
        """Search enabled tools by name/keywords, returning bounded exact input schemas.
        Compact covers every MCP domain, not only Todo/Memory. Cache unchanged contracts."""
        if getattr(mcp, "pkm_capability_profile", "legacy") == "compact" and not path.startswith(("todo", "memory")):
            return await _discover(mcp, {"query": query, "path": path, "offset": offset, "limit": limit, "revision": revision}, True)
        return call("search", {**{"query": query, "path": path, "offset": offset, "limit": limit},
                               **({"revision": revision} if revision is not None else {})})

    @mcp.tool(annotations=read)
    async def capabilities_describe(operation: str) -> dict:
        """Read one exact contract. mcp.tool.<legacy_name> covers enabled MCP tools;
        canonical todo.* / memory.* contracts remain compatible. Never executes."""
        if operation.startswith("mcp.tool."):
            result = await _discover(mcp, {"query": "", "path": operation, "offset": 0, "limit": 1}, True)
            if not result["operations"]:
                raise ValueError("NOT_AVAILABLE: Operation is not in the enabled catalog")
            return {"revision": result["revision"], **result["operations"][0]}
        return call("describe", {"operation": operation})

    @mcp.tool(annotations={**read, "openWorldHint": True})
    async def capability_read(operation: str, version: Annotated[int, Field(strict=True, ge=1, le=1)], arguments: dict,
                              worker_token: str | None = None):
        """Read a discovered operation using its exact arguments and original executor.
        mcp.tool.* preserves original MCP results; canonical pilot IDs return envelopes.
        Mutation operations are rejected; original middleware/authorization still apply."""
        if operation.startswith("mcp.tool."):
            return await _dispatch(mcp, operation, version, arguments, True, worker_token)
        return call("read", {"operation": operation, "version": version, "arguments": arguments}, worker_token)

    @mcp.tool(annotations={"readOnlyHint": False, "destructiveHint": True, "openWorldHint": True})
    async def capability_call(operation: str, version: Annotated[int, Field(strict=True, ge=1, le=1)], arguments: dict,
                              worker_token: str | None = None):
        """Mutate a discovered operation through its original executor, validation,
        CAS, authority and audit. No role override or local-user Memory decision.
        mcp.tool.* preserves original results. Never blindly retry committed effects."""
        if operation.startswith("mcp.tool."):
            return await _dispatch(mcp, operation, version, arguments, False, worker_token)
        return call("call", {"operation": operation, "version": version, "arguments": arguments}, worker_token)


def apply_capability_profile(mcp):
    profile = os.environ.get("PKM_CAPABILITY_PROFILE", "compact")
    if profile not in ("legacy", "compact"):
        raise ValueError("PKM_CAPABILITY_PROFILE must be legacy or compact")
    mcp.pkm_capability_profile = profile
    if profile == "compact" and not getattr(mcp, "pkm_capability_listing", False):
        from fastmcp.server.middleware import Middleware

        class DeferredToolListing(Middleware):
            async def on_list_tools(self, context, call_next):
                tools = await call_next(context)
                if _FULL_CATALOG.get() or mcp.pkm_capability_profile != "compact":
                    return tools
                return [tool for tool in tools if tool.name in _CORE_TOOLS]

        mcp.add_middleware(DeferredToolListing())
        mcp.pkm_capability_listing = True

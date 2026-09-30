"""Uniform, actionable feedback for malformed PKM MCP tool calls."""

import hashlib
import json
from collections import OrderedDict

from fastmcp.exceptions import ValidationError as FastMCPValidationError
from fastmcp.server.middleware import Middleware


ERROR_SCHEMA = "pkm.mcp.tool-error/v1"
MAX_INVALID_CALL_FINGERPRINTS = 256


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _placeholder(schema):
    if "default" in schema:
        return schema["default"]
    schema_type = schema.get("type")
    if schema_type == "array":
        return []
    if schema_type == "object":
        return {}
    if schema_type in {"integer", "number"}:
        return 0
    if schema_type == "boolean":
        return False
    return "<required>"


def _argument_contract(tool):
    schema = tool.parameters if tool is not None and isinstance(tool.parameters, dict) else {}
    properties = schema.get("properties") if isinstance(schema.get("properties"), dict) else {}
    required = [
        str(name) for name in (schema.get("required") or [])
        if str(name) in properties
    ]
    return {
        "allowedFields": sorted(str(name) for name in properties),
        "requiredFields": required,
        "exampleArguments": {
            name: _placeholder(properties[name])
            for name in required
        },
    }


class McpCallGuardMiddleware(Middleware):
    def __init__(self, server):
        self.server = server
        self.invalid_calls = OrderedDict()

    def _fingerprint(self, context, tool_name, arguments):
        fastmcp_context = context.fastmcp_context
        transport_id = str(getattr(fastmcp_context, "session_id", "") or "unknown")
        return hashlib.sha256(
            (transport_id + "\0" + tool_name + "\0" + _json(arguments)).encode("utf-8")
        ).hexdigest()

    def _record_invalid_call(self, context, tool_name, arguments):
        fingerprint = self._fingerprint(
            context, tool_name, arguments)
        count = int(self.invalid_calls.pop(fingerprint, 0)) + 1
        self.invalid_calls[fingerprint] = count
        while len(self.invalid_calls) > MAX_INVALID_CALL_FINGERPRINTS:
            self.invalid_calls.popitem(last=False)
        return count

    async def on_call_tool(self, context, call_next):
        message = context.message
        tool_name = str(getattr(message, "name", "") or "")
        arguments = getattr(message, "arguments", None)
        arguments = arguments if isinstance(arguments, dict) else {}
        fingerprint = self._fingerprint(context, tool_name, arguments)
        previous_attempts = int(self.invalid_calls.get(fingerprint, 0))
        if previous_attempts >= 2:
            self.invalid_calls.move_to_end(fingerprint)
            self.invalid_calls[fingerprint] = previous_attempts + 1
            raise FastMCPValidationError(_json({
                "schema": ERROR_SCHEMA,
                "ok": False,
                "error": {
                    "code": "repeated-invalid-tool-call",
                    "category": "caller",
                    "retryable": False,
                    "tool": tool_name,
                    "message": "This unchanged invalid call is blocked. Correct its arguments before retrying.",
                    "attemptCount": previous_attempts + 1,
                    "loopDetected": True,
                    "blocked": True,
                    "action": "stop-and-correct",
                },
            }))
        try:
            return await call_next(context)
        except FastMCPValidationError as error:
            if ERROR_SCHEMA in str(error):
                raise
            tool = await self.server.get_tool(tool_name)
            attempt_count = self._record_invalid_call(
                context, tool_name, arguments)
            contract = _argument_contract(tool)
            received_fields = sorted(str(name) for name in arguments)
            unexpected_fields = [
                name for name in received_fields
                if name not in contract["allowedFields"]
            ]
            missing_fields = [
                name for name in contract["requiredFields"]
                if name not in arguments
            ]
            repeated = attempt_count > 1
            payload = {
                "schema": ERROR_SCHEMA,
                "ok": False,
                "error": {
                    "code": "invalid-tool-arguments",
                    "category": "caller",
                    "retryable": False,
                    "tool": tool_name,
                    "message": (
                        "This identical invalid tool call was already rejected. "
                        "Stop retrying it unchanged and correct the arguments."
                        if repeated else
                        "Tool arguments do not match the advertised schema. "
                        "Correct the arguments before calling the tool again."
                    ),
                    "receivedFields": received_fields,
                    "unexpectedFields": unexpected_fields,
                    "missingFields": missing_fields,
                    **contract,
                    "attemptCount": attempt_count,
                    "loopDetected": repeated,
                    "action": "stop-and-correct" if repeated else "correct-arguments",
                },
            }
            raise FastMCPValidationError(_json(payload)) from error

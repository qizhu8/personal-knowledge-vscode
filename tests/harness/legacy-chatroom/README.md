# Legacy Chatroom Harness

These Python files are development harnesses for the superseded agent-to-agent session protocol and standalone `pkm-chat` MCP helper. They are not used by the extension runtime and are excluded from release packages.

- `sim_protocol.py` runs the protocol in process.
- `chat_agent.py` runs the same protocol against a live WebSocket Hub.
- `protocol.py` and `llm.py` support those harnesses.
- `chat_server.py` is the legacy standalone Chatroom MCP helper.
- `chat-mcp-approval-client.py` drives that helper for the legacy approval integration test.

The current generated Chatroom integration is owned by `resources/chat_server.py.template` and the unified MCP implementation in `src/mcp.ts`.
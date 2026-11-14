# Source Ownership

`src/extension.ts` is the VS Code activation and composition entry point. New
TypeScript implementation files belong in the owning domain, not beside it.
The entry point remains large; this migration organizes its dependencies rather
than claiming to have extracted all of its embedded application logic.

| Directory | Responsibility |
| --- | --- |
| `chat/` | PKM Chat controller, models, transport, tools, permissions, memory and retrieval receipts |
| `agent-sessions/` | Agent Session lifecycle, Group identity and snapshots |
| `chatroom/` | Multi-member rooms, protocol, persistence, membership and browser client |
| `knowledge/` | Knowledge Root, content storage, privacy, inventory, migration, links and live Notes |
| `retrieval/` | Typed retrieval contracts, snapshots, index events and Worker |
| `skills/` | Skill router configuration and native discovery projections |
| `mcp/` | Generated MCP server integration, stdio location and version/usage policy |
| `sync/` | GitHub synchronization, scheduling, conflicts and synchronization Workers |
| `subscriptions/` | Broker subscriptions, ACL, materialization, MQTT and gateway |
| `runtime/` | Host identity, process coordination, locks, caches, diagnostics and environment policy |
| `ui/` | Navigation, localization, onboarding, prompt/Recipe UI and restoration |
| `servers/` | Server configuration, Python environments and process management |
| `ai/` | General AI integration outside the Chat-specific transport |
| `workflows/` | Project, module, Recipe and workflow contracts and persistence |
| `webview/` | Browser assets, panel scripts, Chat UI and bundled browser entries |

## Dependencies

Use relative imports to the owning implementation. Do not add forwarding files
to `src` to retain the old flat layout. VS Code registrations remain in the
composition/controller layer; storage and transport code stay in their domains.
This is an ownership organization, not a claim that cross-domain dependencies
have been eliminated or that every module is independent of VS Code.

## Runtime Paths

Moving a compiled module adds a directory level. Existing resource and Worker
lookups retain their previous build-root base explicitly, including the build
identity captured by `runtime/extension-host-runtime.ts`.

The historical entry mapping in `scripts/organize-source.js` generates legacy
`dist/*.js` bridges during postbuild. The implementation lives in the domain;
the bridges are generated compatibility artifacts, not a second source tree.
The three standalone Chat bundles remain loadable without workspace dependencies.
Existing Worker filenames also remain supported by these generated entries.

## Checks

```sh
npm run build
node scripts/organize-source.js --verify
node tests/test-ui-build-artifacts.js
node tests/test-api-chat.js
node tests/test-agent-session-lifecycle.js
node tests/test-four-workspace-ui.js
node tests/test-api-chat.js --browser-check
```

Postbuild rejects duplicated ownership, incomplete migration and new root-level
TypeScript files. Artifact tests verify the relocated runtime captures the
actual build and that its legacy entry shares the same module instance.
Run the relevant domain tests for behavioral changes and startup/packaging gates
when resource, Worker, bundling or activation paths change.
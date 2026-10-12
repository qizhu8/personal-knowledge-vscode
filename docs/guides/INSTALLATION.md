# Installation Guide

The canonical Marketplace installation guide is maintained in the [README](../../README.md#installation-guide), where it is visible on the Marketplace **DETAILS** tab.

VS Code Marketplace tabs are platform-defined; extension manifests cannot add a custom Installation Guide tab. This file provides a stable direct link for release notes, support responses, and repository navigation.

Follow the complete guide:

1. Install the extension.
2. Choose or recover the Knowledge Root.
3. Configure Python 3.10+ and create the managed runtime.
4. Generate the unified MCP server code.
5. For VS Code native chat, use the account-level native provider and start `pkm` through **MCP: List Servers**. Do not add another VS Code user/workspace registration for the same server. Copilot CLI / SDK sessions that do not inherit VS Code MCP definitions need the separate user-level registration below.
6. Call `check_version` through the actual agent tool surface, then verify discovery and a real call in a second workspace on the same target/account.

For clients without native provider support, use an explicit user-level adapter for that client. Do not register the same server twice within one client. Review and back up legacy registrations before removing only the matching PKM entries; preserve unrelated servers.

## Copilot CLI / SDK registration

Installing PKM does not modify Copilot CLI's user configuration. If the CLI / SDK
session already exposes PKM tools, no additional registration is needed.
Otherwise, after creating the managed runtime and generating the server:

1. Open **General & MCP > MCP > Copilot CLI / SDK** and copy the machine-specific
   Copilot configuration snippet. Install Copilot CLI if `copilot` is unavailable.
2. Back up `~/.copilot/mcp-config.json`, then merge the `pkm` entry into its
   `mcpServers` object; create the file if it does not exist. Preserve unrelated
   servers and review an existing `pkm` entry instead of adding a duplicate.
   Copilot CLI uses `type: "local"`, not VS Code's `type: "stdio"` / `servers`
   format. The snippet uses the managed runtime and includes the Windows launcher
   environment when needed. `tools: ["*"]` exposes enabled PKM tools, subject to
   client consent.
3. Run `copilot mcp list` and `copilot mcp get pkm`, then start a new CLI / SDK
   chat. If a VS Code-hosted session still has the old tool list, run
   **Developer: Reload Window**. Enabled confirms registration only; verify
   discovery and an actual `check_version` call through the agent.

This registration is per machine and OS account, not per project. For Remote
SSH, use the remote account's configuration and run Copilot on the remote
machine, not Linux executable paths on a local Windows client. Update the entry
after moving the managed runtime or server directory. PKM does not automatically
write or refresh external client configuration.

Settings no longer offers **Inject / Update All** or a copyable MCP installation prompt. Runtime maintenance does not recreate Agent Router files. Run **PKM: Remove Legacy Agent Injection** to confirm private backups and removal of earlier PKM-managed adapters. Canonical Skills and user-authored files are preserved.

See [README.md — Installation Guide](../../README.md#installation-guide) for the animated walkthrough and troubleshooting details.
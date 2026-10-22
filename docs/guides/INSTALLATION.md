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

## File watcher resource limits

PKM uses non-recursive native directory watchers with a shared maximum of **64
per Extension Host** across knowledge content, Project/Recipe state, Chatrooms
and the Chat library. It does not register recursive VS Code watchers for these
trees. Multiple VS Code windows have separate Extension Hosts and therefore
separate budgets; this is not an OS-account-wide limit.

Directories beyond the native budget are still checked by metadata polling
every 15 seconds (plus scan time). Native events trigger a debounced metadata
check; system allocation failures such as `ENOSPC` are reported and leave polling
active. Dependency/cache trees such as `node_modules`, `.git`, `.venv` and
`__pycache__` are excluded before descent, not only after receiving events.
Child symlinks are not traversed; an explicitly configured symlink root works.
System trees such as `/usr` (including `/usr/lib`), `/lib*`, `/etc`, `/proc`,
`/sys`, `/dev` and `/run`, filesystem roots, macOS system directories and Windows
Windows/Program Files directories are refused, including symlink aliases.
This refusal stops both native watching and fallback polling and reports an
error asking for a dedicated Knowledge Root. The five-minute signature check
uses the same guard.
Chat polling only visits namespace-level Chat records and `library.json`;
Action Run polling does not descend into execution workspaces or artifacts.
The separate five-minute knowledge-signature sweep remains a safety check.

If an older PKM build already exhausted the system watcher limit, installing the
fixed build alone does not replace watchers held by running Extension Hosts.
After updating, save your work and use **Developer: Reload Window** in affected
windows. The change does not raise system inotify limits or stop other processes.
Run `npm run test:file-watchers` from the extension source to verify the shared
budget, polling fallback, notifications and disposal.

## Copilot CLI / SDK registration

Installing PKM does not automatically modify Copilot CLI's user configuration. If the CLI / SDK
session already exposes PKM tools, no additional registration is needed.
Otherwise, after creating the managed runtime and generating the server:

1. On the machine/account where Copilot CLI will run, use **PKM: Register Copilot
   CLI MCP (User)** in the Command Palette, or **Register Copilot CLI MCP (User)**
   under **General & MCP > MCP**. Review the host, account configuration path,
   Knowledge Root and launch command in the confirmation. Install Copilot CLI if
   `copilot` is unavailable.
2. Confirm to add `mcpServers.pkm` to the default `~/.copilot/mcp-config.json`
   (`%USERPROFILE%\.copilot\mcp-config.json` on Windows). Existing bytes are backed
   up beside that file as `mcp-config.json.pkm-backup-<id>`, and unrelated entries
   are preserved. Matching configurations are not rewritten. Differing `pkm`
   entries (including disabled servers or restricted tool lists), equivalent
   aliases, malformed JSON, symlinks and configuration changes after review are
   rejected rather than overwritten. Review conflicts manually; do not add a
   second registration. Alternatively, copy the machine-specific snippet and
   merge it manually after making your own backup.
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
write or refresh external client configuration. Custom CLI `--config-dir`
locations are not modified: inspect that client's actual configuration instead.
CLI and VS Code are separate clients; a CLI entry does not replace or suppress
the VS Code native provider.

### VS Code native Copilot Agent discovery

`~/.pkm/mcp-binding.json` is PKM's account binding, **not** a configuration file
that VS Code or Copilot CLI reads. A saved binding alone does not prove either
client has discovered PKM.

1. In the relevant local or remote VS Code extension host, run **PKM: Configure
   VS Code MCP Discovery**, also available as **Configure PKM MCP...** in
   **General & MCP > MCP**. Choose **This machine's account** (recommended,
   extension-managed native provider across workspaces on this host account),
   **VS Code user / profile** (this profile's user MCP file), **Workspace folder**
   (the selected folder's `.vscode/mcp.json`), or **Do not configure**. On Remote
   SSH these choices apply to the remote extension host, not the Windows-local
   account. Choosing no configuration changes nothing; Chat remains usable
   without PKM MCP tools. No independent stdio server is silently started.
2. The command checks the current profile's user `mcp.json`, open workspace
   folders' `.vscode/mcp.json` files (JSONC supported), and legacy `mcp.servers`
   settings for conflicts. Back up and remove matching manual entries yourself
   before switching to account scope. Explicit profile/workspace setup preserves
   other entries and JSONC comments, backs up the existing file, and disables the
   account provider to avoid duplicates. Review the file path before confirming;
   workspace configuration may be committed to Git. Other profiles/adapters cannot be fully inventoried from
   this host; review those before confirming. Existing manual ownership stays
   suppressed until you explicitly select the native provider. A changed
   account binding is backed up beside `mcp-binding.json`.
3. Run **MCP: List Servers**, find **pkm / Personal Knowledge Manager**, review
   the native trust/start controls, and enable the tools in Copilot **Agent**
   mode. Call `check_version`, then repeat discovery in a second workspace on
   the same target/account. If the client list is stale, use **Developer: Reload
   Window**. Configuration commands do not start MCP or grant trust themselves.

On Windows the generated CLI entry and native definition both use the signed
`Code.exe` host, packaged JavaScript stdio proxy, absolute managed Python/server
paths, and `ELECTRON_RUN_AS_NODE=1`. Do not replace this with a bare Python launch.
If an extension upgrade moves the versioned proxy path, review and update the CLI
entry; conflicting older entries are intentionally not silently replaced.
Discovery/status checks do not spawn Python to build the native definition.
Definition available, CLI configuration matching, client discovery, trust,
connection and callable tools are distinct states. Windows-local live discovery
still requires verification on that Windows machine; Linux/Remote SSH tests
cannot establish that a local Windows client is configured.

Settings no longer offers **Inject / Update All** or a copyable MCP installation prompt. Runtime maintenance does not recreate Agent Router files. Run **PKM: Remove Legacy Agent Injection** to confirm private backups and removal of earlier PKM-managed adapters. Canonical Skills and user-authored files are preserved.

### Local recovery snapshots and MCP-only writes

MCP `delete_note`, `delete_skill` and `delete_paper` use PKM Trash and the shared
deletion journal. Restart an existing MCP connection after upgrading; an old
Python process retains its old deletion implementation.

Use `knowledge_snapshot_create` for an immutable, annotated Git tag containing
the actual knowledge bytes. The isolated repository is
`<knowledge-root>/.pkm/state/knowledge-snapshots/repository.git`; it does not
change the development repository's branch/index or upload private contents.
This is local recovery protection, not off-machine disaster recovery.

On Linux, `knowledge_snapshot_configure(enabled=True, local_time="17:00",
timezone="America/Los_Angeles")` installs a persistent user systemd timer.
`knowledge_snapshot_status` reports the schedule, UTC next run and PST/PDT.
17:00 PST corresponds to 01:00 UTC the following day; 17:00 PDT corresponds to
00:00 UTC the following day. The time and timezone are configurable. The user
systemd manager must be running; `Persistent=true` catches a missed run when
the timer starts again. Other platforms currently support manual snapshots,
but not this persistent Linux scheduler.

Restore requires `knowledge_snapshot_restore_preview` followed by
`knowledge_snapshot_restore_apply` with the approved preview hash. It first
creates a safety snapshot; replaced/extra files go to Trash. Current privacy
configuration is preserved, not weakened by historical settings.

For new Linux CLI Agents, [protected-agent.py](../../scripts/protected-agent.py)
requires bubblewrap and fails closed when it is unavailable. Run
`python3 scripts/protected-agent.py --knowledge-root /path/to/knowledge --workspace /path/to/knowledge/packages/project`
to launch Copilot, or add `-- command arguments` for another CLI. The parent
filesystem and knowledge are read-only; only the development workspace and
Copilot runtime are writable. A trusted MCP child runs outside the sandbox and
is reached through a stdio broker. Do not place its executable or generated
server in the writable development workspace. This does not retrofit isolation
into existing VS Code Agents; workspace/user MCP-only instructions are policy,
not an OS permission boundary. Re-run via the launcher for enforced protection.

See [README.md — Installation Guide](../../README.md#installation-guide) for the animated walkthrough and troubleshooting details.
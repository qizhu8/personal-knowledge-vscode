# Account-Level MCP Integration

Status: account binding, native-provider discovery and explicit Copilot CLI user registration are implemented; live Windows-local and cross-workspace acceptance remain pending.

## Decision

PKM setup belongs to one target machine and one OS account, not to a workspace.
One explicit setup must make the configured server discoverable from other
workspaces using that same account and target. Native client trust, enablement,
and per-chat tool selection remain separate decisions.

Use the standard VS Code MCP definition provider as the primary VS Code entry
point, derived from account-level configuration. Users may instead explicitly
choose a VS Code user/profile or workspace-folder MCP file; doing so suppresses
the account provider to avoid duplicate registrations. Choosing no configuration
leaves files unchanged and does not launch a hidden fallback. Prefer stdio: formal MCP
integration does not require opening a network port or running a public service.

This decision does not promise one MCP process. Several Remote Extension Hosts
can launch separate stdio transports. Shared-state concurrency must work across
those processes; a centralized Remote Server is not a singleton Extension Host.

## Existing Implementation

- [registerNativeMcpProvider](../../src/extension.ts) registers
  `personalKnowledge.pkm`, creates remote-aware stdio definitions, and checks
  trust and runtime readiness on explicit startup.
- `rememberMachineStorePath` in the same module persists a machine root and
  compares the global configuration value before updating it. It determines
  provider support from the API, not registration timing: startup must not
  accidentally persist `manual-user` before the native provider is registered.
- **PKM: Configure VS Code MCP Discovery** offers account (native provider),
  user/profile, workspace folder and no-configuration choices. File-based setup
  preserves JSONC comments and other servers, backs up existing bytes and rejects
  stale reviews or conflicts. Missing tools produce one configuration offer per
  extension-host session, not an independent direct stdio launch. Manual
  ownership is not silently taken over at startup; changed bindings are backed
  up. The native definition builder checks paths without spawning Python.
- **PKM: Register Copilot CLI MCP (User)** previews the current host/account and
  launch, then adds only `mcpServers.pkm` to the default user
  `~/.copilot/mcp-config.json` after confirmation. The helper rejects conflicting
  entries/aliases, malformed or ambiguous JSON, unsafe paths and stale review
  revisions; preserves unrelated configuration; privately backs up existing
  bytes; and replaces the config through a same-directory atomic rename under a
  cooperative cross-process lock. Identical registrations are a no-op. The
  final revision check detects intervening external edits, but cannot lock out
  noncooperating external writers after that check.
- Config uses native startup guidance rather than a copyable Agent installation
  prompt. It no longer directs an agent to register a duplicate through Agency.
- The former Settings **Inject / Update All** path is retired. The
  [legacy projection module](../../src/skills/pkm-skill-projection.ts) provides
  backed-up removal; automatic integration maintenance no longer recreates
  generated Router adapters.

Do not infer cross-workspace discovery solely from provider registration or its
internal storage scope. Definition visibility, server startup, client enablement,
and tools actually available to an agent require separate live checks.

## Identity and Configuration

The account binding records a schema version, logical server identity, target
machine identity, OS account identity, canonical Knowledge Root and VS Code
registration owner. Runtime location and protocol version are derived from the
managed launch definition, not stored in the binding. Workspace folders are not
part of server identity. Paths and account names are configuration, not secrets.

Use stable identity across extension upgrades and runtime repairs. A label,
process ID, workspace hash, or rotating build hash must not create another
logical server. Multiple Knowledge Roots, if later supported, require explicit
separate bindings; never silently select a root from the active editor.

Store the binding locally for the execution target, without Settings Sync moving
machine-specific executable paths to a different machine. Diagnose conflicting
workspace overrides instead of allowing them to silently redirect this binding.
The exact native settings representation must be verified on the supported VS
Code version before replacing the current persistence mechanism.

## Formal Setup

1. Show the target machine/account, Knowledge Root, runtime, transport, and
   registration owner before the user confirms setup.
2. Verify ownership and private access to runtime, configuration, control state,
   and Knowledge Root. Report unsafe inherited permissions; do not recursively
   chmod user content without approval.
3. Install or repair the managed runtime and regenerate the server using existing
   extension-owned facilities. Never manually patch generated server output.
4. Publish exactly one stable provider definition for this binding. Keep
   discovery lightweight; runtime installation and health probes are explicit
   asynchronous operations, not synchronous discovery work.
5. Use native MCP trust/start controls. Verify protocol initialization, tool
   listing, and `check_version` through the actual agent tool surface.
6. Open another workspace on the same target/account and repeat discovery with
   no project setup. Record any native client consent separately from PKM setup.

For a client without provider support, offer an explicit user-level registration
adapter. In Remote SSH this must be a remote-user registration, not a Windows
local launch of Linux executables. Provider and manual adapters are mutually
exclusive registration owners within the same client, never automatic duplicates.

Recipe compilation must not depend on a versioned extension installation path.
Generation copies the compiler and its value-contract dependency into an immutable,
content-addressed directory under the managed MCP directory. Configuration is
replaced atomically only after these files are present. Integration maintenance
checks this configuration even when MCP protocol/component versions are unchanged;
an older extension host cannot replace a newer compiler configuration. Python reads
the configuration on each compilation, so path repair does not require restarting a
running server. Loading updated Python code still requires the normal MCP restart.
Missing compiler errors include the config path, contracts path and executable.
Copilot CLI / SDK sessions that do not inherit VS Code provider definitions need
their own explicit user-level registration in `~/.copilot/mcp-config.json`.
General & MCP shows a separate `mcpServers` / `type: "local"` snippet and explicit
user registration action derived from the same managed stdio launch definition,
including Windows environment variables. PKM writes this external configuration
only after explicit review/confirmation, never during activation, runtime
maintenance or discovery. CLI registration does not change the VS Code owner.
The default user path is inspected; custom CLI config directories and inherited
SDK definitions require separate review. Native migration checks the current
profile and open workspace folders; unknown profiles/adapters remain a user
review boundary.
Registration enabled, transport connected, and tools callable remain separate
checks.

## Security Boundary

Other ordinary OS accounts must not read PKM state or invoke account-private
control endpoints. On Linux, account-private directories use mode `0700` and
sensitive state/config files use `0600`, with ownership and ancestor access
checks. Executable assets retain the permissions needed to run. On Windows,
validate the account DACL and inherited access; POSIX mode bits are insufficient.

Stdio is carried over the client-launched process pipes and exposes no listening
port. It does not protect group-readable Knowledge Roots or unsafe executable
paths. Same-account extensions and processes share this trust boundary; root,
administrators, and a compromised owning account are outside the isolation
promise.

If a shared broker is needed, justify it independently. Prefer an account-private
Unix socket with peer-UID validation, or a Windows named pipe with a restricted
DACL and peer validation. A localhost HTTP listener alone is not Linux-account
isolation. Any HTTP adapter needs authenticated access and an explicit security
design; it is not the default deployment.

An authenticated Windows Remote SSH connection can intentionally use the Linux
account's PKM deployment. An unrelated Windows-local workspace cannot implicitly
use it and needs its own deployment or an explicitly authorized remote adapter.

MCP discovery never grants tool approval. Preserve Workspace Trust, native tool
consent, and PKM-specific approval boundaries. Diagnostics omit credentials,
private content, and environment dumps.

## Skill Integration

MCP registration exposes capabilities without injecting workflow policy into
Agent Skill directories. Canonical PKM Skills remain knowledge content and can
still be retrieved explicitly.

An explicit **PKM: Remove Legacy Agent Injection** command archives matching
PKM-managed Router files before removing them and clears connected-target state.
Unowned files, symlinks and canonical Skills are preserved. No automatic
startup deletion or reinjection is performed.

## Migration and Rollback

1. Inventory provider, Agency, user/remote-user, and workspace registrations.
   Identify managed entries by ownership and target binding, not just `pkm` label.
2. Preview the new binding and conflicting entries. Back up only the relevant
   configuration before any authorized mutation; preserve unrelated servers.
3. Verify the native provider path in a clean second workspace before retiring
   managed legacy entries. User-authored entries require an explicit choice.
4. Update onboarding and diagnostics to name the registration owner. Report
   configured, discovered, trusted, started, tools-listed, and agent-visible as
   distinct states; do not collapse them into a misleading green indicator.
5. Retain a reversible migration record. Rollback restores the selected previous
   owner/configuration without starting duplicate servers or rewriting history.

An extension upgrade must not silently change target/account, reset trust, replay
requests, or restart all hosts. Do not publish until local acceptance is complete.

## Acceptance Gates

| Gate | Required evidence |
| --- | --- |
| One setup | Fresh workspace A configures the target once; workspace B has no project MCP file and discovers the same binding. |
| Real tools | An agent in each window lists and invokes `check_version`; provider/catalog presence alone is insufficient. |
| No duplicate | Exactly one registration owner per binding, including upgrade and migration from Agency/workspace entries. |
| Remote routing | Windows SSH launches the Linux runtime on the intended target; Windows-local does not run Linux paths. |
| Account isolation | A second ordinary account cannot read private state or connect to any control socket/pipe. |
| Native consent | Untrusted or disabled configurations do not run privileged tools; PKM setup does not bypass native approval. |
| Parallel transports | Two stdio clients can read/write shared runtime state without lost updates or duplicate operations. |
| Recovery | Repair/upgrade preserves identity; rollback preserves unrelated registrations and existing Knowledge Roots. |
| Responsiveness | Discovery is bounded and nonblocking; failures distinguish transport, runtime, trust, and tool visibility. |

These are release gates, not completed test results. Implement the binding and
registration lifecycle first, then migrate onboarding, run isolated security and
multi-window tests, package, and locally install. Publication remains a separate
user decision.
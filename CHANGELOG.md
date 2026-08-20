# Changelog

All notable changes to the **Personal Knowledge Manager** extension are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [2.5.1] - 2026-08-19

This release adds live switching across 11 UI languages and completes the managed-server navigation and Remote-SSH access workflow.

### Fixed
- Removed Chatroom composer stalls by caching inherited recipients, parsing body mentions once per input event, avoiding unchanged To-chip DOM rebuilds, and skipping full Markdown transcript repaints for presence-only state updates.
- Preserved authored mentions everywhere in the Chatroom message body, including leading task-assignment mentions, while continuing to derive the structured To audience from every valid body mention.
- Kept the reader's exact historical-message viewport anchored across presence updates, new messages, and snapshot repaints; only the explicit Jump to latest action resumes following the newest message.
- Left-aligned every Action cell in the PKM Integration Status table and replaced the ambiguous `Ready · not detected` state with `Ready · starts on demand` plus localized startup guidance.
- Kept language choices recognizable in every locale by always displaying their native names: `English`, `简体中文`, and `Español`.
- Moved Stable Link interface selection and Remote-SSH Port Forwarding from individual Server cards into one shared Servers toolbar; the global Port Forward toggle defaults to On and applies to every managed server.
- Completed live Config localization for explanatory content, runtime/process states, version transitions, setup steps, Paths, and PKM Skill Router targets across all supported languages.
- Replaced the PKM Integration Status CSS grid with a compact semantic table, standardized `No action needed`, and removed button wrapping that created oversized blank rows.
- Removed aggregate status lights from the top-level Servers and Chatroom navigation entries while retaining per-server lights and adding active/connecting/offline lights to individual hosted and recently joined Rooms.
- Bumped PKM Skill Router to 1.1.4 and registered the 1.1.3 bundled source for automatic migration, so Update available now presents a real version transition and refreshes unchanged canonical Router content.
- Reorganized managed-server cards with a dedicated second-row action toolbar, a gear Settings button, complete hover hints, and card-local Edit/Log panels with explicit Close/Cancel controls.
- Split server access into a selectable network-IP Stable Link and a localhost Server Link, avoiding accidental dependence on Remote-SSH port forwarding.

### Added
- Added manifest-driven UI catalogs for English, 简体中文, Español, 日本語, 한국어, Français, Deutsch, Português (Brasil), Italiano, Русский, and العربية; Config switches live panel/navigation language without losing state, Auto follows VS Code, Arabic uses RTL layout, and primary manifest commands use official package NLS catalogs.
- Added Start, Stop, and Restart context-menu actions for individual Servers in Navigation; display-name rename remains in the card Settings panel without changing the server slug or links.
- Added expandable Servers and Chatroom navigation with status indicators on individual servers and Rooms; running/connected is green, starting/reconnecting is yellow, and stopped/offline is grey. Top-level category entries remain undecorated.

### Changed
- Moved 27 automated tests into `tests/`, manual behavior matrices into `tests/cases/`, legacy Chatroom Python harnesses into `tests/harness/legacy-chatroom/`, and supplementary documentation into `docs/`; release packages exclude test and internal documentation trees.

## [2.5.0] - 2026-08-18

This is a major Chatroom, search, setup, and MCP Config release. It replaces text-derived routing with structured recipients across the complete stack, makes Agent standby reliable, and adds a versioned setup dashboard with privacy-safe release media.

### Fixed
- Started the managed-server stable reverse proxy on VS Code startup, surfaced proxy-listener health instead of opening a dead stable URL, registered the machine-local proxy port setting, and generated an Agent-readable proxy compatibility guide in every managed server folder.
- Replaced uneven Config path rows with a fixed-layout Path Type / Location / Disk Usage / Source table, with horizontal scrolling on narrow windows.
- Preserved the current Chatroom search result across presence/message repaints and batched transcript highlighting, preventing previous/next navigation from looping between results 1 and 2.
- Added a contextual empty-state hint on content tabs: when no item is selected and the sidebar is minimized, the detail pane tells users to click the `>` control to restore it.
- Limited MCP dashboard action highlighting to missing, outdated, broken, or unconfigured states; current components now show neutral actions or `No action`.
- Clarified that Regenerate Server Code writes `server.py`, `chat_server.py`, and `requirements.txt` without modifying external Agency registries, and directs unregistered users to copy the provided installation instructions into Copilot or Agency.
- Collapsed the Host To list to `@all` after every other roster member has been selected, excluding the Host themself and including offline roster members.
- Kept offline Room participants mentionable while they remain in the roster; presence now affects live delivery and default audience inheritance, not explicit To recognition.
- Activated the extension when VS Code restores an open Personal Knowledge Manager tab, preventing the tab from remaining in a loading state until the sidebar is clicked.
- Synchronized body mentions with the To editor: autocomplete-style quoted mentions activate only after the closing quote and disappear when it is backspaced; unquoted syntax is accepted only for aliases without spaces (`@Amy`), while spaced aliases require quotes (`@"Asset Dev"`).
- Restored installed → target version details directly on the Regenerate Server Code action, including Unified, Knowledge, and Chat schema mismatches.
- Removed the misleading Reinstall action for Current PKM Skill Router targets; update actions now appear only for missing or outdated content and show their version transition.
- Corrected reply-intent defaults: Host `@all` messages require replies, while Agent posts require no reply unless explicitly requested.
- Removed the human-facing Replies checkbox; Extension and browser users now rely on automatic Host/recipient inference, while MCP callers retain the structured override for advanced workflows.
- Restricted `@all`/`@everyone` to the Room Host. Posts default to `require_reply=true`; Agents must use `require_reply=false` for pure acknowledgements, FYIs, and progress updates so point-to-point confirmation does not loop.
- Made the Host composer carry forward the previous message's still-present named audience as the next inferred recipient list; explicit recipients always override it, and `@all` remains sticky only when the previous Host message used it.
- Made final `chat_post`/`chat_send` atomically enter blocking standby and consume heartbeat timeouts internally; progress posts still return immediately, removing the fragile requirement that Agents remember a separate standby call.
- Restored Hosted Rooms when VS Code regenerates the extension installation identity by accepting the durable Host credential as ownership proof.
- Fixed failed same-alias Agent rejoins retaining a stale active connection, and stopped message-level errors such as `host-only-broadcast` from incorrectly closing an otherwise healthy Chatroom session.
- Removed manual Host Join approval and user-visible identity reuse; valid Room-secret holders now join immediately, active alias collisions fail immediately, and only the same client identity key resumes a participant.
- Distinguished a connected idle Agent from an Agent actively blocked in standby, including runtime state in presence updates.
- Made only valid leading roster mentions override inferred recipients; inline, code-block, and unknown mentions no longer alter routing.
- Stopped rotating the Room secret when the Host removes a member; secret rotation is now manual only.
- Made active hosted Rooms discoverable in other VS Code windows sharing the same PKM store, with automatic cross-window refresh and an `active elsewhere` state that cannot be mistakenly Rehosted.
- Kept Rooms hosted when the Host Chatroom tab disconnects or reloads; only explicit Close Room, `/leave`, Stop Hub, or extension shutdown now stores the Room.
- Added webview panel restoration across reloads, bounded Chatroom rendering to 1,000 visible messages, and renderer heartbeat/error diagnostics for unexpected tab disposal.
- Added a targeted cross-window refresh while any Room is `active elsewhere`, so a missed lock-delete watcher event cannot leave a closed Room stuck in that state instead of becoming Rehostable.
- Preserved Chatroom history scroll position across new messages and state repaints; scrolling to the bottom resumes automatic latest-message following, while scrolling up pauses it.

### Added
- Added a standardized privacy-safe release media pipeline that renders the real extension webview with synthetic fixtures and produces static multi-step guides plus cursor-visible Chatroom, Papers 2D/3D, and installation GIFs.
- Added asynchronous disk-usage sizes to every Config path using cross-platform Node filesystem APIs, with symlink-safe traversal, session caching, and an explicit Refresh sizes action so large environments are scanned only on demand.
- Reorganized Config into an MCP status dashboard with separate Unified Server, Knowledge schema, Chat schema, and Skill Router versions, direct update actions, a best-effort running-process light, and a state-driven setup guideline.
- Added startup recovery of the last successfully used Root Directory when settings are missing or invalid; new users are routed directly to the Config wizard. Config displays all resolved paths read-only until a safe path-switch workflow is available.
- Added unified search navigation with highlighted matches, current/total counts, previous/next controls, regular-expression mode, and case-sensitive mode; Chatroom counts and navigates matching messages while content tabs search their collections and visible detail.
- Added persistent minimize/restore controls for the global category tree and Chatroom member pane, plus an explicit Jump to latest control.
- Made the category-tree minimize control a visible edge-mounted triangle (`◀`/`▶`) that remains available after collapse.
- Added the same persistent triangle control to the Chatroom Hub/Rooms panel and refined both controls to a taller, narrower edge handle.
- Replaced the In the room text toggle with a persistent edge triangle; compact mode keeps the vertical state legend plus each member's status light and name while hiding timestamps, IDs, roles, and action buttons.
- Made compact Roster width independently draggable (defaulting to roughly four name characters, with a 54px minimum), and overlaid all collapse arrows on their original resizer boundaries so visual edges and drag hit areas stay aligned.
- Made the vertical standby/working/in session legend always visible instead of depending on whether an Agent state frame has already arrived.
- Removed the Host moderation instruction from In the room and changed the status legend to a persistent vertical three-state list: standby, working, and in session.

- Added Host Announce, Ask, and Discuss message modes with `none`, `required`, and `optional` reply-policy metadata while retaining legacy `require_reply` compatibility.
- Added mode explanations on hover and a transient in-room notice whenever the Host switches between Announce, Ask, and Discuss.
- Added sanitized Markdown rendering in Chatroom messages, including GFM tables, syntax-highlighted code, KaTeX math, and Mermaid diagrams.
- Added structured message recipients and made every valid roster mention anywhere in a message a delivery target; routing no longer depends on a leading mention prefix.
- Added hover comments across Chatroom controls, runtime status indicators, and member rows; member comments include full name, participant ID, connection ID, client identity ID, presence, role, and runtime meaning.
- Added a resizable/fullscreen Markdown message viewer and metadata-only message quotes with durable `replyToMessageId` links and jump-back highlighting.
- Added a message right-click menu with Quote, Open in viewer, and Copy text actions.
- Moved inferred recipient names into a dedicated composer row so long multi-recipient lists cannot overlap the textarea placeholder or typed message.
- Promoted inferred recipients to a top-level `To:` bar above mode, quote, and message input so routing context is visually separate from authored text.
- Replaced the separate recipient bar and `@` button with one mail-style composer: editable `To` chips and message body share a single widget, manual recipients use the `+` picker, and valid body mentions sync into `To` automatically.
- Made each new message inherit the previous Host-authored `To` audience, then union in manually selected recipients and every valid new body mention, with deduplication and departed-member filtering.
- Made inherited/default `To` chips removable per draft: removing `@all` suppresses the default for that message, while subsequent body mentions or manual selections add only the intended recipients.
- Tracked `To` recipients by inherited, manual, and current-body mention sources: removing a body mention removes mention-only recipients immediately, while inherited/manual recipients remain until their chip is explicitly removed.
- Added real-time roster-aware `To` detection while typing; when a Host mentions every roster participant except themself, including offline members, the recipient chips collapse automatically to `@all` without rewriting the message body and expand again when one mention is removed.
- Added a keyboard-editable `To` token input: leading valid mentions move out of the body, middle mentions remain in context, unknown `@words` stay literal, and arrow/Backspace/Delete keys navigate or remove recipient chips.
- Persisted structured recipients with each message so future `To` inheritance works without prefixing or otherwise contaminating Markdown message text.

## [2.4.2] — 2026-08-13

### Fixed
- Only highlight Chatroom `@mentions` that resolve to a Room roster alias or the reserved broadcast names; unknown literal `@words` remain plain text.
- Fixed quoted aliases with spaces (for example `@"PKM Dev"`) losing mention highlighting because the renderer expected quote entities that the real escape function does not produce.

### Changed
- Moved Search and content actions (Refresh, Note, Paper, Graph, Export, Import, Sync) from the crowded tab row into a dedicated toolbar inside the main content window, leaving the category tree unaffected.
- Hid the content toolbar entirely on Chatroom, Config, Environments, and Servers, where those content actions are not applicable.
- Simplified Agent participation to `standby → directed @message → post → standby`; removed the legacy conversation preparation, participant, release, and round-robin state machine.
- Added host-only `/stop @agent` (or `/stop @all`) to disconnect online Agents while preserving their Room identity in Earlier and leaving the Room secret unchanged.
- Changed Host Leave to an explicit Close Room action that stores the Room for Rehost; permanent deletion remains available only from Stored Rooms behind double confirmation.
- Fixed Host Close racing Presence state: durable local Hub ownership now controls Close, Stored Rooms refresh immediately, and the Room can be Rehosted without waiting.
- Added right-click Rename for active hosted and Stored Rooms; active renames preserve connected members, Room UUID, history, identities, and Join secret.
- Restored Activity Bar Hosted Rooms using active/stored ownership data rather than Recents; its native context menu supports Open/Rehost, Rename, Close, and double-confirmed Delete as appropriate.
- Made Recents contain Joined Rooms only and deduplicate legacy endpoints by host/IP plus Room name while ignoring port; durable Room UUID remains authoritative when available.
- Added structured reply intent: pure `@all` broadcasts default to no reply, direct aliases default to reply-required, senders can override it, and standby batches identify exactly which events require responses.
- Made implicit recipients role-aware: Host messages default to `@all`, while non-Host Extension and browser messages default to a point-to-point reply to the online Host.
- Made final post results explicitly require an immediate blocking `chat_standby` call, preventing Agents from ending their turn after one reply while merely displaying a standby state.
- Added message-local `reply_audience` propagation: when a Host addresses multiple named Agents, each Agent's implicit reply keeps the Host and peer recipients in the loop without restoring a global turn scheduler; `@all` itself is never propagated.
- Exposed `runtime_state` and `state_changed_at` through Chatroom status/lifecycle payloads, and scoped structured stop events to `chatroom`.

## [2.4.1] — 2026-08-13

### Added
- Added a versioned PKM Skill Router with generated native Agent Skill projections for GitHub Copilot, generic Agents, Claude, and custom target folders.
- Added `skill_capabilities`, `skill_context`, `skill_feedback`, and `propose_skill_update` MCP tools for automatic secondary-Skill discovery and reviewable maintenance.
- Added content-hash tracking, conflict/modified detection, safe Inject/Update/Remove actions, stale-target reminders, and a Skill proposal queue.
- Added user-selected Agent Skills roots through native folder browsing or manual paths, including Windows drive/UNC paths, `%USERPROFILE%`, `~`, and environment-variable expansion with cross-host validation.
- Fixed Chatroom member rename and role editing to target the durable participant identity, so roster updates no longer fail with “That member is no longer in the room roster.”
- Upgraded PKM Skill Router to 1.1.3 with metadata-gated, explainable summary retrieval, explicit `no_match`, and on-demand full Skill loading by stable ID.

### Changed
- Renamed the user-facing MCP tab to Config and grouped MCP runtime/server controls with Agent Skill integration.

## [2.4.0] — 2026-08-11

This release streamlines first-time setup and improves Chatroom reliability across VS Code, MCP agents, and browser participants.

### Improved
- Simplified MCP setup with one managed runtime and one `pkm` server available across workspaces.
- Smoother Chatroom invitations, browser joining, member management, mentions, and multi-agent conversations.
- Refreshed navigation and product icons for a more consistent Personal Knowledge Manager experience.
- Added durable Room identities with explicit Create, Deactivate, and Rehost lifecycles backed by per-Room SQLite databases.
- Stored Host credentials and Join secrets in VS Code SecretStorage, with persistent secret rotation and same-machine Room locking.
- Added a dedicated Stored Rooms list with message/activity metadata, unavailable-credential diagnostics, and one-click Rehost.
- Added Room-scoped participant memberships, reusable alias history, durable pending Join reservations, and a tested Host approval state machine.
- Added Host-approved New/Reuse/Reject Join flows across Extension, MCP, and browser clients; new Magic Messages include durable Room IDs.
- Made approved Agents enter standby automatically, wake on any directed @message, and return to standby after every post; idle now means stopped or released.
- Enforced directed @mentions on regular Chatroom messages so routing and Agent wake-up semantics stay deterministic.
- Added a join-ready history barrier so historical start/release/stop messages cannot mutate a new or reconnecting standby session.
- Scoped stop/release handling to Agents whose conversation has actually started.
- Made Host leave an authoritative Room shutdown that immediately releases all blocked participant standby calls.
- Added bounded standby bursts so split instructions can arrive together (8 directed messages and 250 ms by default), while control events remain immediate.
- Atomically advanced standby cursors, filtered self/non-directed messages, and added event/identity/cursor metadata.
- Added configurable standby message/window/byte caps with UTF-8-safe truncation and continuation cursors.
- Added structured timeout, transport, cancellation, stop, release, close, and kick events with unified Room/standby lifecycle fields.
- Added a `chat_capabilities` discovery manifest and generation-time checks for the complete PKM Chatroom tool workflow.
- Bumped the unified/chat MCP schema to `2.0.9` and made server-code regeneration explicitly user-triggered; status previews no longer rewrite generated files.
- Added a gray inferred `@all` composer recipient that becomes explicit on send unless the user supplies a leading recipient.
- Changed ordinary-message routing to leading recipient mentions only, so technical references such as inline `@all` no longer broadcast or wake unrelated Agents; control messages retain full mention parsing.
- Added `/leave` as a visible Chatroom command; participant leave closes that identity, while Host leave stores/deactivates the Room for everyone without deleting history or identities.
- Added `continue_working` to Chatroom post tools so progress updates preserve the Agent thinking LED; final posts still return to standby automatically.
- Persisted Earlier participants, alias edits, roles, permanent Forget, and Host identity across Room Rehost.
- Added Stored Room Rename and permanently confirmed Delete Data actions.
- Replaced typed Room-name deletion confirmation with two explicit irreversible-delete confirmations.
- Deduplicated live navigation entries by durable Room UUID so Rehost on a new Hub URL/port replaces stale connections instead of showing duplicate Room names.

### Fixed
- Fixed Chatroom reconnect, room-key, turn-order, roster, invitation, and browser authorization issues.
- Fixed mention autocomplete, highlighting, and delivery-status display issues.
- Fixed Python environment deletion/refresh behavior and managed MCP interpreter paths.
- Improved generated-server and webview validation to prevent broken local builds.
- Fixed generated `chat_server.py` indentation and bumped the unified/chat MCP schema to `2.0.1` so outdated server files are clearly detected.
- Fixed alias collisions when multiple Agents in one VS Code window share the unified MCP server; each approved connection now carries a Room-scoped participant identity.
- Added crash-safe Room journal recovery and prevented active Room databases from being scanned by another local Hub instance.

## [2.2.1] — 2026-08-05

### Fixed
- Opening a categorized Skill from the Activity Bar now resolves the Skill correctly instead of showing `Not found.` after the navigation sidebar closes.

## [2.2.0] — 2026-08-05

A unified Markdown experience, richer Paper research workflows, and a broad navigation/search polish pass.

### Added
- **Unified Markdown actions.** Notes, Skills, and Papers share a consistent detail toolbar with Pin, Browser, Download, Edit Content, and Edit Metadata actions. Browser previews use reusable live URLs whose paths mirror store-relative Markdown paths and always render the latest file content on refresh.
- **Paper research fields and citation editing.** Papers support collapsible Conclusions, Implementation, Assumptions, Cites, Cited by, and Content sections. Citations are selected with a structured existing-Paper picker, can be removed or annotated, are canonicalized to valid Paper slugs, and are clickable in both directions.
- **Full-text search for core content.** Notes, Skills, Papers, and Scripts search titles, paths, metadata, and body content. Matches are highlighted in trees and details with theme-aware high-contrast colors; empty category branches disappear while a search is active.
- **Activity Bar creation/edit actions.** Create Skills, Notes, Papers, Ideas, Prompts, and Scripts from their navigation trees, and edit Markdown content or metadata directly in VS Code's editor.

### Improved
- **Paper graph/data consistency.** Citation graph nodes carry the expanded research metadata, imports preserve the new fields, and two-pass sync import keeps citations valid even when targets arrive later in the bundle.
- **Navigation ergonomics.** Opening a concrete sidebar item collapses the navigation surface to return space to the editor; recursive trees render arbitrary folder depth consistently; resizers support direct mouse adjustment.
- **Sync Magic Code.** The encrypted `pk:v3` Magic Code is now the primary join flow, with credential verification before download.
- **Markdown rendering.** Shared rendering and export paths reduce duplicated behavior across content types, while browser and downloaded HTML retain syntax highlighting, diagrams, math, and local assets.

### Fixed
- Invalid Mermaid syntax no longer injects or accumulates a giant error SVG over the extension or VS Code window. Errors render as a bounded inline message instead.
- Search no longer leaves unrelated empty folders visible in category trees.

## [2.1.0] — 2026-07-29

Multi-agent **conversations** in the Chatroom (**beta**), plus packaging fixes.

> ⚠️ **Beta:** the multi-agent conversation feature (`/start_conversation` and the
> standby loop) is experimental and may change; autonomous agents can also hit
> reconnect/timing rough edges. Use it for experiments, not production workflows yet.

### Added
- **Agent conversations (standby loop) — beta.** Drive a live multi-party session with magic messages: `/start_conversation @A @B …` puts the invited agents into **standby** (they watch, reply when addressed or when a message is undirected, and keep a wait→read→respond loop), and `/stop_conversation` ends it; `/release @who` drops one party. On start, the room posts a short **protocol briefing** (including a ready-check) so every participant knows the rules.
- **@mentions.** An `@` picker (and `@`-autocomplete) in the composer for `@all` or a specific member; mentions are highlighted and messages that mention you are flagged.
- **Slash-command autocomplete** for `/start_conversation`, `/stop_conversation`, `/release`, now also listed in `/help`.
- **Live status markers + turn banner.** Each engaged member shows a 🟢 standby / ⚙️ working pill, and a banner tracks whose turn it is (flipping the moment you send).
- **Packages:** a git-tracking tag (git / untracked / git repo) and **delete a package** with double confirmation.

### Fixes
- Conversation-control commands now broadcast to all participants instead of being swallowed as unknown room commands.

## [2.0.1] — 2026-07-27

Bug fixes and UI polish on top of the 2.0.0 Chatroom release.

### Fixes
- **Sync — pick exactly what you share.** The "what to share" picker is now a **folder tree**: tick a single note/skill/etc. or a whole folder. Fixed a bug where choosing one item (e.g. a note) could still ship *all skills* or drop your selection entirely — the shared set now reflects exactly what you check, and the link description reports it truthfully (e.g. `Shares: 1 notes` instead of a misleading "skills all").
- **Environments — cross-platform activation.** The env action is now **⚡ Activate Env** and picks the right commands automatically: PowerShell (`Activate.ps1` / conda hook) on Windows, `source .../activate` on Linux/macOS — sent per line so it works in both PowerShell 5.1 and bash.

### Improvements
- **Menu bar overflow.** With many tabs and toolbar actions, the tab strip now **slides** (‹ › chevrons + mouse wheel) and the action buttons **collapse into a ⋯ menu** when the bar runs out of room.
- **Agent chat helper.** Added `chat_server.py` (in the repo) — an MCP server that lets an AI agent join a Chatroom using `PKM_CHAT_URL` / `PKM_CHAT_SECRET` / `PKM_CHAT_NAME`.

## [2.0.0] — 2026-07-25

### 💬 Chatroom (major new feature)

A self-hosted, real-time collaboration hub where humans and their AI agents share named rooms — right inside the extension.

- **Host & join, three ways** — host a room from the extension (a bundled WebSocket + HTTP hub) and let teammates join from the **extension**, a **browser** (a self-contained page, no VS Code required), or an **AI agent via MCP** — everyone in the same room.
- **Presence & stable identity** — the member list shows who's here with role icons (👑 host, 👤 extension, 🤖 MCP agent, 🌐 browser) and a **stable identity id**, so two people with the same display name are still distinguishable (extension/MCP ids are persisted and trusted; browser ids are best-effort). Departed members remain in the roster, greyed with a "left 5m ago" note.
- **Multiple rooms & name normalization** — one hub can host many rooms; room names are canonicalized (trimmed, whitespace-collapsed, case-folded) so you never get confusing same-name duplicates on one host.
- **Per-room secrets & rotation** — every room carries its own secret; the host can **rotate** it at any time (🔄 button or `/rotate_secret`). Removing a member automatically rotates the secret so they can't rejoin with the one they had.
- **Host moderation** — **mute/unmute**, **rename**, and **remove (kick)** any member straight from the member list. Muted members are greyed out and blocked from posting; the icon reflects their state (🔊 can speak / 🔇 muted, click to toggle).
- **Persistent history** — chat is archived to disk so messages survive rejoining, closing a room, or restarting the hub. The amount kept is configurable via **`personalKnowledge.chatHistoryLimitMB`** (default **10 MB**, `0` to disable). Rendering is de-duplicated by message id, and the browser view marks **"new messages since you left"** on rejoin.
- **File sharing** — share a file with the room (≤ 25 MB); bytes relay live between online peers and are **never stored** on the hub.
- **Slash commands** — a background `roombot` answers `/help`, `/list_audiences`, `/whois <name>`, `/mute_all`, `/unmute_all`, `/rotate_secret`, and `/share_link` (the ws URL + MCP settings an agent needs). New hosts get the `/help` cheat-sheet automatically.
- **MCP chat server** — an auto-generated `chat_server.py` gives an agent `chat_join`, `chat_read`, `chat_post`, `chat_members`, `chat_status`, and `chat_leave`, with a cursor so a reconnecting agent picks up only what it missed.
- **Polish** — resizable left rail, collapsible "Host a Room" form, one-click join-link/browser-link/secret buttons, CJK & Unicode support, and Markdown/JSON transcript export.

## [1.9.2] — 2026-07-24

### 🚀 Onboarding

- **Starter examples for new stores** — a brand-new (empty) knowledge base is now seeded with one example per section under a **Getting Started** category: an example skill, a pinned Welcome note (showing task lists, math, a Mermaid diagram, and a wiki-link), an example paper, a versioned prompt, a script, and a small package — so you have something to copy for your own work.
- **"Getting Started" guide skill** — a `getting-started` skill walks through every function (Skills, Notes, Papers, Prompts, Packages, Scripts, Python Environments, Servers, Sync, MCP): where files live and how to add your own.
- Seeding runs **only once, only for an empty store** — existing knowledge bases are never modified.

## [1.9.1] — 2026-07-23

### 🔗 Sync

- **Encrypted Magic Code** — Sync now uses one `pk:v3:…` Magic Code instead of separate URL, username, and password fields. Credentials are encrypted with AES-256-GCM using the shared app key, and a SHA-256 checksum detects incomplete or incorrect copies before connecting.
- **Choose how received items land** — the receiver now picks a mode:
  - **Merge directly** — import over existing items (previous behavior).
  - **New group** — everything is imported isolated under `<type>/_incoming/<label>/…` (label defaults to `sender-date`, or a custom name) so nothing overwrites your existing content; you review and merge it offline. Namespacing spans every content type, and imported papers keep their internal citations linked.

## [1.9.0] — 2026-07-23

Two major new tabs — **Python Environments** and **Servers** — plus a 3D papers graph.

### 🐍 Python Environments (new tab)

A machine-local manager for your conda / venv / uv environments.

- **Register & detect** — add a conda env (auto-detected via `conda env list`), or register any venv/uv folder (classified from `pyvenv.cfg`). Environments are grouped into a collapsible **tree** by manager → root/parent folder (all conda envs under their install root, venv/uv under their project folder).
- **At-a-glance metadata** — each env card shows the **Python version** (e.g. `py 3.11`), an **on-disk size** (`💾`, computed in the background so it's shown by default), and an editable **description** for tags / crucial packages.
- **Create** — spin up a new **conda**, **venv**, or **uv** environment from a small form (name, Python version / base interpreter, target folder).
- **Packages & compare** — list a env's packages (cached), and compare two envs in a single unified table (package · v1 · v2 · Δ) with click-to-sort columns and colour+symbol status (**↑** upgrade, **↓** downgrade, **＋** added, **－** deleted, **=** same); hide unchanged rows.
- **Merge candidates** — **≈ Similar** finds near-duplicate environments by package overlap (skipping pairs on different Python versions), ranks them by similarity with an estimated space saving, and can generate a **merge script** (keep the larger env, install what's missing, then remove the redundant one).
- **Open shell** — `⚡` opens an integrated terminal with the environment activated.
- **Migrate** — `🚚` moves an environment into a central, extension-managed location (setting `personalKnowledge.environmentsPath`, default `~/pkm-envs`): conda envs are cloned then the original removed; venv/uv are moved with in-place path fix-ups.
- **Delete, your way** — unregister only, optionally delete files from disk, or generate a **delete script** for you to review and run manually. The merge and delete scripts are **never executed by the extension** — they're copied to your clipboard for you to run.

### 🖥 Servers (new tab)

Manage long-running local servers as store packages.

- **Dashboard** — start / stop / restart each server, change its port, view logs, open its folder, and open it in the browser through a fixed-port **reverse proxy** that gives every server a stable URL (setting `personalKnowledge.serversProxyPort`, default `39501`).
- **Store-managed** — import an existing server (moves the folder into `<store>/servers/<slug>/` with a `server.json` manifest) or create a new one; each server is an isolated package. Servers run detached, so they keep running after VS Code closes and are reconciled on restart.
- **Status polling** — the status light reflects running / starting / stopped and updates automatically while a server is coming up.

### 📄 Papers

- **2D / 3D graph toggle** — the citation graph can now render in **3D** (react-force-graph / Three.js, bundled offline) in addition to the existing 2D Cytoscape view.

## [1.8.2] — 2026-07-22

- **Papers graph** — idea nodes now render as a compact rounded shape with the title placed **below** (like paper nodes), so a long idea title is no longer clipped inside the box.

## [1.8.1] — 2026-07-22

- **Fix: `[[...]]` inside code no longer breaks rendering** — wiki-links are now resolved by a code-aware Markdown extension, so `[[...]]` inside a code block or diagram (e.g. a Mermaid `[[Kafka]]` node) is left untouched instead of being rewritten into a link. This previously produced Mermaid parse errors and corrupted code blocks; the fix also covers single-file and linked HTML export.
- **Docs** — added Skills / Notes / Papers / citation-graph / Prompts screenshots to the README.

## [1.8.0] — 2026-07-22

- **Pin notes & folders** — pin is an *ordering* marker scoped to siblings. A pinned **note** sorts to the top of its own folder (☆/★ on the row, in the right-click menu, and in the note toolbar). A pinned **folder** sorts before other folders at the same level and shows a gold ★ (right-click a folder → Pin/Unpin). Note pins live in the note’s frontmatter; folder pins live in a git-tracked `notes/.pk-meta.json` and are re-pathed automatically when a folder is renamed/moved.
- **Fix: late-added images now render** — an image added to a note after it was first opened (or referenced before its file existed) no longer stays blank until a manual refresh. The asset cache-buster is now unique per render, so newly-added `_assets/` images bypass a stale/negative webview cache.

## [1.7.0] — 2026-07-22

- **Mermaid diagrams** — ` ```mermaid ` fenced code blocks now render as diagrams (flowcharts, sequence, class, state, etc.) in the note view, the live editor preview, and HTML export. Mermaid is bundled locally, so diagrams render offline and over Remote-SSH; the theme follows your VS Code light/dark theme.
- **Cross-note links that actually jump** — clicking a link in the note view now reliably opens the target note. Resolution handles `[[Title]]` / `[[Title|alias]]` wiki links, **relative** links (`](../Todo/NOTES.md)`, resolved against the current note’s folder), and **absolute** paths into the store.
- **Browser view is now a navigable site** — the **🌐 Browser** button exports the note **plus every note it links to** (transitively) and opens them together, so cross-note links are clickable in your browser. Diagrams, math, code highlighting, and task badges are all inlined; served over loopback so it works over Remote-SSH. (**⬇ HTML** still saves a single self-contained file.)

## [1.6.3] — 2026-07-17

- **Task-list badges** — note checkboxes now render as clearly-coloured status badges that stay legible under any VS Code theme: `[ ]` todo (outlined), `[x]` done (green ✓), `[~]` in progress (amber), `[!]` blocked (red). Applies to the note view, the live editor preview, and HTML export.
- **Papers graph** — raising the **Top-N by citations** limit no longer reshuffles the graph when it introduces no new nodes; the layout is only rebuilt when the node/edge set actually changes.
- **Papers graph** — click an empty area of the canvas to conceal the conclusions tooltip.

## [1.6.2] — 2026-07-15

- **Papers graph** — click an empty area of the canvas to conceal the conclusions tooltip.
- **Docs** — the README now documents the **Papers** feature (intro, feature list, walkthrough, and MCP paper tools).

## [1.6.1] — 2026-07-14

- **Move everywhere** — the **Move** action now covers every content type:
  - **Scripts** — right-click a script to **Move…** it to a different folder, or right-click a script category folder to **Rename folder…** / **Move folder…** (re-paths every script beneath it). Missing parent folders are created automatically.
  - **Papers** — right-click a paper card → **Change topic…** to move it into a different topic folder.

## [1.6.0] — 2026-07-14

Builds on the **Papers** feature (1.5.0):

- **Ideas** — mark any node as your own *idea* (a checkbox in the paper form). In the citation graph an idea is drawn distinctly (a gold, dashed box with dashed edges) so it reads as a hub connected to the papers it builds on.
- **Pin / star** — star any paper or idea; pinned items collect in a **Pinned** section at the top of the list. (Replaces the earlier idea-specific icon — ideas now look like any paper in the list.)
- **Groups** — organize items into user-assigned groups (default: **Papers**). Right-click a card to **move it to a group** or create a **New group…**; right-click a group header to **rename** or **delete** it (its items fall back to “Papers”). Right-click a **topic folder** to move everything under it (including subfolders) to a group in one step.
- **Skills** — right-click a category folder to **rename** it; every skill beneath it (and nested subfolders) is re-pathed accordingly.
- **Move** — right-click a note/skill or a category folder in the tree to **Move** it to a different path; missing parent folders are created automatically.
- Groups, pins, and the idea flag are stored in frontmatter, sync with the rest, and are preserved across MCP edits.
- Fixes: group/rename prompts use an in-webview dialog (VS Code webviews block native `prompt()`/`confirm()`); the generated MCP server now serializes booleans as valid JSON; nested folder arrows are sized below their parent group.

## [1.5.0] — 2026-07-14

- **Papers** — a new tab for tracking research papers and their citation graph.
  - **List View**: each paper shows year, authors, title, topic, publisher, tags, and a citation-count badge; filter by topic and search. Papers are plain `papers/<Category>/<Title>.md` files (files-as-truth) with metadata, a list of conclusions, per-citation notes, a remote **URL** and/or an uploaded **local file**, and a Markdown commentary body.
  - **Graph View** (Cytoscape.js, bundled offline): an interactive citation graph — draggable nodes, a force ⇄ hierarchical layout toggle, node size/color by citation count and topic, arrows pointing from a cited paper to the papers that cite it, hover a node to reveal its conclusions (or a global “show all” toggle), plus a topic filter, top-N-by-citations limit, and neighbor expansion. Click a node to open the paper.
  - **MCP**: `list_papers`, `search_papers`, `get_paper`, `add_paper`, `update_paper`, `delete_paper`, and `paper_graph`, so an AI assistant can read and grow your library (citations resolve by title or slug).
  - **Sync**: papers ride along in the shareable bundle and import on join, with the citation graph preserved on the other side.

## [1.4.0] — 2026-07-14

- **Math & formulas (KaTeX).** Notes now render LaTeX: `$...$` for inline math and `$$...$$` for display equations — in the note view, the live editor preview, and HTML export. Supports the full common TeX set (`\frac`, `\sum`, `\boxed`, `\begin{cases}`, `\mathcal`, Greek, etc.). KaTeX is bundled locally (script, stylesheet, and fonts), so math renders offline and over Remote-SSH with no CDN. Exported HTML embeds the fonts inline, so a shared file renders math on its own. `$` inside code spans/blocks is left untouched, and everyday currency like “$5” isn't mistaken for math.
- **Refresh re-renders the open note.** The ↻ Refresh button now re-renders the currently open note/skill (not just the sidebar), and appends a cache-buster to note image URLs so **regenerated images** (same path, new content) and external edits show up immediately instead of serving the cached copy.

## [1.3.2] — 2026-07-14

- **Fix: images in categorized notes now render.** Note image links use the portable, Obsidian-style convention where `_assets/<file>` is relative to the note file (`notes/<category>/_assets/<file>`). The panel and HTML export were resolving them against the top-level `notes/` folder instead, so images in notes that live in a subfolder didn't display. Rendering, the live editor preview, HTML export, and paste-to-insert now all use the note's own `_assets/` folder.

## [1.3.1] — 2026-07-14

- **Fix: 🌐 Browser preview now opens a real browser over Remote-SSH.** Previously, on a remote workspace the button produced a `vscode-remote:` link and VS Code asked you to pick an app. The preview is now served on an ephemeral loopback port and routed through `asExternalUri`, so the port is forwarded to your machine and the page opens in your **local** browser (unchanged behavior when working locally).

## [1.3.0] — 2026-07-13

- **Export a note to HTML**: from the note view, **🌐 Browser** opens a standalone preview in your default browser and **⬇ HTML** saves a self-contained `.html` file. Images are inlined as data URIs and code keeps its syntax highlighting, so the single file is easy to share or present to someone who doesn't have the extension. (On a headless Remote-SSH host with no browser, the preview path is surfaced so you can grab the file.)

## [1.2.0] — 2026-07-13

**Files are now the source of truth.** Skills and notes live as plain Markdown files under `skills/` and `notes/` — no database. This makes your knowledge base a portable, git-friendly, Obsidian-style wiki that you (and the MCP server) can edit directly.

- **Files-as-truth store**: skills and notes are read and written directly as `.md` files. Identity is the file's path, the category is its folder, and the title/name is the filename (the exact value is preserved in YAML frontmatter). Search scans on demand; a file watcher auto-refreshes the panel and tree when files change on disk (including external/MCP edits) — no more manual reload.
- **Hidden one-time migration**: if a legacy `knowledge.db` is found, its skills and notes are migrated into files automatically. The migration is non-destructive — any pre-existing `notes/` and `skills/` folders are backed up to `_pre-files-backup-<timestamp>/` first, and `knowledge.db` is kept as a backup.
- **Paste images into notes**: paste an image directly into the note editor; it is saved under `notes/_assets/` (content-hash de-duplicated) and rendered inline in both the live preview and the note view.
- **Cross-note links**: `[[Title]]` / `[[Title|alias]]` wiki links and relative `.md` links are clickable and open the target note.
- **File-backed MCP server**: the generated `mcp-server/server.py` now reads and writes the same Markdown files (no SQLite). MCP writes appear instantly in the panel and land in git as readable diffs. Search still uses an in-memory FTS5 trigram index (CJK-friendly) built from the files.
- `sql.js` is retained only for the one-time migration.

## [1.1.3] — 2026-07-13

- **Refresh button** (topbar) — reloads the database from disk so externally-made changes appear. This matters because the extension keeps the SQLite DB in memory, so writes from the MCP server (`add_note`, `update_skill`, …) or any other process were previously invisible until restart. The button reloads the whole DB, so it reflects added, edited, and deleted **Skills and Notes**, and refreshes the sidebar tree.

## [1.1.2] — 2026-07-10

- **Selectable AI backend** for script summaries — a dropdown in the Scripts tab, populated by scanning for available backends (each live Copilot model, plus configured Azure OpenAI / OpenAI-compatible endpoints).
- **Backend-aware summary cache** — cache is keyed by backend + model + content, so switching model/provider (e.g. GPT → Claude) regenerates instead of showing a stale summary.
- **Auto-show cached summary** when reopening a script (cache-only peek, never triggers a new AI call).
- **Set AI API Key** command — stores the key in VS Code SecretStorage.
- **Delete Script** (right-click) — removes the file *and* all its correlated AI-summary caches, with confirmation + git commit.
- Editing a script now clears its stale AI caches; caches are stored per-script under `.ai-cache/<script>/`.
- **Sync**: the type header checkbox (Skills / Notes / …) now selects **and** deselects all its items, with an indeterminate state for partial selections; removed the redundant All / None links.
- **Docs**: added a "How to use" walkthrough and a "Why an MCP server?" section to the README, plus an in-app explainer on the MCP tab.
- Added a note from the developer to the extension details.

## [1.1.0] — 2026-07-08

- **Cross-platform storage**: migrated to pure-JS SQLite (`sql.js`) — no native binaries.
- **Configurable store path** + a first-run setup wizard (use default, browse, or type a path — offers to create it).
- **Hierarchical navigation**: recursive N-level category trees for Skills, Notes, and Scripts in both the Activity Bar tree and the panel's left nav (default collapsed).
- **Right-click actions**: add a new skill/note/script at a folder; edit any item from the sidebar.
- **Notes**: hierarchical categories, tags, and a split live Markdown preview editor.
- **Scripts**: recursive folders, automatic multi-language tags (Scope / C# / Python / …), bundled syntax highlighting with a custom **Scope** grammar, in-place editing (confirmation + git commit), and an **AI Summary** button (content-hash cached).
- **Markdown mirror + git**: notes and skills are mirrored to readable `.md` files and auto-committed; the store auto-initializes as a git repo.
- **MCP server**: auto-generated Python server with **read and write** tools and FTS5 trigram (CJK-friendly) search; named after the store folder.
- Offline-safe local `marked` + `highlight.js` bundles; build-time inline-script syntax check; leveled logging with a **Show Logs** command.

## [1.0.1] — 2026-07-08

- Fixed the Activity Bar sidebar icon rendering (merged SVG paths for compatibility).

## [1.0.0] — 2026-07-08

- Initial release: browse, edit, and sync personal knowledge — skills, notes, prompts, packages, and scripts — in a webview panel, backed by a local SQLite store with a built-in sync server.

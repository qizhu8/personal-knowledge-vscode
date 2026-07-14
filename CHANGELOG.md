# Changelog

All notable changes to the **Personal Knowledge** extension are documented here.
This project follows [Semantic Versioning](https://semver.org/).

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

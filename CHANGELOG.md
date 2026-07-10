# Changelog

All notable changes to the **Personal Knowledge** extension are documented here.
This project follows [Semantic Versioning](https://semver.org/).

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

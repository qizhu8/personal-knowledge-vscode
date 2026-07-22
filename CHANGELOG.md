# Changelog

All notable changes to the **Personal Knowledge** extension are documented here.
This project follows [Semantic Versioning](https://semver.org/).

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

# Personal Knowledge

A VS Code extension for managing your personal knowledge base — skills, notes, papers, prompts, packages, and scripts — with hierarchical navigation, full-text search, syntax highlighting, AI-assisted summaries, a built-in sync server, and MCP integration so AI assistants can read *and write* your knowledge directly.

> **A note from the developer**
>
> This is a small extension born from a simple need: one unified place to manage skills, quick notes, large collections of prompts, and development scripts across multiple projects, vms, even colleagues. I don't want/need/should/feel happy to put everything to git, thus I have this extension. I'm a heavy user myself — and I'll keep improving it with regular updates. I hope it helps more people stay organized. Welcome aboard, and thanks for giving it a try!
>
> — Uone

## For Human
This extension allows you (human) to add/update/delete items, but it is more preferrable for agents to update and we review. Let agents play with your knowledge, they are kids.

## First-Aid Tip
If you (usually me myself :) ) accidentally deleted/screwed up something, ask AI to fix. AI can read the Markdown files and mcp scripts to understand what to do.

## Features

- **Skills** — reusable know-how as searchable Markdown, organised into an arbitrary-depth category tree
- **Notes** — quick-capture Markdown notes with a **split live-preview editor**, hierarchical categories, tags, and types
- **Prompts** — browse versioned prompt files (project -> task -> version -> file)
- **Packages** — browse local Python/Node packages
- **Scripts** — organise Scope / C# / Python / PowerShell scripts in a recursive folder tree with:
  - **Automatic language tags** (e.g. `Scope`, `C#`, `Python` — multiple tags per file)
  - **Syntax highlighting** (bundled highlight.js + a custom **Scope** grammar)
  - **AI Summary** button — Purpose / How it works / Inputs / Output / Issues, cached by content hash
  - **In-place editing** with confirmation + automatic git commit
- **Hierarchical navigation** — both the Activity Bar tree and the panel's left nav render arbitrary-depth folders (default collapsed)
- **Right-click actions** — add a new skill/note/script at a folder, or edit any item, straight from the sidebar
- **Full-text search** — instant search across all content (CJK-friendly on the MCP side)
- **Files are the source of truth** — every skill and note is a plain, git-tracked `.md` file; edit them here, in your editor, or from the MCP server and the panel refreshes automatically
- **Paste images & cross-note links** — paste images straight into a note (stored under `notes/_assets/`), and link between notes with `[[Title]]` wiki links or relative `.md` links
- **Math & formulas** — LaTeX rendering via KaTeX: `$...$` inline and `$$...$$` display equations, bundled to work offline; also embedded into HTML exports
- **Papers** — track research papers and your own **ideas** with a citation graph:
  - **List view** grouped into user-defined **groups** and topic folders, showing year, authors, topic, publisher, tags, and a citation-count badge; **pin/star** favourites to the top, and right-click to move a paper between groups or **change its topic**
  - **Graph view** — an interactive, draggable citation graph (Cytoscape.js; force or hierarchical layout) sized/coloured by citation count and topic, with idea nodes drawn distinctly, that reveals each paper's conclusions on hover
  - Papers are plain `papers/<Topic>/<Title>.md` files (with a remote URL and/or an uploaded local file), and are exposed via **MCP** and **sync**
- **Sync** — share a temporary authenticated link so another machine can pull your knowledge
- **MCP server** — auto-generated Python server with **read and write** tools that operate directly on the Markdown files, with FTS5 trigram search (CJK-friendly)
- **Selectable AI backend** — Copilot (built-in), Azure OpenAI, or any OpenAI-compatible endpoint; keys stored in SecretStorage
- **Cross-platform** — no native binaries

## Installation

Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=Uone.personal-knowledge) or download the `.vsix` from [Releases](https://github.com/qizhu8/personal-knowledge-vscode/releases) and run:

```
code --install-extension personal-knowledge-*.vsix
```

## First run

On first activation the extension asks where to store your knowledge base (use the default `~/personal-knowledge`, browse to an existing folder, or type a custom path — it offers to create it). It then initialises the folder, a git repository, and an MCP server. If a legacy `knowledge.db` from an older version is found, its skills and notes are migrated into Markdown files automatically (non-destructively).

## Store directory

```
<your-store>/
  skills/             <- skills (git-tracked .md files, the source of truth)
  notes/              <- notes  (git-tracked .md files, the source of truth)
    _assets/          <- images pasted into notes
  papers/             <- papers (git-tracked .md files) + citation graph
  prompts/            <- versioned prompt files
  packages/           <- local Python/Node packages
  scripts/            <- Scope / C# / Python / PowerShell scripts
  mcp-server/         <- generated MCP server
```

Change the location any time via **Settings -> Personal Knowledge: Store Path**.

## How to use

1. **Open the panel** — click the Personal Knowledge icon in the Activity Bar, or press `Ctrl+Shift+K` / `Cmd+Shift+K`.
2. **Browse** — the left navigation shows your Skills, Notes, Papers, Prompts, Packages, and Scripts as collapsible folder trees. Click any item to preview it.
3. **Capture knowledge**:
   - Select code in any editor -> right-click -> **Save Selection as Skill**.
   - Press `Ctrl+Shift+N` / `Cmd+Shift+N` for a quick note (with live Markdown preview).
   - Right-click a folder in the sidebar -> **New Skill / Note / Script Here**.
4. **Edit** — right-click any item -> **Edit**, or use the ✏ button in the detail view. Script edits are confirmed and committed to git automatically.
5. **Understand a script** — open any script and click **✨ AI Summary** for a purpose / inputs / output / issues breakdown.
6. **Share** — use the **Sync** button to hand another machine a temporary authenticated link to pull selected content.
7. **Connect an AI assistant** — generate an MCP server (see below).

Everything is stored as plain Markdown files under your chosen folder and tracked in git — so you always own your data and have full history.

## Why an MCP server?

The extension is where **you** manage your knowledge. The **MCP server** is how your **AI assistant** uses it.

Without it, you end up copy-pasting the same context into every chat, and anything the AI figures out is lost when the session ends. With the MCP server running, any MCP-aware assistant (Claude Desktop, GitHub Copilot, etc.) can:

- **Search and read** your accumulated skills, notes, and scripts on demand — so it answers with *your* conventions, gotchas, and past solutions instead of generic guesses.
- **Write back** new learnings — `add_note`, `update_skill`, and friends let the assistant persist what it discovers, turning your knowledge base into a durable, shared memory that grows across sessions.
- **Stay in sync** — because the server reads the same store the extension writes, edits from either side show up in both, and every write is git-tracked.

In short: the extension gives *you* a home for your knowledge; the MCP server gives your *AI* a key to that home, so it can both learn from and contribute to it.

## MCP integration

Open the **MCP** tab in the panel and click **Generate MCP Server**, then add the shown snippet to your AI client config. The server (named after your store folder) exposes:

| Tool | Description |
|------|-------------|
| `list_skills` / `search_skills` / `get_skill` | Browse / search / read skills |
| `list_notes` / `search_notes` / `get_note` | Browse / search / read notes |
| `add_note` / `update_note` / `delete_note` | Create / edit / remove notes |
| `add_skill` / `update_skill` / `delete_skill` | Create / edit / remove skills |
| `list_papers` / `search_papers` / `get_paper` / `paper_graph` | Browse / search / read papers and their citation graph |
| `add_paper` / `update_paper` / `delete_paper` | Create / edit / remove papers |

Search uses an in-memory FTS5 **trigram** index (CJK-friendly, ranked) built from the Markdown files at call time, with a substring fallback for short queries. Reads and writes operate directly on the git-tracked `.md` files.

## AI backend

The **AI Summary** feature uses the backend selected in **Settings -> Personal Knowledge: AI Backend**:

- `copilot` — GitHub Copilot via the built-in VS Code Language Model API (no key needed)
- `azure-openai` — set endpoint / deployment / API version, then run **Personal Knowledge: Set AI API Key**
- `openai-compatible` — any OpenAI-compatible endpoint (OpenAI, vLLM, Ollama, ...)

API keys are stored in VS Code SecretStorage, never in settings.

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+K` / `Cmd+Shift+K` | Open panel |
| `Ctrl+Shift+N` / `Cmd+Shift+N` | Quick note |

## Settings

| Setting | Description |
|---------|-------------|
| `personalKnowledge.storePath` | Knowledge store directory |
| `personalKnowledge.openOnStartup` | Open the panel automatically at startup |
| `personalKnowledge.maxTreeDepth` | Max folder levels in the tree (default 4) |
| `personalKnowledge.logLevel` | `debug` / `info` / `warn` / `error` |
| `personalKnowledge.aiBackend` | `copilot` / `azure-openai` / `openai-compatible` |
| `personalKnowledge.aiModel` / `aiEndpoint` / `aiAzureApiVersion` | AI backend configuration |

## Building from source

```bash
npm install
npm run build
npx vsce package
```

## License

MIT (c) Yu Wang

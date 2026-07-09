# Personal Knowledge

A VS Code extension for managing your personal knowledge base — skills, notes, prompts, packages, and scripts — with hierarchical navigation, full-text search, syntax highlighting, AI-assisted summaries, a built-in sync server, and MCP integration so AI assistants can read *and write* your knowledge directly.

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
- **Markdown mirror + git** — every note and skill is mirrored to a readable `.md` file and committed to git automatically
- **Sync** — share a temporary authenticated link so another machine can pull your knowledge
- **MCP server** — auto-generated Python server with **read and write** tools and FTS5 trigram search (CJK-friendly)
- **Selectable AI backend** — Copilot (built-in), Azure OpenAI, or any OpenAI-compatible endpoint; keys stored in SecretStorage
- **Cross-platform** — pure-JS SQLite (sql.js), no native binaries

## Installation

Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=Uone.personal-knowledge) or download the `.vsix` from [Releases](https://github.com/qizhu8/personal-knowledge-vscode/releases) and run:

```
code --install-extension personal-knowledge-*.vsix
```

## First run

On first activation the extension asks where to store your knowledge base (use the default `~/personal-knowledge`, browse to an existing folder, or type a custom path — it offers to create it). It then initialises the database, a git repository, and an MCP server.

## Store directory

```
<your-store>/
  knowledge.db        <- skills & notes (SQLite)
  skills/             <- markdown mirror (git-tracked)
  notes/              <- markdown mirror (git-tracked)
  prompts/            <- versioned prompt files
  packages/           <- local Python/Node packages
  scripts/            <- Scope / C# / Python / PowerShell scripts
  mcp-server/         <- generated MCP server
```

Change the location any time via **Settings -> Personal Knowledge: Store Path**.

## MCP integration

Open the **MCP** tab in the panel and click **Generate MCP Server**, then add the shown snippet to your AI client config. The server (named after your store folder) exposes:

| Tool | Description |
|------|-------------|
| `list_skills` / `search_skills` / `get_skill` | Browse / search / read skills |
| `list_notes` / `search_notes` / `get_note` | Browse / search / read notes |
| `add_note` / `update_note` / `delete_note` | Create / edit / remove notes |
| `add_skill` / `update_skill` / `delete_skill` | Create / edit / remove skills |

Search uses an in-memory FTS5 **trigram** index (CJK-friendly, ranked) built at startup, with a `LIKE` fallback for short queries. Writes also update the git-tracked markdown mirror.

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

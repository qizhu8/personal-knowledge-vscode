# Personal Knowledge

A VS Code extension for managing your personal knowledge base — skills, notes, prompts, packages, and scripts — with full-text search, a built-in sync server, and optional MCP integration so AI assistants can query your knowledge directly.

## Features

- **Skills** — store reusable know-how as searchable Markdown entries, organised by category
- **Notes** — quick-capture notes with types (todo, done, observation, data-path, general)
- **Prompts** — browse versioned prompt files from your store directory
- **Packages & Scripts** — browse local packages and shell scripts
- **Full-text search** — FTS5-powered instant search across all content
- **Sync** — share a temporary authenticated link so another machine can pull your knowledge
- **MCP Server wizard** — one-click generation of a Python MCP server so Claude Desktop, GitHub Copilot, and other AI clients can search your knowledge base
- **Activity Bar icon** — quick access sidebar without leaving your current editor

## Installation

Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=YOUR_PUBLISHER_ID.personal-knowledge) or download the `.vsix` from [Releases](https://github.com/qizhu8/personal-knowledge-vscode/releases) and run:

```
code --install-extension personal-knowledge-*.vsix
```

## Store directory

By default the extension stores everything under `~/personal-knowledge/`. Override via **Settings → Personal Knowledge: Store Path**.

```
~/personal-knowledge/
  knowledge.db        ← skills & notes (SQLite)
  prompts/            ← versioned prompt files
  packages/           ← local Python/Node packages
  scripts/            ← shell scripts
  mcp-server/         ← generated MCP server (optional)
```

## MCP integration

Open the **⚡ MCP** tab in the panel, click **Generate MCP Server**, then follow the shown instructions to connect Claude Desktop or VS Code Copilot. The generated server exposes:

| Tool | Description |
|------|-------------|
| `list_skills` | List all skills (optionally by category) |
| `search_skills` | Full-text search across skills |
| `get_skill` | Retrieve full content of a skill |
| `list_notes` | List notes (optionally by type) |
| `search_notes` | Full-text search across notes |
| `get_note` | Retrieve full content of a note |

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+K` / `Cmd+Shift+K` | Open panel |
| `Ctrl+Shift+N` / `Cmd+Shift+N` | Quick note |

## Building from source

```bash
npm install
npm run build
npx vsce package
```

## License

MIT © Yu Wang

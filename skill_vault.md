# How to Use SkillVault

A remote skill/doc library, reachable from any repo via VS Code's Copilot Chat (agent mode). Ask in
plain language and the agent calls the right tool — no manual copy-pasting of playbooks between
workspaces.

## What you need

- Microsoft corpnet or SAW network access (the service only accepts traffic from Microsoft's network).
- VS Code with Copilot Chat (agent mode).
- An API key — ask **jimihe** for one; it's not included in this file. Keys come in two kinds:
  **Admin** (can edit/delete any skill) and **User** (can read/fetch every skill, but can only
  edit/delete skills it created itself). Most people get a User key.

## One-time setup

Add this to your user-level `mcp.json` (Windows: `%APPDATA%\Code\User\mcp.json`) so it's available
from every workspace:

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "skillvault-api-key",
      "description": "SkillVault API key (ask jimihe for this)",
      "password": true
    }
  ],
  "servers": {
    "skillvault": {
      "type": "http",
      "url": "https://skillvaultmcp-jimihe-azsc.azurewebsites.net/mcp",
      "headers": {
        "x-api-key": "${input:skillvault-api-key}"
      }
    }
  }
}
```

Reload VS Code (or start a new chat). The first tool call will prompt for the API key once, then
cache it in secret storage — it's never stored in plaintext.

## How to use it

In any agent-mode Copilot Chat session, just ask in plain language:

- **"Search my skill vault for \<topic\>"** → finds and ranks matching skills by keyword.
- **"Pull down the \<slug\> skill"** → fetches it; the agent writes the files into `./.skillvault/<slug>/` in your current repo (gitignore that folder).
- **"List all skills"** or **"list skills tagged \<tag\>"** → shows what's available.
- **"Save this as a skill called \<slug\>"** → adds a new skill (a `SKILL.md` plus any extra files); you become its owner.
- **"Update the \<slug\> skill with …"** → overwrites it as a new version (send the full file set, not just a diff). Only works if you own that skill (or you have an Admin key).
- **"Remove the \<slug\> skill"** → deletes it (recoverable unless you ask for a hard delete). Same ownership rule as update.
- **"Who am I / what key am I using"** → the agent can call `whoami` to show your owner name and role.

No need to remember exact tool names or parameters — describe what you want and the agent figures
out the rest.

## Browsing without an agent

Open `https://skillvaultmcp-jimihe-azsc.azurewebsites.net/api/ui?code=<your key>` in a browser once
(it caches the key locally and cleans the URL). From there you can search, view, and download any
skill as a `.zip`.

## Good to know

- This is jimihe's personal vault, shared out of convenience. With a **User** key, `update_skill`/
  `remove_skill`/`rollback_skill` only work on skills you created yourself — this is enforced by
  the server, not just a courtesy, so you can't accidentally (or otherwise) overwrite or delete
  someone else's skill. Ask **jimihe** (an Admin) if a skill needs to change hands.
- The web UI (`/api/ui`) is read/search/download-only for everyone regardless of key type — adding,
  updating, and removing skills is only available through the MCP tools above.
- Version history/rollback is temporarily unavailable (a storage stopgap); adding and updating
  skills still works normally, just without an undo button for now.
- Hitting the bare hostname (`https://skillvaultmcp-jimihe-azsc.azurewebsites.net` with no path)
  will 401 — there's no route mapped at `/`. Always use the full `/api/ui?code=<key>` URL for
  browsing, or the `/mcp` endpoint via `mcp.json` for the agent.

# Release Screenshots

Release screenshots use the extension's real built webview (`dist/webview/panel.html`, `panel.js`, and `panel.css`) with an in-memory VS Code bridge and synthetic fixtures.

## Privacy

The capture pipeline never reads the configured PKM root, VS Code global storage, SecretStorage, Room databases, or live Chat Hubs. Fixtures use only `/home/demo/...`, fictional Rooms/Agents/messages, and synthetic Papers. The capture script validates fixture identities/graph keys and rejects unexpected PNG/GIF metadata.

Do not capture the live extension window for public release media.

## Commands

```bash
npm run screenshots
npm run screenshots:gif
```

The first command builds and captures:

- `resources/screenshots/config-dashboard.png`
- `resources/screenshots/chatroom.png`
- `resources/screenshots/chatroom-guide.png`
- `resources/screenshots/papers-graph-guide.png`
- `resources/screenshots/installation-guide.png`

The GIF command also captures:

- `resources/screenshots/chatroom.gif` — uncluttered Magic Link, autocomplete, send, working, response, and standby feature demo
- `resources/screenshots/papers-graph.gif` — uncluttered real 2D and 3D manipulation feature demo
- `resources/screenshots/installation-guide.gif` — uncluttered Config dashboard feature tour

Static `*-guide.png` files carry the complete multi-step lesson rails. GIFs prioritize the product interaction itself.

## Requirements

- Python Playwright with Chromium installed
- Pillow only when generating GIF output

The preview uses deterministic VS Code Dark Modern variables. When changing shared colors or layout, also inspect the extension under a VS Code light theme before publishing.
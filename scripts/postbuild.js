#!/usr/bin/env node
/* Post-build validation for the extension and browser Chatroom webviews. */
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const htmlPath = path.join(__dirname, "..", "dist", "webview", "panel.html");
let html = fs.readFileSync(htmlPath, "utf-8");

// 1. Strip blocking hljs CDN script tag
html = html.replace(
  /<script src="https:\/\/cdnjs\.cloudflare\.com\/[^"]*highlight[^"]*"><\/script>/,
  ""
);
fs.writeFileSync(htmlPath, html);

// 2. Syntax-check the extracted panel application script.
try {
  const panelJsPath = path.join(__dirname, "..", "dist", "webview", "panel.js");
  new vm.Script(fs.readFileSync(panelJsPath, "utf-8"), { filename: "panel.js" });
  if (!html.includes('href="%%PANEL_CSS%%"') || !html.includes('src="%%PANEL_JS%%"')) {
    throw new Error("panel.html is missing panel CSS/JS placeholders");
  }
  if (/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/.test(html) || /<style(?:\s[^>]*)?>/.test(html)) {
    throw new Error("panel.html must not contain inline JavaScript or CSS");
  }
  const panelCss = fs.readFileSync(path.join(__dirname, "..", "dist", "webview", "panel.css"), "utf-8");
  if (!/#chat-active\.hidden\s*\{\s*display\s*:\s*none\s*\}/.test(panelCss)) {
    throw new Error("panel.css must hide #chat-active when no Chatroom is active");
  }
  const panelJs = fs.readFileSync(panelJsPath, "utf-8");
  if (/chat-hosted-actions|chatCopyActiveInvite|chatOpenActiveBrowser|chatRotateActiveKey/.test(panelJs)) {
    throw new Error("active Chatroom header must not duplicate Hub Invite/Browser/Key actions");
  }
  if (!html.includes("Regenerate Server Code") || !panelJs.includes("mcp-regenerate-server-code") ||
      !panelJs.includes("highlightMcpRegenerate") || !panelCss.includes("mcpRegenerateHighlight")) {
    throw new Error("outdated MCP guidance must expose and highlight Regenerate Server Code");
  }
  if (!html.includes('data-tab="servers">Servers</button>') || html.includes('data-tab="servers">🖥')) {
    throw new Error("Servers menu tab must use text only, without a leading icon");
  }
  if (!html.includes('data-tab="mcp">Config</button>') || !panelJs.includes("renderPkmSkillTargets") ||
      !panelJs.includes("pkmSkillInject") || !panelJs.includes("pkmSkillOpenProposals") ||
      !panelJs.includes("pkmSkillBrowseCustomTarget") || !panelJs.includes("pkmSkillEnterCustomTarget") ||
      !panelCss.includes("pkm-skill-target")) {
    throw new Error("Config tab must expose PKM Skill Router target controls");
  }
  if (!panelJs.includes('id="chat-composer"') || !panelJs.includes('id="chat-recipient-chips"') ||
      !panelJs.includes("function chatComposerRecipientNames") || !panelJs.includes("chatDefaultRecipientNames") ||
      !panelJs.includes("chatStructuredRecipientNames")) {
    throw new Error("Chat composer must expose unified To chips with inherited, manual, and mentioned recipients");
  }
  if (!panelJs.includes("chat.active?.selfHost ? [{ name: 'all'")) {
    throw new Error("Extension Chatroom must show @all in the mention picker only to the Host");
  }
  if (panelJs.includes('id="chat-response-required"') || !panelJs.includes("a.selfHost ? 'Close Room' : 'Leave Room'")) {
    throw new Error("Chatroom UI must infer reply intent automatically and distinguish Host Close from guest Leave");
  }
  if (!panelJs.includes("function chatActiveRoomMenu") || !panelJs.includes("function chatStoredRoomMenu") ||
      !panelJs.includes("chatRehostStoredRoom") || !panelJs.includes("chatDeleteStoredRoom")) {
    throw new Error("Chatroom right-click menus must expose active and Stored Room actions");
  }
  const extensionJs = fs.readFileSync(path.join(__dirname, "..", "dist", "extension.js"), "utf-8");
  if (!extensionJs.includes("Regenerate Server Code") || !extensionJs.includes("offerMcpServerRegeneration")) {
    throw new Error("extension must offer direct MCP server-code regeneration");
  }
  const browserSource = fs.readFileSync(path.join(__dirname, "..", "src", "chatroom-browser.ts"), "utf-8");
  if (!browserSource.includes("selfMember&&selfMember.host") || !browserSource.includes('host?host.user:"all"') ||
      !browserSource.includes("selfMember&&selfMember.host?[{name:\"all\"")) {
    throw new Error("Browser Chatroom must reserve @all for Hosts and default guest replies to the Host");
  }
  const extensionTs = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf-8");
  const packageJson = fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8");
  for (const command of ["openHostedRoomItem", "renameHostedRoom", "closeHostedRoom", "deleteHostedRoom"]) {
    if (!packageJson.includes(`personalKnowledge.${command}`) || !extensionTs.includes(`personalKnowledge.${command}`)) {
      throw new Error(`Hosted Room navigation command is missing: ${command}`);
    }
  }
  if (!extensionTs.includes("this.hub?.adminRooms().find") ||
      !extensionTs.includes("rc.selfHost && room.room === ChatHub.canonRoom(rc.room)") ||
      !extensionTs.includes("await this.hub.adminCloseRoom(locallyHosted.room)") ||
      !extensionTs.includes("await this.refreshStoredRooms()")) {
    throw new Error("Host Close must use durable Hub ownership and refresh Stored Rooms immediately");
  }
  const roomIdentityTs = fs.readFileSync(path.join(__dirname, "..", "src", "chat-room-identity.ts"), "utf-8");
  if (!roomIdentityTs.includes('if (roomId) return `room:${roomId}`') ||
      !roomIdentityTs.includes("new URL(url).hostname") ||
      !extensionTs.includes("return chatRoomIdentity(url, room, roomId)") ||
      !extensionTs.includes("item.roomId === opts.roomId")) {
    throw new Error("Chatroom navigation must deduplicate by Room UUID or host+name without port");
  }
  if (extensionTs.includes("Type ${roomName} to delete") ||
      !extensionTs.includes('"Delete Data Permanently"') ||
      !extensionTs.includes("Final confirmation: permanently delete")) {
    throw new Error("Stored Room deletion must use two click confirmations without typed-name matching");
  }
  const previewOnlyBranches = extensionTs.match(/\? \{ serverPath: mcpStatus\(\)\.serverPath, configSnippet: combinedMcpRegistry\(\) \}/g) || [];
  if (previewOnlyBranches.length !== 2 ||
      !/resolveMcpServerDefinition:\s*\(\)\s*=>\s*createDefinition\(\)/.test(extensionTs)) {
    throw new Error("MCP preview/provider resolution must not regenerate server code implicitly");
  }
  if (!extensionTs.includes('new PkTreeItem(this.text("tabs.config"), "root-mcp"') || extensionTs.includes('new PkTreeItem("MCP", "root-mcp"')) {
    throw new Error("Localized Config navigation label is missing or regressed to MCP");
  }
  console.log("post-build: hljs CDN removed, panel.js syntax OK");
} catch (e) {
  console.error("post-build: PANEL SCRIPT ERROR —", e.message);
  process.exit(1);
}

// 3. Syntax-check the chat browser-view HTML (generated at runtime in chatroom.ts,
//    so it never reaches panel.html's check — a stray edit there kills the page).
try {
  const { browserViewHtml } = require(path.join(__dirname, "..", "dist", "chatroom.js"));
  const bv = browserViewHtml();
  const bvScripts = [...bv.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  for (const s of bvScripts) new vm.Script(s[1], { filename: "browser-view:inline" });
  console.log("post-build: browser-view script syntax OK");
} catch (e) {
  console.error("post-build: BROWSER-VIEW SCRIPT SYNTAX ERROR —", e.message);
  process.exit(1);
}


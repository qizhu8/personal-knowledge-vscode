const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("unverified connection observation is not a permanent global MCP failure banner", () => {
  const root = process.env.PKM_STABILITY_EXTENSION_ROOT || path.resolve(__dirname, "..");
  const source = fs.readFileSync(path.join(root, "src/webview/panel/50-mcp.js"), "utf8");
  const hidden = new Set(), text = { textContent:"" }, regenerate = {};
  const banner = { dataset:{}, classList:{ add:key => hidden.add(key), remove:key => hidden.delete(key) }, querySelector:() => regenerate };
  const strings = JSON.parse(fs.readFileSync(path.join(root, "resources/locales/en.json"), "utf8")).strings;
  const context = vm.createContext({ uiI18n:{resolved:"en"}, t:key=>strings[key]||key, vscode:{getState:()=>({})}, document:{ getElementById:id => id === "mcp-global-warning" ? banner : text } });
  vm.runInContext(fs.readFileSync(path.join(root, "src/webview/panel/06-help.js"), "utf8"), context);
  vm.runInContext(source + ";globalThis.update = updateGlobalMcpWarning", context);
  context.update({ installed:true, current:true, lifecycle:{ connectionState:"unverified", reason:"Connection not verified" } });
  assert(hidden.has("hidden"), "a prepared runtime with no client handshake is not a global error");
  assert.equal(text.textContent, "");
  context.update({ installed:false, current:false, expectedVersion:"2.0.0" });
  assert(!hidden.has("hidden"));
  assert.match(text.textContent, /missing/);
  context.update({ installed:true, current:false, installedVersion:"1.0.0", expectedVersion:"2.0.0" });
  assert(!hidden.has("hidden"));
  assert.match(text.textContent, /needs update/);
});

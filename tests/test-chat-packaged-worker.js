#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-packaged-worker-test-"));
try {
  const vsix = path.join(root, "extension.vsix");
  execFileSync("npx", ["vsce", "package", "--out", vsix], { cwd: path.join(__dirname, ".."), stdio: "ignore" });
  execFileSync("unzip", ["-q", vsix, "-d", root]);
  const extensionRoot = path.join(root, "extension");
  assert(!fs.existsSync(path.join(extensionRoot, "node_modules", "sql.js", "package.json")), "test must not rely on packaged sql.js node_modules resolution");
  assert(fs.existsSync(path.join(extensionRoot, "resources", "pkm-skills-router.md")), "VSIX must include the canonical PKM Skill Router seed");
  assert(fs.existsSync(path.join(extensionRoot, "dist", "pkm-skill-projection.js")), "VSIX must include the compiled Skill projection manager");
  const { ChatPersistence } = require(path.join(extensionRoot, "dist", "chat-persistence.js"));
  const persistence = new ChatPersistence(path.join(root, "rooms"), 50);
  persistence.openRoom("packaged-room-001", "Packaged Room")
    .then(result => {
      assert.deepStrictEqual(result, { messages: [], replayed: 0 });
      return persistence.dispose();
    })
    .then(() => console.log("packaged worker test: sql-wasm runtime resolves from extracted VSIX OK"))
    .catch(error => { console.error(error); process.exitCode = 1; });
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
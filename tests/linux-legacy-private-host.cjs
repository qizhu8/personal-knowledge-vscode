"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");

exports.run = async () => {
  const root = process.env.PKM_LEGACY_PRIVATE_ROOT;
  const readyPath = process.env.PKM_LEGACY_PRIVATE_READY;
  const releasePath = process.env.PKM_LEGACY_PRIVATE_RELEASE;
  const profile = process.env.PKM_LEGACY_PRIVATE_PROFILE;
  assert(root && readyPath && releasePath && profile);

  const extension = vscode.extensions.getExtension("uone.personal-knowledge");
  assert(extension, "The private profile did not load the legacy extension.");
  assert.equal(fs.realpathSync(extension.extensionPath), fs.realpathSync(process.env.PKM_LEGACY_PRIVATE_EXTENSION));
  const manifest = JSON.parse(fs.readFileSync(path.join(extension.extensionPath, "package.json"), "utf8"));
  assert.equal(manifest.version, "2.7.32");
  await extension.activate();

  const store = require(path.join(extension.extensionPath, "dist/filestore.js"));
  assert.equal(fs.realpathSync(store.getStorePath()), fs.realpathSync(root));

  const procStatus = fs.readFileSync("/proc/self/status", "utf8");
  const procStat = fs.readFileSync("/proc/self/stat", "utf8");
  const procCommand = fs.readFileSync("/proc/self/cmdline").toString("utf8").split("\0").filter(Boolean);
  const procClose = procStat.lastIndexOf(")");
  let serverPath;
  if (process.env.PKM_LEGACY_PRIVATE_GENERATE_MCP === "1") {
    const mcp = require(path.join(extension.extensionPath, "dist/mcp.js"));
    assert.equal(typeof mcp.generateMcpServer, "function");
    const vendor = path.join(extension.extensionPath, "resources", "vendor");
    const wheels = fs.readdirSync(vendor).filter(name => name.endsWith(".whl"))
      .map(name => path.join(vendor, name));
    process.env.PYTHONPATH = [process.env.PYTHONPATH, ...wheels].filter(Boolean).join(path.delimiter);
    mcp.generateMcpServer({ globalStorageUri: { fsPath: path.join(profile, "User", "globalStorage", "uone.personal-knowledge") } });
    serverPath = path.join(root, "mcp-server", "server.py");
    assert(fs.statSync(serverPath).isFile(), "The installed legacy extension did not generate its MCP server.");
  }

  fs.writeFileSync(readyPath, JSON.stringify({
    extensionHostPid: process.pid,
    uid: process.getuid(),
    procDirectoryUid: fs.statSync("/proc/self").uid,
    procStatusUid: /^Uid:\s+(.+)$/m.exec(procStatus)?.[1],
    procComm: procStat.slice(procStat.indexOf("(") + 1, procClose),
    procCommandSummary: procCommand.map(value => value.startsWith("--")
      ? value.replace(/=.*/, "=<value>") : path.basename(value)).slice(0, 20),
    typeArguments: process.argv.filter(value => /type|extensionhost/i.test(value)).slice(0, 4),
    extensionPath: extension.extensionPath,
    version: manifest.version,
    root: fs.realpathSync(root),
    ...(serverPath ? { serverPath } : {}),
  }), { flag: "wx", mode: 0o600 });

  while (!fs.existsSync(releasePath)) await new Promise(resolve => setTimeout(resolve, 50));
};

#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { isAbsoluteForPlatform, isForeignAbsolutePath, resolveMachineStorePath, extensionHostDescription } = require("../dist/store-path.js");

const existing = new Set(["/linux/store", "/linux/previous", "C:\\Users\\me\\knowledge"]);
const isDirectory = value => existing.has(value);

assert.strictEqual(isForeignAbsolutePath("C:\\Users\\me\\knowledge", "linux"), true);
assert.strictEqual(isForeignAbsolutePath("/home/me/knowledge", "win32"), true);
assert.strictEqual(isForeignAbsolutePath("/home/me/knowledge", "linux"), false);
assert.strictEqual(isForeignAbsolutePath("C:\\Users\\me\\knowledge", "win32"), false);
assert.strictEqual(isAbsoluteForPlatform("relative/path", "linux"), false);
assert.strictEqual(isAbsoluteForPlatform("C:\\PKM\\runtime", "win32"), true);
assert.strictEqual(isAbsoluteForPlatform("C:\\PKM\\runtime", "linux"), false);
assert.deepStrictEqual(resolveMachineStorePath({
  machinePath: "/linux/store", configuredPath: "C:\\Users\\me\\knowledge", previousPath: "/linux/previous",
}, isDirectory, "linux"), { path: "/linux/store", source: "machine", rejected: [] });
assert.deepStrictEqual(resolveMachineStorePath({
  configuredPath: "C:\\Users\\me\\knowledge", previousPath: "/linux/previous",
}, isDirectory, "linux"), { path: "/linux/previous", source: "previous", rejected: ["C:\\Users\\me\\knowledge"] });
assert.deepStrictEqual(resolveMachineStorePath({ configuredPath: "/linux/store" }, isDirectory, "linux"), {
  path: "/linux/store", source: "configuration", rejected: [],
});
assert.strictEqual(resolveMachineStorePath({ configuredPath: "D:\\Missing" }, () => false, "linux"), undefined);
assert.strictEqual(extensionHostDescription("win32", "DESKTOP-1"), "Local Windows machine DESKTOP-1");
assert.strictEqual(extensionHostDescription("linux", "gpu-01", "ssh-remote"), "Remote extension host gpu-01 (Linux, ssh-remote)");

const root = path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
assert.strictEqual(manifest.contributes.configuration.properties["personalKnowledge.storePath"].scope, "machine");
assert.strictEqual(manifest.contributes.configuration.properties["personalKnowledge.environmentsPath"].scope, "machine");
assert.strictEqual(manifest.contributes.configuration.properties["personalKnowledge.mcpPythonPath"].scope, "machine");
assert.strictEqual(manifest.contributes.configuration.properties["personalKnowledge.mcpRuntimePath"].scope, "machine");
assert.strictEqual(manifest.contributes.configuration.properties["personalKnowledge.mcpServerPath"].scope, "machine");
assert.strictEqual(manifest.contributes.configuration.properties["personalKnowledge.chatInviteHost"].scope, "machine");
for (const file of ["src/filestore.ts", "src/storage.ts"]) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  assert.doesNotMatch(source, /homedir\(\).*personal-knowledge/);
  assert.match(source, /let _store(?:Path)? = "";/);
}
const extension = fs.readFileSync(path.join(root, "src", "extension.ts"), "utf8");
assert.match(extension, /MACHINE_STORE_PATH_KEY = "machineStorePath\.v1"/);
assert.match(extension, /Use default  \(\$\{defaultPath\}\)/);
assert.match(extension, /This path stays on this extension host and is not copied by VS Code Settings Sync/);
assert.doesNotMatch(extension, /Use default  \(~\/personal-knowledge\)/);
assert.match(extension, /const activeStorePath = _storeReady \? getStorePath\(\) : ""/);
assert.match(extension, /Download synchronized knowledge into this machine-local root/);
assert.match(extension, /targetRoot = path\.resolve\(getStorePath\(\)\)/);
assert.match(extension, /Sync download cancelled before writing any files/);
assert.match(extension, /This directory stores migrated\/created conda, venv, and uv environments/);
assert.match(extension, /Existing environments will not be moved automatically/);
assert.match(extension, /It can grow very large/);
assert.match(extension, /Current disk usage:/);
assert.match(extension, /localAbsolutePathError\(value\)/);
const mcpSource = fs.readFileSync(path.join(root, "src", "mcp.ts"), "utf8");
assert.match(mcpSource, /export function managedMcpRuntimePath/);
assert.match(mcpSource, /export function managedMcpServerDirectory/);
assert.match(mcpSource, /isAbsoluteForPlatform\(configured\) && !isForeignAbsolutePath\(configured\)/);
assert.match(mcpSource, /const runtimeName = path\.basename\(runtimePath\)/);
assert.match(extension, /function safeMcpRuntimeTarget\(directory: string\)/);
assert.match(extension, /function safeMcpServerTarget\(directory: string\)/);
assert.match(extension, /Choose an empty directory or an existing PKM-managed runtime/);
assert.match(extension, /Choose an empty directory or an existing PKM-generated server directory/);

console.log("machine store path test: machine scope, cross-OS rejection, reinstall recovery, host-aware setup, no fallback, and Sync target confirmation OK");

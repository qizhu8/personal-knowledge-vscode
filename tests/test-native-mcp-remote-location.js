#!/usr/bin/env node
const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.join(__dirname, "..");
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-native-mcp-location-"));
const compiled = path.join(fixture, "mcp-native-location.js");
childProcess.execFileSync("npx", [
  "esbuild",
  path.join(root, "src", "mcp-native-location.ts"),
  "--bundle",
  "--platform=node",
  "--format=cjs",
  `--outfile=${compiled}`,
], { cwd: root, stdio: "ignore" });

const { nativeMcpCwdUri } = require(compiled);

class TestUri {
  constructor(scheme, authority, uriPath) {
    this.scheme = scheme;
    this.authority = authority;
    this.path = uriPath;
  }

  with(change) {
    return new TestUri(
      change.scheme ?? this.scheme,
      change.authority ?? this.authority,
      this.path,
    );
  }
}

const fileUri = value => new TestUri("file", "", value.replace(/\\/g, "/"));
const localExtension = new TestUri("file", "", "/home/person/.vscode/extensions/pkm");
const localCwd = nativeMcpCwdUri(localExtension, "/home/person/pkm/mcp-server", fileUri);
assert.deepStrictEqual(
  { scheme: localCwd.scheme, authority: localCwd.authority, path: localCwd.path },
  { scheme: "file", authority: "", path: "/home/person/pkm/mcp-server" },
  "local MCP definitions must retain a local file URI",
);

const remoteExtension = new TestUri(
  "vscode-remote",
  "ssh-remote+build-host",
  "/home/person/.vscode-server/extensions/pkm",
);
const remoteCwd = nativeMcpCwdUri(remoteExtension, "/home/person/pkm/mcp-server", fileUri);
assert.deepStrictEqual(
  { scheme: remoteCwd.scheme, authority: remoteCwd.authority, path: remoteCwd.path },
  {
    scheme: "vscode-remote",
    authority: "ssh-remote+build-host",
    path: "/home/person/pkm/mcp-server",
  },
  "remote MCP definitions must launch on the extension host instead of the local UI machine",
);

const extensionSource = fs.readFileSync(path.join(root, "src", "extension.ts"), "utf8");
assert.match(
  extensionSource,
  /definition\.cwd = nativeMcpCwdUri\(context\.extensionUri, data\.cwd, vscode\.Uri\.file\)/,
  "the native MCP provider must route cwd through the remote-aware helper",
);
assert.doesNotMatch(
  extensionSource,
  /definition\.cwd = vscode\.Uri\.file\(data\.cwd\)/,
  "the native MCP provider must not erase the remote extension-host authority",
);

fs.rmSync(fixture, { recursive: true, force: true });
console.log("native MCP remote location tests passed");

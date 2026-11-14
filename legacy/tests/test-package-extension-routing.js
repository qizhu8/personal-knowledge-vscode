const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

test("default packaging still invokes the stable VSIX builder and verifier", () => {
  const script = `
    const cp = require("node:child_process"), path = require("node:path");
    const Module = require("node:module"), load = Module._load;
    const calls = [];
    Module._load = function(request, ...args) {
      if (request === "./next-rehearsal-runtime") return { stage(output, options) {
        require("node:assert/strict").deepEqual(options, { production: true });
        require("node:assert/strict").equal(output, path.join(process.cwd(), "next-runtime"));
      }};
      if (request === "fs") return { rmSync() {} };
      return load.call(this, request, ...args);
    };
    cp.spawnSync = (command, args, options) => {
      calls.push({ command, args, prebuilt: options.env.PKM_PACKAGE_PREBUILT });
      return { status: 0 };
    };
    delete process.env.PKM_PACKAGE_NEXT_REHEARSAL;
    process.argv = [process.execPath, "package-extension.js", "--prebuilt"];
    require("./scripts/package-extension.js");
    const assert = require("node:assert/strict");
    const version = require("./package.json").version;
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].args, ["vsce", "package", "--out", path.join(process.cwd(), "personal-knowledge-" + version + ".vsix")]);
    assert.deepEqual(calls[1].args, [path.join(process.cwd(), "scripts", "verify-vsix-package.js"),
      path.join(process.cwd(), "personal-knowledge-" + version + ".vsix"), version, "stable"]);
    assert.equal(calls[0].prebuilt, "1");
    assert.equal(calls[1].prebuilt, "1");
  `;
  const result = spawnSync(process.execPath, ["-e", script], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("direct prepublish without the staged payload fails closed", () => {
  const env = { ...process.env };
  delete env.PKM_PACKAGE_NEXT_PAYLOAD_STAGED;
  const result = spawnSync(process.execPath, ["scripts/vscode-prepublish.js"], { cwd: root, env, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing next-server payload/);
});

test("installed VSIX acceptance cannot be combined with prepare-only", () => {
  const result = spawnSync(process.execPath, ["scripts/run-next-trial-electron-test.js",
    "--installed-vsix", "--prepare-only"], { cwd: root, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage:/);
});

"use strict";
const fs = require("node:fs"), path = require("node:path"), { createHash } = require("node:crypto");
const assert = require("node:assert/strict");
const hash = value => createHash("sha256").update(value).digest("hex");
function privateFile(file) {
  const before = fs.lstatSync(file);
  assert(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size <= 65_536
    && (before.mode & 0o077) === 0 && before.uid === process.getuid());
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd);
    assert.equal(before.dev, after.dev); assert.equal(before.ino, after.ino);
    assert.equal(before.mtimeMs, after.mtimeMs); assert.equal(before.ctimeMs, after.ctimeMs);
    return bytes;
  } finally { fs.closeSync(fd); }
}
function create({ fixture, nonce, actorId, recipeId, executableDigest, definition, inputSha256, canonicalJson, onHeld, allowNativeCopies = false }) {
  assert.equal(fs.realpathSync(fixture), fixture);
  assert.equal(privateFile(path.join(fixture, "native-ui-fixture-token")).toString(), nonce);
  const workspace = path.join(fixture, "workspace");
  assert.equal(fs.realpathSync(workspace), workspace);
  const effects = path.join(fixture, "native-recipe-effects.jsonl");
  const adapter = {
    id: "synthetic-fixed-local-recipe", version: 1,
    outputContractDigest: hash("fixed SHA256 output v1"), authorizationDigest: hash(canonicalJson(definition)),
    authorizeDefinition: value => value.actorId === actorId && value.executableDigest === executableDigest
      && (value.source?.recipeId === recipeId || allowNativeCopies && /^recipe_[a-f0-9-]{36}$/.test(value.source?.recipeId))
      && definition.spec.nodes.some(node => canonicalJson(value.node) === canonicalJson(node)),
    authorizeData: value => Object.keys(value.inputs).length === 1 && ["complete", "cancel", "crash"].includes(value.inputs.mode),
    validateOutput: outputs => Object.keys(outputs).length === 1 && outputs.sha256 === inputSha256,
    async execute(invocation, { signal }) {
      assert.equal(privateFile(path.join(fixture, "native-ui-fixture-token")).toString(), nonce);
      assert.equal(fs.realpathSync(workspace), workspace);
      const sha256 = hash(privateFile(path.join(workspace, "recipe-input.txt")));
      assert.equal(sha256, inputSha256);
      if (signal.aborted) throw new Error("Trusted fixture execution was fenced before dispatch.");
      if (invocation.node.nodeId === "record") {
        if (invocation.inputs.mode !== "cancel") {
          const fd = fs.openSync(effects, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT
            | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
          try {
            const stat = fs.fstatSync(fd);
            assert(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid()
              && (stat.mode & 0o077) === 0 && stat.size <= 65_536);
            fs.writeSync(fd, JSON.stringify({ runId: invocation.runId, invocationId: invocation.invocationId, sha256 }) + "\n");
            fs.fsyncSync(fd);
          } finally { fs.closeSync(fd); }
        }
        if (invocation.inputs.mode !== "complete") {
          onHeld?.({ runId: invocation.runId, mode: invocation.inputs.mode, leaseExpiresAt: invocation.deadline });
          await new Promise(resolve => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", resolve, { once: true });
          });
          return { status: "unknown", outputs: { sha256 } };
        }
      }
      return { status: "succeeded", outputs: { sha256 } };
    },
  };
  return { adapters: { "pkm.step.noop/v1": adapter }, effects };
}
module.exports = { create };

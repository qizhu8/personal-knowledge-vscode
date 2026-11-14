"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

exports.options = ({ fixture, root, nonce, workspaceId }) => {
  assert.equal(fs.realpathSync(root), root);
  assert.equal(path.dirname(root), fs.realpathSync(fixture));
  assert.equal(fs.readFileSync(path.join(fixture, "in-place-fixture-token"), "utf8"), nonce);
  const authorityId = "installed-synthetic-root-adoption";
  const allowedTools = ["knowledge_snapshot_status"];
  const stat = fs.statSync(root, { bigint: true });
  const rootPin = `${stat.dev}:${stat.ino}`;
  return {
    snapshotAdmission: {
      authorityId, allowedTools,
      authorize: binding => typeof workspaceId === "string" && binding.workspaceId === workspaceId
        && binding.workspaceRoot === root && binding.actorId === "mcp:external"
        && binding.authorityId === authorityId && binding.operation === "admit"
        && binding.privateGitRoot === path.join(root, "packages/knowledge-snapshots/repository.git")
        && JSON.stringify([...binding.allowedTools].sort()) === JSON.stringify([...allowedTools].sort())
        && (binding.rootPin === undefined || binding.rootPin === rootPin),
    },
  };
};

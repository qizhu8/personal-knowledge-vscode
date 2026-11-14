"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { pathToFileURL } = require("node:url"), { DatabaseSync } = require("node:sqlite");
async function main() {
  const [fixture, root, target, nonce, workspaceId] = process.argv.slice(2);
  assert.equal(process.env.PKM_PRIVATE_UI_ROOT_CRASH, nonce);
  const options = require("./in-place-options.cjs").options({ fixture, root, nonce, workspaceId });
  const { resumeLegacyRootAdoptionExperimental } = await import(pathToFileURL(path.join(target, "next-runtime/server/dist/legacy-root-adoption.js")).href);
  options.acquireWriterQuiescence = async () => ({
    assertHeld() {
      assert.equal(fs.readFileSync(path.join(fixture, "in-place-fixture-token"), "utf8"), nonce);
      const file = path.join(root, "core.sqlite"), commitExists = fs.existsSync(path.join(root, ".pkm-next-root-adoption.commit.json"));
      if (!fs.existsSync(file) || commitExists) return;
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='legacy_ui_bootstrap_compatibility'").get()) return;
        const row = db.prepare("SELECT workspace_id,payload_sha256 FROM legacy_ui_bootstrap_compatibility").get();
        if (!row) return;
        assert.equal(row.workspace_id, workspaceId);
        const journal = JSON.parse(fs.readFileSync(path.join(root, ".pkm-next-root-adoption.json"), "utf8"));
        if (journal.todoProjection) {
          const todo = db.prepare("SELECT workspace_id,payload_sha256 FROM legacy_todo_root_projection").get();
          assert.equal(todo.workspace_id, workspaceId);
          for (const board of journal.todoProjection.boards)
            assert.deepEqual(fs.readFileSync(path.join(root, board.destination)), fs.readFileSync(path.join(root, board.source)));
        }
        fs.writeFileSync(path.join(fixture, "ui-root-crash-evidence.json"),
          JSON.stringify({ workspaceId, commitExists, payloadSha256: row.payload_sha256 }), { flag: "wx", mode: 0o600 });
        process.exit(80);
      } finally { db.close(); }
    },
    release() {},
  });
  const result = await resumeLegacyRootAdoptionExperimental(root, options);
  await result.storage.close();
  throw new Error("The explicitly armed root-adoption crash point was not reached.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });

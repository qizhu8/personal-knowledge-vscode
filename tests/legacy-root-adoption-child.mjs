import assert from "node:assert/strict";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { scanMarkdown } from "../dist/markdown.js";
import { legacyKnowledgeWrite } from "../dist/legacy-knowledge-write.js";
import { resumeLegacyRootAdoptionExperimental } from "../dist/legacy-root-adoption.js";

const root = process.argv[2];
const actor = { id: "synthetic-root-owner", canWrite: true };
const quiescence = { assertHeld() {}, release() {} };
const adopted = await resumeLegacyRootAdoptionExperimental(root, {
  acquireWriterQuiescence: async () => quiescence,
});
let native;
try {
  native = await createNativeRuntime({ storage: adopted.storage });
  const readBefore = await native.core.dispatch("capability_read", {
    operation: "knowledge.note.get", version: 1, arguments: { id: "synthetic-note" },
  }, actor);
  assert.equal(readBefore.error, undefined, JSON.stringify(readBefore));
  assert.equal(readBefore.result.item.content, "Original synthetic content.\n");

  const updated = await legacyKnowledgeWrite(native.core, adopted.storage, actor, {
    tool: "update_note",
    arguments: { slug: "Existing", content: "Updated by the restarted synthetic server.\n" },
  });
  assert.deepEqual(JSON.parse(updated.text), { ok: true, slug: "Existing" });
  const record = scanMarkdown(root).find(item => item.record.id === "synthetic-note");
  assert.equal(record.record.content, "Updated by the restarted synthetic server.\n");
  console.log(JSON.stringify({
    qualification: adopted.qualification,
    workspaceId: adopted.workspaceId,
    sourceFingerprint: adopted.sourceFingerprint,
    readBefore: readBefore.result.item.content,
    updated: { revision: record.record.revision },
  }));
} finally {
  await native?.close();
  await adopted.storage.close();
}

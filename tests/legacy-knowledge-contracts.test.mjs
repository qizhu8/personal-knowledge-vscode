import { test } from "node:test";
import assert from "node:assert";
import * as contracts from "../dist/domain/knowledge-contracts.js";

test("original Knowledge identity, aliases and pinned/floating link contract assertions", () => {
const first = contracts.nextKnowledgeIdentity(
  undefined,
  "note",
  "Project/Original",
  "Project/Original",
  () => "knowledge_0123456789abcdef01234567",
);
assert.deepStrictEqual(first, {
  schema: "pkm.knowledge/v1",
  knowledgeId: "knowledge_0123456789abcdef01234567",
  revision: 1,
  aliases: ["note:Project/Original"],
});
const moved = contracts.nextKnowledgeIdentity(first, "note", "Project/Original", "Archive/Renamed");
assert.strictEqual(moved.knowledgeId, first.knowledgeId);
assert.strictEqual(moved.revision, 2);
assert.deepStrictEqual(moved.aliases, ["note:Archive/Renamed", "note:Project/Original"]);
assert.strictEqual(contracts.compileKnowledgeIdentityV1(moved).ok, true);
assert.strictEqual(contracts.compileKnowledgeIdentityV1({ ...moved, revision: 0 }).ok, false);
assert.throws(() => contracts.legacyKnowledgeAlias("note", "../\u0000"), /control characters/);
assert.strictEqual(contracts.compileKnowledgeLinksV1([{
  relation: "supports",
  target: "pkm://knowledge/knowledge_0123456789abcdef01234567",
  mode: "pinned",
  required: true,
  targetRevision: "7",
}]).ok, true);
assert.strictEqual(contracts.compileKnowledgeLinksV1([{
  relation: "supports",
  target: "notes/Project/Original",
  mode: "floating",
  required: true,
}]).ok, false);
assert.strictEqual(contracts.compileKnowledgeLinksV1([{
  relation: "supports",
  target: "pkm://knowledge/knowledge_0123456789abcdef01234567",
  mode: "pinned",
  required: true,
}]).ok, false);
assert.deepStrictEqual(contracts.validateKnowledgeIdentitySet([
  moved,
  { ...moved, aliases: ["note:Other"] },
  { ...first, knowledgeId: "knowledge_aaaaaaaaaaaaaaaaaaaaaaaa", aliases: moved.aliases },
]).map(item => item.code).sort(), ["alias-collision", "alias-collision", "duplicate-knowledge-id"]);
});

#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const contracts = require("../dist/knowledge-contracts.js");
const store = require("../dist/filestore.js");

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

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-knowledge-contracts-"));
try {
  store.setStorePath(root);
  store.noteUpsert({
    slug: "Project/Original", title: "Original", content: "body", type: "general", tags: [], category: "Project",
    links: [{
      relation: "supports",
      target: "pkm://knowledge/knowledge_aaaaaaaaaaaaaaaaaaaaaaaa",
      mode: "floating",
      required: false,
    }],
  });
  const originalNote = store.noteGet("Project/Original");
  assert.match(originalNote.knowledgeId, /^knowledge_[a-f0-9]{24}$/);
  assert.strictEqual(originalNote.revision, 1);
  assert.strictEqual(originalNote.links[0].relation, "supports");
  store.noteUpsert({
    slug: originalNote.slug, title: "Renamed", content: "body 2", type: "general", tags: [], category: "Archive",
  });
  const renamedNote = store.noteGet("Archive/Renamed");
  assert.strictEqual(renamedNote.knowledgeId, originalNote.knowledgeId);
  assert.strictEqual(renamedNote.revision, 2);
  assert.deepStrictEqual(renamedNote.aliases, ["note:Archive/Renamed", "note:Project/Original"]);
  assert.strictEqual(renamedNote.links[0].target, "pkm://knowledge/knowledge_aaaaaaaaaaaaaaaaaaaaaaaa");
  assert.throws(() => store.noteUpsert({
    slug: renamedNote.slug, title: "Invalid Link", content: "body", type: "general", tags: [], category: "Archive",
    links: [{ relation: "supports", target: "relative/path", mode: "floating", required: false }],
  }), /Invalid Knowledge links/);

  store.skillUpsert({ name: "Stable Skill", content: "v1", category: "One" });
  const originalSkill = store.skillGet("Stable Skill");
  store.skillUpsert({ name: "Stable Skill", content: "v2", category: "Two" });
  const movedSkill = store.skillGet("Stable Skill");
  assert.strictEqual(movedSkill.knowledgeId, originalSkill.knowledgeId);
  assert.deepStrictEqual(movedSkill.aliases, ["skill:One/Stable Skill", "skill:Two/Stable Skill"]);

  store.paperUpsert({ slug: "Topic/Original Research", title: "Original Research", content: "v1", category: "Topic" });
  const originalResearch = store.paperGet("Topic/Original Research");
  store.paperUpsert({ slug: originalResearch.slug, title: "Moved Research", content: "v2", category: "Archive" });
  const movedResearch = store.paperGet("Archive/Moved Research");
  assert.strictEqual(movedResearch.knowledgeId, originalResearch.knowledgeId);
  assert.deepStrictEqual(movedResearch.aliases, ["research:Archive/Moved Research", "research:Topic/Original Research"]);

  console.log("Knowledge contracts: stable IDs, revisions, aliases, Note/Skill/Research moves OK");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

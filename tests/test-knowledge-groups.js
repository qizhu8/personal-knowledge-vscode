#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const groups = require("../dist/knowledge-groups");
const filestore = require("../dist/filestore");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-knowledge-groups-"));
groups.setKnowledgeGroupStoreRoot(root);

let snapshot = groups.knowledgeGroupSnapshot("skills", ["Coding/TypeScript", "Ads"]);
assert.deepStrictEqual(snapshot.groups.map(group => group.id), ["default", "unnamed"]);
assert.deepStrictEqual(snapshot.assignments, { Coding: "default", Ads: "default" });

snapshot = groups.knowledgeGroupCreate("skills", "Engineering", "#336699");
const engineering = snapshot.groups.find(group => group.name === "Engineering");
assert(engineering);
snapshot = groups.knowledgeGroupAssign("skills", "Coding/Nested", engineering.id);
assert.strictEqual(snapshot.assignments.Coding, engineering.id, "only the top-level folder is assigned");

snapshot = groups.knowledgeGroupRename("skills", engineering.id, "Development");
assert.strictEqual(snapshot.groups.find(group => group.id === engineering.id).name, "Development");
snapshot = groups.knowledgeGroupSetColor("skills", engineering.id, "#ABCDEF");
assert.strictEqual(snapshot.groups.find(group => group.id === engineering.id).color, "#abcdef");
groups.knowledgeGroupFolderRenamed("skills", "Coding", "Development/Coding");
snapshot = groups.knowledgeGroupSnapshot("skills", ["Development/Coding", "Ads"]);
assert.strictEqual(snapshot.assignments.Development, engineering.id, "a renamed top-level folder keeps its visual Group");

snapshot = groups.knowledgeGroupDelete("skills", engineering.id);
assert.strictEqual(snapshot.assignments.Development, "unnamed", "deleting a visual Group must not remove its folder");
assert.throws(() => groups.knowledgeGroupDelete("skills", "unnamed"), /cannot be deleted/);
assert.throws(() => groups.knowledgeGroupDelete("skills", "default"), /cannot be deleted/);

snapshot = groups.knowledgeGroupSnapshot("papers", ["MyIdeas/Research", "Published"]);
assert.strictEqual(snapshot.assignments.MyIdeas, "my-ideas");
assert(snapshot.pinnedFolders.includes("MyIdeas"));
assert.strictEqual(snapshot.assignments.Published, "default");
assert(fs.existsSync(path.join(root, ".pkm", "knowledge-groups.json")));

filestore.setStorePath(root);
filestore.paperUpsert({
  slug: "Research/Test Idea",
  title: "Test Idea",
  category: "Research",
  kind: "idea",
  group: "MyIdeas",
  content: "idea body",
});
filestore.paperUpsert({
  slug: "Published/Citing Paper",
  title: "Citing Paper",
  category: "Published",
  cites: [{ paper: "Research/Test Idea", note: "builds on" }],
  content: "paper body",
});
let migration = filestore.migrateLegacyMyIdeasFolder();
assert.deepStrictEqual(migration, { moved: 1, updatedReferences: 1 });
assert.strictEqual(filestore.paperGet("Research/Test Idea"), null);
assert.strictEqual(filestore.paperGet("MyIdeas/Research/Test Idea").group, "Papers");
assert.strictEqual(filestore.paperGet("Published/Citing Paper").cites[0].paper, "MyIdeas/Research/Test Idea");
migration = filestore.migrateLegacyMyIdeasFolder();
assert.deepStrictEqual(migration, { moved: 0, updatedReferences: 0 }, "migration must be idempotent");

filestore.paperUpsert({
  slug: "Interrupted/Recovered Idea",
  title: "Recovered Idea",
  category: "Interrupted",
  kind: "idea",
  group: "MyIdeas",
  cites: [],
  content: "same user-authored body",
});
filestore.paperUpsert({
  slug: "MyIdeas/Interrupted/Recovered Idea",
  title: "Recovered Idea",
  category: "MyIdeas/Interrupted",
  kind: "idea",
  content: "same user-authored body",
});
migration = filestore.migrateLegacyMyIdeasFolder();
assert.deepStrictEqual(migration, { moved: 1, updatedReferences: 0 });
assert.strictEqual(filestore.paperGet("Interrupted/Recovered Idea"), null,
  "an interrupted migration must retire an equivalent legacy source");
assert(filestore.paperGet("MyIdeas/Interrupted/Recovered Idea"),
  "an interrupted migration must preserve the canonical destination");

filestore.paperUpsert({
  slug: "Interrupted/Diverged Idea",
  title: "Diverged Idea",
  category: "Interrupted",
  kind: "idea",
  group: "MyIdeas",
  content: "source body",
});
filestore.paperUpsert({
  slug: "MyIdeas/Interrupted/Diverged Idea",
  title: "Diverged Idea",
  category: "MyIdeas/Interrupted",
  kind: "idea",
  content: "different destination body",
});
assert.throws(() => filestore.migrateLegacyMyIdeasFolder(), /destination contains different content/,
  "migration must never discard a divergent source");

fs.rmSync(root, { recursive: true, force: true });
console.log("knowledge groups test: visual grouping and idempotent MyIdeas migration OK");

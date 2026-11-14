"use strict";
const fs = require("node:fs"), path = require("node:path"), { createHash, randomUUID } = require("node:crypto");
exports.prepare = ({ extension, root, fixture }) => {
  const file = path.join(fixture, "original-recipe-evidence.json");
  const evidence = JSON.parse(fs.readFileSync(file));
  const note = { title: "Bound", type: "general", category: "", tags: [], content: "SATURN installed bound Note.\n" };
  const skill = { name: "Proof", description: "", category: "Testing", tags: [], content: "SATURN installed bound Skill.\n" };
  const hash = value => createHash("sha256").update(JSON.stringify(Object.fromEntries(
    Object.keys(value).sort().map(key => [key, value[key]])))).digest("hex");
  fs.mkdirSync(path.join(root, "notes"), { recursive: true });
  fs.mkdirSync(path.join(root, "skills/Testing"), { recursive: true });
  fs.writeFileSync(path.join(root, "notes/Bound.md"), "---\ntitle: Bound\ntype: general\ntags: []\n---\n" + note.content, { flag: "wx", mode: 0o600 });
  fs.writeFileSync(path.join(root, "skills/Testing/Proof.md"), "---\nname: Proof\ndescription: \"\"\ntags: []\n---\n" + skill.content, { flag: "wx", mode: 0o600 });
  const { ProjectStore } = require(path.join(extension, "dist/workflows/project-store.js"));
  const store = new ProjectStore(path.join(root, ".pkm/state"));
  store.updateRecipe({ commandId: randomUUID(), fingerprint: randomUUID(), expectedStoreVersion: store.list().storeVersion },
    evidence.recipeId, { name: evidence.recipe.name, category: evidence.recipe.category,
      description: evidence.recipe.description, definition: evidence.definition, nodeBindings: [{ nodeId: "inspect", bindings: [
        { bindingId: "note", kind: "note", knowledgeId: "Bound", contentHash: hash(note), usage: "reference" },
        { bindingId: "skill", kind: "skill", knowledgeId: "Testing/Proof", contentHash: hash(skill), usage: "required" },
      ] }] });
  evidence.recipe = store.list().recipes.find(item => item.recipeId === evidence.recipeId);
  evidence.recipeRevision = evidence.recipe.revision;
  fs.writeFileSync(file, JSON.stringify(evidence), { mode: 0o600 });
  return { recipeId: evidence.recipeId, note, skill };
};

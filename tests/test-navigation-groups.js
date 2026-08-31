#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.join(__dirname, "..");
const { setStorePath, folderCreate, folderList, folderRename, folderDeletePromote } = require("../dist/filestore.js");
const promptStorage = require("../dist/storage.js");
const store = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-navigation-groups-"));

try {
  setStorePath(store);
  promptStorage.setStorePath(store);
  for (const area of ["skills", "notes", "papers", "prompts", "scripts"]) {
    assert.strictEqual(folderCreate(area, "Top/Middle/Leaf"), true, `${area} must support multi-level group creation`);
    assert.ok(folderList(area).includes("Top/Middle/Leaf"), `${area} nested group must be listed`);
  }
  const promptVersion = promptStorage.promptList().find(row => row.project === "Top" && row.task === "Middle")?.versions.find(version => version.version === "Leaf");
  assert.deepStrictEqual(promptVersion?.files, [], "Prompt .gitkeep must not appear as a Prompt file");
  const promptLeaf = path.join(store, "prompts", "Top", "Middle", "Leaf");
  fs.writeFileSync(path.join(promptLeaf, "prompt.md"), "prompt");
  assert.deepStrictEqual(folderDeletePromote("prompts", "Top/Middle/Leaf", "Ungrouped"), { ok: true, moved: 1 });
  assert.ok(fs.existsSync(path.join(store, "prompts", "Top", "Middle", "Ungrouped", "prompt.md")), "Prompt delete must preserve hierarchy depth and files");

  const noteLeaf = path.join(store, "notes", "Top", "Middle", "Leaf");
  fs.writeFileSync(path.join(noteLeaf, "item.md"), "content");
  assert.deepStrictEqual(folderRename("notes", "Top/Middle", "Top/Renamed"), { ok: true });
  assert.ok(fs.existsSync(path.join(store, "notes", "Top", "Renamed", "Leaf", "item.md")));
  assert.deepStrictEqual(folderDeletePromote("notes", "Top/Renamed"), { ok: true, moved: 1 });
  assert.ok(fs.existsSync(path.join(store, "notes", "Top", "Leaf", "item.md")), "delete must promote contents without deleting files");

  assert.strictEqual(folderCreate("skills", "Collision/Child"), true);
  fs.writeFileSync(path.join(store, "skills", "Collision", "Child", "same.md"), "child");
  fs.writeFileSync(path.join(store, "skills", "Collision", "same.md"), "parent");
  const collision = folderDeletePromote("skills", "Collision/Child");
  assert.strictEqual(collision.ok, false);
  assert.match(collision.error, /already exists/);
  assert.ok(fs.existsSync(path.join(store, "skills", "Collision", "Child", "same.md")), "collision rejection must leave source unchanged");

  const extension = fs.readFileSync(path.join(root, "src", "extension.ts"), "utf8");
  const manifest = fs.readFileSync(path.join(root, "package.json"), "utf8");
  const packageJson = JSON.parse(manifest);
  for (const command of ["newSubgroup", "renameSubgroup", "deleteSubgroup"]) {
    assert.match(extension, new RegExp(`personalKnowledge\\.${command}`));
    assert.match(manifest, new RegExp(`personalKnowledge\\.${command}`));
  }
  for (const area of ["skills", "notes", "papers", "prompts", "scripts"]) {
    assert.match(extension, new RegExp(`pk-${area}-root|['\"]${area === "prompts" ? "root-prompts" : `root-${area}`}['\"]`));
    assert.match(manifest, new RegExp(`pk-\\(skills\\|notes\\|papers\\|prompts\\|scripts\\)`));
  }
  assert.match(extension, /slash-separated paths create multiple levels/);
  assert.match(extension, /Prompts support three group levels/);
  assert.match(extension, /folderDeletePromote\(group\.area, group\.path, fallback\)/);
  assert.match(extension, /"skill-folder": "skills", "note-folder": "notes", "paper-folder": "papers", "script-folder": "scripts"/);
  const commandTitles = Object.fromEntries(packageJson.contributes.commands.map(command => [command.command, command.title]));
  assert.strictEqual(commandTitles["personalKnowledge.newSubgroup"], "New Subgroup…");
  assert.strictEqual(commandTitles["personalKnowledge.renameSubgroup"], "Rename Subgroup…");
  assert.strictEqual(commandTitles["personalKnowledge.deleteSubgroup"], "Delete Subgroup…");
  const subgroupMenus = packageJson.contributes.menus["view/item/context"].filter(menu => ["personalKnowledge.newSubgroup", "personalKnowledge.renameSubgroup", "personalKnowledge.deleteSubgroup"].includes(menu.command));
  assert.strictEqual(subgroupMenus.length, 3);
  assert.match(subgroupMenus.find(menu => menu.command === "personalKnowledge.newSubgroup").when, /skills\|notes\|papers\|prompts\|scripts/);
  assert.doesNotMatch(subgroupMenus.find(menu => menu.command === "personalKnowledge.newSubgroup").when, /terminal-group/);
  assert.match(subgroupMenus.find(menu => menu.command === "personalKnowledge.renameSubgroup").when, /terminal-group/);
  assert.match(subgroupMenus.find(menu => menu.command === "personalKnowledge.deleteSubgroup").when, /terminal-group/);

  console.log("navigation groups test: multi-level create, rename, safe promote-delete, collision protection, and unified menus OK");
} finally {
  fs.rmSync(store, { recursive: true, force: true });
}

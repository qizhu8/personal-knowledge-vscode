#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.join(__dirname, "..");
const { setStorePath, folderCreate, folderList, folderRename, folderDeletePromote } = require("../dist/filestore.js");
const extensionSource = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");

assert.match(extensionSource, /let gitCommitQueue = Promise\.resolve\(\)/,
  "automatic Git commits must be serialized without blocking the extension host");
assert.match(extensionSource, /execFile\("git", args/);
assert.doesNotMatch(extensionSource, /function gitCommit\(msg: string\): void \{[\s\S]{0,500}execSync/,
  "folder UI refresh must not wait for synchronous git add/commit");
assert.match(extensionSource, /case "folderCreate"[\s\S]{0,900}_treeProvider\?\.refresh\(\)[\s\S]{0,500}respond\(\{ command: "list"/,
  "folder creation must refresh navigation and category trees in the same request");
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

  const transientFolder = path.join(store, "papers", "Generative Retrieval");
  fs.mkdirSync(transientFolder, { recursive: true });
  fs.writeFileSync(path.join(transientFolder, "paper.md"), "paper");
  let removeAttempts = 0;
  const transient = folderDeletePromote("papers", "Generative Retrieval", "", {
    remove(folder) {
      removeAttempts++;
      if (removeAttempts < 3) {
        const error = new Error("OneDrive is synchronizing the folder");
        error.code = "EPERM";
        throw error;
      }
      fs.rmSync(folder, { recursive: true, force: true });
    },
    sleep() {},
  });
  assert.deepStrictEqual(transient, { ok: true, moved: 1 });
  assert.strictEqual(removeAttempts, 3, "transient Windows EPERM must be retried");
  assert.ok(fs.existsSync(path.join(store, "papers", "paper.md")), "successful retry must preserve promoted content");

  const lockedFolder = path.join(store, "papers", "Locked");
  fs.mkdirSync(lockedFolder, { recursive: true });
  fs.writeFileSync(path.join(lockedFolder, "locked.md"), "locked");
  let persistentAttempts = 0;
  const persistent = folderDeletePromote("papers", "Locked", "", {
    remove() {
      persistentAttempts++;
      const error = new Error("OneDrive still owns the directory");
      error.code = "EPERM";
      throw error;
    },
    sleep() {},
  });
  assert.strictEqual(persistent.ok, false);
  assert.strictEqual(persistent.moved, 0);
  assert.strictEqual(persistentAttempts, 8, "persistent Windows EPERM must use the bounded retry budget");
  assert.match(persistent.error, /contents were restored/);
  assert.ok(fs.existsSync(path.join(lockedFolder, "locked.md")), "persistent failure must roll promoted content back");
  assert.strictEqual(fs.existsSync(path.join(store, "papers", "locked.md")), false, "rollback must not leave a duplicate in the destination");

  const nestedPaperFolder = path.join(store, "papers", "Parent", "Child");
  fs.mkdirSync(nestedPaperFolder, { recursive: true });
  fs.writeFileSync(path.join(nestedPaperFolder, "nested.md"), "nested");
  assert.deepStrictEqual(folderDeletePromote("papers", "Parent/Child"), { ok: true, moved: 1 });
  assert.ok(fs.existsSync(path.join(store, "papers", "Parent", "nested.md")), "nested Research delete must promote to its direct parent without duplicating the path");

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
  assert.doesNotMatch(extension, /_maxDepth|maxTreeDepth|folderSegs = e\.path\.slice/, "generic Navigation trees must preserve every hierarchy level");
  assert.match(extension, /for \(const seg of e\.path\)/, "Navigation path construction must traverse the complete path");
  assert.match(extension, /for \(const segment of folder\.split\("\/"\)\.filter\(Boolean\)\)/, "empty deep folders must preserve every hierarchy level");
  assert.strictEqual(packageJson.contributes.configuration.properties["personalKnowledge.maxTreeDepth"], undefined);
  assert.match(extension, /item\.description = relativePath\.split\("\/"\)\.pop\(\) \|\| relativePath/, "Navigation Notes must display the real filename beside the frontmatter title");
  assert.match(extension, /item\.tooltip = `\$\{n\.title\}\\nnotes\/\$\{relativePath\}`/, "Navigation Notes must expose their full relative path");
  assert.match(extension, /Prompts support three group levels/);
  assert.match(extension, /folderDeletePromote\(group\.area, group\.path, fallback\)/);
  assert.match(extension, /folderDeletePromote\("papers", folderPath\)/,
    "Research webview folder deletion must promote directly to the parent folder");
  assert.match(extension, /"skill-folder": "skills", "note-folder": "notes", "paper-folder": "papers", "script-folder": "scripts"/);
  for (const module of ["knowledge", "tools", "automation", "projects", "settings"]) {
    assert.match(extension, new RegExp(`new PkTreeItem\\("${module[0].toUpperCase()}${module.slice(1)}", "module-${module}"`),
      `Navigation must expose the ${module} rail module`);
  }
  assert.match(extension, /element\.nodeType === "module-knowledge"[\s\S]{0,500}"root-skills"[\s\S]{0,500}"root-notes"[\s\S]{0,500}"root-papers"/);
  assert.match(extension, /element\.nodeType === "module-tools"[\s\S]{0,1400}"root-prompts"[\s\S]{0,500}"root-scripts"[\s\S]{0,500}"root-packages"[\s\S]{0,500}environments,[\s\S]{0,200}servers/);
  assert.match(extension, /element\.nodeType === "module-automation"[\s\S]{0,700}"Agent Sessions"[\s\S]{0,200}recipes/);
  assert.match(extension, /new PkTreeItem\("Recipe Library", "page-recipes", C\)/,
    "Recipe Library must be expandable in Navigation");
  assert.match(extension, /case 'page-recipes':\s+return this\._withSubscribedContent\("recipes", this\._recipeFolder\(\[\]\)\)/);
  assert.match(extension, /case 'recipe-folder':\s+return this\._recipeFolder\(element\.nodeData\.path\)/);
  assert.match(extension, /split\("\/"\)\.map\(segment => segment\.trim\(\)\)\.filter\(Boolean\)/,
    "Recipe categories must preserve their complete hierarchy");
  assert.match(extension, /command: "personalKnowledge\.openRecipe"[\s\S]{0,100}recipe\.recipeId/,
    "Recipe leaves must open the existing Recipe editor");
  assert.match(extension, /nodeType === 'page-recipes'\) this\.contextValue = 'pk-recipes-root'/);
  assert.match(extension, /nodeType === 'recipe-folder'\) this\.contextValue = 'pk-recipes-group'/);
  assert.match(extension, /nodeType === 'recipe'\) this\.contextValue = 'pk-recipe-item'/);
  assert.match(extension, /privateNavigationLabel\("recipes", name, topLevel\)/);
  assert.match(extension, /privacyType: "recipes", privacyName: name/);
  assert.match(extension, /registerCommand\("personalKnowledge\.addRecipeHere"[\s\S]{0,900}createRecipe\([\s\S]{0,250}\{ kind: "global" \}/);
  assert.match(extension, /_addFolderPaths\(this\._buildPathTree\(entries\), snapshot\.recipeFolders\)/,
    "Navigation must render persisted empty Recipe folders");
  assert.match(extension, /registerCommand\("personalKnowledge\.newRecipeSubfolder"[\s\S]{0,1400}createRecipeFolder\(/);
  assert.match(extension, /registerCommand\("personalKnowledge\.deleteRecipeFolder"[\s\S]{0,1800}deleteRecipeFolder\(/);
  assert.match(extension, /no Recipes will be deleted/i, "Recipe folder deletion must clearly preserve Recipes");
  assert.match(extension, /element\.nodeType === "module-projects"[\s\S]{0,500}"Overview"[\s\S]{0,200}chatroom/);
  assert.match(extension, /element\.nodeType === "module-settings"[\s\S]{0,700}"General & MCP"[\s\S]{0,500}"Router"[\s\S]{0,300}subscriptions/);
  assert.match(extension, /registerCommand\("personalKnowledge\.openPanelTab"/);
  assert.match(extension, /new PkTreeItem\("Network & Sharing", "root-subscriptions"/);
  assert.match(extension, /return \[brokers, subscribers\]/);
  assert.match(extension, /case 'subscription-brokers-group': return this\._subscriptionBrokers\(\)/);
  assert.match(extension, /case 'subscription-subscribers-group': return this\._subscriptionSubscribers\(\)/);
  const commandTitles = Object.fromEntries(packageJson.contributes.commands.map(command => [command.command, command.title]));
  assert.strictEqual(commandTitles["personalKnowledge.openSubscriptions"], "Open Subscription");
  assert.strictEqual(commandTitles["personalKnowledge.openRecipe"], "Open");
  assert.strictEqual(commandTitles["personalKnowledge.addRecipeHere"], "New Recipe Here");
  assert.strictEqual(commandTitles["personalKnowledge.newRecipeSubfolder"], "New Recipe Subfolder…");
  assert.strictEqual(commandTitles["personalKnowledge.deleteRecipeFolder"], "Delete Recipe Folder…");
  assert.match(extension, /function folkNavigationLabel\(value: string, root: boolean\)/);
  assert.match(extension, /replace\(\/--\[a-f0-9\]\{12\}\$\/i, ""\)/);
  assert.match(extension, /privateNavigationLabel\("skills", name, topLevel\)/);
  assert.match(extension, /privateNavigationLabel\("prompts", p, true\)/);
  assert.match(extension, /privacyTopLevel/);
  assert.strictEqual(commandTitles["personalKnowledge.setFolderPrivate"], "Set as Private");
  assert.strictEqual(commandTitles["personalKnowledge.setFolderPublic"], "Set as Public");
  assert.strictEqual(commandTitles["personalKnowledge.newSubgroup"], "New Subgroup…");
  assert.strictEqual(commandTitles["personalKnowledge.renameSubgroup"], "Rename Subgroup…");
  assert.strictEqual(commandTitles["personalKnowledge.deleteSubgroup"], "Delete Subgroup…");
  const subgroupMenus = packageJson.contributes.menus["view/item/context"].filter(menu => ["personalKnowledge.newSubgroup", "personalKnowledge.renameSubgroup", "personalKnowledge.deleteSubgroup"].includes(menu.command));
  assert.strictEqual(subgroupMenus.length, 3);
  assert.match(subgroupMenus.find(menu => menu.command === "personalKnowledge.newSubgroup").when, /skills\|notes\|papers\|prompts\|scripts/);
  assert.doesNotMatch(subgroupMenus.find(menu => menu.command === "personalKnowledge.newSubgroup").when, /terminal-group/);
  assert.match(subgroupMenus.find(menu => menu.command === "personalKnowledge.renameSubgroup").when, /terminal-group/);
  assert.match(subgroupMenus.find(menu => menu.command === "personalKnowledge.deleteSubgroup").when, /terminal-group/);
  const recipeMenus = packageJson.contributes.menus["view/item/context"].filter(menu => ["personalKnowledge.openRecipe", "personalKnowledge.addRecipeHere"].includes(menu.command));
  assert.strictEqual(recipeMenus.filter(menu => menu.command === "personalKnowledge.openRecipe").length, 1);
  assert.strictEqual(recipeMenus.filter(menu => menu.command === "personalKnowledge.addRecipeHere").length, 2);
  assert(recipeMenus.some(menu => menu.command === "personalKnowledge.addRecipeHere" && menu.group === "inline"), "Recipe folders must expose an inline + action");
  const recipeFolderMenus = packageJson.contributes.menus["view/item/context"].filter(menu =>
    ["personalKnowledge.newRecipeSubfolder", "personalKnowledge.deleteRecipeFolder"].includes(menu.command));
  assert.strictEqual(recipeFolderMenus.length, 2);
  assert.match(recipeFolderMenus.find(menu => menu.command === "personalKnowledge.newRecipeSubfolder").when, /pk-recipes-\(root\|group\)/);
  assert.match(recipeFolderMenus.find(menu => menu.command === "personalKnowledge.deleteRecipeFolder").when, /pk-recipes-group/);

  console.log("navigation groups test: multi-level create, rename, safe promote-delete, collision protection, and unified menus OK");
} finally {
  fs.rmSync(store, { recursive: true, force: true });
}

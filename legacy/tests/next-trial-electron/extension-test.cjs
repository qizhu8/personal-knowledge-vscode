"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const vscode = require("vscode");

function replace(object, name, value) {
  const original = object[name];
  object[name] = value;
  assert.equal(object[name], value, `Cannot instrument ${name}`);
  return () => { object[name] = original; };
}

function snapshot(directory, legacyRuntime = false, includeMetadata = false) {
  const files = {};
  const metadata = file => {
    const stat = fs.lstatSync(file);
    return { mode: stat.mode, inode: stat.ino, mtimeMs: stat.mtimeMs };
  };
  if (includeMetadata) files["."] = metadata(directory);
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      // The activated legacy extension refreshes its own host liveness record.
      if (legacyRuntime && path.relative(directory, file) === ".pkm/state/api-chat-control/hosts") continue;
      assert(!entry.isSymbolicLink(), "Synthetic fixture must not contain links");
      if (entry.isDirectory()) {
        if (includeMetadata) files[`${path.relative(directory, file)}/`] = metadata(file);
        visit(file);
      } else {
        const sha256 = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
        files[path.relative(directory, file)] = includeMetadata ? { sha256, ...metadata(file) } : sha256;
      }
    }
  }
  visit(directory);
  return files;
}

function childRequest(child, message) {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("Timed out waiting for isolated child response")); }, 10000);
    const listener = response => { if (response.id === id) { cleanup(); resolve(response); } };
    const exit = () => { cleanup(); reject(new Error("Isolated child exited before response")); };
    function cleanup() { clearTimeout(timer); child.off("message", listener); child.off("exit", exit); }
    child.on("message", listener); child.once("exit", exit);
    child.send({ ...message, id }, error => { if (error) { cleanup(); reject(error); } });
  });
}

exports.run = async () => {
  console.log("Trial Electron: test runner started");
  const root = process.env.PKM_TRIAL_ELECTRON_ROOT;
  const selected = process.env.PKM_TRIAL_ELECTRON_DIRECTORY;
  const node = process.env.PKM_TRIAL_ELECTRON_NODE;
  const extensionPath = process.env.PKM_TRIAL_ELECTRON_EXTENSION;
  const legacy = process.env.PKM_TRIAL_ELECTRON_LEGACY;
  const python = process.env.PKM_TRIAL_ELECTRON_PYTHON;
  for (const value of [root, selected, node, extensionPath, legacy]) assert.ok(value);
  assert.deepEqual(fs.readdirSync(selected), []);
  const errors = [], notices = [], children = [], restore = [];
  const dialogs = [vscode.Uri.file(selected), vscode.Uri.file(node)];
  const inputs = ["Electron trial", "Original synthetic content", "Updated synthetic content"];
  const picks = ["Create document", "List and edit documents"];
  let phase = "trial", importParent, declineWrite = false, resourceArea, resourcePath, boardSection, structuredKind, recipeName, libraryPath;
  const warnings = [], traffic = [], previews = [];
  const resourcePreviews = [];
  const boardPreviews = [];
  const structuredPreviews = [];
  const recipePreviews = [];
  const libraryPreviews = [], libraryBytes = new Map(), libraryModels = new Map();
  let editorJourney = false, editorArea, editorCreate = false, declineDraft = false;
  const nativeEdited = [];
  let archiveArea;
  const archiveBytes = new Map(), archivePreviews = [];
  const archiveAreas = ["packages", "actions", "components", "action-module-sets", "action-state"];
  const archiveSourcePath = relative => relative.startsWith("action-state/") ?
    `.pkm/state/actions/${relative.slice("action-state/".length)}` : relative;
  let scriptIdentity;
  let originalRecipes, migratedRecipes, recipeSourceBytes;
  const binaryResource = Buffer.alloc(70013);
  for (let index = 0; index < binaryResource.length; index++) binaryResource[index] = (index * 37) & 255;
  const pngResource = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0c0AAAAASUVORK5CYII=", "base64");
  const fork = childProcess.fork;
  restore.push(replace(childProcess, "fork", function (modulePath, ...args) {
    const child = fork.call(this, modulePath, ...args);
    if (fs.existsSync(modulePath) && fs.realpathSync(modulePath) === fs.realpathSync(path.join(extensionPath, "next-runtime/server/dist/managed-client-child.js"))) {
      children.push(child);
      child.on("message", message => traffic.push({ child, direction: "receive", message }));
      const send = child.send;
      child.send = function (message, ...rest) {
        traffic.push({ child, direction: "send", message });
        return send.call(this, message, ...rest);
      };
    }
    return child;
  }));
  restore.push(replace(vscode.window, "showOpenDialog", async () => [dialogs.shift()]));
  restore.push(replace(vscode.window, "showWarningMessage", async (message, options) => {
    if (editorJourney && message === "Publish this draft to the isolated trial?") return declineDraft ? undefined : "Publish Isolated Draft";
    if (/disposable PKM Next trial/.test(message)) return "Create Trial";
    if (/Enable isolated_experiment writing/.test(message)) {
      const request = traffic.filter(item => item.direction === "send" && item.message.type === "prepare-import-write").at(-1);
      const prepared = traffic.find(item => item.child === request.child && item.direction === "receive" &&
        item.message.id === request.message.id).message.result;
      assert(options.detail.includes(prepared.authorizationDigest), "Approval must show the reconciled authorization digest");
      assert(options.detail.includes(prepared.workspaceId));
      assert(options.detail.includes(prepared.planSha256));
      assert.match(options.detail, /External writers: UNKNOWN/);
      assert.match(options.detail, /not a fence/);
      assert.match(options.detail, /Blockers: None/);
      assert(options.detail.includes(path.join(importParent, "workspace")));
      return declineWrite ? undefined : "Enable Isolated Experiment";
    }
    if (/Resume the saved isolated_experiment/.test(message)) {
      assert.match(options.detail, /External writers: UNKNOWN/);
      return "Resume Isolated Experiment";
    }
    if (phase !== "trial" && /static legacy COPY|import is blocked|exact displayed plan digest/.test(message)) {
      warnings.push({ phase, message, detail: options.detail });
      if (/Assert this/.test(message)) {
        assert.match(options.detail, /assertion, not a writer fence/);
        return "I Assert Static Copy";
      }
      const plan = traffic.filter(item => item.direction === "receive" && item.message.type === "import-plan").at(-1).message;
      assert(options.detail.includes(plan.planSha256), "UI must show actual child plan digest");
      assert(options.detail.includes(plan.target), "UI must show actual child target");
      assert.equal(fs.existsSync(path.join(importParent, "workspace")), false);
      if (phase === "blocked") {
        assert(plan.blockers.length);
        for (const blocker of plan.blockers) {
          assert(options.detail.includes(blocker.code));
          assert(options.detail.includes(blocker.message));
        }
        return undefined;
      }
      assert.match(options.detail, /Blockers:\nNone/);
      return phase === "refused" ? undefined : "Import Exact Plan";
    }
    return undefined;
  }));
  restore.push(replace(vscode.window, "showInputBox", async () => inputs.shift()));
  restore.push(replace(vscode.window, "showQuickPick", async (choices, options) => {
    if (options?.placeHolder?.startsWith("Optional original Memory SQLite")) return "No Memory Engine";
    if (archiveArea && choices[0]?.area) return choices.find(item => item.area === archiveArea);
    if (editorJourney) {
      if (options.placeHolder.includes("choose a knowledge area")) return choices.find(item => item.area === editorArea);
      return choices.find(item => editorCreate ? item.action === "create" : item.item?.id === `editable-${editorArea}`);
    }
    if (libraryPath) {
      const item = choices.find(item => item.label === libraryPath);
      if (item) return item;
      const next = choices.find(item => item.more);
      assert(next, `Imported library path must be user-selectable: ${libraryPath}`);
      return next;
    }
    if (recipeName) {
      const item = choices.find(item => item.label === recipeName);
      assert(item, "Original global/project Recipe must be user-selectable");
      return item;
    }
    if (structuredKind) {
      const item = choices.find(item => item.label === (structuredKind === "Research" ? "Structured Paper" : "Structured Skill"));
      assert(item);
      return item;
    }
    if (boardSection) {
      if (options.placeHolder.includes("Boards read-only")) return choices.find(item => item.slug === "LegacyBoard");
      if (options.placeHolder.includes("writes deferred")) return boardSection;
      if (options.placeHolder.includes("digest-pinned")) return "Next Board item page";
    }
    if (resourceArea) {
      const item = options.placeHolder.includes("select notes")
        ? choices.find(item => item.label === `Resource ${resourceArea}`)
        : choices.find(item => item.label === `Resource.assets/${resourcePath}`);
      assert(item, "Expected imported resource/document must be user-selectable");
      return item;
    }
    if (typeof choices[0] !== "object") return picks.shift();
    if (phase === "trial") { assert.equal(choices.length, 1); assert.equal(choices[0].label, "Electron trial"); return choices[0]; }
    const item = choices.find(item => item.label === "Electron import");
    assert(item);
    return item;
  }));
  restore.push(replace(vscode.window, "showInformationMessage", async message => { notices.push(message); }));
  restore.push(replace(vscode.window, "showErrorMessage", async message => { errors.push(message); }));
  const showTextDocument = vscode.window.showTextDocument;
  restore.push(replace(vscode.window, "showTextDocument", async function (document, ...args) {
    if (phase !== "trial" && !editorJourney) {
      assert.equal(document.isUntitled, true, "Preview must not provide a writable imported file URI");
      if (document.languageId === "plaintext" && /^Isolated (packages|actions|components|action-module-sets|action-state) read-only/.test(document.getText())) archivePreviews.push(document.getText());
      else if (document.languageId === "plaintext" && /^Isolated (prompts|scripts) read-only/.test(document.getText())) libraryPreviews.push(document.getText());
      else if (document.languageId === "plaintext" && document.getText().startsWith("Isolated Recipe read-only")) recipePreviews.push(document.getText());
      else if (document.languageId === "plaintext" && /^Isolated (Research|Skills) read-only/.test(document.getText())) structuredPreviews.push(document.getText());
      else if (document.languageId === "plaintext" && document.getText().startsWith("Isolated Board")) boardPreviews.push(document.getText());
      else if (document.languageId === "plaintext") resourcePreviews.push(document.getText());
      else previews.push(document.getText());
    }
    return showTextDocument.call(this, document, ...args);
  }));
  try {
    const extension = vscode.extensions.getExtension("uone.personal-knowledge");
    assert.ok(extension, "Production extension is not loaded");
    assert.equal(fs.realpathSync(extension.extensionPath), fs.realpathSync(extensionPath));
    await extension.activate();
    console.log("Trial Electron: production extension activated");
    const store = require(path.join(extensionPath, "dist/knowledge/filestore.js"));
    assert.equal(fs.realpathSync(store.getStorePath()), fs.realpathSync(legacy), "Unexpected Knowledge Root");
    assert.deepEqual(fs.readdirSync(selected), [], "Activation must not start a trial");
    assert.equal(children.length, 0, "Activation must not start the incomplete Next server");
    await vscode.commands.executeCommand("personalKnowledge.nextTrialStart");
    console.log("Trial Electron: start/create command completed");
    assert.equal(children.length, 1, "The command must fork the verified bundled host");
    assert.equal(children[0].exitCode, null, "Trial child exited before editing");
    await vscode.commands.executeCommand("personalKnowledge.nextTrialDocuments");
    console.log("Trial Electron: list/edit command completed");
    assert.deepEqual(errors, []);
    assert(notices.some(message => /document created/i.test(message)));
    assert(notices.some(message => /document updated/i.test(message)));
    const noteDirectory = path.join(selected, "workspace", "notes");
    const notes = fs.readdirSync(noteDirectory).filter(file => file.endsWith(".md"));
    assert.equal(notes.length, 1);
    assert.match(fs.readFileSync(path.join(noteDirectory, notes[0]), "utf8"), /Updated synthetic content/);
    const child = children[0];
    const exited = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
    await vscode.commands.executeCommand("personalKnowledge.nextTrialClose");
    console.log("Trial Electron: drain command completed");
    assert.deepEqual(await exited, { code: 0, signal: null });
    assert.deepEqual(errors, [], "Close must drain successfully");
    assert.equal(fs.readFileSync(path.join(legacy, "fixture-sentinel.txt"), "utf8"), "untouched",
      "Trial must not change the existing fixture root sentinel");
    assert.deepEqual(inputs, []);
    assert.deepEqual(dialogs, []);
    assert.deepEqual(picks, []);
    const authority = path.join(legacy, ".pkm/state/actions/host-authority.json");
    const authorityDeadline = Date.now() + 15000;
    while (!fs.existsSync(authority) && Date.now() < authorityDeadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert(fs.existsSync(authority), "Wait for legacy activation authority provisioning before taking the unchanged-root baseline");
    const legacyBefore = snapshot(legacy, true);
    assert(python, "Runner must select local Python in isolated environment");
    for (const scenario of ["blocked", "refused", "import"]) {
      phase = scenario;
      const source = path.join(root, `copy-${scenario}`);
      importParent = path.join(root, `parent-${scenario}`);
      fs.mkdirSync(source, { mode: 0o700 });
      fs.mkdirSync(importParent, { mode: 0o700 });
      fs.mkdirSync(path.join(source, "notes"));
      fs.writeFileSync(path.join(source, "notes/Import.md"),
        "---\ntitle: Electron import\ndocumentId: electron-import\nrevision: 2\n---\nSynthetic Electron import\n");
      if (scenario === "import") {
        for (const area of ["packages", "actions", "components", "action-module-sets"]) {
          for (const [file, bytes] of [
            ["Fixture/manifest.json", Buffer.from('{"name":"Original archive fixture","unknown":{"preserve":17}}\n')],
            ["Fixture/spec.yaml", Buffer.from("name: inert synthetic\nexecution: never\n")],
            ["Fixture/never.py", Buffer.from("raise RuntimeError('ARCHIVED CODE MUST NEVER RUN')\n")],
            ["Fixture/.original-hidden", Buffer.from("Opaque original hidden data\n")],
            ["Fixture/data.bin", binaryResource],
            ["Fixture/empty.bin", Buffer.alloc(0)],
          ]) {
            const relative = `${area}/${file}`;
            archiveBytes.set(relative, bytes);
            fs.mkdirSync(path.dirname(path.join(source, relative)), { recursive: true });
            fs.writeFileSync(path.join(source, relative), bytes, { mode: file.endsWith(".py") ? 0o751 : 0o640 });
          }
          fs.mkdirSync(path.join(source, area, "Empty"), { recursive: true });
        }
        for (const [file, bytes] of [
          ["host-authority.json", Buffer.from('{"schema":"historical-host","authority":"OLD-ARCHIVED-AUTHORITY","mustNotInherit":true}\n')],
          ["grants.json", Buffer.from('{"grants":[{"effect":"write","approved":true}],"historicalOnly":true}\n')],
          ["runs/legacy-run.json", Buffer.from('{"status":"succeeded","approval":"old","historicalOnly":true}\n')],
          [".original-hidden", Buffer.from("Opaque original Action state history\n")],
          ["data.bin", binaryResource],
          ["empty.bin", Buffer.alloc(0)],
        ]) {
          const relative = `action-state/${file}`, original = path.join(source, archiveSourcePath(relative));
          archiveBytes.set(relative, bytes);
          fs.mkdirSync(path.dirname(original), { recursive: true });
          fs.writeFileSync(original, bytes, { mode: file === "host-authority.json" ? 0o600 : 0o640 });
        }
        fs.mkdirSync(path.join(source, ".pkm/state/actions/Empty"), { recursive: true, mode: 0o750 });
        for (const [index, area] of ["notes", "skills", "papers"].entries()) {
          fs.mkdirSync(path.join(source, area), { recursive: true });
          const metadata = { schema: "pkm.knowledge/v1", documentId: `editable-${area}`,
            knowledgeId: `knowledge_${String(index + 5).repeat(24)}`, revision: 3, title: `Editable ${area}`,
            aliases: [`${area === "notes" ? "note" : area === "skills" ? "skill" : "research"}:Original Editable ${area}`],
            tags: ["original"], customOriginal: { owner: "Original owner", nested: [7, "preserved"] },
            ...(area === "skills" ? { name: "Editable skills", recipe_required: true, recipe_hint: "Original hint", related_skills: ["Resource"] } : {}),
            ...(area === "papers" ? { authors: ["Original author"], cites: [{ paper: "Resource", note: "Original citation" }], conclusions: ["Original conclusion"] } : {}) };
          fs.writeFileSync(path.join(source, area, "Editable.md"), `---\n${area === "notes" ? `${JSON.stringify(metadata)}\n` :
            require(path.join(extensionPath, "next-runtime/server/node_modules/yaml")).stringify(metadata)}---\nOriginal editable ${area} body.\n`);
        }
        libraryBytes.set("prompts/Original/Task/v1/zz-prompt.jinja2", Buffer.from(
          "{# PROMPT_METADATA\ntitle: Original title\nnote:\nOriginal note\n#}\n{% extends 'base.jinja2' %}\n{{ inert_variable }}\n"));
        libraryBytes.set("scripts/Old/original.py", Buffer.from(
          "from pathlib import Path\nPath('MUST_NOT_EXECUTE').write_text('Not authorized')\n"));
        libraryBytes.set("scripts/Tools/unassigned.sh", Buffer.from("#!/bin/sh\nprintf 'must not execute\\n'\n"));
        libraryBytes.set("scripts/Tools/data.bin", binaryResource);
        libraryBytes.set("scripts/Tools/chunk.txt", Buffer.alloc(70013, 65));
        for (const [file, bytes] of libraryBytes) {
          fs.mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
          fs.writeFileSync(path.join(source, file), bytes, { mode: file.endsWith(".sh") ? 0o751 : 0o640 });
        }
        for (let index = 0; index < 55; index++) fs.writeFileSync(
          path.join(source, `prompts/Original/Task/v1/filler-${String(index).padStart(2, "0")}.txt`), "Synthetic paging fixture\n");
        const oracle = JSON.parse(childProcess.execFileSync(node, ["-e", `
          const storage = require(process.argv[1]);
          const fs = require("node:fs");
          storage.setStorePath(process.argv[2]);
          storage.promptSaveVersionNote("Original", "Task", "v1", "zz-prompt.jinja2", "Original second version note", "v2");
          const original = storage.scriptGet("Old/original.py");
          if (!storage.scriptMove("Old/original.py", "Tools")) throw new Error("Original Script move failed");
          const identityFile = storage.scriptIdentityFile("Tools/original.py");
          const identity = JSON.parse(fs.readFileSync(identityFile, "utf8"));
          if (identity.knowledgeId !== original.knowledgeId) throw new Error("Script move changed original identity");
          identity.originalOpaque = { preserved: "Original Script metadata" };
          fs.writeFileSync(identityFile, JSON.stringify(identity, null, 2) + "\\n");
          process.stdout.write(JSON.stringify({
            v1: storage.promptGetFile("Original", "Task", "v1", "zz-prompt.jinja2"),
            v2: storage.promptGetFile("Original", "Task", "v2", "zz-prompt.jinja2"),
            script: storage.scriptGet("pkm://scripts/Old/original.py"),
            identity
          }));
        `, path.join(extensionPath, "dist/knowledge/storage.js"), source], { encoding: "utf8" }));
        assert(oracle.script && oracle.v1 && oracle.v2, "Original storage functions must resolve saved alias and versions");
        scriptIdentity = oracle.identity;
        libraryBytes.delete("scripts/Old/original.py");
        for (const file of ["prompts/Original/Task/v2/zz-prompt.jinja2", "scripts/Tools/original.py", "scripts/Tools/.original.py.pkm.json"])
          libraryBytes.set(file, fs.readFileSync(path.join(source, file)));
        fs.mkdirSync(path.join(source, "prompts/Original/Task/v2/empty"), { recursive: true });
        libraryModels.set("prompts/Original/Task/v1/zz-prompt.jinja2", oracle.v1);
        libraryModels.set("prompts/Original/Task/v2/zz-prompt.jinja2", oracle.v2);
        libraryModels.set("scripts/Tools/original.py", oracle.script);
        fs.writeFileSync(path.join(source, "scripts/Tools/oversize.txt"), Buffer.alloc(1024 * 1024 + 1, 65));
        const { ProjectStore } = require(path.join(extensionPath, "dist/workflows/project-store.js"));
        const { canonicalJson } = require(path.join(extensionPath, "dist/workflows/workflow-contracts.js"));
        const store = new ProjectStore(path.join(source, ".pkm/state"), randomUUID, { autoMigrate: false });
        let version = store.list().storeVersion;
        const command = name => ({ commandId: name, fingerprint: `synthetic-${name}`, expectedStoreVersion: version });
        const project = store.createProject(command("create-project"), "Electron Original Project");
        version = project.snapshot.storeVersion;
        const globalRecipe = store.createRecipe(command("create-global-recipe"), { kind: "global" }, "Electron Global Recipe", "Guides/Nested");
        version = globalRecipe.snapshot.storeVersion;
        store.createRecipe(command("create-project-recipe"), { kind: "project", projectId: project.entityId }, "Electron Project Recipe", "Guides");
        const sourceFile = path.join(source, ".pkm/state/projects.json");
        const envelope = JSON.parse(fs.readFileSync(sourceFile, "utf8"));
        envelope.futureOpaqueMetadata = { preserve: ["Original ProjectStore bytes", 17] };
        fs.writeFileSync(sourceFile, canonicalJson(envelope));
        originalRecipes = store.list().recipes;
        recipeSourceBytes = fs.readFileSync(sourceFile);
        const parityRoot = path.join(root, "original-recipe-parity");
        fs.cpSync(source, parityRoot, { recursive: true });
        const parity = new ProjectStore(path.join(parityRoot, ".pkm/state"), randomUUID);
        parity.list();
        const plan = parity.migrateLegacyRecipes("preview");
        for (const action of ["stage", "verify", "cutover"]) parity.migrateLegacyRecipes(action, { sourceDigest: plan.sourceDigest });
        migratedRecipes = parity.list().recipes;
        fs.writeFileSync(path.join(source, "notes/LegacyBoard.md"),
          "---\ntitle: LegacyBoard\ndocumentId: legacy-board\ndocumentKind: todo-board\n---\n");
        fs.mkdirSync(path.join(source, "notes/LegacyBoard.assets"));
        const story = { id: "original-story", kind: "UserStory", title: "Original legacy Story", goal: "Keep original contract",
          scope: "Read-only rehearsal", acceptance: ["No task changes"], evidence: [], state: "Planning", storyStatus: "confirmed" };
        const tasks = Array.from({ length: 55 }, (_, index) => ({ id: `original-task-${index}`, kind: "Task",
          title: `Original legacy task ${index}`, goal: "Preserve task", scope: "Original Board", acceptance: ["Original acceptance"],
          evidence: [], state: "Planning", parentId: story.id }));
        fs.writeFileSync(path.join(source, "notes/LegacyBoard.assets/pkm-todo-board.json"),
          JSON.stringify({ schema: "pkm.todo-board/v1", items: [story, ...tasks],
            workers: { "external:copilot:fixture": "e".repeat(64) } }, null, 2) + "\n");
        for (const area of ["notes", "skills", "papers"]) {
          fs.mkdirSync(path.join(source, area), { recursive: true });
          fs.mkdirSync(path.join(source, area, "Resource.assets"));
          fs.writeFileSync(path.join(source, area, "Resource.md"),
            `---\ntitle: Resource ${area}\ndocumentId: resource-${area}\nrevision: 1\n---\nSynthetic ${area} resource document\n`);
          fs.writeFileSync(path.join(source, area, "Resource.assets/data.bin"), binaryResource);
          fs.writeFileSync(path.join(source, area, "Resource.assets/pixel.png"), pngResource);
          fs.writeFileSync(path.join(source, area, "Resource.assets/empty.bin"), "");
        }
        fs.writeFileSync(path.join(source, "papers/Structured.md"),
          `---\nschema: pkm.knowledge/v1\nknowledgeId: knowledge_111111111111111111111111\nrevision: 7\naliases: [Original Paper Alias]\ntitle: Structured Paper\nkind: paper\ngroup: Original Group\nauthors: [Synthetic Author]\nyear: 2025\ntopic: Migration\npublisher: Fixture Publisher\ntags: [synthetic]\nconclusions: [Original conclusion]\nimplementation: [Original implementation]\nassumptions: [Original assumption]\ncites: [{paper: Resource, note: Original citation}]\nlinks: [{kind: related, target: original-target}]\ncustomMigrationField: preserve-paper-metadata\n---\nOriginal structured Paper body.\n`);
        fs.writeFileSync(path.join(source, "skills/Structured.md"),
          `---\nschema: pkm.knowledge/v1\nknowledgeId: knowledge_222222222222222222222222\nrevision: 9\naliases: [Original Skill Alias]\nname: Structured Skill\ntitle: Structured Skill\ncategory: Original Category\ndescription: Original skill description\ntags: [synthetic]\nsource_project: original-project\nrecipe_required: true\nrecipe_hint: Original recipe hint\nrelated_skills: [Resource]\npriority: highest\npinned: true\nlinks: [{kind: related, target: original-target}]\ncustomMigrationField: preserve-skill-metadata\n---\nOriginal structured Skill body.\n`);
        for (const [area, alias] of [["papers", "research:Original-Paper-Alias"], ["skills", "skill:Original-Skill-Alias"]]) {
          const file = path.join(source, area, "Structured.md");
          fs.writeFileSync(file, fs.readFileSync(file, "utf8")
            .replace(/aliases: \[[^\]]+\]/, `aliases: [${alias}]`)
            .replace("links: [{kind: related, target: original-target}]",
              "links: [{relation: related, target: 'pkm://knowledge/knowledge_111111111111111111111111', mode: floating, required: false}]"));
        }
        fs.writeFileSync(path.join(source, "notes/Resource.assets/large.bin"), Buffer.alloc(1024 * 1024 + 1));
      }
      if (scenario === "blocked") fs.writeFileSync(path.join(source, "notes/.unsupported"), "block me");
      const sourceBefore = snapshot(source, false, true);
      dialogs.push(...[source, importParent, node, python].map(file => vscode.Uri.file(file)));
      const childCount = children.length;
      await vscode.commands.executeCommand("personalKnowledge.nextTrialImport");
      assert.deepEqual(errors, []);
      assert.equal(children.length, childCount + 1);
      const importedChild = children.at(-1);
      const sent = () => traffic.filter(item => item.child === importedChild && item.direction === "send").map(item => item.message);
      if (scenario !== "import") {
        assert.equal(sent().some(message => message.type === "confirm-import"), false);
        assert.deepEqual(fs.readdirSync(importParent), []);
        assert.equal(importedChild.exitCode, 0, "Cancelled/blocked child must drain");
      } else {
        const confirmed = sent().find(message => message.type === "confirm-import");
        const plan = traffic.find(item => item.child === importedChild && item.message.type === "import-plan").message;
        assert.equal(confirmed.planSha256, plan.planSha256);
        assert(sent().some(message => message.type === "import-status"));
        assert(sent().some(message => message.type === "attach-import"));
        const responses = traffic.filter(item => item.child === importedChild && item.direction === "receive").map(item => item.message);
        const statusId = sent().find(message => message.type === "import-status").id;
        const attachId = sent().find(message => message.type === "attach-import").id;
        assert.equal(responses.find(message => message.id === statusId).result.outcome.status, "published");
        assert.equal(responses.find(message => message.id === attachId).result.readOnly, true);
        assert.equal(previews.at(-1), "Synthetic Electron import\n");
        const target = path.join(importParent, "workspace"), targetBefore = snapshot(target);
        const boardBytes = fs.readFileSync(path.join(source, "notes/LegacyBoard.assets/pkm-todo-board.json"));
        const checkBoards = async () => {
          for (const section of ["Board summary", "Tasks (read-only)", "User Stories (read-only)"]) {
            boardSection = section;
            try { await vscode.commands.executeCommand("personalKnowledge.nextTrialBoards"); }
            finally { boardSection = undefined; }
          }
          assert.deepEqual(errors, []);
          const texts = boardPreviews.slice(-4);
          assert.equal(texts.length, 4, "Board task paging must expose both pages");
          assert(texts[0].includes('"workitems": 55'));
          assert(texts[0].includes('"userstories": 1'));
          assert(texts[1].includes("Original legacy task 0"));
          assert(texts[2].includes("Original legacy task 54"));
          assert(texts[3].includes("Original legacy Story"));
          assert(texts.every(text => text.includes("read_only_defer") && !text.includes("e".repeat(64))));
          assert.deepEqual(fs.readFileSync(path.join(target, "boards/LegacyBoard/pkm-todo-board.json")), boardBytes);
        };
        await checkBoards();
        const checkStructured = async () => {
          for (const kind of ["Research", "Skills"]) {
            structuredKind = kind;
            try { await vscode.commands.executeCommand(`personalKnowledge.nextTrial${kind}`); }
            finally { structuredKind = undefined; }
            assert.deepEqual(errors, []);
            const text = structuredPreviews.at(-1);
            assert(text.includes(kind === "Research" ? "knowledge_111111111111111111111111" : "knowledge_222222222222222222222222"));
            assert(text.includes(kind === "Research" ? "research:Original-Paper-Alias" : "skill:Original-Skill-Alias"));
            assert(text.includes(kind === "Research" ? "Original conclusion" : "Original recipe hint"));
            assert(text.includes(kind === "Research" ? "Original citation" : "original-project"));
            assert(text.includes(kind === "Research" ? "preserve-paper-metadata" : "preserve-skill-metadata"));
            assert(text.includes(kind === "Research" ? "Original structured Paper body." : "Original structured Skill body."));
            assert(text.includes('"revision": ' + (kind === "Research" ? "7" : "9")));
          }
        };
        await checkStructured();
        const checkRecipes = async () => {
          for (const name of ["Electron Global Recipe", "Electron Project Recipe"]) {
            recipeName = name;
            try { await vscode.commands.executeCommand("personalKnowledge.nextTrialRecipes"); }
            finally { recipeName = undefined; }
            assert.deepEqual(errors, []);
            const text = recipePreviews.at(-1), parsed = JSON.parse(text.slice(text.indexOf("{")));
            const expected = migratedRecipes.find(item => item.name === name), original = originalRecipes.find(item => item.name === name);
            assert(expected && original);
            const actual = { ...parsed.item };
            for (const key of ["schema", "knowledgeId", "aliases"]) if (!(key in expected)) delete actual[key];
            assert.deepEqual(actual, expected, "Recipe details must match the actual original ProjectStore migration, not a re-created UI model");
            assert.equal(parsed.item.recipeId, original.recipeId);
            assert.equal(parsed.item.scope, "global");
            assert.equal(parsed.item.revision, expected.revision);
            if (name === "Electron Project Recipe") {
              assert.match(parsed.item.category, /^Project\/Electron Original Project\/Guides$/);
              assert.equal(original.scope, "project");
            }
            assert(text.includes("No execution") && text.includes("does not grant project ownership"));
          }
          assert.deepEqual(fs.readFileSync(path.join(source, ".pkm/state/projects.json")), recipeSourceBytes);
        };
        await checkRecipes();
        const checkLibrary = async (attachedReadOnly = false) => {
          const beforeReads = snapshot(target), start = traffic.length;
          for (const file of [...libraryBytes.keys(), "prompts/Original/Task/v2/empty"]) {
            libraryPath = file;
            try { await vscode.commands.executeCommand(`personalKnowledge.nextTrial${file.startsWith("prompts/") ? "Prompts" : "Scripts"}`); }
            finally { libraryPath = undefined; }
            assert.deepEqual(errors, []);
            const text = libraryPreviews.at(-1), parsed = JSON.parse(text.slice(text.indexOf("{")));
            assert.equal(parsed.item.path, file);
            assert.match(text, /No execution, template rendering, writes, sidecar initialization/);
            assert.match(text, /aliases are not an event log/);
            if (libraryBytes.has(file)) {
              const expected = libraryBytes.get(file);
              assert.equal(parsed.item.sha256, createHash("sha256").update(expected).digest("hex"));
              assert.deepEqual(Buffer.from(parsed.raw, parsed.encoding), expected, "Library raw bytes must round-trip without rendering or execution");
            } else assert.equal(parsed.item.kind, "directory");
            if (libraryModels.has(file)) assert.deepEqual(parsed.legacy, libraryModels.get(file),
              "UI projection must match actual original storage function, not a re-created UI model");
            if (file.endsWith("original.py")) assert.deepEqual(parsed.item.scriptIdentity, scriptIdentity);
            if (file.endsWith("unassigned.sh")) {
              assert.equal(parsed.item.identityStatus, "unassigned");
              assert.equal(parsed.legacy.knowledgeId, null);
              assert.equal(fs.existsSync(path.join(target, "scripts/Tools/.unassigned.sh.pkm.json")), false);
            }
          }
          const reads = traffic.slice(start).filter(item => item.direction === "send");
          assert(reads.length > 0 && reads.every(item => item.message.type === "invoke" &&
            ["library-list", "library-get"].includes(item.message.operation)), "Library commands may issue only read IPC");
          assert(reads.some(item => item.message.operation === "library-list" && item.message.args.offset > 0),
            "Real Prompt inventory must exercise pinned pagination");
          assert(reads.some(item => item.message.operation === "library-get" && item.message.args.offset === 65536),
            "Real library bytes must exercise continuation chunks");
          const beforeRefusal = traffic.length, beforePreviews = libraryPreviews.length;
          libraryPath = "scripts/Tools/oversize.txt";
          try { await vscode.commands.executeCommand("personalKnowledge.nextTrialScripts"); }
          finally { libraryPath = undefined; }
          assert.equal(libraryPreviews.length, beforePreviews);
          assert.equal(errors.length, 1);
          assert.match(errors.shift(), /limited to 1 MiB/);
          assert(!traffic.slice(beforeRefusal).some(item => item.direction === "send" && item.message.operation === "library-get"),
            "Oversize UI refusal must precede any content read");
          const libraryPin = JSON.parse(libraryPreviews.at(-1).slice(libraryPreviews.at(-1).indexOf("{"))).snapshotRevision;
          const promptPath = "prompts/Original/Task/v1/zz-prompt.jinja2";
          const promptDigest = createHash("sha256").update(libraryBytes.get(promptPath)).digest("hex");
          for (const binding of [
            { path: promptPath, expectedDigest: "0".repeat(64), snapshotRevision: libraryPin },
            { path: promptPath, expectedDigest: promptDigest, snapshotRevision: "0".repeat(64) },
            { path: "prompts/../escape", expectedDigest: promptDigest, snapshotRevision: libraryPin },
          ]) {
            const refused = await childRequest(children.at(-1), { type: "invoke", operation: "library-get",
              args: { area: "prompts", ...binding } });
            assert(refused.result?.error || refused.error, "Invalid Prompt/Script binding must fail closed");
          }
          assert.equal(fs.existsSync(path.join(target, "MUST_NOT_EXECUTE")), false);
          const librarySnapshot = files => Object.fromEntries(Object.entries(files).filter(([file]) => /^(prompts|scripts)\//.test(file)));
          assert.deepEqual(librarySnapshot(snapshot(target)), librarySnapshot(beforeReads), "Prompt/Script browsing must leave all library bytes unchanged");
          if (attachedReadOnly) assert.deepEqual(snapshot(target), beforeReads, "Read-only attach must leave all target bytes unchanged");
          assert.deepEqual(snapshot(source, false, true), sourceBefore, "Original source bytes, modes, directories and timestamps must remain unchanged");
        };
        await checkLibrary(true);
        const checkArchive = async (attachedReadOnly = false) => {
          const before = snapshot(target), start = traffic.length;
          for (const area of archiveAreas) {
            archiveArea = area;
            for (const relative of [...archiveBytes.keys()].filter(file => file.startsWith(`${area}/`)).concat(`${area}/Empty`)) {
              libraryPath = relative;
              try { await vscode.commands.executeCommand("personalKnowledge.nextTrialCodeArchive"); }
              finally { libraryPath = undefined; }
              assert.deepEqual(errors, []);
              const text = archivePreviews.at(-1), parsed = JSON.parse(text.slice(text.indexOf("{")));
              assert.equal(parsed.item.path, relative);
              assert.equal(parsed.item.identityStatus, "not-applicable");
              assert.equal(parsed.item.prompt, null);
              assert.equal(parsed.item.scriptIdentity, null);
              assert.equal(parsed.preservedStoragePath, `legacy-code-archive/${relative}`);
              assert.match(text, /NOT installed; execution NOT authorized; runtime NOT verified/);
              assert.match(text, /Trusted workspace automatic Action trust policy is unchanged/);
              if (area === "action-state") {
                assert.equal(parsed.archivePolicy, "archive_only");
                assert.equal(parsed.authorizationStatus, "not-inherited");
                assert.equal(parsed.originalSourcePath, archiveSourcePath(relative));
                assert.match(text, /do NOT describe current runtime state/);
                assert.match(text, /No authorization is restored/);
              }
              if (archiveBytes.has(relative)) {
                const bytes = archiveBytes.get(relative);
                assert.deepEqual(Buffer.from(parsed.raw, parsed.encoding), bytes);
                assert.equal(parsed.item.sha256, createHash("sha256").update(bytes).digest("hex"));
                assert.equal(parsed.legacy, null);
                assert.deepEqual(fs.readFileSync(path.join(target, "legacy-code-archive", relative)), bytes);
                assert.equal(fs.statSync(path.join(target, "legacy-code-archive", relative)).mode & 0o777,
                  fs.statSync(path.join(source, archiveSourcePath(relative))).mode & 0o777, "Inert preserved file mode is evidence, not execution authority");
              } else {
                assert.equal(parsed.item.kind, "directory");
                assert.equal(fs.statSync(path.join(target, "legacy-code-archive", relative)).mode & 0o777,
                  fs.statSync(path.join(source, archiveSourcePath(relative))).mode & 0o777);
              }
            }
            assert.equal(fs.existsSync(path.join(target, area)), false, "Inert archive must never occupy an active runtime root");
            if (area === "action-state")
              assert.equal(fs.existsSync(path.join(target, ".pkm/state/actions")), false, "Historical Action state must never become native runtime authority or grants");
          }
          archiveArea = undefined;
          const reads = traffic.slice(start).filter(item => item.direction === "send");
          assert(reads.length && reads.every(item => item.message.type === "invoke" &&
            ["library-list", "library-get"].includes(item.message.operation)), "Archive inspection cannot install, register, grant or execute");
          for (const area of archiveAreas) {
            const relative = area === "action-state" ? "action-state/grants.json" : `${area}/Fixture/never.py`;
            const original = archiveBytes.get(relative);
            const listing = await childRequest(children.at(-1), { type: "invoke", operation: "library-list",
              args: { area, offset: 0, limit: 50 } });
            const binding = { path: relative, snapshotRevision: listing.result.result.snapshotRevision,
              expectedDigest: createHash("sha256").update(original).digest("hex") };
            for (const invalid of [
              { ...binding, expectedDigest: "0".repeat(64) },
              { ...binding, snapshotRevision: "0".repeat(64) },
              { ...binding, path: `${area}/../notes/Import.md` },
              { ...binding, path: `legacy-code-archive/${relative}` },
              ...(area === "action-state" ? [{ ...binding, path: ".pkm/state/actions/grants.json" }] : []),
            ]) {
              const refused = await childRequest(children.at(-1), { type: "invoke", operation: "library-get",
                args: { area, ...invalid } });
              assert(refused.result?.error || refused.error, "Invalid archive binding must fail closed");
            }
            const stillOpen = await childRequest(children.at(-1), { type: "invoke", operation: "library-list",
              args: { area, offset: 0, limit: 50 } });
            assert(Array.isArray(stillOpen.result?.result?.items), "Refused archive requests must not poison valid reads");
          }
          const stableSnapshot = files => Object.fromEntries(Object.entries(files).filter(([file]) =>
            attachedReadOnly || !/^core\.sqlite-(wal|shm)$/.test(file)));
          assert.deepEqual(stableSnapshot(snapshot(target)), stableSnapshot(before),
            "Archive browsing changes no target files; an authorized live writer may refresh its SQLite lease sidecars");
          assert.deepEqual(snapshot(source, false, true), sourceBefore);
          assert.equal(fs.statSync(path.join(target, "legacy-code-archive")).mode & 0o777, 0o700);
        };
        await checkArchive(true);
        console.log("Trial Electron: protected inert packages/actions/components/module-set and archive_only Action state history verified without inherited authority, installation or execution");
        console.log("Trial Electron: Prompt versions, metadata, Script aliases/unassigned identities, binary/chunked bytes and pagination verified without execution");
        assert.deepEqual(snapshot(target), targetBefore, "Recipe list/details must not change imported target");
        console.log("Trial Electron: original ProjectStore global/project Recipe mapping, pinned details and preserved source verified");
        assert.deepEqual(snapshot(target), targetBefore, "Structured read models must not mutate imported target");
        console.log("Trial Electron: structured Research/Skills identities, original metadata, related fields and body verified");
        const staleBoard = await childRequest(importedChild, { type: "invoke", operation: "board-tasks",
          args: { board_slug: "LegacyBoard", expected_digest: "0".repeat(64), limit: 50 } });
        assert(staleBoard.error || staleBoard.result?.error, "Stale Board digest must fail");
        const unsafeBoard = await childRequest(importedChild, { type: "invoke", operation: "board-get",
          args: { board_slug: "../outside" } });
        assert(unsafeBoard.error || unsafeBoard.result?.error);
        assert.deepEqual(snapshot(target), targetBefore, "Board reads and refused requests must not write target files");
        console.log("Trial Electron: original Board summary, paginated tasks, Stories and read-only rejection verified");
        const checkResource = async (area, filename, expected) => {
          resourceArea = area; resourcePath = filename;
          try { await vscode.commands.executeCommand("personalKnowledge.nextTrialResources"); }
          finally { resourceArea = undefined; }
          assert.deepEqual(errors, []);
          const text = resourcePreviews.at(-1), digest = createHash("sha256").update(expected).digest("hex");
          assert(text.includes(`Digest: sha256:${digest}`));
          assert(text.includes(`Area: ${area}`));
          assert(text.includes(`Size: ${expected.length}`));
          const hex = text.split("\n").filter(line => /^[a-f0-9]{8}  /.test(line)).map(line => line.slice(10).replace(/ /g, "")).join("");
          assert.deepEqual(Buffer.from(hex, "hex"), expected, "Real binary bytes must round-trip through UI chunks and safe hex preview");
        };
        for (const area of ["notes", "skills", "papers"]) await checkResource(area, "data.bin", binaryResource);
        await checkResource("notes", "pixel.png", pngResource);
        await checkResource("papers", "empty.bin", Buffer.alloc(0));
        const readsBeforeLarge = sent().filter(message => message.operation === "asset-get").length;
        resourceArea = "notes"; resourcePath = "large.bin";
        await vscode.commands.executeCommand("personalKnowledge.nextTrialResources");
        resourceArea = undefined;
        assert.match(errors.pop(), /limited to 1 MiB/);
        assert.equal(sent().filter(message => message.operation === "asset-get").length, readsBeforeLarge);
        assert.deepEqual(snapshot(target), targetBefore, "Resource UI must not mutate imported files");
        console.log("Trial Electron: notes/skills/papers binary chunks, PNG, empty resource and size refusal verified");
        await vscode.commands.executeCommand("personalKnowledge.nextTrialDocuments");
        assert.equal(previews.at(-1), "Synthetic Electron import\n");
        const rejection = await childRequest(importedChild, { type: "invoke", operation: "create",
          args: { id: "forbidden", operationId: randomUUID(), title: "Forbidden", content: "must not write" } });
        assert(rejection.error || rejection.result?.error, "Server must reject direct IPC write in read-only mode");
        assert.deepEqual(snapshot(target), targetBefore, "Read-only reads/refused write must not change any target file");
        editorJourney = true; editorArea = "skills";
        try {
          const before = traffic.length;
          await vscode.commands.executeCommand("personalKnowledge.nextTrialEditDocument");
          await vscode.commands.executeCommand("personalKnowledge.nextTrialPublishDocument");
          assert.match(errors.pop(), /Focus an isolated trial draft/);
          assert(!traffic.slice(before).some(item => item.direction === "send" && /-(create|update)$/.test(item.message.operation ?? "")),
            "Read-only document preview must not acquire publication authority");
          assert.deepEqual(snapshot(target), targetBefore);
        } finally { editorJourney = false; }
        declineWrite = true;
        await vscode.commands.executeCommand("personalKnowledge.nextTrialEnableWrite");
        assert(!sent().some(message => message.type === "enable-import-write"), "Declined authorization must not enable writes");
        declineWrite = false;
        inputs.push("/wrong-target");
        await vscode.commands.executeCommand("personalKnowledge.nextTrialEnableWrite");
        assert.match(errors.pop(), /Target confirmation did not match/);
        assert(!sent().some(message => message.type === "enable-import-write"));
        inputs.push(path.join(importParent, "workspace"));
        await vscode.commands.executeCommand("personalKnowledge.nextTrialEnableWrite");
        assert.deepEqual(errors, []);
        const enabling = sent().find(message => message.type === "enable-import-write");
        assert.equal(enabling.confirmTarget, target);
        assert.equal(enabling.acknowledgeIsolatedExperiment, true);
        const replaceEditor = async content => {
          const document = vscode.window.activeTextEditor.document;
          const edit = new vscode.WorkspaceEdit();
          edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), content);
          assert(await vscode.workspace.applyEdit(edit));
          assert.equal(document.getText(), content);
          return document;
        };
        editorJourney = true;
        try {
          for (const area of ["notes", "skills", "papers"]) {
            editorArea = area; editorCreate = false;
            const before = await childRequest(importedChild, { type: "invoke", operation: "metadata-get", args: { id: `editable-${area}` } });
            await vscode.commands.executeCommand("personalKnowledge.nextTrialEditDocument");
            const body = await replaceEditor(`Edited ${area} body.\nSecond line {{ not rendered }}.\n`);
            await vscode.commands.executeCommand("personalKnowledge.nextTrialDocumentFields");
            const changes = area === "notes" ? { tags: ["updated"], pinned: true } :
              area === "skills" ? { priority: "highest", recipe_hint: "Edited native hint" } :
                { authors: ["Edited author"], conclusions: ["Edited conclusion"] };
            await replaceEditor(JSON.stringify(changes, null, 2));
            if (area === "notes") {
              const beforeCancel = traffic.length;
              declineDraft = true;
              await vscode.commands.executeCommand("personalKnowledge.nextTrialPublishDocument");
              declineDraft = false;
              assert(!traffic.slice(beforeCancel).some(item => item.direction === "send"), "Cancelled publication sends no write");
              assert.equal(body.getText(), `Edited ${area} body.\nSecond line {{ not rendered }}.\n`);
            }
            await vscode.commands.executeCommand("personalKnowledge.nextTrialPublishDocument");
            assert.deepEqual(errors, [], "Native publish must use the existing isolated experiment authorization");
            const after = await childRequest(importedChild, { type: "invoke", operation: "metadata-get", args: { id: `editable-${area}` } });
            const original = before.result.result.metadata, updatedMetadata = after.result.result.metadata;
            assert.equal(updatedMetadata.knowledgeId, original.knowledgeId);
            assert.equal(updatedMetadata.documentId, original.documentId);
            assert.deepEqual(updatedMetadata.customOriginal, original.customOriginal);
            for (const alias of original.aliases) assert(updatedMetadata.aliases.includes(alias));
            for (const [field, value] of Object.entries(changes)) assert.deepEqual(updatedMetadata[field], value);
            const updated = await childRequest(importedChild, { type: "invoke", operation: "get", args: { id: `editable-${area}` } });
            assert.equal(updated.result.result.content, body.getText());
            assert.equal(updated.result.result.revision, 4);
            nativeEdited.push({ id: `editable-${area}`, area, content: body.getText(), knowledgeId: original.knowledgeId });
            editorCreate = true;
            inputs.push(`Native Electron ${area}`, "Native Category");
            await vscode.commands.executeCommand("personalKnowledge.nextTrialEditDocument");
            await replaceEditor(`Created native ${area}\nwith multiple lines.\n`);
            await vscode.commands.executeCommand("personalKnowledge.nextTrialPublishDocument");
            assert.deepEqual(errors, []);
            const listing = await childRequest(importedChild, { type: "invoke", operation: "list", args: { area, limit: 100 } });
            const created = listing.result.result.items.find(item => item.path === `Native Category/Native Electron ${area}.md`);
            assert(created, "Native create must select canonical area/category/path and identity");
            nativeEdited.push({ id: created.id, area, content: `Created native ${area}\nwith multiple lines.\n` });
          }
          editorCreate = false; editorArea = "skills";
          await vscode.commands.executeCommand("personalKnowledge.nextTrialEditDocument");
          const retained = await replaceEditor("My stale multiline draft\nmust remain available\n");
          const current = await childRequest(importedChild, { type: "invoke", operation: "get", args: { id: "editable-skills" } });
          const changed = await childRequest(importedChild, { type: "invoke", operation: "update", args: {
            id: "editable-skills", operationId: randomUUID(), title: current.result.result.title,
            content: "Concurrent isolated editor content\n", expectedRevision: current.result.result.revision, expectedSha256: current.result.result.sha256,
          } });
          assert(changed.result.result);
          await vscode.commands.executeCommand("personalKnowledge.nextTrialPublishDocument");
          assert.match(errors.pop(), /CONFLICT/);
          assert.equal(retained.getText(), "My stale multiline draft\nmust remain available\n");
          const beforeRetry = traffic.length;
          await vscode.commands.executeCommand("personalKnowledge.nextTrialPublishDocument");
          assert.match(errors.pop(), /blocked/);
          assert(!traffic.slice(beforeRetry).some(item => item.direction === "send"), "Rejected draft must never auto-rebase or replay");
          nativeEdited.find(item => item.id === "editable-skills").content = "Concurrent isolated editor content\n";
          editorArea = "papers";
          await vscode.commands.executeCommand("personalKnowledge.nextTrialEditDocument");
          const invalidBody = await replaceEditor("Retained body after invalid Research metadata\n");
          await vscode.commands.executeCommand("personalKnowledge.nextTrialDocumentFields");
          await replaceEditor('{"authors":"not an array"}');
          const beforeInvalid = snapshot(target);
          await vscode.commands.executeCommand("personalKnowledge.nextTrialPublishDocument");
          assert.match(errors.pop(), /INVALID_ARGUMENT/);
          assert.equal(invalidBody.getText(), "Retained body after invalid Research metadata\n");
          assert.deepEqual(snapshot(target), beforeInvalid, "Native metadata validation must reject before any file effect");
          assert.deepEqual(snapshot(source, false, true), sourceBefore);
          console.log("Trial Electron: native Notes/Skills/Research multiline edits, structured metadata, categorized create, identity preservation and retained CAS conflict verified");
        } finally { editorJourney = false; editorCreate = false; }
        inputs.push("Electron created", "Synthetic created");
        picks.push("Create document");
        await vscode.commands.executeCommand("personalKnowledge.nextTrialDocuments");
        const old = await childRequest(importedChild, { type: "invoke", operation: "get", args: { id: "electron-import" } });
        inputs.push("Synthetic Electron updated");
        picks.push("List and edit documents");
        await vscode.commands.executeCommand("personalKnowledge.nextTrialDocuments");
        assert.deepEqual(errors, []);
        const stale = await childRequest(importedChild, { type: "invoke", operation: "update", args: {
          id: "electron-import", title: old.result.result.title, content: "Must not overwrite",
          operationId: randomUUID(), expectedRevision: old.result.result.revision, expectedSha256: old.result.result.sha256,
        } });
        assert(stale.result?.error || stale.error, "Stale CAS must fail");
        const updated = await childRequest(importedChild, { type: "invoke", operation: "get", args: { id: "electron-import" } });
        assert.equal(updated.result.result.content, "Synthetic Electron updated");
        const stopped = new Promise(resolve => importedChild.once("exit", (code, signal) => resolve({ code, signal })));
        await vscode.commands.executeCommand("personalKnowledge.nextTrialClose");
        assert.deepEqual(await stopped, { code: 0, signal: null });
        assert(traffic.some(item => item.child === importedChild && item.message.type === "closed"));
        dialogs.push(vscode.Uri.file(node));
        await vscode.commands.executeCommand("personalKnowledge.nextTrialResumeWrite");
        assert.deepEqual(errors, []);
        const resumedChild = children.at(-1);
        assert.notEqual(resumedChild, importedChild);
        const persisted = await childRequest(resumedChild, { type: "invoke", operation: "get", args: { id: "electron-import" } });
        assert.equal(persisted.result.result.content, "Synthetic Electron updated");
        const persistedList = await childRequest(resumedChild, { type: "invoke", operation: "list", args: { limit: 100 } });
        assert(persistedList.result.result.items.length >= 5);
        await checkBoards();
        await checkStructured();
        await checkRecipes();
        await checkLibrary();
        await checkArchive();
        for (const expected of nativeEdited) {
          const persisted = await childRequest(resumedChild, { type: "invoke", operation: "get", args: { id: expected.id } });
          assert.equal(persisted.result.result.content, expected.content);
          assert.equal(persisted.result.result.area, expected.area);
          if (expected.knowledgeId) {
            const metadata = await childRequest(resumedChild, { type: "invoke", operation: "metadata-get", args: { id: expected.id } });
            assert.equal(metadata.result.result.metadata.knowledgeId, expected.knowledgeId);
          }
        }
        await checkResource("skills", "data.bin", binaryResource);
        const resumedExit = new Promise(resolve => resumedChild.once("exit", (code, signal) => resolve({ code, signal })));
        await vscode.commands.executeCommand("personalKnowledge.nextTrialClose");
        assert.deepEqual(await resumedExit, { code: 0, signal: null });
        const tampered = path.join(target, "unexpected-file");
        fs.writeFileSync(tampered, "Synthetic tampering after clean close");
        dialogs.push(vscode.Uri.file(node));
        await vscode.commands.executeCommand("personalKnowledge.nextTrialResumeWrite");
        assert(errors.length, "Changed experiment must fail closed on resume");
        errors.splice(0);
        assert.deepEqual(inputs, []);
        assert.deepEqual(picks, []);
        console.log("Trial Electron: isolated_experiment authorization, CAS conflict, clean restart and tamper refusal verified");
      }
      assert.deepEqual(snapshot(source, false, true), sourceBefore);
      assert.deepEqual(snapshot(legacy, true), legacyBefore, "Import must leave legacy fixture data unchanged (excluding live host heartbeat)");
      assert.deepEqual(dialogs, []);
      console.log(`Trial Electron: static-copy ${scenario} verified`);
    }
    assert.equal(previews.length, 2);
    assert.equal(resourcePreviews.length, 6);
    assert.equal(boardPreviews.length, 8);
    assert.equal(structuredPreviews.length, 4);
    assert.equal(recipePreviews.length, 4);
    assert.equal(libraryPreviews.length, 16);
    assert.equal(archivePreviews.length, 70);
    assert.deepEqual(errors, []);
    let actionInstalledPassed = false, skillsInstalledPassed = false, memoryInstalledPassed = false;
    if (process.env.PKM_TRIAL_ACTIONS_INSTALLED === "1") {
      const sources = ["blocked", "refused", "import"].map(name => path.join(root, `copy-${name}`));
      const sourceSnapshots = sources.map(source => snapshot(source, false, true));
      await require(path.join(extensionPath, "trial-action-test.cjs")).run({ root, node, extensionPath, legacy, vscode });
      for (let index = 0; index < sources.length; index++)
        assert.deepEqual(snapshot(sources[index], false, true), sourceSnapshots[index], "Actions must not modify synthetic import sources.");
      assert.deepEqual(snapshot(legacy, true), legacyBefore, "Actions must not modify the existing Knowledge Root.");
      console.log("Trial Electron: synthetic source snapshots and existing Knowledge Root remained unchanged after Actions");
      actionInstalledPassed = true;
      await require(path.join(extensionPath, "trial-skills-test.cjs")).run({ root, extensionPath, legacy, python, vscode });
      for (let index = 0; index < sources.length; index++)
        assert.deepEqual(snapshot(sources[index], false, true), sourceSnapshots[index], "Skills indexing must not modify synthetic import sources.");
      skillsInstalledPassed = true;
      await require(path.join(extensionPath, "trial-memory-test.cjs")).run({ root, node, python, extensionPath, legacy, vscode, children, traffic });
      for (let index = 0; index < sources.length; index++)
        assert.deepEqual(snapshot(sources[index], false, true), sourceSnapshots[index], "Memory import must not modify the other synthetic import sources.");
      memoryInstalledPassed = true;
    }
    fs.writeFileSync(path.join(root, "passed.json"), JSON.stringify({
      passed: true, importPassed: true, writePassed: true, resourcesPassed: true, boardsPassed: true, structuredPassed: true, recipesPassed: true,
      libraryPassed: true, nativeEditorPassed: true, codeArchivePassed: true, actionStateArchivePassed: true, actionInstalledPassed, skillsInstalledPassed, memoryInstalledPassed,
    }), { flag: "wx" });
  } finally {
    if (children.some(child => child.exitCode === null && child.signalCode === null)) {
      await vscode.commands.executeCommand("personalKnowledge.nextTrialClose");
    }
    for (const undo of restore.reverse()) undo();
  }
};

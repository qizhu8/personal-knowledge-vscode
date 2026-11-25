import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { initialize, Storage } from "../dist/storage.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { legacyKnowledgeWrite } from "../dist/legacy-knowledge-write.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
for (const profile of ["compact", "legacy"]) test(`original write signatures use native CAS journal (${profile})`,
  { timeout: 60_000 }, async t => {
    const parent = await mkdtemp(join(root, "tests/.pkm-knowledge-write-"));
    let client;
    t.after(async () => { try { await client?.close(); } finally { await rm(parent, { recursive: true, force: true }); } });
    const data = await initialize(join(parent, "workspace"));
    client = new Client({ name: "knowledge-write", version: "1.0.0" });
    await client.connect(new StdioClientTransport({
      command: "python3", args: [join(root, "compat/legacy-compact-mcp.py"), "--data", data,
        "--node", process.execPath, "--allow-writes"],
      env: { ...process.env, PKM_CAPABILITY_PROFILE: profile, PYTHONDONTWRITEBYTECODE: "1" },
      stderr: "pipe",
    }));
    const invoke = async (name, args) => client.callTool({ name, arguments: args });
    const success = async (name, args, expected) => {
      const result = await invoke(name, args);
      assert.notEqual(result.isError, true, JSON.stringify(result));
      assert.deepEqual(JSON.parse(result.content[0].text), expected);
      return result;
    };
    for (const [kind, name, args] of [
      ["note", "Note", { title: "Note", content: "Original", tags: ["first"] }],
      ["skill", "Skill", { name: "Skill", content: "Original", recipe_required: true }],
      ["paper", "Paper", { title: "Paper", content: "Original", year: 2026 }],
    ]) {
      const expected = kind === "skill" ? { ok: true, name } : { ok: true, slug: `Folder/${name}` };
      await success(`add_${kind}`, { ...args, category: "Folder" }, expected);
      await success(`update_${kind}`, { [kind === "skill" ? "name" : "slug"]: kind === "skill" ? name : `Folder/${name}`,
        content: "Revised" }, expected);
      const area = kind === "note" ? "notes" : kind === "skill" ? "skills" : "papers";
      const path = join(data, area, "Folder", `${name}.md`);
      const raw = await readFile(path, "utf8");
      assert.match(raw, /knowledgeId: "knowledge_[a-f0-9]{24}"/);
      assert.match(raw, /Revised/);
      await mkdir(join(data, area, "Folder", `${name}.assets`));
      const payload = Buffer.from([255, 0, 128, 9]);
      await writeFile(join(data, area, "Folder", `${name}.assets`, "opaque.bin"), payload);
      const movedExpected = kind === "skill" ? { ok: true, name } : { ok: true, slug: `Elsewhere/${name}` };
      await success(`update_${kind}`, {
        [kind === "skill" ? "name" : "slug"]: kind === "skill" ? name : `Folder/${name}`, category: "Elsewhere",
      }, movedExpected);
      await assert.rejects(readFile(path), { code: "ENOENT" });
      const movedRaw = await readFile(join(data, area, "Elsewhere", `${name}.md`), "utf8");
      assert.equal(/knowledgeId: ("knowledge_[a-f0-9]{24}")/.exec(movedRaw)[1], /knowledgeId: ("knowledge_[a-f0-9]{24}")/.exec(raw)[1]);
      assert.deepEqual(await readFile(join(data, area, "Elsewhere", `${name}.assets`, "opaque.bin")), payload);
      await success(`update_${kind}`, {
        [kind === "skill" ? "name" : "slug"]: kind === "skill" ? name : `Elsewhere/${name}`, category: "Folder",
      }, expected);
      if (kind === "skill") await success("add_skill", { ...args, category: "Folder", content: "Overwrite preserves identity" }, expected);
    }
    await success("add_note", { title: "Note", content: "Duplicate", category: "Folder" },
      { error: "Note 'Folder/Note' already exists. Use update_note instead." });
    await success("update_note", { slug: "missing", content: "x" }, { error: "Note 'missing' not found." });
    for (const kind of ["note", "paper", "skill"]) {
      const nameArg = kind === "skill" ? "name" : "title";
      const result = kind === "skill" ? { ok: true, name: "Sanitized" } : { ok: true, slug: "Folder/Sanitized" };
      await success(`add_${kind}`, { [nameArg]: "Sanitized", category: "Folder", content: "First" }, result);
      const area = kind === "note" ? "notes" : kind === "skill" ? "skills" : "papers";
      const path = join(data, area, "Folder/Sanitized.md");
      const original = await readFile(path, "utf8");
      await success(`add_${kind}`, { [nameArg]: "Sanitized?", category: "Folder", content: "Overwrite preserves identity" },
        kind === "skill" ? { ok: true, name: "Sanitized?" } : result);
      const updated = await readFile(path, "utf8");
      assert.equal(/knowledgeId: ("knowledge_[a-f0-9]{24}")/.exec(updated)[1], /knowledgeId: ("knowledge_[a-f0-9]{24}")/.exec(original)[1]);
      assert.match(updated, /revision: 2/);
      assert.match(updated, /Overwrite preserves identity/);
    }
    const denied = await invoke("add_note", { title: "Unsafe", content: "x", category: "System" });
    assert.equal(denied.isError, true);
    const spoof = await invoke("add_note", { title: "Spoof", content: "x", actorId: "local:owner" });
    assert.equal(spoof.isError, true);
  });

test("legacy write adapter pins source CAS before dispatch and never retries a competing edit", { timeout: 20_000 }, async t => {
  const parent = await mkdtemp(join(root, "tests/.pkm-knowledge-write-cas-"));
  const data = await initialize(join(parent, "workspace"));
  const storage = await Storage.open(data);
  const native = await createNativeRuntime({ storage });
  t.after(async () => { try { await native.close(); await storage.close(); }
    finally { await rm(parent, { recursive: true, force: true }); } });
  const actor = { id: "mcp:external", canWrite: true };
  await legacyKnowledgeWrite(native.core, storage, actor, {
    tool: "add_note", arguments: { title: "Pinned", content: "Before" },
  });

  const path = join(data, "notes", "Pinned.md");
  const before = await readFile(path, "utf8");
  let dispatches = 0;
  const racingCore = { async dispatch(method, input, principal) {
    dispatches++;
    await writeFile(path, before.replace("Before", "Competing edit"));
    return native.core.dispatch(method, input, principal);
  } };
  await assert.rejects(legacyKnowledgeWrite(racingCore, storage, actor, {
    tool: "update_note", arguments: { slug: "Pinned", content: "Must not commit" },
  }), /CONFLICT/);
  assert.equal(dispatches, 1);
  assert.equal(await readFile(path, "utf8"), before.replace("Before", "Competing edit"));
});

test("sanitized Skill overwrite pins exact destination CAS and preserves external edits without retry", { timeout: 20_000 }, async t => {
  const parent = await mkdtemp(join(root, "tests/.pkm-skill-write-cas-"));
  const data = await initialize(join(parent, "workspace")), storage = await Storage.open(data);
  const native = await createNativeRuntime({ storage });
  t.after(async () => { try { await native.close(); await storage.close(); }
    finally { await rm(parent, { recursive: true, force: true }); } });
  const actor = { id: "mcp:external", canWrite: true };
  await legacyKnowledgeWrite(native.core, storage, actor, { tool: "add_skill", arguments: { name: "Pinned", content: "Before" } });
  const path = join(data, "skills/Pinned.md"), before = await readFile(path, "utf8");
  let dispatches = 0;
  const racingCore = { async dispatch(method, input, principal) {
    dispatches++;
    await writeFile(path, before.replace("Before", "Competing Skill edit"));
    return native.core.dispatch(method, input, principal);
  } };
  await assert.rejects(legacyKnowledgeWrite(racingCore, storage, actor, {
    tool: "add_skill", arguments: { name: "Pinned?", content: "Must not commit" },
  }), /CONFLICT/);
  assert.equal(dispatches, 1);
  assert.equal(await readFile(path, "utf8"), before.replace("Before", "Competing Skill edit"));
});

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";
import { legacyInlineNoteSourcePins } from "../dist/legacy-inline-note-contracts.js";
import { LEGACY_INLINE_NOTE_JOURNAL_DDL } from "../dist/legacy-inline-note-journal.js";
import { createNativeLegacyInlineNoteHost } from "../dist/legacy-inline-note-native.js";

export const packageRoot = fileURLToPath(new URL("../legacy/", import.meta.url));
export const at = "2026-11-07T16:30:34.625Z";
export const actor = { id: "mcp:external", canWrite: true, collaborationKind: "agent" };
export const human = { id: "user:alice", canWrite: true, collaborationKind: "human" };
export const item = { id: "one", title: "Exact original inline task", goal: "Keep original semantics",
  scope: "Inline Markdown only", acceptance: ["Full snapshot and byte parity"], state: "Planning", evidence: [] };
export const markdown = "\uFEFF---\r\ntitle: \"Original\"\r\nknowledgeId: original-note-stable-id\r\nunknown:\r\n  preserve: [opaque, 3]\r\ndescription: |\r\n  ~~~pkm-work-item\r\n  YAML scalar is not a block\r\n  ~~~\r\n---\r\n# Original body\r\n\r\n````markdown\r\n~~~pkm-work-item\r\nnot JSON\r\n~~~\r\n````\r\n\r\nKeep [evidence](Original.assets/evidence.txt).\r\n";
export const hash = value => createHash("sha256").update(value).digest("hex");

export function originalCapture() {
  for (const [relative, digest] of Object.entries(legacyInlineNoteSourcePins))
    assert.equal(hash(readFileSync(join(packageRoot, relative))), digest, `source pin: ${relative}`);
  class CaptureDate extends Date {
    constructor(...args) { super(...(args.length ? args : [at])); }
    static now() { return Date.parse(at); }
  }
  function load(relative, overrides = {}) {
    const filename = join(packageRoot, relative);
    const require = createRequire(join(packageRoot, "dist/knowledge/filestore.js"));
    const module = { exports: {} };
    const javascript = ts.transpileModule(readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    runInNewContext(javascript, {
      module, exports: module.exports, require: id => overrides[id] ?? require(id),
      Date: CaptureDate, Buffer, console, process, setTimeout, clearTimeout,
    }, { filename });
    return module.exports;
  }
  const parser = load("src/knowledge/note-work-items.ts");
  const writer = load("src/knowledge/filestore.ts", { "./note-work-items": parser });
  return { parser, writer };
}
export async function fixture(t, initial = markdown, policyPatch = {}) {
  const parent = join(dirname(fileURLToPath(import.meta.url)), `.legacy-inline-note-captures-${randomUUID()}`);
  const root = join(parent, "native");
  const originalRoot = join(parent, "original");
  await mkdir(join(root, "notes"), { recursive: true });
  await mkdir(join(originalRoot, "notes"), { recursive: true });
  await mkdir(join(root, "notes/Original.assets"));
  await mkdir(join(originalRoot, "notes/Original.assets"));
  await writeFile(join(root, "notes/Original.assets/evidence.txt"), "source capture evidence");
  await writeFile(join(originalRoot, "notes/Original.assets/evidence.txt"), "source capture evidence");
  await writeFile(join(root, "notes/Original.md"), initial);
  await writeFile(join(originalRoot, "notes/Original.md"), initial);
  const databasePath = join(parent, "journal.sqlite");
  let database = new DatabaseSync(databasePath);
  database.exec(LEGACY_INLINE_NOTE_JOURNAL_DDL);
  const policy = {
    admissions: [{ slug: "Original", sourceMarkdownDigest: hash(initial) }],
    authorize: who => who.id === human.id && who.collaborationKind === "human" ? { id: who.id, role: "user" }
      : who.id === actor.id && who.collaborationKind === "agent" ? { id: who.id, role: "worker" } : undefined,
    assertFocus: async () => {},
    assertNoLegacySyncEffects: async () => {},
    ...policyPatch,
  };
  let locked = false;
  const withDurableFence = async (_id, work) => {
    assert.equal(locked, false, "native owner serializes entire workspace");
    locked = true;
    try { return await work(); } finally { locked = false; }
  };
  const open = () => createNativeLegacyInlineNoteHost({ database, root, policy, withDurableFence, now: () => at });
  let runtime = open();
  t.after(async () => { database.close(); await rm(parent, { recursive: true, force: true }); });
  return {
    parent, root, originalRoot, policy, databasePath, withDurableFence,
    get database() { return database; }, get runtime() { return runtime; },
    restart() { database.close(); database = new DatabaseSync(databasePath); runtime = open(); return runtime; },
    read: () => readFile(join(root, "notes/Original.md"), "utf8"),
    overwrite: value => writeFile(join(root, "notes/Original.md"), value),
    async compareOriginal(command, who = actor, operation = "legacy.note.workitems.command") {
      const { writer, parser } = originalCapture();
      const before = await this.read();
      writer.setStorePath(originalRoot);
      const expected = parser.readNoteWorkItems(before).digest;
      let original;
      if (operation.endsWith(".upsert")) {
        // Exact resources/knowledge_mutations.js:51-53 create/edit wrapper.
        const externalCommand = { action: parser.readNoteWorkItems(before).items.some(value => value.id === command.id) ? "edit" : "create", item: command };
        original = writer.noteWorkItemExternalCommand("Original", expected, externalCommand);
      } else original = writer.noteWorkItemCommand("Original", expected, command,
        { id: who.id, role: who.collaborationKind === "human" ? "user" : "worker" });
      const request = { slug: "Original", expected_digest: expected, operationId: randomUUID(),
        ...(operation.endsWith(".upsert") ? { item: command } : { command }) };
      const result = await runtime.journal.dispatch(operation, request, who);
      assert.equal(JSON.stringify(result), JSON.stringify({ ok: true, ...original }));
      assert.equal(await this.read(), await readFile(join(originalRoot, "notes/Original.md"), "utf8"));
      assert.equal(result.digest, hash(await this.read()));
      assert.equal(await readFile(join(root, "notes/Original.assets/evidence.txt"), "utf8"), "source capture evidence");
      return { result, request };
    },
  };
}

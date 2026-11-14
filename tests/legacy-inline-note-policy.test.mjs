import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { actor, human, item, markdown, hash, fixture, originalCapture } from "./legacy-inline-note-captures.mjs";
import { inspectLegacyInlineNote } from "../dist/domain/legacy-inline-note-reducer.js";
import { createNativeLegacyInlineNoteHost } from "../dist/legacy-inline-note-native.js";
import { legacyInlineNoteDefinitions } from "../dist/legacy-inline-note-contracts.js";
import { CoreError } from "../dist/contracts.js";
import { z } from "zod";
import { legacyInlineNoteItemSchema } from "../dist/legacy-inline-note-contracts.js";

const operation = "legacy.note.workitems.command";
const request = command => ({ slug: "Original", expected_digest: hash(markdown), operationId: randomUUID(), command });
const rejects = (f, input, who = actor, code) => assert.rejects(
  f.runtime.journal.dispatch(operation, input, who), error => !code || error.code === code);

test("default deny, trusted current actor, strict schemas, source evidence for non-equivalent variants", async t => {
  const f = await fixture(t);
  const input = request({ action: "create", item });
  for (const invalid of [{ ...input, role: "user" }, { ...input, command: { ...input.command, id: item.id } },
    { ...input, command: { action: "claim", id: item.id, item } }, { ...input, command: { action: "create", item: { ...item, unknown: 1 } } },
    { ...input, command: { action: "create", item: { ...item, monitoring: { until: "yesterday", endCondition: "x" } } } },
    { ...input, operationId: "not-an-id" }, { ...input, slug: "../outside" }]) await rejects(f, invalid, actor, "INVALID_ARGUMENT");
  await rejects(f, { ...input, worker_token: "a".repeat(64) }, actor, "NOT_AVAILABLE");
  await rejects(f, input, { ...actor, canWrite: false }, "ACCESS_DENIED");
  await rejects(f, input, { ...actor, id: "user:forged", collaborationKind: "human" }, "ACCESS_DENIED");
  const denied = createNativeLegacyInlineNoteHost({
    database: f.database, root: f.root, withDurableFence: f.withDurableFence,
  });
  await assert.rejects(denied.journal.dispatch(operation, input, actor), { code: "ACCESS_DENIED" });
  const oldAuthority = f.policy.authorize;
  const revoked = createNativeLegacyInlineNoteHost({
    database: f.database, root: f.root, policy: f.policy,
    withDurableFence: (id, work) => f.withDurableFence(id, async () => {
      f.policy.authorize = () => undefined;
      try { return await work(); } finally { f.policy.authorize = oldAuthority; }
    }),
  });
  await assert.rejects(revoked.journal.dispatch(operation, input, actor), { code: "ACCESS_DENIED" });
  f.policy.authorize = who => ({ id: who.id, role: "user" });
  await rejects(f, input, actor, "ACCESS_DENIED");
  f.policy.authorize = oldAuthority;
  for (const field of ["assertFocus", "assertNoLegacySyncEffects"]) {
    const saved = f.policy[field];
    delete f.policy[field];
    await rejects(f, input, actor, "NOT_AVAILABLE");
    f.policy[field] = saved;
  }
  assert.equal(await f.read(), markdown);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM legacy_inline_note_intent").get().n, 0);
  assert.equal(legacyInlineNoteDefinitions.length, 2);
  for (const definition of legacyInlineNoteDefinitions) {
    for (const io of ["input", "output"]) {
      for (const schema of [definition.input, definition.output]) {
        const jsonSchema = z.toJSONSchema(schema, { io });
        assert.equal(jsonSchema.type, "object");
        assert.equal(jsonSchema.additionalProperties, false);
        assert.doesNotThrow(() => JSON.stringify(jsonSchema));
      }
    }
  }
  const sourceItem = { ...item, icon: "eye", description: "Literal JSON ```", monitoring: { endCondition: "Explicit stop" } };
  assert.deepEqual(legacyInlineNoteItemSchema.parse(sourceItem), JSON.parse(JSON.stringify(originalCapture().parser.validateNoteWorkItem(sourceItem))));
  assert.notEqual(legacyInlineNoteItemSchema.parse(sourceItem), sourceItem);
  assert.equal(legacyInlineNoteItemSchema.safeParse({ ...item, unknown: "no loss" }).success, false);
});

test("worker protections, human-only acceptance, source original reviewer variant honestly rejected, no focus takeover", async t => {
  const f = await fixture(t);
  await f.compareOriginal({ action: "create", item: { ...item, reviewerIds: [actor.id] } }, human);
  await f.compareOriginal({ action: "claim", id: item.id });
  const { parser } = originalCapture();
  let current = parser.readNoteWorkItems(await f.read());
  for (const [field, value] of Object.entries({ title: "easier", scope: "less", acceptance: ["lower"],
    ownerId: "chat:another", reviewerIds: [], history: [] })) {
    await rejects(f, { ...request({ action: "edit", item: { ...current.items[0], [field]: value } }),
      expected_digest: current.digest }, actor, "INVALID_ARGUMENT");
  }
  await f.compareOriginal({ action: "transition", id: item.id, state: "Done", outcome: "Success", evidence: ["actual://test"] });
  current = parser.readNoteWorkItems(await f.read());
  const acceptance = { action: "accept", id: item.id, reason: "Delegated original worker review" };
  const doneBytes = await f.read();
  assert.doesNotThrow(() => parser.commandNoteWorkItem(doneBytes, current.digest, acceptance, { id: actor.id, role: "worker" }));
  await rejects(f, { ...request(acceptance), expected_digest: current.digest }, actor, "NOT_AVAILABLE");
  assert.equal(await f.read(), doneBytes);
  await f.compareOriginal(acceptance, human);
  await f.compareOriginal({ action: "create", item: { ...item, id: "next" } });
  const beforeClaim = await f.read();
  f.policy.assertFocus = async (_actor, _slug, before, after) => {
    const old = inspectLegacyInlineNote(before).items;
    const changed = inspectLegacyInlineNote(after).items;
    if (changed.some(value => value.state === "WIP" && old.find(prior => prior.id === value.id)?.state !== "WIP"))
      throw new CoreError("WORKITEM_FOCUS_CONFLICT", "Another native Board owns active focus; no takeover.");
  };
  await rejects(f, { ...request({ action: "claim", id: "next" }), expected_digest: hash(beforeClaim) }, actor, "WORKITEM_FOCUS_CONFLICT");
  assert.equal(await f.read(), beforeClaim);
  assert.equal(f.runtime.journal.inspect(), undefined);
});

test("source-pin CAS, malformed/duplicate blocks/YAML, Board authority, System and symlink admission fail closed", async t => {
  const f = await fixture(t);
  const input = request({ action: "create", item });
  await rejects(f, { ...input, expected_digest: "a".repeat(64) }, actor, "CONFLICT");
  await f.overwrite(markdown + "\r\nExternal edit\r\n");
  await rejects(f, { ...input, expected_digest: hash(await f.read()) }, actor, "CONFLICT");
  await f.overwrite(markdown);
  const { parser } = originalCapture();
  const block = parser.upsertNoteWorkItem("", hash(""), item);
  for (const invalid of [block + block, "~~~pkm-work-item\n{}\n", "~~~pkm-work-item\nnot json\n~~~\n",
    "~~~pkm-work-item\n" + JSON.stringify(item).replace('"id":"one"', '"id":"first","id":"one"') + "\n~~~\n",
    "---\ntitle: x\ntitle: y\n---\n", "---\nunclosed: true\n",
    "---\ndocumentKind: todo-board\n---\n", "~~~pkm-work-item\n" + JSON.stringify({ ...item, dependsOn: ["missing"] }) + "\n~~~\n"]) {
    assert.throws(() => inspectLegacyInlineNote(invalid));
  }
  await writeFile(join(f.root, "notes/Original.assets/pkm-todo-board.json"), "{}");
  await rejects(f, input, actor, "NOT_AVAILABLE");
  const linked = await fixture(t);
  await writeFile(join(linked.parent, "other.md"), markdown);
  const { unlink } = await import("node:fs/promises");
  await unlink(join(linked.root, "notes/Original.md"));
  await symlink(join(linked.parent, "other.md"), join(linked.root, "notes/Original.md"));
  await rejects(linked, input);
  assert.equal(await linked.read(), markdown);
});

import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const require = createRequire(import.meta.url);
const built = await require("esbuild").build({ stdin: {
  contents: `export * from "./src/original-mcp-api-chat-schema.ts";
    export * from "./src/original-mcp-native-host-receipt.ts";
    export { canonicalJson } from "./src/domain/project-recipes-workflow-contracts.ts";`,
  resolveDir: resolve("."),
}, bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent" });
const module = new Module(resolve("tests/.chat-cold-schema-memory.cjs"));
module.filename = module.id; module.paths = Module._nodeModulePaths(resolve("."));
module._compile(built.outputFiles[0].text, module.filename);
const { originalApiChatOptionalSchemaGroups: groups, originalMcpNativeHostReceiptDdl: hostDdl,
  originalMcpNativeHostReceiptDigest: digest, canonicalJson,
  verifyOriginalApiChatOptionalReadSchema: verify } = module.exports;
const schema = db => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name").all();

// SQL metadata fixtures only: no RootOwner, real native/source grant, model or human authority.
function fixture(t, selected = ["source", "requests", "images", "execution"]) {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  db.exec(hostDdl + groups.filter(group => selected.includes(group.name)).map(group => group.ddl).join("\n"));
  const journal = { workspaceId: "10000000-0000-4000-8000-000000000001",
    plan: { root: "/metadata-only/not-opened", planSha256: "a".repeat(64), profileSha256: "b".repeat(64) } };
  const body = { schema: "pkm.original-mcp-native-host-admission/v1", root: journal.plan.root,
    workspaceId: journal.workspaceId, planSha256: journal.plan.planSha256, profileSha256: journal.plan.profileSha256,
    sourceCatalogSha256: "c".repeat(64), authorityId: "metadata-only", epoch: "historical-not-live",
    actorId: "mcp:external", domains: ["api-chat-native"], configurationSha256: "d".repeat(64) };
  const host = { ...body, receiptSha256: digest(body) };
  db.prepare("INSERT INTO original_mcp_native_host_admissions VALUES(?,?)").run(host.receiptSha256, canonicalJson(host));
  const planBody = { schema: "pkm.original-api-chat-source/v1", root: journal.plan.root, workspaceId: journal.workspaceId,
    custodyPlanSha256: journal.plan.planSha256, profileSha256: journal.plan.profileSha256,
    indexPath: "/metadata-only/deleted-independent-source-stage/index.sqlite", indexSha256: "e".repeat(64),
    chats: 1, messages: 1, controls: 0, limits: { maxChats: 2, maxMessagesPerChat: 4, maxMessages: 8 } };
  const plan = { ...planBody, planSha256: digest(planBody) };
  const mutateWithTrigger = (name, work) => {
    const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(name).sql;
    db.exec(`DROP TRIGGER ${name}`);
    try { work(); } finally { db.exec(ddl); }
  };
  if (selected.includes("source")) {
    db.exec("DROP TRIGGER original_api_chat_source_chats_no_insert; DROP TRIGGER original_api_chat_source_messages_no_insert; DROP TRIGGER original_api_chat_source_library_no_insert;");
    db.prepare("INSERT INTO original_api_chat_source_admission VALUES(1,?,?,?,?)")
      .run(canonicalJson(plan), plan.planSha256, host.receiptSha256, "historical-metadata-decision");
    db.prepare("INSERT INTO original_api_chat_source_chats VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run("metadata-only", "chat-reference", "unopened.json", "f".repeat(64), "Metadata", "past", "past", 1, null, 0,
        "archive_only", "{}", "ungroup", null);
    db.prepare("INSERT INTO original_api_chat_source_messages VALUES(?,?,?,?,?)")
      .run("chat-reference", 1, "message-reference", "{}", "f".repeat(64));
    db.prepare("INSERT INTO original_api_chat_source_library VALUES(1,?)").run("{}");
    for (const table of ["original_api_chat_source_chats", "original_api_chat_source_messages", "original_api_chat_source_library"])
      db.exec(`CREATE TRIGGER ${table}_no_insert BEFORE INSERT ON ${table}
    BEGIN SELECT RAISE(ABORT,'original Chat source immutable'); END;`);
  }
  const replaceSource = (changes, serialized) => {
    const changed = { ...plan, ...changes }, { planSha256: _old, ...body } = changed;
    changed.planSha256 = digest(body);
    mutateWithTrigger("original_api_chat_source_admission_no_update", () =>
      db.prepare("UPDATE original_api_chat_source_admission SET payload=?,sha256=?")
        .run(serialized ?? canonicalJson(changed), changed.planSha256));
  };
  const replaceHost = changes => {
    const changed = { ...host, ...changes }, { receiptSha256: _old, ...body } = changed;
    changed.receiptSha256 = digest(body);
    mutateWithTrigger("original_mcp_native_host_admissions_no_update", () =>
      db.prepare("UPDATE original_mcp_native_host_admissions SET receipt_sha256=?,payload=?")
        .run(changed.receiptSha256, canonicalJson(changed)));
    mutateWithTrigger("original_api_chat_source_admission_no_update", () =>
      db.prepare("UPDATE original_api_chat_source_admission SET native_host_sha256=?").run(changed.receiptSha256));
  };
  return { db, journal, plan, host, replaceSource, replaceHost, mutateWithTrigger,
    check: () => verify(db, schema(db), journal) };
}
test("exact optional Chat groups verify historical SQL metadata read-only without the deleted source index", t => {
  for (const selected of [["source"], ["source", "requests", "images"], ["source", "requests", "images", "execution"]]) {
    const f = fixture(t, selected), before = f.db.prepare("SELECT total_changes() AS n").get().n;
    f.db.exec("PRAGMA query_only=ON;");
    const names = f.check();
    assert.ok(names.has("original_api_chat_source_admission"));
    assert.equal(names.has("original_native_chat_executions"), selected.includes("execution"));
    assert.equal(f.db.prepare("SELECT total_changes() AS n").get().n, before);
  }
});
test("missing, noncanonical or differently bound source/Host receipts fail closed", t => {
  for (const mutate of [
    f => f.mutateWithTrigger("original_api_chat_source_admission_no_delete", () =>
      f.db.exec("DELETE FROM original_api_chat_source_admission")),
    f => f.replaceSource({ workspaceId: "20000000-0000-4000-8000-000000000001" }),
    f => f.replaceSource({ root: "/metadata-only/a-different-root" }),
    f => f.replaceSource({ custodyPlanSha256: "0".repeat(64) }),
    f => f.replaceSource({ profileSha256: "0".repeat(64) }),
    f => f.replaceSource({}, JSON.stringify(f.plan)),
    f => f.replaceSource({}, "malformed-metadata-not-to-log"),
    f => f.mutateWithTrigger("original_api_chat_source_admission_no_update", () =>
      f.db.exec("UPDATE original_api_chat_source_admission SET sha256='" + "0".repeat(64) + "'")),
    f => f.mutateWithTrigger("original_mcp_native_host_admissions_no_delete", () =>
      f.db.exec("DELETE FROM original_mcp_native_host_admissions")),
    f => f.mutateWithTrigger("original_mcp_native_host_admissions_no_update", () =>
      f.db.prepare("UPDATE original_mcp_native_host_admissions SET payload=?").run(JSON.stringify(f.host))),
    f => f.replaceHost({ workspaceId: "20000000-0000-4000-8000-000000000001" }),
    f => f.replaceHost({ root: "/metadata-only/a-different-root" }),
    f => f.replaceHost({ planSha256: "0".repeat(64) }),
    f => f.replaceHost({ profileSha256: "0".repeat(64) }),
  ]) {
    const f = fixture(t); mutate(f); assert.throws(f.check, error =>
      ["RECOVERY_REQUIRED", "ACCESS_DENIED"].includes(error.code) && !error.message.includes("malformed-metadata"));
  }
  const f = fixture(t);
  assert.throws(() => verify(f.db, schema(f.db), undefined), /Historical Chat schema/);
  assert.throws(() => verify(f.db, schema(f.db), { ...f.journal, workspaceId: "20000000-0000-4000-8000-000000000001" }));
});
test("immutable source counts and message provenance must match the admitted capsule", t => {
  for (const mutate of [
    f => f.replaceSource({ chats: 0 }),
    f => f.replaceSource({ messages: 0 }),
    f => f.replaceSource({ controls: 1 }),
    f => f.mutateWithTrigger("original_api_chat_source_messages_no_update", () =>
      f.db.exec("UPDATE original_api_chat_source_messages SET chat_id='orphan'")),
  ]) {
    const f = fixture(t); mutate(f); assert.throws(f.check, /Historical Chat schema/);
  }
});
test("partial groups, standalone runtime groups and altered or unknown schema objects are refused", t => {
  for (const selected of [["requests"], ["images"], ["execution"], ["source", "images"], ["source", "execution"]]) {
    const f = fixture(t, selected); assert.throws(f.check);
  }
  for (const sql of [
    "DROP TABLE original_api_chat_source_controls",
    "DROP TABLE original_api_chat_responses",
    "DROP TRIGGER original_native_chat_events_no_update",
    "ALTER TABLE original_api_chat_requests ADD COLUMN unqualified TEXT",
    "CREATE INDEX unknown_chat_index ON original_api_chat_requests(command_id)",
    "CREATE TRIGGER unknown_chat_trigger AFTER INSERT ON original_native_chat_text BEGIN SELECT 1; END",
  ]) {
    const f = fixture(t); f.db.exec(sql); assert.throws(f.check, /optional admission DDL/);
  }
});

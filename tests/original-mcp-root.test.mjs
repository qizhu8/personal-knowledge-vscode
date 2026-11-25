import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, writeFile, readFile, readdir, rm, lstat, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import {
  captureOriginalMcpCustody, verifyOriginalMcpCustody, prepareOriginalMcpRoot,
  openOriginalMcpRoot, rollbackOriginalMcpRoot, acquireOriginalMcpRootFence,
} from "../dist/original-mcp-root.js";
import { validateWorkspace } from "../dist/workspace-validation.js";
import { RootOwner } from "../dist/root-owner.js";
import { createNativePublicOwnerBackend, nativePublicFullOptions } from "../dist/native-public-mcp-owner.js";
import { scanMarkdown, createFreshRootScanner } from "../dist/markdown-read.js";

const digest = value => createHash("sha256").update(value).digest("hex");
const limits = { maxEntries: 30_000, maxDepth: 32, maxBytes: 1_073_741_824, maxFileBytes: 536_870_912 };
const actor = { id: "mcp:external", canWrite: true };
async function fixture(t, history = 2) {
  const directory = resolve("tests", `.original-mcp-${randomUUID()}`);
  const root = join(directory, "root"), backup = join(directory, "custody");
  await mkdir(directory, { mode: 0o700 });
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const name of ["notes/public", "notes/private", "notes/.trash/deleted-note", "skills/.trash/deleted-skill",
    "papers", ".pkm/state/actions", ".pkm/state/api-chat-history", ".pkm/automation-output",
    "chatrooms", "packages", "envs", "servers", "mcp-server", "_pre-files-backup-20261118"]) {
    await mkdir(join(root, name), { recursive: true, mode: 0o775 });
  }
  await writeFile(join(root, "notes/public/note.md"), "---\ntitle: Public\n---\nA public original.\n", { mode: 0o664 });
  await writeFile(join(root, "notes/private/secret.md"), "---\ntitle: Secret\n---\nNot granted to MCP.\n", { mode: 0o600 });
  await writeFile(join(root, "notes/.trash/deleted-note/info.json"), '{"original":"retained"}', { mode: 0o600 });
  await writeFile(join(root, "skills/.trash/deleted-skill/content.md"), "An old deleted Skill.", { mode: 0o600 });
  await writeFile(join(root, ".pkm/content-privacy.json"), JSON.stringify({ schema: 1, private: { notes: ["private"] } }), { mode: 0o600 });
  await writeFile(join(root, ".pkm/knowledge-groups.json"), '{"schema":1,"groups":[]}', { mode: 0o600 });
  await writeFile(join(root, ".pkm/state/actions/settings.json"),
    '{"toolchains":{"configured":"preserved-not-authorized"},"workspace_roots":{"configured":"/not-executed"}}', { mode: 0o600 });
  for (let i = 0; i < history; i++)
    await writeFile(join(root, ".pkm/state/api-chat-history", `${i}.json`), `{"synthetic":${i}}`, { mode: 0o600 });
  const db = new DatabaseSync(join(root, "knowledge.db"));
  db.exec("CREATE TABLE old_history(value TEXT); INSERT INTO old_history VALUES('preserved original');");
  db.close();
  await symlink("/never-follow-this-tool-environment", join(root, "envs", "untrusted-tool"));
  return { directory, root, backup, request: { root, backup, operatorId: "test-operator",
    profileSha256: digest("synthetic-profile"), limits } };
}
async function originalSnapshot(root) {
  const result = [];
  async function visit(path, prefix) {
    const stat = await lstat(path, { bigint: true });
    result.push([prefix, String(stat.ino), Number(stat.mode), String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs),
      stat.isFile() ? digest(await readFile(path)) : null]);
    if (stat.isDirectory()) for (const name of (await readdir(path)).sort()) await visit(join(path, name), `${prefix}/${name}`);
  }
  for (const name of [".pkm", "notes", "skills", "papers", "knowledge.db", "chatrooms"])
    await visit(join(root, name), name);
  return result;
}

test("original MCP custody streams beyond the small Chat receipt and preserves configured state, SQLite and Trash without authority", {
  timeout: 120_000,
}, async t => {
  const f = await fixture(t, 4100);
  const before = await originalSnapshot(f.root);
  const writerFence = await acquireOriginalMcpRootFence(f.root);
  t.after(() => writerFence.release());
  const plan = await captureOriginalMcpCustody(f.request, { writerFence });
  writerFence.assertHeld();
  assert(plan.entries > 4096);
  assert.equal(plan.operatorId, f.request.operatorId);
  assert.equal(plan.profileSha256, f.request.profileSha256);
  assert(plan.auxiliary.includes("envs"), "Opaque tool environments are explicitly untrusted, not traversed or executed.");
  assert.deepEqual(await originalSnapshot(f.root), before);
  await verifyOriginalMcpCustody(plan);
  const prepared = await prepareOriginalMcpRoot(plan, { writerFence });
  writerFence.assertHeld();
  await assert.rejects(validateWorkspace(f.root), { code: "RECOVERY_REQUIRED" });
  const opened = await openOriginalMcpRoot(plan, { writerFence });
  t.after(() => opened.owner.close());
  assert(opened.owner instanceof RootOwner);
  assert.equal(opened.workspaceId, prepared.workspaceId);
  assert.equal(opened.storage.workspaceRoot(), f.root);
  assert.deepEqual(scanMarkdown(f.root).map(row => row.record.title), ["Public"], "Private originals are denials, not inherited grants.");
  const scanner = createFreshRootScanner(f.root);
  const fresh = scanner.scan();
  assert.equal(fresh.sources.size, 1);
  assert.deepEqual(await nativePublicFullOptions(opened.storage, { actor }).then(value => value.trash), undefined);
  await assert.rejects(nativePublicFullOptions(opened.storage, { actor, trustedActions: true }), { code: "ACCESS_DENIED" });
  const backend = createNativePublicOwnerBackend(opened.owner, { actor });
  const reply = await backend.invoke("legacy_knowledge_read", { tool: "get_note", arguments: { slug: "public/note" } });
  assert.match(JSON.stringify(reply), /public original/);
  const secret = await backend.invoke("legacy_knowledge_read", { tool: "get_note", arguments: { slug: "private/secret" } });
  assert.doesNotMatch(JSON.stringify(secret), /Not granted to MCP/);
  await assert.rejects(backend.invoke("legacy_api_chat_read", {}), { code: "NOT_AVAILABLE" });
  await assert.rejects(backend.invoke("legacy_knowledge_read", { tool: "get_script", arguments: {} }), { code: "NOT_AVAILABLE" });
  await backend.close();
  await opened.owner.close();
  assert.throws(() => writerFence.assertHeld(), { code: "STORAGE_UNAVAILABLE" }, "Canonical-owner close releases the exact maintenance fence.");
  assert.deepEqual(await originalSnapshot(f.root), before);
  const restarted = await openOriginalMcpRoot(plan);
  t.after(() => restarted.owner.close());
  await restarted.owner.close();
  const rolled = await rollbackOriginalMcpRoot(plan, prepared);
  assert((await readdir(rolled.archive)).includes("core.sqlite"), "B1 native state is retained, never deleted.");
  assert.deepEqual(await originalSnapshot(f.root), before);
  assert(!(await readdir(f.root)).includes(".pkm-next-workspace"));
});

test("custody refuses unknown state, explicit limits, source changes and corrupted backup without adopting", async t => {
  const unknown = await fixture(t);
  await mkdir(join(unknown.root, ".pkm/state/unknown-future-authority"), { mode: 0o700 });
  await assert.rejects(captureOriginalMcpCustody(unknown.request), /Unknown original runtime state/);
  const bounded = await fixture(t);
  await assert.rejects(captureOriginalMcpCustody(bounded.request, {
    writerFence: { root: bounded.root, mode: "exclusive", assertHeld() {} },
  }), /actual branded canonical Linux writer fence/);
  await assert.rejects(captureOriginalMcpCustody({ ...bounded.request, limits: { ...limits, maxEntries: 1 } }), /entry\/depth bound/);
  assert(!(await readdir(bounded.backup)).includes("complete.json"));
  const f = await fixture(t);
  const plan = await captureOriginalMcpCustody(f.request);
  await writeFile(join(f.root, ".pkm/state/api-chat-history/0.json"), '{"changed":true}');
  await assert.rejects(prepareOriginalMcpRoot(plan), /source identity changed/);
  assert(!(await readdir(f.root)).includes(".pkm-next-original-mcp.json"));
  const g = await fixture(t);
  const otherPlan = await captureOriginalMcpCustody(g.request);
  await writeFile(join(g.backup, "blobs", "00000001"), "corrupted");
  await assert.rejects(prepareOriginalMcpRoot(otherPlan), /backup payload changed/);
  const h = await fixture(t);
  const linkedPlan = await captureOriginalMcpCustody(h.request);
  await prepareOriginalMcpRoot(linkedPlan);
  const unrelated = join(h.directory, "unrelated.sqlite");
  await writeFile(unrelated, "must not be opened or changed");
  await symlink(unrelated, join(h.root, "core.sqlite"));
  await assert.rejects(openOriginalMcpRoot(linkedPlan), /safe single-link regular files/);
  assert.equal(await readFile(unrelated, "utf8"), "must not be opened or changed");
});

test("prepared interruption resumes exactly, changed active source refuses rollback, and unchanged rollback recovers interruption", async t => {
  const f = await fixture(t);
  const plan = await captureOriginalMcpCustody(f.request);
  await assert.rejects(prepareOriginalMcpRoot(plan, { checkpoint(point) {
    if (point === "journal-durable") throw new Error("synthetic prepare interruption");
  } }), /synthetic prepare interruption/);
  assert(!(await readdir(f.root)).includes(".pkm-next-workspace"));
  const prepared = await prepareOriginalMcpRoot(plan);
  await assert.rejects(openOriginalMcpRoot({ ...plan, profileSha256: digest("other") }), /plan digest/);
  const opened = await openOriginalMcpRoot(plan);
  t.after(() => opened.owner.close());
  const backend = createNativePublicOwnerBackend(opened.owner, { actor });
  await assert.rejects(backend.invoke("legacy_knowledge_write", { tool: "add_note",
    arguments: { title: "Not allowed", content: "unchanged", category: "private" } }), /ACCESS_DENIED/);
  await assert.rejects(backend.invoke("legacy_knowledge_write", { tool: "update_note",
    arguments: { slug: "public/note", title: "A requested rename", category: "private" } }), /ACCESS_DENIED/);
  await backend.close();
  await opened.owner.close();
  await assert.rejects(rollbackOriginalMcpRoot(plan, prepared, { checkpoint(point) {
    if (point === "file-archived") throw new Error("synthetic interruption");
  } }), /synthetic interruption/);
  await assert.rejects(RootOwner.open(f.root), { code: "RECOVERY_REQUIRED" });
  await rollbackOriginalMcpRoot(plan, prepared);
  await rollbackOriginalMcpRoot(plan, prepared);
  const g = await fixture(t);
  const otherPlan = await captureOriginalMcpCustody(g.request);
  const other = await openOriginalMcpRoot(otherPlan);
  t.after(() => other.owner.close());
  const otherPrepared = { root: other.root, workspaceId: other.workspaceId, planSha256: other.planSha256, journalSha256: other.journalSha256 };
  const writable = createNativePublicOwnerBackend(other.owner, { actor });
  const mutation = await writable.invoke("legacy_knowledge_write", { tool: "update_note",
    arguments: { slug: "public/note", content: "A changed authoritative original." } });
  assert.match(JSON.stringify(mutation), /public\/note/);
  await writable.close();
  await other.owner.close();
  const resumed = await openOriginalMcpRoot(otherPlan);
  t.after(() => resumed.owner.close());
  assert.match(await readFile(join(g.root, "notes/public/note.md"), "utf8"), /changed authoritative original/);
  await resumed.owner.close();
  await assert.rejects(rollbackOriginalMcpRoot(otherPlan, otherPrepared), /source identity changed/);
  assert((await readdir(g.root)).includes("core.sqlite"), "Changed B1 remains intact for separate capture and explicit rebind.");
});

test("cold authority is never inferred from custody or a prepared receipt when a VS Code writer starts", async t => {
  const f = await fixture(t);
  const plan = await captureOriginalMcpCustody(f.request);
  const writer = spawn(process.execPath, ["-e", "process.stdout.write('ready');process.stdin.resume();",
    "--", "--type=extensionHost"], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(async () => {
    if (writer.exitCode !== null) return;
    const close = once(writer, "close"); writer.stdin.end(); await close;
  });
  await once(writer.stdout, "data");
  await assert.rejects(openOriginalMcpRoot(plan), { code: "LEGACY_WRITERS_ACTIVE" });
  assert(!(await readdir(f.root)).includes(".pkm-next-workspace"));
  assert.equal(writer.exitCode, null, "No user writer is stopped by admission.");
});

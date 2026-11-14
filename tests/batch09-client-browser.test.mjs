import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import test from "node:test";
import { ProtocolClient, OPERATIONS } from "../browser/protocol.mjs";
import { KNOWLEDGE_LIFECYCLE_OPERATIONS, createKnowledgeLifecycleClient,
  knowledgeMutationScanRevision } from "../browser/knowledge-lifecycle.mjs";
import { nativeWorkspace, syntheticManager, until } from "./batch06-manager-fixtures.mjs";

test("real Chromium qualifies specialized lifecycle, byte moves, CAS review and read-only surfaces", { timeout: 45_000 }, async t => {
  const manager = syntheticManager("feature", 3, { hold: true, publish: true });
  const f = await nativeWorkspace(t, async root => {
    for (const area of ["notes", "skills", "papers"]) await mkdir(join(root, area, ".trash"), { recursive: true });
    return { trash: { layoutVersion: "pkm.trash-lifecycle/v1" },
      manager: { ownerForActor: manager.config.ownerForActor, host: manager.host } };
  });
  f.addCleanup(() => manager.release());
  const url = await f.listen();
  const readerUrl = await f.listen({ id: "native:batch09-reader", canWrite: false });
  const protocol = new ProtocolClient({ origin: url, operations: { ...OPERATIONS, ...KNOWLEDGE_LIFECYCLE_OPERATIONS } });
  protocol.authenticate(f.bearer);
  await protocol.bootstrap();
  const api = createKnowledgeLifecycleClient(protocol);
  t.after(() => protocol.disconnect());
  const create = async (title, category = "", content = "synthetic source") => api.noteCreate({
    operationId: randomUUID(), expectedScanRevision: await knowledgeMutationScanRevision(api), title, category, content,
  });
  const conflict = await create("Pinned edit", "", "<script>unsafe()</script>\noriginal body");
  const conflictFile = join(f.root, "notes", conflict.path);
  const raw = await readFile(conflictFile, "utf8");
  await writeFile(conflictFile, raw.replace(/\n---\n/, "\nvendor_extension: { mode: retain }\n---\n"));
  const paired = await create("Paired browser", "Folder", "[bytes](Paired%20browser.assets/payload.bin)");
  const assetBytes = Buffer.from(Array.from({ length: 70_003 }, (_, i) => i % 251));
  await mkdir(join(f.root, "notes", "Folder", "Paired browser.assets"), { recursive: true });
  await writeFile(join(f.root, "notes", "Folder", "Paired browser.assets", "payload.bin"), assetBytes);
  await writeFile(join(f.root, "notes", "Folder", "Paired browser.assets", "mutable.bin"), Buffer.from("browser lifecycle"));
  const restored = await create("Recover browser");
  const restoreFile = join(f.root, "notes", restored.path);
  const restoreBytes = await readFile(restoreFile);
  await mkdir(join(f.root, "notes", "Recover browser.assets"), { recursive: true });
  await writeFile(join(f.root, "notes", "Recover browser.assets", "exact.bin"), assetBytes.subarray(0, 17));
  const started = await f.call("manager.runtime.start", manager.start("batch09-intermediate"));
  assert(started.result, JSON.stringify(started));
  await until(() => manager.calls.published === 1);

  for (const name of ["knowledge-lifecycle.mjs", "knowledge-lifecycle.css"]) {
    const response = await fetch(`${url}/${name}`);
    assert.equal(response.status, 200);
    assert(!response.headers.get("content-type")?.includes("json"));
    assert(response.headers.get("content-security-policy")?.includes("script-src 'self'"));
    assert(!(await response.text()).includes(f.bearer));
  }
  assert.equal((await fetch(`${url}/knowledge-lifecycle.ts`)).status, 401);
  const child = spawn(process.env.PYTHON ?? "python", [resolve(import.meta.dirname, "batch09-client-browser.py")],
    { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, TMPDIR: f.root, TMP: f.root, TEMP: f.root } });
  let stderr = "", report, movedDocumentBytes;
  child.stderr.on("data", bytes => { stderr += bytes; });
  const lines = createInterface({ input: child.stdout });
  const checkpoints = [];
  const handling = (async () => {
    for await (const line of lines) {
      const event = JSON.parse(line);
      if (event.checkpoint === "document-moved") {
        assert.deepEqual(await readFile(join(f.root, "notes", "Folder", "Renamed.assets", "payload.bin")), assetBytes);
        await assert.rejects(readFile(join(f.root, "notes", "Folder", "Renamed.assets", "mutable.bin")),
          error => error.code === "ENOENT");
        await assert.rejects(readFile(join(f.root, "notes", "Folder", "Renamed.assets", "renamed.bin")),
          error => error.code === "ENOENT");
        await assert.rejects(readFile(join(f.root, "notes", "Folder", "Paired browser.assets", "payload.bin")),
          error => error.code === "ENOENT");
        movedDocumentBytes = await readFile(join(f.root, "notes", "Folder", "Renamed.md"));
        child.stdin.write('{"ready":true}\n');
        checkpoints.push(event.checkpoint);
      } else if (event.checkpoint === "collision") {
        await writeFile(restoreFile, "# occupied synthetic destination\n");
        child.stdin.write('{"ready":true}\n');
        checkpoints.push(event.checkpoint);
      } else if (event.checkpoint === "remove-collision") {
        assert.equal(await readFile(restoreFile, "utf8"), "# occupied synthetic destination\n");
        await rm(restoreFile);
        child.stdin.write('{"ready":true}\n');
        checkpoints.push(event.checkpoint);
      } else report = event;
    }
  })();
  const closed = new Promise((done, reject) => { child.once("error", reject); child.once("close", done); });
  const timer = setTimeout(() => child.kill("SIGTERM"), 30_000);
  t.after(() => { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); });
  child.stdin.write(JSON.stringify({ url, readerUrl, token: f.bearer, conflictId: conflict.id, pairedId: paired.id,
    assetDigest: (await api.assetList({ id: paired.id })).items.find(item => item.path.endsWith("/payload.bin")).digest,
    assetBase64: assetBytes.toString("base64") }) + "\n");
  const status = await closed;
  clearTimeout(timer);
  await handling;
  assert.equal(status, 0, stderr);
  assert.deepEqual(checkpoints, ["document-moved", "collision", "remove-collision"]);
  assert.equal(report.browser, "chromium");
  assert(report.screenshotBytes > 10_000);
  assert.deepEqual(report.errors, []);
  assert.equal((await api.documentGet({ id: conflict.id })).content, "Reviewed browser draft");
  assert((await readFile(conflictFile, "utf8")).includes("vendor_extension: { mode: retain }"));
  assert.deepEqual(await readFile(join(f.root, "notes", "Moved", "Renamed.assets", "payload.bin")), assetBytes);
  assert.deepEqual(await readFile(join(f.root, "notes", "Moved", "Renamed.md")), movedDocumentBytes);
  assert.deepEqual(await readFile(restoreFile), restoreBytes);
  assert.deepEqual(await readFile(join(f.root, "notes", "Recover browser.assets", "exact.bin")), assetBytes.subarray(0, 17));
  const notes = await api.noteList({});
  assert(notes.items.some(item => item.title === "Browser Note"));
  const skills = await api.skillList({});
  assert.equal(skills.items.find(item => item.name === "Browser Skill")?.description, "Skill edited");
  const research = await api.researchList({});
  const source = research.items.find(item => item.title === "Browser Source");
  const citing = research.items.find(item => item.title === "Browser Citation");
  assert.deepEqual(citing.cites, [{ paper: source.slug, note: "Reviewed support" }]);
  const state = await f.call("manager.runtime.get", { runId: "batch09-intermediate" });
  assert.equal(state.result.state, "active", "lifecycle mutations cannot finish the held intermediate run");
  assert.equal(manager.calls.integrate.length, 0);
});

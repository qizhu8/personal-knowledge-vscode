import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, closeSync, constants, existsSync, fsyncSync, openSync, writeFileSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { acquireLinuxRootWriterFence, markLinuxRootNextOwned } from "../dist/linux-root-writer-fence.js";
import {
  admitExperimentalInPlaceSkillTrash, prepareExperimentalInPlaceSkillTrash, previewExperimentalOriginalSkillRestoreJournal,
  transitionExperimentalOriginalRestoreJournal, prepareExperimentalBoundOriginalJournalLock,
  acquireExperimentalBoundOriginalJournalLock, recoverExperimentalBoundOriginalJournalLock,
} from "../dist/legacy-inplace-skill-trash.js";
import { prepareLegacyRootAdoptionExperimental } from "../dist/legacy-root-adoption.js";

const original = createRequire(import.meta.url)("../legacy/dist/knowledge/filestore.js");
const originalJournal = createRequire(import.meta.url)("../legacy/dist/knowledge/knowledge-deletion-journal.js");
const hash = data => createHash("sha256").update(data).digest("hex");

async function reviewAbandonedFixtureLock(path, attempt) {
  const members = await readdir(path);
  assert.equal(members.length, 1);
  const bytes = await readFile(join(path, members[0]));
  await assert.rejects(attempt(), /abandoned lock ownership is unknown/);
  assert.deepEqual(await readdir(path), members);
  assert.deepEqual(await readFile(join(path, members[0])), bytes);
  await rm(path, { recursive: true });
}

test("isolated bound legacy lock accepts only a committed exact dead-owner effect", { timeout: 120000 }, async t => {
  const mask = process.umask(0o077);
  t.after(() => process.umask(mask));
  const parent = resolve(".migration-test-work", `bound-original-lock-${randomUUID()}`);
  t.after(() => rm(parent, { recursive: true, force: true }));
  const worker = `
    const [{ acquireLinuxRootWriterFence }, api] = await Promise.all([import(process.argv[1]), import(process.argv[2])]);
    const fs = await import("node:fs");
    const path = await import("node:path");
    const [root, sidecar, entryId, workspaceId, operationId, attemptId, point] = process.argv.slice(3);
    const pointer = sidecar + "." + operationId + "." + attemptId + ".fixture-pointer";
    let pins;
    function persist() {
      const fd = fs.openSync(pointer + ".new", "wx", 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(pins)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(pointer + ".new", pointer);
      const dir = fs.openSync(path.dirname(pointer), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    }
    const fence = await acquireLinuxRootWriterFence(root);
    const options = { mode: "isolated-experiment", root, sidecar, targetId: "fixture-target",
      entryId, workspaceId, operationId, attemptId, fence,
      faultInjector: stage => { if (stage === point) process.kill(process.pid, "SIGKILL"); } };
    const prepared = api.prepareExperimentalBoundOriginalJournalLock(options);
    pins = { intentSha256: prepared.intentSha256 }; persist();
    console.log("INTENT=" + prepared.intentSha256);
    if (point === "prepared-no-lock") process.kill(process.pid, "SIGKILL");
    await api.acquireExperimentalBoundOriginalJournalLock({ ...options, intentSha256: prepared.intentSha256,
      persistEffect: binding => { pins.effectSha256 = binding.effectSha256; persist(); console.log("EFFECT=" + binding.effectSha256); } }, async () => {
      if (point === "inside-work") process.kill(process.pid, "SIGKILL");
    });
    await fence.release();
  `;
  const recoveryWorker = `
    const [{ acquireLinuxRootWriterFence }, api] = await Promise.all([import(process.argv[1]), import(process.argv[2])]);
    const [root, sidecar, entryId, workspaceId, operationId, attemptId, intentSha256, effectSha256, point] = process.argv.slice(3);
    const fence = await acquireLinuxRootWriterFence(root);
    await api.recoverExperimentalBoundOriginalJournalLock({ mode: "isolated-experiment", root, sidecar, targetId: "fixture-target",
      entryId, workspaceId, operationId, attemptId, intentSha256, effectSha256, fence,
      faultInjector: stage => { if (stage === point) process.kill(process.pid, "SIGKILL"); } });
  `;
  for (const scenario of ["normal", "bound-prepare-written", "bound-prepare-committed", "prepared-no-lock", "bound-lock-acquired", "bound-effect-written",
    "bound-effect-committed", "bound-effect-anchored", "inside-work", "forged-member", "extra-member", "wrong-workspace", "wrong-root",
    "wrong-operation", "wrong-domain", "wrong-effect", "foreign-lock", "changed-asset", "changed-journal", "cleanup-crash", "removed-crash"]) {
    const root = join(parent, scenario, "root"), syncDir = join(parent, scenario, "profile/github-sync/experimental-next");
    const sidecar = join(syncDir, "fixture-target.original-trash.sqlite");
    await mkdir(join(root, "skills/One.assets"), { recursive: true, mode: 0o700 });
    await mkdir(syncDir, { recursive: true, mode: 0o700 });
    const workspaceId = randomUUID(), operationId = randomUUID(), attemptId = randomUUID();
    const marker = JSON.stringify({ schema: "pkm.next-workspace/v2", id: workspaceId });
    await writeFile(join(root, ".pkm-next-workspace"), marker, { mode: 0o600 });
    await writeFile(join(root, "skills/One.md"), "---\nname: One\n---\n![image](One.assets/a.png)\n");
    await writeFile(join(root, "skills/One.assets/a.png"), "original attachment");
    original.setStorePath(root);
    const deleted = original.skillMoveToTrash("One");
    assert(deleted);
    const first = await acquireLinuxRootWriterFence(root);
    try { await prepareExperimentalInPlaceSkillTrash({ mode: "isolated-experiment", root, sidecar, targetId: "fixture-target", fence: first }); }
    finally { await first.release(); }
    const point = scenario === "foreign-lock" ? "prepared-no-lock"
      : ["forged-member", "extra-member", "wrong-workspace", "wrong-root",
        "wrong-operation", "wrong-domain", "wrong-effect", "changed-asset", "changed-journal", "cleanup-crash", "removed-crash"].includes(scenario)
        ? "bound-effect-anchored" : scenario;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", worker,
      new URL("../dist/linux-root-writer-fence.js", import.meta.url).href,
      new URL("../dist/legacy-inplace-skill-trash.js", import.meta.url).href,
      root, sidecar, deleted.id, workspaceId, operationId, attemptId, point], { encoding: "utf8", timeout: 30000 });
    if (scenario === "normal") assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
    else assert.equal(child.signal, "SIGKILL", `${scenario}: ${child.stdout}\n${child.stderr}`);
    const pointer = `${sidecar}.${operationId}.${attemptId}.fixture-pointer`;
    const pins = existsSync(pointer) ? JSON.parse(await readFile(pointer, "utf8")) : {};
    const intentSha256 = pins.intentSha256 ?? "0".repeat(64), effectSha256 = pins.effectSha256;
    const lock = join(root, ".pkm/state/knowledge-deletions.json.lock");
    if (scenario === "cleanup-crash" || scenario === "removed-crash") {
      const recovery = spawnSync(process.execPath, ["--input-type=module", "-e", recoveryWorker,
        new URL("../dist/linux-root-writer-fence.js", import.meta.url).href,
        new URL("../dist/legacy-inplace-skill-trash.js", import.meta.url).href,
        root, sidecar, deleted.id, workspaceId, operationId, attemptId, intentSha256, effectSha256,
        scenario === "cleanup-crash" ? "bound-cleanup-committed" : "bound-lock-removed"],
      { encoding: "utf8", timeout: 30000 });
      assert.equal(recovery.signal, "SIGKILL", `${scenario}: ${recovery.stdout}\n${recovery.stderr}`);
    }
    const fence = await acquireLinuxRootWriterFence(root);
    try {
      const request = { mode: "isolated-experiment", root, sidecar, targetId: "fixture-target",
        entryId: deleted.id, workspaceId, operationId, attemptId, intentSha256, effectSha256, fence };
      if (scenario === "normal") {
        const path = join(syncDir, `fixture-target.original-trash-lock-${operationId}-${attemptId}.sqlite`);
        const db = new DatabaseSync(path, { readOnly: true });
        try {
          assert.equal(JSON.parse(db.prepare("SELECT body FROM lock_records WHERE kind='result'").get().body).schema,
            "pkm.experimental-original-journal-lock-released/v1");
        } finally { db.close(); }
        assert.equal(existsSync(lock), false);
        await assert.rejects(recoverExperimentalBoundOriginalJournalLock(request), /unresolved intent/);
      } else if (scenario === "bound-prepare-written") {
        await assert.rejects(recoverExperimentalBoundOriginalJournalLock(request), /unresolved intent|recovery journal/);
        assert.equal(existsSync(lock), false);
      } else if (scenario === "bound-prepare-committed") {
        await assert.rejects(recoverExperimentalBoundOriginalJournalLock(request), /intent pointer differs/);
        assert.equal(existsSync(lock), false);
      } else if (scenario === "prepared-no-lock") {
        assert.equal((await recoverExperimentalBoundOriginalJournalLock(request)).state, "not-acquired");
        assert.equal(existsSync(lock), false);
      } else if (scenario === "bound-lock-acquired" || scenario === "bound-effect-written"
        || scenario === "bound-effect-committed") {
        await assert.rejects(async () => recoverExperimentalBoundOriginalJournalLock(request),
          /unbound original lock state|unrecognized SQLite recovery journal|effect pointer differs or is missing/);
        assert(existsSync(lock));
      } else if (scenario === "forged-member") {
        const [name] = await readdir(lock), path = join(lock, name);
        await writeFile(path, "foreign owner");
        await assert.rejects(recoverExperimentalBoundOriginalJournalLock(request), /bound lock identity or members changed/);
        assert.equal(await readFile(path, "utf8"), "foreign owner");
      } else if (scenario === "extra-member") {
        await writeFile(join(lock, "foreign"), "do not remove");
        await assert.rejects(recoverExperimentalBoundOriginalJournalLock(request), /bound lock identity or members changed/);
        assert.equal(await readFile(join(lock, "foreign"), "utf8"), "do not remove");
      } else if (scenario === "wrong-workspace") {
        await writeFile(join(root, ".pkm-next-workspace"), JSON.stringify({ schema: "pkm.next-workspace/v2", id: randomUUID() }));
        await assert.rejects(recoverExperimentalBoundOriginalJournalLock(request), /workspace identity differs/);
        assert(existsSync(lock));
      } else if (scenario === "wrong-root") {
        const other = join(parent, scenario, "other-root");
        await mkdir(other, { mode: 0o700 });
        const otherFence = await acquireLinuxRootWriterFence(other);
        try {
          await assert.rejects(recoverExperimentalBoundOriginalJournalLock({ ...request, root: other, fence: otherFence }),
            /original source identity differs/);
          assert(existsSync(lock));
        } finally { await otherFence.release(); }
      } else if (scenario === "wrong-operation" || scenario === "wrong-domain") {
        const path = join(syncDir, `fixture-target.original-trash-lock-${operationId}-${attemptId}.sqlite`);
        const db = new DatabaseSync(path);
        const row = db.prepare("SELECT body FROM lock_records WHERE kind='intent'").get();
        const intent = JSON.parse(row.body);
        if (scenario === "wrong-operation") intent.operationId = randomUUID();
        else intent.pidNamespace = "pid:[1]";
        const body = JSON.stringify(intent);
        db.prepare("UPDATE lock_records SET body=?, sha256=? WHERE kind='intent'").run(body, hash(body));
        db.close();
        await assert.rejects(recoverExperimentalBoundOriginalJournalLock(request),
          /intent pointer differs|not the exact source, workspace and operation|process domain differs/);
        assert(existsSync(lock));
      } else if (scenario === "wrong-effect") {
        const path = join(syncDir, `fixture-target.original-trash-lock-${operationId}-${attemptId}.sqlite`);
        const db = new DatabaseSync(path);
        const effect = JSON.parse(db.prepare("SELECT body FROM lock_records WHERE kind='effect'").get().body);
        effect.intentSha256 = "f".repeat(64);
        const body = JSON.stringify(effect);
        db.prepare("UPDATE lock_records SET body=?, sha256=? WHERE kind='effect'").run(body, hash(body));
        db.close();
        await assert.rejects(recoverExperimentalBoundOriginalJournalLock(request), /effect pointer differs/);
        assert(existsSync(lock));
      } else if (scenario === "foreign-lock") {
        const nonce = randomUUID(), path = join(lock, `${nonce}.json`);
        await mkdir(lock, { mode: 0o700 });
        await writeFile(path, JSON.stringify({ pid: 2147483647, nonce, acquiredAt: 1, owner: "foreign" }));
        const bytes = await readFile(path);
        await assert.rejects(recoverExperimentalBoundOriginalJournalLock(request), /unbound original lock state/);
        assert.deepEqual(await readFile(path), bytes);
      } else if (scenario === "changed-asset") {
        await writeFile(join(root, "skills/.trash", deleted.id, "assets/a.png"), "foreign change");
        await assert.rejects(recoverExperimentalBoundOriginalJournalLock(request), /original transition payload changed/);
        assert(existsSync(lock));
      } else if (scenario === "changed-journal") {
        await writeFile(join(root, ".pkm/state/knowledge-deletions.json"), "foreign change");
        await assert.rejects(recoverExperimentalBoundOriginalJournalLock(request), /no trusted journal successor pointers/);
        assert(existsSync(lock));
      } else if (scenario === "removed-crash") {
        assert.equal(existsSync(lock), false);
        await assert.rejects(recoverExperimentalBoundOriginalJournalLock(request));
      } else {
        const result = await recoverExperimentalBoundOriginalJournalLock(request);
        assert.equal(result.state, "reconciled");
        assert.equal(existsSync(lock), false);
        await assert.rejects(recoverExperimentalBoundOriginalJournalLock(request));
      }
    } finally { await fence.release(); }
    assert.equal(await readFile(join(root, "skills/.trash", deleted.id, "assets/a.png"), "utf8"),
      scenario === "changed-asset" ? "foreign change" : "original attachment");
  }
});

test("bound legacy lock preserves a live owner and recovers only after that process exits", { timeout: 30000 }, async t => {
  const mask = process.umask(0o077);
  t.after(() => process.umask(mask));
  const parent = resolve(".migration-test-work", `bound-live-lock-${randomUUID()}`);
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "root"), syncDir = join(parent, "profile/github-sync/experimental-next");
  const sidecar = join(syncDir, "fixture-target.original-trash.sqlite");
  await mkdir(join(root, "skills"), { recursive: true, mode: 0o700 });
  await mkdir(syncDir, { recursive: true, mode: 0o700 });
  const workspaceId = randomUUID(), operationId = randomUUID(), attemptId = randomUUID();
  await writeFile(join(root, ".pkm-next-workspace"), JSON.stringify({ schema: "pkm.next-workspace/v2", id: workspaceId }));
  await writeFile(join(root, "skills/One.md"), "---\nname: One\n---\nContent.\n");
  original.setStorePath(root);
  const deleted = original.skillMoveToTrash("One");
  const first = await acquireLinuxRootWriterFence(root);
  try { await prepareExperimentalInPlaceSkillTrash({ mode: "isolated-experiment", root, sidecar, targetId: "fixture-target", fence: first }); }
  finally { await first.release(); }
  const worker = `
    const [{ acquireLinuxRootWriterFence }, api] = await Promise.all([import(process.argv[1]), import(process.argv[2])]);
    const fs = await import("node:fs"), path = await import("node:path");
    const [root, sidecar, entryId, workspaceId, operationId, attemptId] = process.argv.slice(3);
    const pointer = sidecar + "." + operationId + "." + attemptId + ".fixture-pointer";
    let pins;
    function persist() {
      const fd = fs.openSync(pointer + ".new", "wx", 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(pins)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(pointer + ".new", pointer);
      const dir = fs.openSync(path.dirname(pointer), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    }
    const fence = await acquireLinuxRootWriterFence(root);
    const options = { mode: "isolated-experiment", root, sidecar, targetId: "fixture-target",
      entryId, workspaceId, operationId, attemptId, fence };
    const prepared = api.prepareExperimentalBoundOriginalJournalLock(options);
    pins = { intentSha256: prepared.intentSha256 }; persist();
    console.log("INTENT=" + prepared.intentSha256);
    await api.acquireExperimentalBoundOriginalJournalLock({ ...options, intentSha256: prepared.intentSha256,
      persistEffect: binding => { pins.effectSha256 = binding.effectSha256; persist(); console.log("EFFECT=" + binding.effectSha256); } }, async () => {
      await fence.release();
      console.log("ready");
      await new Promise(() => { setInterval(() => {}, 1000); });
    });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", worker,
    new URL("../dist/linux-root-writer-fence.js", import.meta.url).href,
    new URL("../dist/legacy-inplace-skill-trash.js", import.meta.url).href,
    root, sidecar, deleted.id, workspaceId, operationId, attemptId], { stdio: ["ignore", "pipe", "pipe"] });
  const closed = new Promise(resolve => child.once("close", resolve));
  let errors = "";
  child.stderr.on("data", bytes => { errors += bytes; });
  try {
    const output = await new Promise((resolve, reject) => {
      let output = "";
      child.stdout.on("data", bytes => { output += bytes; if (output.includes("ready")) resolve(output); });
      child.once("exit", () => reject(new Error(`owner exited before ready: ${errors}`)));
    });
    const intentSha256 = /INTENT=([a-f0-9]{64})/.exec(output)?.[1];
    const effectSha256 = /EFFECT=([a-f0-9]{64})/.exec(output)?.[1];
    assert(intentSha256 && effectSha256);
    const fence = await acquireLinuxRootWriterFence(root);
    try {
      const request = { mode: "isolated-experiment", root, sidecar, targetId: "fixture-target",
        entryId: deleted.id, workspaceId, operationId, attemptId, intentSha256, effectSha256, fence };
      const lock = join(root, ".pkm/state/knowledge-deletions.json.lock");
      await assert.rejects(recoverExperimentalBoundOriginalJournalLock(request), /owner is still alive/);
      assert(existsSync(lock));
      child.kill("SIGKILL");
      await closed;
      assert.equal((await recoverExperimentalBoundOriginalJournalLock(request)).state, "reconciled");
      assert.equal(existsSync(lock), false);
    } finally { await fence.release(); }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  }
});

test("bound lock resumes only an anchored original journal transition after SIGKILL", { timeout: 60000 }, async t => {
  const mask = process.umask(0o077);
  t.after(() => process.umask(mask));
  const parent = resolve(".migration-test-work", `bound-journal-transition-${randomUUID()}`);
  t.after(() => rm(parent, { recursive: true, force: true }));
  for (const point of ["transition-intent-committed", "transition-intent-anchored", "transition-temporary-written", "transition-effect-anchored", "transition-applied",
    "staged-tamper", "after-tamper", "effect-forgery"]) {
  const root = join(parent, point, "root"), syncDir = join(parent, point, "profile/github-sync/experimental-next");
  const sidecar = join(syncDir, "fixture-target.original-trash.sqlite");
  await mkdir(join(root, "skills/One.assets"), { recursive: true, mode: 0o700 });
  await mkdir(syncDir, { recursive: true, mode: 0o700 });
  const workspaceId = randomUUID(), operationId = randomUUID(), attemptId = randomUUID();
  await writeFile(join(root, ".pkm-next-workspace"), JSON.stringify({ schema: "pkm.next-workspace/v2", id: workspaceId }));
  await writeFile(join(root, "skills/One.md"), "---\nname: One\n---\n![image](One.assets/a.png)\n");
  await writeFile(join(root, "skills/One.assets/a.png"), "original attachment");
  original.setStorePath(root);
  const deleted = original.skillMoveToTrash("One");
  const first = await acquireLinuxRootWriterFence(root);
  try { await prepareExperimentalInPlaceSkillTrash({ mode: "isolated-experiment", root, sidecar, targetId: "fixture-target", fence: first }); }
  finally { await first.release(); }
  const worker = `
    const [{ acquireLinuxRootWriterFence }, api] = await Promise.all([import(process.argv[1]), import(process.argv[2])]);
    const fs = await import("node:fs"), path = await import("node:path");
    const [root, sidecar, entryId, workspaceId, operationId, attemptId, crashPoint] = process.argv.slice(3);
    const pointer = sidecar + "." + operationId + "." + attemptId + ".fixture-pointer";
    let pins;
    function persist() {
      const fd = fs.openSync(pointer + ".new", "wx", 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(pins)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(pointer + ".new", pointer);
      const dir = fs.openSync(path.dirname(pointer), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    }
    const fence = await acquireLinuxRootWriterFence(root);
    const options = { mode: "isolated-experiment", root, sidecar, targetId: "fixture-target",
      entryId, workspaceId, operationId, attemptId, fence };
    const prepared = api.prepareExperimentalBoundOriginalJournalLock(options);
    pins = { intentSha256: prepared.intentSha256 }; persist();
    console.log("INTENT=" + prepared.intentSha256);
    await api.transitionExperimentalOriginalRestoreJournal({ ...options,
      boundLock: { workspaceId, operationId, attemptId, intentSha256: prepared.intentSha256,
        persistEffect: binding => { pins.effectSha256 = binding.effectSha256; persist(); console.log("EFFECT=" + binding.effectSha256); },
        persistJournalIntent: binding => { Object.assign(pins, binding); persist(); },
        persistJournalEffect: binding => { Object.assign(pins, binding); persist(); } },
      faultInjector: point => { if (point === crashPoint) process.kill(process.pid, "SIGKILL"); } });
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", worker,
    new URL("../dist/linux-root-writer-fence.js", import.meta.url).href,
    new URL("../dist/legacy-inplace-skill-trash.js", import.meta.url).href,
    root, sidecar, deleted.id, workspaceId, operationId, attemptId,
    point === "staged-tamper" ? "transition-effect-anchored"
      : ["after-tamper", "effect-forgery"].includes(point) ? "transition-applied" : point],
    { encoding: "utf8", timeout: 30000 });
  assert.equal(child.signal, "SIGKILL", `${child.stdout}\n${child.stderr}`);
  const { intentSha256, effectSha256, transitionSha256, transitionEffectSha256 } = JSON.parse(
    await readFile(`${sidecar}.${operationId}.${attemptId}.fixture-pointer`, "utf8"));
  assert(intentSha256 && effectSha256);
  const journal = join(root, ".pkm/state/knowledge-deletions.json"), interrupted = await readFile(journal);
  const fence = await acquireLinuxRootWriterFence(root);
  try {
    const base = { mode: "isolated-experiment", root, sidecar, targetId: "fixture-target",
      entryId: deleted.id, workspaceId, operationId, attemptId, intentSha256, effectSha256,
      transitionSha256, transitionEffectSha256, fence };
    await assert.rejects(recoverExperimentalBoundOriginalJournalLock({ ...base, operationId: randomUUID() }), /intent is missing/);
    if (point === "transition-temporary-written") {
      await assert.rejects(recoverExperimentalBoundOriginalJournalLock(base), /no trusted journal successor pointers/);
      assert(existsSync(`${journal}.lock`));
      assert(existsSync(`${journal}.${deleted.id}.next-restore-tmp`));
      continue;
    }
    if (point === "transition-intent-committed") {
      await assert.rejects(recoverExperimentalBoundOriginalJournalLock(base), /cannot classify an unresolved journal transition/);
      assert(existsSync(`${journal}.lock`));
      assert(existsSync(`${sidecar}.journal-${deleted.id}`));
      continue;
    }
    assert(transitionSha256);
    if (point !== "transition-intent-anchored") assert(transitionEffectSha256);
    if (point === "staged-tamper" || point === "after-tamper") {
      const changed = point === "staged-tamper" ? `${journal}.${deleted.id}.next-restore-tmp` : journal;
      await writeFile(changed, "foreign journal change");
      await assert.rejects(recoverExperimentalBoundOriginalJournalLock(base), /journal successor differs/);
      assert(existsSync(`${journal}.lock`));
      continue;
    }
    if (point === "effect-forgery") {
      const db = new DatabaseSync(`${sidecar}.journal-${deleted.id}.effect`);
      try {
        const row = db.prepare("SELECT body FROM effect WHERE singleton=1").get();
        const effect = JSON.parse(row.body);
        effect.tempIno = String(BigInt(effect.tempIno) + 1n);
        const body = JSON.stringify(effect);
        db.prepare("UPDATE effect SET body=?, sha256=? WHERE singleton=1").run(body, hash(body));
      } finally { db.close(); }
      await assert.rejects(recoverExperimentalBoundOriginalJournalLock(base), /bound journal effect pointer differs/);
      assert(existsSync(`${journal}.lock`));
      continue;
    }
    await assert.rejects(recoverExperimentalBoundOriginalJournalLock({ ...base, transitionSha256: "0".repeat(64) }),
      /bound journal transition pointer differs/);
    assert(existsSync(`${journal}.lock`));
    assert.equal((await recoverExperimentalBoundOriginalJournalLock(base)).state, "reconciled");
    const unanchored = { ...base, attemptId: randomUUID() };
    const unanchoredPrepared = prepareExperimentalBoundOriginalJournalLock(unanchored);
    await assert.rejects(transitionExperimentalOriginalRestoreJournal({ ...unanchored,
      boundLock: { workspaceId, operationId, attemptId: unanchored.attemptId,
        intentSha256: unanchoredPrepared.intentSha256, persistEffect: () => {},
        persistJournalIntent: () => {}, persistJournalEffect: () => {} } }),
    /existing journal transition has no matching trusted resume pointer/);
    assert.deepEqual(await readFile(journal), interrupted);
    const unrelated = { ...base, operationId: randomUUID(), attemptId: randomUUID() };
    const unrelatedPrepared = prepareExperimentalBoundOriginalJournalLock(unrelated);
    await assert.rejects(transitionExperimentalOriginalRestoreJournal({ ...unrelated,
      boundLock: { workspaceId, operationId: unrelated.operationId, attemptId: unrelated.attemptId,
        intentSha256: unrelatedPrepared.intentSha256, persistEffect: () => {},
        resumeJournalIntentSha256: transitionSha256, resumeJournalEffectSha256: transitionEffectSha256,
        persistJournalIntent: () => {}, persistJournalEffect: () => {} } }),
    /journal transition intent differs from the original source/);
    const retry = { ...base, attemptId: randomUUID() };
    const prepared = prepareExperimentalBoundOriginalJournalLock(retry);
    const pointer = `${sidecar}.${operationId}.${retry.attemptId}.fixture-pointer`;
    const persist = pins => {
      const fd = openSync(pointer, "w", 0o600);
      try { writeFileSync(fd, JSON.stringify(pins)); fsyncSync(fd); } finally { closeSync(fd); }
      const dir = openSync(dirname(pointer), constants.O_RDONLY | constants.O_DIRECTORY);
      try { fsyncSync(dir); } finally { closeSync(dir); }
    };
    persist({ intentSha256: prepared.intentSha256 });
    let retryEffect;
    const result = await transitionExperimentalOriginalRestoreJournal({ ...retry,
      boundLock: { workspaceId, operationId, attemptId: retry.attemptId, intentSha256: prepared.intentSha256,
        resumeJournalIntentSha256: transitionSha256, resumeJournalEffectSha256: transitionEffectSha256,
        persistEffect: binding => { retryEffect = binding.effectSha256; persist(binding); },
        persistJournalIntent: binding => { persist({ ...binding, intentSha256: prepared.intentSha256, effectSha256: retryEffect }); },
        persistJournalEffect: binding => { persist({ ...binding, intentSha256: prepared.intentSha256, effectSha256: retryEffect }); } } });
    assert(retryEffect);
    assert.equal(result.state, "applied");
    const after = await readFile(journal);
    if (point === "transition-applied") assert.deepEqual(after, interrupted);
    assert.deepEqual(JSON.parse(after).records, []);
    assert.equal(await readFile(join(root, "skills/.trash", deleted.id, "assets/a.png"), "utf8"), "original attachment");
  } finally { await fence.release(); }
  }
});

test("isolated journal transition preserves unbound abandoned locks and reconciles exact effects after fixture review", { timeout: 120000 }, async t => {
  const mask = process.umask(0o077);
  t.after(() => process.umask(mask));
  const parent = resolve(".migration-test-work", `original-journal-transition-${randomUUID()}`);
  t.after(() => rm(parent, { recursive: true, force: true }));
  const worker = `
    const [{ acquireLinuxRootWriterFence }, { transitionExperimentalOriginalRestoreJournal }] = await Promise.all([
      import(process.argv[1]), import(process.argv[2]) ]);
    const root = process.argv[3], sidecar = process.argv[4], entryId = process.argv[5], point = process.argv[6];
    const fence = await acquireLinuxRootWriterFence(root);
    await transitionExperimentalOriginalRestoreJournal({ mode: "isolated-experiment", root, sidecar,
      targetId: "fixture-target", entryId, fence,
      faultInjector: stage => { if (stage === point) process.kill(process.pid, "SIGKILL"); } });
  `;
  for (const scenario of ["transition-intent-written", "transition-intent-committed",
    "transition-temporary-written", "effect-sidecar-created", "effect-database-opened",
    "transition-effect-written", "transition-effect-durable", "transition-effect-committed", "transition-applied",
    "foreign-after", "same-bytes-rewrite", "other-bucket-change", "staged-mode-change"]) {
    const point = scenario === "staged-mode-change" ? "transition-effect-committed"
      : ["foreign-after", "same-bytes-rewrite", "other-bucket-change"].includes(scenario)
        ? "transition-intent-committed" : scenario;
    const root = join(parent, scenario, "root"), syncDir = join(parent, scenario, "profile/github-sync/experimental-next");
    const sidecar = join(syncDir, "fixture-target.original-trash.sqlite");
    await mkdir(join(root, "skills/One.assets"), { recursive: true, mode: 0o700 });
    await mkdir(join(root, "notes"), { recursive: true, mode: 0o700 });
    await mkdir(syncDir, { recursive: true, mode: 0o700 });
    const content = "---\nname: One\n---\n![image](One.assets/a.png)\n", attachment = Buffer.from([0, 1, 254, 255]);
    await writeFile(join(root, "skills/One.md"), content);
    await writeFile(join(root, "skills/One.assets/a.png"), attachment);
    if (scenario === "other-bucket-change") {
      await writeFile(join(root, "skills/Two.md"), "---\nname: Two\n---\nOriginal two.\n");
    }
    originalJournal.recordKnowledgeResourceMutation(root, ["notes/Other Note.md"], [], () => true);
    original.setStorePath(root);
    const deleted = original.skillMoveToTrash("One");
    assert(deleted);
    const other = scenario === "other-bucket-change" && original.skillMoveToTrash("Two");
    const journal = join(root, ".pkm/state/knowledge-deletions.json");
    const before = await readFile(journal), metadata = await readFile(join(root, "skills/.trash", deleted.id, "metadata.json"));
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", worker,
      new URL("../dist/linux-root-writer-fence.js", import.meta.url).href,
      new URL("../dist/legacy-inplace-skill-trash.js", import.meta.url).href, root, sidecar, deleted.id, point],
    { encoding: "utf8", timeout: 30000 });
    assert.equal(child.signal, "SIGKILL", `${point}: ${child.stdout}\n${child.stderr}`);
    const fence = await acquireLinuxRootWriterFence(root);
    try {
      const request = { mode: "isolated-experiment", root, sidecar, targetId: "fixture-target", entryId: deleted.id, fence };
      await reviewAbandonedFixtureLock(`${journal}.lock`, () => transitionExperimentalOriginalRestoreJournal(request));
      if (scenario === "foreign-after") {
        const db = new DatabaseSync(`${sidecar}.journal-${deleted.id}`, { readOnly: true });
        const intent = JSON.parse(db.prepare("SELECT body FROM transition").get().body);
        db.close();
        const external = Buffer.from(intent.afterBase64, "base64");
        await writeFile(journal, external);
        await assert.rejects(transitionExperimentalOriginalRestoreJournal(request), /after-image has no exact recorded effect identity/);
        assert.deepEqual(await readFile(journal), external);
      } else if (scenario === "same-bytes-rewrite") {
        await writeFile(journal, before);
        await assert.rejects(transitionExperimentalOriginalRestoreJournal(request), /unknown journal transition state/);
        assert.deepEqual(await readFile(journal), before);
      } else if (scenario === "other-bucket-change") {
        await writeFile(join(root, "skills/.trash", other.id, "payload"), "external change");
        await assert.rejects(transitionExperimentalOriginalRestoreJournal(request), /original transition payload changed/);
        assert.deepEqual(await readFile(journal), before);
      } else if (scenario === "staged-mode-change") {
        const temp = `${journal}.${deleted.id}.next-restore-tmp`;
        await chmod(temp, 0o400);
        await assert.rejects(transitionExperimentalOriginalRestoreJournal(request), /journal changed before controlled atomic replacement/);
        assert.deepEqual(await readFile(journal), before);
        assert.equal((await lstat(temp)).mode & 0o777, 0o400);
      } else if (["effect-sidecar-created", "effect-database-opened", "transition-effect-written"].includes(scenario)) {
        await assert.rejects(transitionExperimentalOriginalRestoreJournal(request), /unknown journal transition effect|unrecognized SQLite recovery journal/);
        assert.deepEqual(await readFile(journal), before);
        assert(existsSync(`${journal}.${deleted.id}.next-restore-tmp`));
        assert(existsSync(`${sidecar}.journal-${deleted.id}.effect`));
      } else if (point === "transition-temporary-written") {
        await assert.rejects(transitionExperimentalOriginalRestoreJournal(request), /unknown journal transition temporary/);
        assert.deepEqual(await readFile(journal), before);
        assert(existsSync(`${journal}.${deleted.id}.next-restore-tmp`));
      } else {
        const result = await transitionExperimentalOriginalRestoreJournal(request);
        assert.equal(result.state, "applied");
        assert.equal(result.beforeSha256, hash(before));
        assert.deepEqual(await readFile(journal), Buffer.from(result.afterBase64, "base64"));
        assert.deepEqual(JSON.parse(await readFile(journal, "utf8")).records.map(record => record.path), ["notes/Other Note.md"]);
        assert.deepEqual(await transitionExperimentalOriginalRestoreJournal(request), result);
        await writeFile(journal, before);
        await assert.rejects(transitionExperimentalOriginalRestoreJournal(request), /unknown journal transition state/);
        assert.deepEqual(await readFile(journal), before);
      }
    } finally { await fence.release(); }
    assert.deepEqual(await readFile(join(root, "skills/.trash", deleted.id, "metadata.json")), metadata);
    assert.equal(await readFile(join(root, "skills/.trash", deleted.id, "payload"), "utf8"), content);
    assert.deepEqual(await readFile(join(root, "skills/.trash", deleted.id, "assets/a.png")), attachment);
  }
});

test("original writer restore journal projection matches real before and after bytes", async t => {
  const mask = process.umask(0o077);
  t.after(() => process.umask(mask));
  const parent = resolve(".migration-test-work", `original-skill-restore-${randomUUID()}`);
  const root = join(parent, "root"), syncDir = join(parent, "profile/github-sync/experimental-next");
  await mkdir(join(root, "skills/One.assets"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, "notes"), { recursive: true, mode: 0o700 });
  await mkdir(syncDir, { recursive: true, mode: 0o700 });
  t.after(() => rm(parent, { recursive: true, force: true }));
  const content = "---\nname: One\n---\n![image](One.assets/a.png)\n";
  const attachment = Buffer.from([0, 1, 254, 255]);
  await writeFile(join(root, "skills/One.md"), content);
  await writeFile(join(root, "skills/One.assets/a.png"), attachment);
  originalJournal.recordKnowledgeResourceMutation(root, ["notes/Other Note.md"], [], () => true);
  original.setStorePath(root);
  const deleted = original.skillMoveToTrash("One");
  assert(deleted);
  const journal = join(root, ".pkm/state/knowledge-deletions.json");
  const before = await readFile(journal);
  const fence = await acquireLinuxRootWriterFence(root);
  let preview;
  try {
    const prepared = await prepareExperimentalInPlaceSkillTrash({
      mode: "isolated-experiment", root, sidecar: join(syncDir, "fixture-target.original-trash.sqlite"),
      targetId: "fixture-target", fence,
    });
    preview = previewExperimentalOriginalSkillRestoreJournal(prepared, deleted.id);
    assert.equal(preview.beforeSha256, hash(before));
    assert.equal(preview.entryId, deleted.id);
    assert.deepEqual(preview.restoredPaths.sort(), ["skills/One.assets/a.png", "skills/One.md"]);
    assert.deepEqual(await readFile(journal), before);
  } finally { await fence.release(); }
  assert.deepEqual(original.skillTrashRestore(deleted.id), { ok: true, path: "One.md" });
  const after = await readFile(journal);
  assert.deepEqual(after, Buffer.from(preview.afterBase64, "base64"));
  assert.equal(hash(after), preview.afterSha256);
  assert.deepEqual(JSON.parse(after).records.map(record => record.path), ["notes/Other Note.md"]);
  assert.equal(await readFile(join(root, "skills/One.md"), "utf8"), content);
  assert.deepEqual(await readFile(join(root, "skills/One.assets/a.png")), attachment);
});

test("journal transition waits for the real legacy journal lock", { timeout: 30000 }, async t => {
  const mask = process.umask(0o077);
  t.after(() => process.umask(mask));
  const parent = resolve(".migration-test-work", `original-journal-lock-${randomUUID()}`);
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "root"), syncDir = join(parent, "profile/github-sync/experimental-next");
  await mkdir(join(root, "skills"), { recursive: true, mode: 0o700 });
  await mkdir(syncDir, { recursive: true, mode: 0o700 });
  await writeFile(join(root, "skills/One.md"), "---\nname: One\n---\nContent.\n");
  original.setStorePath(root);
  const deleted = original.skillMoveToTrash("One");
  assert(deleted);
  const journal = join(root, ".pkm/state/knowledge-deletions.json"), before = await readFile(journal);
  const sidecar = join(syncDir, "fixture-target.original-trash.sqlite");
  const { withCrossProcessLock } = createRequire(import.meta.url)("../legacy/dist/runtime/cross-process-lock.js");
  let release, ready;
  const locked = new Promise(resolve => { ready = resolve; });
  const holder = withCrossProcessLock(`${journal}.lock`, "fixture legacy writer", 10000, async () => {
    await new Promise(resolve => { release = resolve; ready(); });
  });
  await locked;
  const fence = await acquireLinuxRootWriterFence(root);
  try {
    let settled = false;
    const transition = transitionExperimentalOriginalRestoreJournal({
      mode: "isolated-experiment", root, sidecar, targetId: "fixture-target", entryId: deleted.id, fence,
    }).then(result => { settled = true; return result; }, error => { settled = true; throw error; });
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(settled, false);
    assert.deepEqual(await readFile(journal), before);
    assert.equal(existsSync(`${sidecar}.journal-${deleted.id}`), false);
    release();
    await holder;
    assert.equal((await transition).state, "applied");
  } finally {
    release();
    await holder;
    await fence.release();
  }
});

test("journal transition rejects a fence whose release has started", { timeout: 30000 }, async t => {
  const mask = process.umask(0o077);
  t.after(() => process.umask(mask));
  const parent = resolve(".migration-test-work", `original-journal-released-fence-${randomUUID()}`);
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "root"), syncDir = join(parent, "profile/github-sync/experimental-next");
  await mkdir(join(root, "skills"), { recursive: true, mode: 0o700 });
  await mkdir(syncDir, { recursive: true, mode: 0o700 });
  await writeFile(join(root, "skills/One.md"), "---\nname: One\n---\nContent.\n");
  original.setStorePath(root);
  const deleted = original.skillMoveToTrash("One");
  assert(deleted);
  const journal = join(root, ".pkm/state/knowledge-deletions.json"), before = await readFile(journal);
  const sidecar = join(syncDir, "fixture-target.original-trash.sqlite");
  const fence = await acquireLinuxRootWriterFence(root);
  const release = fence.release();
  try {
    await assert.rejects(transitionExperimentalOriginalRestoreJournal({
      mode: "isolated-experiment", root, sidecar, targetId: "fixture-target", entryId: deleted.id, fence,
    }), /fence was lost/i);
    assert.deepEqual(await readFile(journal), before);
    assert.equal(existsSync(sidecar), false);
  } finally { await release; }
});

test("unknown abandoned target lock is never removed or accepted", { timeout: 30000 }, async t => {
  const mask = process.umask(0o077);
  t.after(() => process.umask(mask));
  const parent = resolve(".migration-test-work", `original-trash-unknown-lock-${randomUUID()}`);
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "root"), syncDir = join(parent, "profile/github-sync/experimental-next");
  await mkdir(join(root, "skills"), { recursive: true, mode: 0o700 });
  await mkdir(syncDir, { recursive: true, mode: 0o700 });
  await writeFile(join(root, "skills/One.md"), "---\nname: One\n---\nContent.\n");
  original.setStorePath(root);
  const deleted = original.skillMoveToTrash("One");
  assert(deleted);
  const lock = join(parent, "profile/github-sync/targets-state.lock"), nonce = randomUUID();
  await mkdir(lock, { mode: 0o700 });
  const record = JSON.stringify({ pid: 2147483647, nonce, acquiredAt: 1, owner: "unknown external operation" });
  await writeFile(join(lock, `${nonce}.json`), record, { mode: 0o600 });
  const sidecar = join(syncDir, "fixture-target.original-trash.sqlite"), fence = await acquireLinuxRootWriterFence(root);
  try {
    await assert.rejects(prepareExperimentalInPlaceSkillTrash({
      mode: "isolated-experiment", root, sidecar, targetId: "fixture-target", fence,
    }), /abandoned lock ownership is unknown/);
    assert.equal(await readFile(join(lock, `${nonce}.json`), "utf8"), record);
    assert.equal(existsSync(sidecar), false);
  } finally { await fence.release(); }
});

test("gated adoption atomically upgrades original Trash evidence to an exact in-place v2 receipt", async t => {
  const mask = process.umask(0o077);
  t.after(() => process.umask(mask));
  const parent = resolve(".migration-test-work", `original-receipt-upgrade-${randomUUID()}`);
  const root = join(parent, "root"), syncDir = join(parent, "profile/github-sync/experimental-next");
  const sidecar = join(syncDir, "fixture-target.original-trash.sqlite");
  t.after(() => rm(parent, { recursive: true, force: true }));
  await mkdir(join(root, "skills/One.assets"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, "notes"), { recursive: true, mode: 0o700 });
  await mkdir(syncDir, { recursive: true, mode: 0o700 });
  await writeFile(join(root, "skills/One.md"), "---\nname: One\n---\n![image](One.assets/a.png)\n");
  const attachment = Buffer.from([0, 1, 254, 255]);
  await writeFile(join(root, "skills/One.assets/a.png"), attachment);
  original.setStorePath(root);
  const clock = Date.now;
  let deleted;
  try {
    Date.now = () => {
      const time = clock();
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      return time;
    };
    deleted = original.skillMoveToTrash("One");
  } finally { Date.now = clock; }
  assert.notEqual(Number(deleted.id.split("-")[0]), Date.parse(deleted.deletedAt));
  const unexpected = join(root, "skills/.trash", deleted.id, "foreign.txt");
  await writeFile(unexpected, "unowned");
  const options = { experimentalOriginalSkillTrash: { mode: "isolated-experiment", sidecar, targetId: "fixture-target" } };
  await assert.rejects(prepareLegacyRootAdoptionExperimental(root, options), /unknown original Trash bucket members/);
  assert.equal(existsSync(sidecar), false);
  assert.equal(await readFile(unexpected, "utf8"), "unowned");
  await rm(unexpected);
  const files = [join(root, "skills/.trash", deleted.id, "metadata.json"),
    join(root, "skills/.trash", deleted.id, "payload"),
    join(root, "skills/.trash", deleted.id, "assets/a.png"),
    join(root, ".pkm/state/knowledge-deletions.json")];
  const snapshot = async () => Promise.all(files.map(async file => {
    const stat = await lstat(file, { bigint: true });
    return { ino: stat.ino, mode: stat.mode, uid: stat.uid, gid: stat.gid,
      mtime: stat.mtimeNs, ctime: stat.ctimeNs, bytes: await readFile(file) };
  }));
  const before = await snapshot();
  const fence = await acquireLinuxRootWriterFence(root);
  try { await prepareExperimentalInPlaceSkillTrash({ mode: "isolated-experiment", root, sidecar,
    targetId: "fixture-target", fence }); }
  finally { await fence.release(); }
  const readSource = () => {
    const db = new DatabaseSync(sidecar, { readOnly: true });
    try { return db.prepare("SELECT body,sha256 FROM adoption").get(); } finally { db.close(); }
  };
  const v1Source = readSource();
  for (const fault of ["receipt-written", "intent-written", "before-commit"]) {
    await assert.rejects(prepareLegacyRootAdoptionExperimental(root, { experimentalOriginalSkillTrash: {
      ...options.experimentalOriginalSkillTrash, faultInjector: point => { if (point === fault) throw new Error("receipt rollback"); },
    } }), /receipt rollback/);
    const db = new DatabaseSync(sidecar, { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='original_receipt'").get().n, 0);
      assert.deepEqual(db.prepare("SELECT body,sha256 FROM adoption").get(), v1Source);
    } finally { db.close(); }
    assert.deepEqual(await snapshot(), before);
  }
  await assert.rejects(prepareLegacyRootAdoptionExperimental(root, options), /adoption journal and Sync recovery binding are not yet qualified/);
  assert.deepEqual(readSource(), v1Source);
  let db = new DatabaseSync(sidecar);
  let receiptRow;
  try {
    receiptRow = db.prepare("SELECT body,sha256 FROM original_receipt").get();
    assert.equal(receiptRow.sha256, hash(receiptRow.body));
    const receipt = JSON.parse(receiptRow.body), rootStat = await lstat(root, { bigint: true });
    assert.equal(receipt.schema, "pkm.legacy-trash-inplace-receipt/v2");
    assert.equal(receipt.root, root);
    assert.equal(receipt.rootDev, String(rootStat.dev));
    assert.equal(receipt.rootIno, String(rootStat.ino));
    assert.equal(receipt.sourceSha256, v1Source.sha256);
    const source = JSON.parse(v1Source.body);
    assert.equal(source.entries[0].identity.id, deleted.id);
    assert.equal(source.entries[0].identity.deletedAt, deleted.deletedAt);
    assert.deepEqual(Buffer.from(source.entries[0].metadataBase64, "base64"), await readFile(files[0]));
    assert.deepEqual(Buffer.from(receipt.journalBase64, "base64"), await readFile(files[3]));
    assert.deepEqual(Buffer.from(receipt.files.find(file => file.path === "skills/One.assets/a.png").base64, "base64"), attachment);
    assert(receipt.files.every(file => file.id === deleted.id));
    const forged = JSON.stringify({ ...receipt, root: join(parent, "other") });
    db.prepare("UPDATE original_receipt SET body=?, sha256=?").run(forged, hash(forged));
  } finally { db.close(); }
  await assert.rejects(prepareLegacyRootAdoptionExperimental(root, options), /receipt differs from the original source/);
  assert.deepEqual(await snapshot(), before);
  db = new DatabaseSync(sidecar);
  try {
    const forged = JSON.parse(receiptRow.body);
    forged.files[0].base64 = Buffer.from("foreign").toString("base64");
    const body = JSON.stringify(forged);
    db.prepare("UPDATE original_receipt SET body=?,sha256=?").run(body, hash(body));
  } finally { db.close(); }
  const secondFence = await acquireLinuxRootWriterFence(root);
  try {
    await assert.rejects(transitionExperimentalOriginalRestoreJournal({ mode: "isolated-experiment", root, sidecar,
      targetId: "fixture-target", entryId: deleted.id, fence: secondFence }),
    /in-place adoption receipt bytes or identity differ/);
  } finally { await secondFence.release(); }
  db = new DatabaseSync(sidecar);
  try { db.prepare("UPDATE original_receipt SET body=?,sha256=?").run(receiptRow.body, receiptRow.sha256); }
  finally { db.close(); }
  await assert.rejects(prepareLegacyRootAdoptionExperimental(root, options), /adoption journal and Sync recovery binding are not yet qualified/);
  assert.deepEqual(await snapshot(), before);
  assert.equal(existsSync(join(root, ".pkm-next-workspace")), false);
  assert.equal(existsSync(join(root, "core.sqlite")), false);
});

test("v1 sidecar upgrade SIGKILL retains unknown rollback state and replays a committed receipt", { timeout: 30000 }, async t => {
  const mask = process.umask(0o077);
  t.after(() => process.umask(mask));
  const parent = resolve(".migration-test-work", `original-receipt-crash-${randomUUID()}`);
  for (const point of ["receipt-written", "committed"]) {
  const root = join(parent, point, "root"), syncDir = join(parent, point, "profile/github-sync/experimental-next");
  const sidecar = join(syncDir, "fixture-target.original-trash.sqlite");
  t.after(() => rm(parent, { recursive: true, force: true }));
  await mkdir(join(root, "skills/One.assets"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, "notes"), { recursive: true, mode: 0o700 });
  await mkdir(syncDir, { recursive: true, mode: 0o700 });
  await writeFile(join(root, "skills/One.md"), "---\nname: One\n---\n![image](One.assets/a.png)\n");
  await writeFile(join(root, "skills/One.assets/a.png"), "original attachment");
  original.setStorePath(root);
  const deleted = original.skillMoveToTrash("One");
  const journal = join(root, ".pkm/state/knowledge-deletions.json");
  const before = await readFile(journal), asset = join(root, "skills/.trash", deleted.id, "assets/a.png");
  const fence = await acquireLinuxRootWriterFence(root);
  try { await prepareExperimentalInPlaceSkillTrash({ mode: "isolated-experiment", root, sidecar,
    targetId: "fixture-target", fence }); }
  finally { await fence.release(); }
  const worker = `
    const { prepareLegacyRootAdoptionExperimental } = await import(process.argv[1]);
    await prepareLegacyRootAdoptionExperimental(process.argv[2], {
      experimentalOriginalSkillTrash: { mode: "isolated-experiment", sidecar: process.argv[3], targetId: "fixture-target",
        faultInjector: point => { if (point === process.argv[4]) process.kill(process.pid, "SIGKILL"); } }
    });
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", worker,
    new URL("../dist/legacy-root-adoption.js", import.meta.url).href, root, sidecar, point], { encoding: "utf8", timeout: 30000 });
  assert.equal(child.signal, "SIGKILL", `${child.stdout}\n${child.stderr}`);
  const options = { experimentalOriginalSkillTrash: { mode: "isolated-experiment", sidecar, targetId: "fixture-target" } };
  await reviewAbandonedFixtureLock(join(parent, point, "profile/github-sync/targets-state.lock"),
    () => prepareLegacyRootAdoptionExperimental(root, options));
  if (point === "receipt-written") {
    assert(existsSync(`${sidecar}-journal`));
    const pending = await readFile(`${sidecar}-journal`);
    await assert.rejects(prepareLegacyRootAdoptionExperimental(root, options), /unrecognized SQLite recovery journal/);
    assert.deepEqual(await readFile(`${sidecar}-journal`), pending);
  } else {
    await assert.rejects(prepareLegacyRootAdoptionExperimental(root, options), /adoption journal and Sync recovery binding are not yet qualified/);
    const db = new DatabaseSync(sidecar, { readOnly: true });
    try { assert.equal(JSON.parse(db.prepare("SELECT body FROM original_receipt").get().body).schema, "pkm.legacy-trash-inplace-receipt/v2"); }
    finally { db.close(); }
  }
  assert.deepEqual(await readFile(journal), before);
  assert.equal(await readFile(asset, "utf8"), "original attachment");
  assert.equal(existsSync(join(root, ".pkm-next-workspace")), false);
  assert.equal(existsSync(join(root, "core.sqlite")), false);
  }
});

test("gated same-root adoption prepares original Trash before workspace and recovers without cutover", async t => {
  const mask = process.umask(0o077);
  t.after(() => process.umask(mask));
  const parent = resolve(".migration-test-work", `original-skill-adoption-${randomUUID()}`);
  const root = join(parent, "root");
  const syncDir = join(parent, "profile/github-sync/experimental-next");
  const sidecar = join(syncDir, "fixture-target.original-trash.sqlite");
  await mkdir(join(root, "skills/One.assets"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, "notes"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, ".pkm"), { recursive: true, mode: 0o700 });
  await mkdir(syncDir, { recursive: true, mode: 0o700 });
  t.after(() => rm(parent, { recursive: true, force: true }));
  await writeFile(join(root, ".pkm/content-privacy.json"), JSON.stringify({ schema: 1, private: {} }));
  await writeFile(join(root, "notes/Existing.md"), "---\ntitle: Existing\n---\nNote.\n");
  await writeFile(join(root, "skills/One.md"), "---\nname: One\n---\n![image](One.assets/a.png)\n");
  await writeFile(join(root, "skills/One.assets/a.png"), Buffer.from([0, 1, 254, 255]));
  original.setStorePath(root);
  const clock = Date.now;
  let deleted;
  try {
    Date.now = () => {
      const time = clock();
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      return time;
    };
    deleted = original.skillMoveToTrash("One");
  } finally { Date.now = clock; }
  assert(deleted);
  assert.notEqual(Number(deleted.id.split("-")[0]), Date.parse(deleted.deletedAt));
  async function snapshot(directory, prefix = "") {
    const result = [];
    for (const name of (await readdir(directory)).sort()) {
      const path = prefix ? `${prefix}/${name}` : name, file = join(directory, name);
      const stat = await lstat(file, { bigint: true });
      result.push({ path, dev: stat.dev, ino: stat.ino, mode: stat.mode, uid: stat.uid, gid: stat.gid,
        mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs, ...(stat.isFile() ? { bytes: await readFile(file) } : {}) });
      if (stat.isDirectory()) result.push(...await snapshot(file, path));
    }
    return result;
  }
  const worker = `
    const { prepareLegacyRootAdoptionExperimental } = await import(process.argv[1]);
    await prepareLegacyRootAdoptionExperimental(process.argv[2], {
      experimentalOriginalSkillTrash: { mode: "isolated-experiment", sidecar: process.argv[3], targetId: "fixture-target",
        faultInjector: point => { if (point === process.argv[4]) process.kill(process.pid, "SIGKILL"); } }
    });
  `;
  const options = { experimentalOriginalSkillTrash: { mode: "isolated-experiment", sidecar, targetId: "fixture-target" } };
  await writeFile(join(root, "core.sqlite"), "unrecognized Next state");
  await assert.rejects(prepareLegacyRootAdoptionExperimental(root, options), /existing Next state/);
  assert.equal(existsSync(sidecar), false);
  assert.equal(await readFile(join(root, "core.sqlite"), "utf8"), "unrecognized Next state");
  await rm(join(root, "core.sqlite"));
  const before = await snapshot(root);
  for (const point of ["sidecar-created", "database-opened", "receipt-written", "intent-written", "before-commit", "committed"]) {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", worker,
      new URL("../dist/legacy-root-adoption.js", import.meta.url).href, root, sidecar, point],
    { encoding: "utf8", timeout: 30000 });
    assert.equal(child.signal, "SIGKILL", `${point}: ${child.stdout}\n${child.stderr}`);
    await reviewAbandonedFixtureLock(join(parent, "profile/github-sync/targets-state.lock"),
      () => prepareLegacyRootAdoptionExperimental(root, options));
    await assert.rejects(prepareLegacyRootAdoptionExperimental(root, options),
      /Original Skill Trash is prepared, but adoption journal and Sync recovery binding are not yet qualified/);
    const db = new DatabaseSync(sidecar, { readOnly: true });
    try {
      const source = JSON.parse(db.prepare("SELECT body FROM adoption").get().body);
      const receiptRow = db.prepare("SELECT body,sha256 FROM original_receipt").get();
      const receipt = JSON.parse(receiptRow.body);
      assert.equal(receiptRow.sha256, hash(receiptRow.body));
      assert.equal(receipt.schema, "pkm.legacy-trash-inplace-receipt/v2");
      assert.equal(receipt.root, root);
      assert(receipt.files.some(file => file.id === deleted.id && file.path === "skills/One.md"));
      assert.equal(source.schema, "pkm.experimental-inplace-skill-trash-source/v2");
      assert.equal(source.entries[0].metadata.id, deleted.id);
      assert.equal(source.entries[0].metadata.deletedAt, deleted.deletedAt);
      const identity = source.entries[0].identity, rootStat = await lstat(root, { bigint: true });
      assert.equal(identity.schema, "pkm.original-skill-trash-identity/v1");
      assert.equal(identity.root, root);
      assert.equal(identity.rootDev, String(rootStat.dev));
      assert.equal(identity.rootIno, String(rootStat.ino));
      assert.equal(identity.id, deleted.id);
      assert.equal(identity.idTimestampMs, deleted.id.split("-")[0]);
      assert.notEqual(Number(identity.idTimestampMs), Date.parse(identity.deletedAt));
      assert.equal(identity.metadataSha256, hash(await readFile(join(root, "skills/.trash", deleted.id, "metadata.json"))));
      assert.equal(identity.journalSha256, hash(await readFile(join(root, ".pkm/state/knowledge-deletions.json"))));
      assert.equal(existsSync(`${sidecar}.binding`), false);
    } finally { db.close(); }
    assert.deepEqual(await snapshot(root), before);
    assert.equal(existsSync(join(root, ".pkm-next-workspace")), false);
    assert.equal(existsSync(join(root, ".pkm-next-root-adoption.json")), false);
    if (point !== "committed") await rm(sidecar);
  }
  assert.deepEqual(await readdir(join(root, "skills/.trash")), [deleted.id]);
  const originalAsset = join(root, "skills/.trash", deleted.id, "assets/a.png");
  await writeFile(originalAsset, "external change");
  await assert.rejects(prepareLegacyRootAdoptionExperimental(root, options), /source or Sync binding changed/);
  assert.equal(await readFile(originalAsset, "utf8"), "external change");
  await writeFile(originalAsset, Buffer.from([0, 1, 254, 255]));
  const metadataPath = join(root, "skills/.trash", deleted.id, "metadata.json");
  const originalMetadata = await readFile(metadataPath);
  const editedMetadata = Buffer.from(JSON.stringify(JSON.parse(originalMetadata.toString("utf8"))) + "\n");
  await writeFile(metadataPath, editedMetadata);
  await assert.rejects(prepareLegacyRootAdoptionExperimental(root, options), /not exact filestore v1 format/);
  assert.deepEqual(await readFile(metadataPath), editedMetadata);
  await writeFile(metadataPath, originalMetadata);
  await writeFile(`${sidecar}.binding`, "unknown binding", { mode: 0o600 });
  await assert.rejects(prepareLegacyRootAdoptionExperimental(root, options), /unknown binding state/);
  assert.equal(await readFile(`${sidecar}.binding`, "utf8"), "unknown binding");
  await rm(`${sidecar}.binding`);
  // This marker and Sync journal are synthetic; the real adoption remains blocked.
  const binding = { workspaceId: randomUUID(), targetId: "fixture-target", configHash: hash("target"), policyId: randomUUID() };
  await writeFile(join(root, ".pkm-next-workspace"),
    JSON.stringify({ schema: "pkm.next-workspace/v2", id: binding.workspaceId }), { mode: 0o600 });
  const syncJournal = join(syncDir, "fixture-target.json");
  await writeFile(syncJournal, JSON.stringify({ schema: "pkm.experimental-legacy-sync/v1", ...binding, phase: "idle" }), { mode: 0o600 });
  const bindWorker = `
    const [{ acquireLinuxRootWriterFence }, { admitExperimentalInPlaceSkillTrash }] = await Promise.all([
      import(process.argv[1]), import(process.argv[2]) ]);
    const root = process.argv[3], sidecar = process.argv[4], syncJournal = process.argv[5], binding = JSON.parse(process.argv[6]);
    const fence = await acquireLinuxRootWriterFence(root);
    await admitExperimentalInPlaceSkillTrash({ mode: "isolated-experiment", root, sidecar, syncJournal, binding, fence,
      faultInjector: point => { if (point === process.argv[7]) process.kill(process.pid, "SIGKILL"); } });
  `;
  const sourceBytes = await readFile(sidecar);
  for (const point of ["binding-sidecar-created", "binding-database-opened", "binding-intent-written",
    "binding-before-commit", "binding-committed"]) {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", bindWorker,
      new URL("../dist/linux-root-writer-fence.js", import.meta.url).href,
      new URL("../dist/legacy-inplace-skill-trash.js", import.meta.url).href,
      root, sidecar, syncJournal, JSON.stringify(binding), point], { encoding: "utf8", timeout: 30000 });
    assert.equal(child.signal, "SIGKILL", `${point}: ${child.stdout}\n${child.stderr}`);
    const fence = await acquireLinuxRootWriterFence(root);
    try {
      await reviewAbandonedFixtureLock(join(parent, "profile/github-sync/targets-state.lock"),
        () => admitExperimentalInPlaceSkillTrash({ mode: "isolated-experiment", root, sidecar, syncJournal, binding, fence }));
      const result = await admitExperimentalInPlaceSkillTrash({ mode: "isolated-experiment", root, sidecar, syncJournal, binding, fence });
      const db = new DatabaseSync(sidecar, { readOnly: true }), bindingDb = new DatabaseSync(`${sidecar}.binding`, { readOnly: true });
      try {
        const source = db.prepare("SELECT body,sha256 FROM adoption").get();
        const bound = JSON.parse(bindingDb.prepare("SELECT body FROM binding").get().body);
        assert.equal(result.sha256, source.sha256);
        assert.equal(bound.sourceSha256, source.sha256);
        assert.equal(JSON.parse(source.body).entries[0].metadata.id, deleted.id);
        assert.equal(bound.binding.workspaceId, binding.workspaceId);
      } finally { db.close(); bindingDb.close(); }
    } finally { await fence.release(); }
    assert.deepEqual(await readFile(sidecar), sourceBytes);
    if (point !== "binding-committed") await rm(`${sidecar}.binding`);
  }
  assert.equal(existsSync(join(root, ".pkm-next-root-adoption.commit.json")), false);
});

test("original writer Trash is recorded in place with exact Sync binding and atomic sidecar recovery", { timeout: 90000 }, async t => {
  const mask = process.umask(0o077);
  t.after(() => process.umask(mask));
  const parent = resolve(".migration-test-work", `original-skill-trash-${randomUUID()}`);
  const root = join(parent, "root"), profile = join(parent, "profile");
  const syncDir = join(profile, "github-sync/experimental-next");
  const sidecar = join(syncDir, "fixture-target.original-trash.sqlite"), syncJournal = join(syncDir, "fixture-target.json");
  await mkdir(join(root, "skills/One.assets"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, "notes"), { recursive: true, mode: 0o700 });
  await mkdir(syncDir, { recursive: true, mode: 0o700 });
  t.after(() => rm(parent, { recursive: true, force: true }));
  const content = "---\nname: One\n---\n![image](One.assets/a.png)\n";
  await writeFile(join(root, "skills/One.md"), content);
  await writeFile(join(root, "skills/One.assets/a.png"), "original attachment");
  originalJournal.recordKnowledgeResourceMutation(root, ["notes/Other Note.md"], [], () => true);
  original.setStorePath(root);
  const deleted = original.skillMoveToTrash("One");
  assert(deleted);
  const binding = { workspaceId: randomUUID(), targetId: "fixture-target", configHash: hash("target"), policyId: randomUUID() };
  await writeFile(join(root, ".pkm-next-workspace"),
    JSON.stringify({ schema: "pkm.next-workspace/v2", id: binding.workspaceId }), { mode: 0o600 });
  const takeoverFence = await acquireLinuxRootWriterFence(root);
  try { await markLinuxRootNextOwned(root, takeoverFence); }
  finally { await takeoverFence.release(); }
  assert.throws(() => original.skillTrashRestore(deleted.id), /legacy writes are fenced/);
  const journalPath = join(root, ".pkm/state/knowledge-deletions.json");
  const metadataPath = join(root, "skills/.trash", deleted.id, "metadata.json");
  const before = await readFile(journalPath), metadata = await readFile(metadataPath);
  assert(JSON.parse(before).records.some(record => record.path === "notes/Other Note.md"));
  await writeFile(syncJournal, JSON.stringify({ schema: "pkm.experimental-legacy-sync/v1", ...binding, phase: "idle" }), { mode: 0o600 });
  const worker = `
    const [{ acquireLinuxRootWriterFence }, { admitExperimentalInPlaceSkillTrash }] = await Promise.all([
      import(process.argv[1]), import(process.argv[2]) ]);
    const root = process.argv[3], sidecar = process.argv[4], binding = JSON.parse(process.argv[5]), syncJournal = process.argv[7];
    const fence = await acquireLinuxRootWriterFence(root);
    await admitExperimentalInPlaceSkillTrash({ mode: "isolated-experiment", root, sidecar, syncJournal, binding, fence,
      faultInjector: point => { if (point === process.argv[6]) process.kill(process.pid, "SIGKILL"); } });
    await fence.release();
  `;
  const invoke = async fault => {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", worker,
      new URL("../dist/linux-root-writer-fence.js", import.meta.url).href,
      new URL("../dist/legacy-inplace-skill-trash.js", import.meta.url).href,
      root, sidecar, JSON.stringify(binding), fault, syncJournal], { encoding: "utf8", timeout: 30000 });
    assert.equal(child.signal, "SIGKILL", `${child.stdout}\n${child.stderr}`);
  };
  let fence, adopted;
  fence = await acquireLinuxRootWriterFence(root);
  try {
    const markerPath = join(root, ".pkm-next-workspace"), marker = await readFile(markerPath);
    await rm(markerPath);
    await assert.rejects(admitExperimentalInPlaceSkillTrash({ mode: "isolated-experiment", root, sidecar, syncJournal, binding, fence }),
      /ENOENT/);
    assert.equal(existsSync(sidecar), false);
    await writeFile(markerPath, marker, { mode: 0o600 });
  } finally { await fence.release(); }
  for (const point of ["sidecar-created", "database-opened", "intent-written", "before-commit", "committed"]) {
    await invoke(point);
    fence = await acquireLinuxRootWriterFence(root);
    try {
      await reviewAbandonedFixtureLock(join(profile, "github-sync/targets-state.lock"),
        () => admitExperimentalInPlaceSkillTrash({ mode: "isolated-experiment", root, sidecar, syncJournal, binding, fence }));
      adopted = await admitExperimentalInPlaceSkillTrash({ mode: "isolated-experiment", root, sidecar, syncJournal, binding, fence });
    }
    finally { await fence.release(); }
    if (point !== "committed") await rm(sidecar);
  }
  assert.equal(adopted.entries.length, 1);
  assert.equal(adopted.entries[0].metadata.id, deleted.id);
  assert.deepEqual(Buffer.from(adopted.entries[0].metadataBase64, "base64"), metadata);
  assert.deepEqual(adopted.entries[0].files.map(file => file.path).sort(),
    ["skills/One.assets/a.png", "skills/One.md"]);
  fence = await acquireLinuxRootWriterFence(root);
  try {
    assert.deepEqual(await admitExperimentalInPlaceSkillTrash({ mode: "isolated-experiment", root, sidecar, syncJournal, binding, fence }), adopted);
    const markerPath = join(root, ".pkm-next-workspace");
    const marker = await readFile(markerPath);
    await writeFile(markerPath, JSON.stringify({ schema: "pkm.next-workspace/v2", id: randomUUID() }));
    await assert.rejects(admitExperimentalInPlaceSkillTrash({ mode: "isolated-experiment", root, sidecar, syncJournal, binding, fence }),
      /workspace identity differs/);
    await writeFile(markerPath, marker);
    const asset = join(root, "skills/.trash", deleted.id, "assets/a.png");
    await chmod(asset, 0o400);
    await assert.rejects(admitExperimentalInPlaceSkillTrash({ mode: "isolated-experiment", root, sidecar, syncJournal, binding, fence }),
      /source or Sync binding changed/);
    await chmod(asset, 0o600);
    const assetDirectory = join(root, "skills/.trash", deleted.id, "assets");
    await chmod(assetDirectory, 0o500);
    await assert.rejects(admitExperimentalInPlaceSkillTrash({ mode: "isolated-experiment", root, sidecar, syncJournal, binding, fence }),
      /source or Sync binding changed/);
    await chmod(assetDirectory, 0o700);
    const savedMetadata = join(profile, "saved-metadata");
    await rename(metadataPath, savedMetadata);
    await writeFile(metadataPath, metadata, { mode: 0o600 });
    await assert.rejects(admitExperimentalInPlaceSkillTrash({ mode: "isolated-experiment", root, sidecar, syncJournal, binding, fence }),
      /source or Sync binding changed/);
    await rm(metadataPath);
    await rename(savedMetadata, metadataPath);
    await assert.rejects(admitExperimentalInPlaceSkillTrash({ mode: "isolated-experiment", root, sidecar, syncJournal, binding, fence,
      faultInjector: point => { if (point === "intent-written") chmodSync(asset, 0o400); } }),
    /file identity, permissions or bytes changed before sidecar commit/);
    await chmod(asset, 0o600);
    const lateMember = join(assetDirectory, "late-member");
    await assert.rejects(admitExperimentalInPlaceSkillTrash({ mode: "isolated-experiment", root, sidecar, syncJournal, binding, fence,
      faultInjector: point => { if (point === "intent-written") writeFileSync(lateMember, "preserve"); } }),
    /original directory changed before sidecar commit/);
    assert.equal(await readFile(lateMember, "utf8"), "preserve");
    await rm(lateMember);
    await assert.rejects(admitExperimentalInPlaceSkillTrash({ mode: "isolated-experiment", root, sidecar, syncJournal, fence,
      binding: { ...binding, configHash: hash("changed") } }), /binding or phase differs/);
    await writeFile(join(root, "skills/.trash", deleted.id, "unexpected"), "preserve");
    await assert.rejects(admitExperimentalInPlaceSkillTrash({ mode: "isolated-experiment", root, sidecar, syncJournal, binding, fence }), /unknown/);
    assert.equal(await readFile(join(root, "skills/.trash", deleted.id, "unexpected"), "utf8"), "preserve");
    await rm(join(root, "skills/.trash", deleted.id, "unexpected"));
    const payloadPath = join(root, "skills/.trash", deleted.id, "payload");
    await writeFile(payloadPath, content + "external change\n");
    await assert.rejects(admitExperimentalInPlaceSkillTrash({ mode: "isolated-experiment", root, sidecar, syncJournal, binding, fence }),
      /source or Sync binding changed/);
    assert.equal(await readFile(payloadPath, "utf8"), content + "external change\n");
    await writeFile(payloadPath, content);
    await writeFile(`${sidecar}-journal`, "unrecognized recovery state", { mode: 0o600 });
    await assert.rejects(admitExperimentalInPlaceSkillTrash({ mode: "isolated-experiment", root, sidecar, syncJournal, binding, fence }),
      /unrecognized SQLite recovery journal/);
    assert.equal(await readFile(`${sidecar}-journal`, "utf8"), "unrecognized recovery state");
    await rm(`${sidecar}-journal`);
    const attempt = join(profile, "contender-attempt"), done = join(profile, "contender-done");
    let contender;
    await admitExperimentalInPlaceSkillTrash({ mode: "isolated-experiment", root, sidecar, syncJournal, binding, fence,
      faultInjector: point => {
        if (point !== "intent-written") return;
        const code = `
          const fs = require("node:fs"), { withCrossProcessLock } = require(process.argv[1]);
          fs.writeFileSync(process.argv[3], "attempt");
          withCrossProcessLock(process.argv[2], "synthetic target writer", 10000, async () => {
            const value = JSON.parse(fs.readFileSync(process.argv[5], "utf8"));
            value.configHash = "${hash("external target change")}";
            fs.writeFileSync(process.argv[5], JSON.stringify(value));
            fs.writeFileSync(process.argv[4], "done");
          }).catch(() => { process.exitCode = 1; });
        `;
        contender = spawn(process.execPath, ["-e", code, resolve("legacy/dist/runtime/cross-process-lock.js"),
          join(profile, "github-sync/targets-state.lock"), attempt, done, syncJournal], { stdio: "ignore" });
        const limit = Date.now() + 5000;
        while (!existsSync(attempt) && Date.now() < limit) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        assert(existsSync(attempt), "contending writer must attempt the actual target lock");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
        assert.equal(existsSync(done), false, "target writer must not change the journal during admission");
      } });
    const status = await new Promise(done => contender.once("exit", done));
    assert.equal(status, 0);
    assert.equal(await readFile(done, "utf8"), "done");
    await assert.rejects(admitExperimentalInPlaceSkillTrash({ mode: "isolated-experiment", root, sidecar, syncJournal, binding, fence }),
      /binding or phase differs/);
  } finally { await fence.release(); }
  assert.deepEqual(await readFile(journalPath), before);
  assert.deepEqual(await readFile(metadataPath), metadata);
  assert.equal(await readFile(join(root, "skills/.trash", deleted.id, "payload"), "utf8"), content);
  assert.equal(await readFile(join(root, "skills/.trash", deleted.id, "assets/a.png"), "utf8"), "original attachment");
  assert.deepEqual(await readdir(join(root, "skills/.trash")), [deleted.id]);
});

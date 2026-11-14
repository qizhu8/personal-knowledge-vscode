import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { lstat, mkdir, readFile, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { prepareLegacyRootAdoptionExperimental, legacyRootAdoptionLockDirectory,
  resumeLegacyRootAdoptionExperimental } from "../dist/legacy-root-adoption.js";
import { inspectLinuxLegacyWriterQuiescence } from "../dist/linux-legacy-writer-quiescence.js";

const testsRoot = dirname(fileURLToPath(import.meta.url));
const childScript = join(testsRoot, "linux-legacy-writer-process-child.mjs");
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
const rootHash = root => createHash("sha256").update(root).digest("hex").slice(0, 40);

async function waitForFile(file, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return await readFile(file, "utf8"); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      await delay(10);
    }
  }
  throw new Error(`Timed out waiting for synthetic process ${file}`);
}

function start(mode, root, readyPath, ...args) {
  return spawn(process.execPath, [childScript, mode, readyPath, root, ...args],
    { stdio: ["pipe", "ignore", "ignore"] });
}

async function waitForClose(child) {
  if (child.exitCode !== null || child.signalCode !== null)
    return { code: child.exitCode, signal: child.signalCode };
  return new Promise(resolveClose => child.once("close", () => resolveClose({ code: child.exitCode, signal: child.signalCode })));
}

async function closeChild(child) {
  if (child.exitCode === null && child.signalCode === null) child.stdin.end();
  return waitForClose(child);
}

async function snapshot(root) {
  const entries = [];
  async function visit(directory, prefix = "") {
    for (const name of (await readdir(directory)).sort()) {
      const path = prefix ? `${prefix}/${name}` : name, full = join(directory, name);
      const stat = await lstat(full, { bigint: true });
      entries.push({
        path, kind: stat.isDirectory() ? "directory" : "file",
        dev: stat.dev.toString(), ino: stat.ino.toString(), mode: Number(stat.mode & 0o777n),
        mtimeNs: stat.mtimeNs.toString(), ctimeNs: stat.ctimeNs.toString(),
        ...(stat.isFile() ? { sha256: createHash("sha256").update(await readFile(full)).digest("hex") } : {}),
      });
      if (stat.isDirectory()) await visit(full, path);
    }
  }
  await visit(root);
  return entries;
}

async function cleanup(root, readyPaths) {
  for (const file of readyPaths) await rm(file, { force: true });
  await rm(root, { recursive: true, force: true });
  const directory = legacyRootAdoptionLockDirectory(root), prefix = rootHash(root);
  try {
    for (const name of await readdir(directory)) {
      if (name.startsWith(`${prefix}.`)) await rm(join(directory, name), { recursive: true, force: true });
    }
    await rmdir(directory);
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
  }
}

async function fixture(t) {
  const root = resolve(testsRoot, `.linux-writer-quiescence-${randomUUID()}`);
  const readyPaths = [];
  await mkdir(join(root, "notes"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, "mcp-server"), { mode: 0o700 });
  await writeFile(join(root, "notes", "Existing.md"),
    "---\ntitle: Existing\ndocumentId: quiescence-note\nrevision: 1\n---\nSynthetic content.\n",
    { mode: 0o600 });
  t.after(() => cleanup(root, readyPaths));
  const ready = name => {
    const file = join(testsRoot, `.linux-writer-quiescence-${randomUUID()}-${name}`);
    readyPaths.push(file);
    return file;
  };
  return { root, ready };
}

test("multiple uninstrumented extension hosts block adoption and resume until each exits", {
  skip: process.platform !== "linux", timeout: 30000,
}, async t => {
  const { root, ready } = await fixture(t);
  const hosts = [];
  t.after(async () => { for (const host of hosts) await closeChild(host); });

  const firstFile = ready("window-one"), secondFile = ready("window-two");
  const first = start("hold", root, firstFile, "--type=extensionHost");
  const second = start("hold", root, secondFile, "--type=extensionHost");
  hosts.push(first, second);
  assert.equal(await waitForFile(firstFile), "ready");
  assert.equal(await waitForFile(secondFile), "ready");

  const report = await inspectLinuxLegacyWriterQuiescence(root);
  assert.deepEqual(report.blockers.filter(item => item.kind === "vscode-extension-host").map(item => item.pid).sort((a, b) => a - b),
    [first.pid, second.pid].sort((a, b) => a - b));
  await assert.rejects(prepareLegacyRootAdoptionExperimental(root, {}), { code: "LEGACY_WRITERS_ACTIVE" });

  await closeChild(first);
  assert.deepEqual((await inspectLinuxLegacyWriterQuiescence(root)).blockers
    .filter(item => item.kind === "vscode-extension-host").map(item => item.pid), [second.pid]);
  await assert.rejects(prepareLegacyRootAdoptionExperimental(root, {}), { code: "LEGACY_WRITERS_ACTIVE" });
  await closeChild(second);
  const prepared = await prepareLegacyRootAdoptionExperimental(root, {});
  assert.equal(prepared.recoveredPendingPlan, false);

  const restartedHostFile = ready("restart-window");
  const restartedHost = start("hold", root, restartedHostFile, "--type=extensionHost");
  hosts.push(restartedHost);
  assert.equal(await waitForFile(restartedHostFile), "ready");
  const before = await snapshot(root);
  await assert.rejects(resumeLegacyRootAdoptionExperimental(root, {}), { code: "LEGACY_WRITERS_ACTIVE" });
  assert.deepEqual(await snapshot(root), before);
  await closeChild(restartedHost);

  const resumed = await resumeLegacyRootAdoptionExperimental(root, {});
  assert.equal(resumed.recoveredPendingPlan, true);
  await resumed.storage.close();
  assert.equal((await inspectLinuxLegacyWriterQuiescence(root)).blockers.length, 0);
});

test("root-specific legacy MCP and writable file handles block the handoff without terminating processes", {
  skip: process.platform !== "linux", timeout: 15000,
}, async t => {
  const { root, ready } = await fixture(t);
  const children = [];
  t.after(async () => { for (const child of children) await closeChild(child); });

  const serverPath = join(root, "mcp-server", "server.py");
  const mcpFile = ready("legacy-mcp");
  const mcp = start("hold", root, mcpFile, serverPath);
  children.push(mcp);
  assert.equal(await waitForFile(mcpFile), "ready");
  assert.ok((await inspectLinuxLegacyWriterQuiescence(root)).blockers.some(item => item.pid === mcp.pid && item.kind === "legacy-mcp"));
  await closeChild(mcp);

  const writerFile = ready("writable-handle");
  const writer = start("writable", root, writerFile);
  children.push(writer);
  assert.equal(await waitForFile(writerFile), "ready");
  assert.ok((await inspectLinuxLegacyWriterQuiescence(root)).blockers.some(item => item.pid === writer.pid && item.kind === "writable-root-handle"));
  await closeChild(writer);
  assert.equal((await inspectLinuxLegacyWriterQuiescence(root)).blockers.length, 0);
});

test("a VS Code-shaped ancestor is not implicitly trusted", {
  skip: process.platform !== "linux", timeout: 15000,
}, async t => {
  const { root, ready } = await fixture(t);
  const result = spawnSync(process.execPath, [childScript, "inspect-as-parent", ready("ancestor"), root, "--type=extensionHost"],
    { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.deepEqual(value.report.allowedExtensionHostPids, []);
  assert(value.report.blockers.some(item => item.pid === value.parent && item.kind === "vscode-extension-host"));
});

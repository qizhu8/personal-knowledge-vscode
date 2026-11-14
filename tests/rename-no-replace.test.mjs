import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  noReplacePlatformSupported, renameNoReplace, renameNoReplaceProgram, renameNoReplaceSync,
} from "../dist/rename-no-replace.js";

const python = execFileSync(process.platform === "win32" ? "python" : "python3",
  ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
const supported = noReplacePlatformSupported(process.platform);
async function fixture(t) {
  const root = resolve(import.meta.dirname, `.rename-no-replace-${randomUUID()}`);
  await mkdir(root);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, source: join(root, "source space \u4e2d"), destination: join(root, "destination \u6587") };
}
test("only Linux and Windows have a qualified no-replace API branch", () => {
  assert.equal(noReplacePlatformSupported("linux"), true);
  assert.equal(noReplacePlatformSupported("win32"), true);
  for (const platform of ["darwin", "freebsd", "aix", "unknown"]) assert.equal(noReplacePlatformSupported(platform), false);
});
for (const [mode, move] of [["async", renameNoReplace], ["sync", renameNoReplaceSync]]) {
  for (const kind of ["file", "directory"]) {
    test(`${mode} no-replace moves real ${kind} bytes including Unicode and spaces`, { skip: !supported }, async t => {
      const { source, destination } = await fixture(t);
      if (kind === "directory") {
        await mkdir(join(source, "nested space"), { recursive: true });
        await writeFile(join(source, "nested space", "\u4e2d\u6587.bin"), Buffer.from([0, 255, 128]));
      } else await writeFile(source, Buffer.from([0, 255, 128]));
      await move(source, destination, python);
      await assert.rejects(readFile(source), { code: "ENOENT" });
      assert.deepEqual(await readFile(kind === "directory" ? join(destination, "nested space", "\u4e2d\u6587.bin") : destination),
        Buffer.from([0, 255, 128]));
    });
  }
  for (const sourceKind of ["file", "directory"]) {
    for (const target of ["file", "empty-directory", "nonempty-directory", "symlink"]) {
      test(`${mode} no-replace preserves ${sourceKind} source and existing ${target}`, { skip: !supported || target === "symlink" && process.platform === "win32" }, async t => {
        const { root, source, destination } = await fixture(t);
        if (sourceKind === "directory") await mkdir(source);
        await writeFile(sourceKind === "directory" ? join(source, "payload") : source, "source bytes");
        if (target === "file") await writeFile(destination, "destination bytes");
        else if (target === "symlink") {
          await mkdir(join(root, "outside"));
          await writeFile(join(root, "outside/sentinel"), "destination bytes");
          await symlink(join(root, "outside"), destination);
        } else {
          await mkdir(destination);
          if (target === "nonempty-directory") await writeFile(join(destination, "sentinel"), "destination bytes");
        }
        await assert.rejects(async () => move(source, destination, python), error => error.code === "DESTINATION_EXISTS"
          // Windows reports ERROR_ACCESS_DENIED for some existing target types.
          || process.platform === "win32" && error.code === "MOVE_FAILED");
        assert.equal(await readFile(sourceKind === "directory" ? join(source, "payload") : source, "utf8"), "source bytes");
        if (target === "file") assert.equal(await readFile(destination, "utf8"), "destination bytes");
        if (target === "empty-directory") assert.deepEqual(await readdir(destination), []);
        if (target === "nonempty-directory" || target === "symlink") {
          assert.equal(await readFile(join(destination, "sentinel"), "utf8"), "destination bytes");
        }
      });
    }
  }
}
for (const empty of [true, false]) {
  test(`racing publishers never replace the ${empty ? "empty" : "nonempty"} directory winner`, { skip: !supported }, async t => {
    const { root, destination } = await fixture(t);
    const sources = Array.from({ length: 4 }, (_, index) => join(root, `stage-${index}`));
    for (const [index, path] of sources.entries()) {
      await mkdir(path);
      if (!empty) await writeFile(join(path, "winner"), String(index));
    }
    const results = await Promise.allSettled(sources.map(source => renameNoReplace(source, destination, python)));
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    const winner = results.findIndex(result => result.status === "fulfilled");
    if (!empty) assert.equal(await readFile(join(destination, "winner"), "utf8"), String(winner));
    for (const [index, source] of sources.entries()) {
      if (index === winner) await assert.rejects(readdir(source), { code: "ENOENT" });
      else if (empty) assert.deepEqual(await readdir(source), []);
      else assert.equal(await readFile(join(source, "winner"), "utf8"), String(index));
    }
  });
}
test("missing Python fails explicitly without any filesystem fallback", { skip: !supported }, async t => {
  const { root, source, destination } = await fixture(t);
  await mkdir(source);
  await assert.rejects(renameNoReplace(source, destination, join(root, "missing-python")), { code: "UNAVAILABLE" });
  assert.throws(() => renameNoReplaceSync(source, destination, join(root, "missing-python")), { code: "UNAVAILABLE" });
  assert.deepEqual(await readdir(source), []);
  await assert.rejects(readdir(destination), { code: "ENOENT" });
});
test("invalid addresses never start a filesystem move", async () => {
  await assert.rejects(renameNoReplace("relative", resolve("target"), python), TypeError);
  assert.throws(() => renameNoReplaceSync(resolve("same"), resolve("same"), python), TypeError);
});
test("missing source fails without creating a destination", { skip: !supported }, async t => {
  const { source, destination } = await fixture(t);
  await assert.rejects(renameNoReplace(source, destination, python), { code: "MOVE_FAILED" });
  assert.throws(() => renameNoReplaceSync(source, destination, python), { code: "MOVE_FAILED" });
  await assert.rejects(stat(destination), { code: "ENOENT" });
});
test("real cross-volume moves fail rather than copy/delete", { skip: process.platform !== "linux" }, async t => {
  const { root, source } = await fixture(t);
  let volume;
  try { volume = await mkdtemp("/dev/shm/pkm-no-replace-"); }
  catch (error) {
    if (["ENOENT", "EACCES", "ENOSPC"].includes(error.code)) return t.skip(`No available second test volume: ${error.code}`);
    throw error;
  }
  t.after(() => rm(volume, { recursive: true, force: true }));
  if ((await stat(volume)).dev === (await stat(root)).dev) return t.skip("No distinct test filesystem");
  await mkdir(source);
  await writeFile(join(source, "payload"), "retained source");
  const destination = join(volume, "target");
  await assert.rejects(renameNoReplace(source, destination, python), { code: "MOVE_FAILED" });
  assert.throws(() => renameNoReplaceSync(source, destination, python), { code: "MOVE_FAILED" });
  assert.equal(await readFile(join(source, "payload"), "utf8"), "retained source");
  await assert.rejects(stat(destination), { code: "ENOENT" });
});

function windowsSimulation({ source = "C:/PKM root/\u4e2d\u6587", destination = "C:/PKM root/target", winerror = 0, success = false } = {}) {
  // Execute the actual Python helper against a fake kernel32, not a second implementation.
  const harness = [
    "import ctypes, json, sys",
    "from ctypes import wintypes",
    "data = json.loads(sys.argv[1])",
    "class Move:",
    " def __call__(self, source, destination, flags):",
    "  assert self.argtypes == [wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD]",
    "  assert self.restype == wintypes.BOOL",
    "  print(json.dumps({'source':source,'destination':destination,'flags':flags}))",
    "  return data['success']",
    "class Kernel: MoveFileExW = Move()",
    "def load(name, use_last_error):",
    " assert name == 'kernel32' and use_last_error is True",
    " return Kernel()",
    "ctypes.WinDLL = load",
    "ctypes.get_last_error = lambda: data['winerror']",
    "sys.platform = 'win32'",
    "sys.argv = ['helper', data['source'], data['destination']]",
    "exec(compile(sys.stdin.read(), '<rename-no-replace>', 'exec'))",
  ].join("\n");
  return spawnSync(python, ["-c", harness, JSON.stringify({ source, destination, winerror, success })], {
    input: renameNoReplaceProgram, encoding: "utf8", env: { ...process.env, PYTHONUTF8: "1" },
  });
}
test("Windows branch uses Unicode MoveFileExW with WRITE_THROUGH and NO replace/copy flags", () => {
  const result = windowsSimulation({ success: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    source: "\\\\?\\C:\\PKM root\\\u4e2d\u6587", destination: "\\\\?\\C:\\PKM root\\target", flags: 8,
  });
});
for (const [label, source, expected] of [
  ["UNC", "\\\\server\\share\\folder", "\\\\?\\UNC\\server\\share\\folder"],
  ["extended", "\\\\?\\C:\\folder", "\\\\?\\C:\\folder"],
  ["long", `C:\\${"long-folder\\".repeat(40)}file`, `\\\\?\\C:\\${"long-folder\\".repeat(40)}file`],
]) {
  test(`Windows branch preserves ${label} absolute path addressing`, () => {
    const result = windowsSimulation({ source, success: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).source, expected);
  });
}
for (const [winerror, status] of [[80, 17], [183, 17], [17, 18], [5, 79], [32, 79], [2, 79]]) {
  test(`Windows error ${winerror} remains an explicit failure, never replacement/copy`, () => {
    const result = windowsSimulation({ winerror });
    assert.equal(result.status, status, result.stderr);
    assert.match(result.stderr, new RegExp(`winerror=${winerror}`));
    assert.equal(JSON.parse(result.stdout).flags, 8);
  });
}
test("unsupported OS and missing Linux no-replace API refuse publication explicitly", () => {
  for (const [platform, expected] of [["darwin", 77], ["linux", 78]]) {
    const result = spawnSync(python, ["-c", [
      "import ctypes, sys",
      `sys.platform = ${JSON.stringify(platform)}`,
      "ctypes.CDLL = lambda *args, **kwargs: object()",
      "sys.argv = ['helper', '/source', '/destination']",
      "exec(compile(sys.stdin.read(), '<rename-no-replace>', 'exec'))",
    ].join("\n")], { input: renameNoReplaceProgram, encoding: "utf8" });
    assert.equal(result.status, expected, result.stderr);
  }
});

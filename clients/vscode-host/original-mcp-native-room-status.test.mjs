import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url)), require = createRequire(import.meta.url);
const built = await require("esbuild").build({
  entryPoints: [join(root, "clients/vscode-host/original-mcp-native-room-status.ts")],
  bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent",
});
const compiled = new Module(join(root, "room-status-memory.cjs"));
compiled.filename = join(root, "room-status-memory.cjs"); compiled.paths = Module._nodeModulePaths(root);
compiled._compile(built.outputFiles[0].text, compiled.filename);
const api = compiled.exports, hash = value => createHash("sha256").update(value).digest("hex");
async function fixture(t) {
  const directory = join(root, ".migration-test-work", `room-status-${randomUUID()}`);
  const resources = join(directory, "next-runtime/server/legacy/resources");
  await mkdir(resources, { recursive: true, mode: 0o700 });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const baseline = process.env.PKM_LEGACY_VSIX || join(root, "../personal-knowledge-vscode/personal-knowledge-4.0.22.vsix");
  assert.equal(hash(await readFile(baseline)), "1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27");
  const files = {};
  for (const name of ["chat_server.py.template", "mcp_call_guard.py"]) {
    const bytes = execFileSync("unzip", ["-p", baseline, `extension/resources/${name}`]);
    await writeFile(join(resources, name), bytes, { mode: 0o600 });
    files[`server/legacy/resources/${name}`] = hash(bytes);
  }
  await writeFile(join(directory, "next-runtime/manifest.json"), JSON.stringify({ files }), { mode: 0o600 });
  const oracle = args => execFileSync("python3", ["-I", "-B", "-c",
    "import asyncio,json,runpy,sys;sys.path.insert(0,sys.argv[1]);m=runpy.run_path(sys.argv[1]+'/chat_server.py.template');f=m['chat_status'];f=getattr(f,'fn',f);sys.stdout.write(asyncio.run(f(**json.loads(sys.argv[2]))))",
    resources, JSON.stringify(args)], { encoding: "utf8", env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: "1" } });
  return { directory, resources, oracle };
}
test("native status executes the exact original producer, preserves named-client errors and creates no client/credential file", async t => {
  const f = await fixture(t);
  assert.equal(api.originalMcpNativeRoomStatusAvailable(f.directory), true);
  for (const args of [{}, { name: "雪 'agent' \"one\"\\x" }, { name: "  " }]) {
    const actual = await api.readOriginalMcpNativeRoomStatus(f.directory, args, new AbortController().signal);
    assert.deepEqual(actual, { result: f.oracle(args) });
  }
  assert.deepEqual(await readdir(f.resources), ["chat_server.py.template", "mcp_call_guard.py"]);
  const original = JSON.parse((await api.readOriginalMcpNativeRoomStatus(f.directory, {}, new AbortController().signal)).result);
  assert.deepEqual(original, { ok: true, active_aliases: [], connections: [] });
});
test("missing/changed original status payload and pre-aborted work fail closed without a fallback engine", async t => {
  const f = await fixture(t);
  assert.equal(api.originalMcpNativeRoomStatusAvailable(join(f.directory, "missing")), false);
  await assert.rejects(api.readOriginalMcpNativeRoomStatus(join(f.directory, "missing"), {}, new AbortController().signal),
    { code: "NATIVE_ROOM_STATUS_PRODUCER_UNAVAILABLE" });
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(api.readOriginalMcpNativeRoomStatus(f.directory, {}, cancelled.signal), { code: "NATIVE_ROOM_CANCELLED" });
  const running = new AbortController(), timer = setTimeout(() => running.abort(), 20);
  try {
    await assert.rejects(api.readOriginalMcpNativeRoomStatus(f.directory, {}, running.signal), { code: "NATIVE_ROOM_CANCELLED" });
  } finally { clearTimeout(timer); }
  assert.deepEqual(await readdir(f.resources), ["chat_server.py.template", "mcp_call_guard.py"]);
  await writeFile(join(f.resources, "chat_server.py.template"), "# changed producer, never execute\n");
  assert.equal(api.originalMcpNativeRoomStatusAvailable(f.directory), false);
  await assert.rejects(api.readOriginalMcpNativeRoomStatus(f.directory, {}, new AbortController().signal),
    { code: "NATIVE_ROOM_STATUS_PRODUCER_CHANGED" });
});

test("the actual status process denies a retained import attempting a file writer", async t => {
  const f = await fixture(t), path = join(f.resources, "mcp_call_guard.py");
  const bytes = Buffer.concat([await readFile(path), Buffer.from("\nopen('not-an-authorized-Room-writer', 'w').write('blocked')\n")]);
  await writeFile(path, bytes);
  const manifestPath = join(f.directory, "next-runtime/manifest.json"), manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.files["server/legacy/resources/mcp_call_guard.py"] = hash(bytes);
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(api.readOriginalMcpNativeRoomStatus(f.directory, {}, new AbortController().signal),
    { code: "NATIVE_ROOM_STATUS_PRODUCER_FAILED" });
  assert.deepEqual(await readdir(f.resources), ["chat_server.py.template", "mcp_call_guard.py"]);
});

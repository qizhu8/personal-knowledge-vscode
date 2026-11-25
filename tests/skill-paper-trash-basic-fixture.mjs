import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { compatibilityMcpFixture, compatibilityMcpValue } from "./compatibility-mcp-fixture.mjs";
import { pinnedOriginalKnowledgeWriterFixture } from "./original-knowledge-writer-fixture.mjs";

export const value = compatibilityMcpValue;
export const hash = bytes => createHash("sha256").update(bytes).digest("hex");
export const assetBytes = Buffer.from([255, 0, 128, 13, 10, 9]);
const originalSha256 = "1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27";
const kinds = [["skill", "skills"], ["paper", "papers"]];

export async function skillPaperTrashFixture(t, { shared = false } = {}) {
  assert(process.env.PKM_TEST_WORKSPACE, "Use the existing private test framework.");
  assert(process.env.PKM_TEST_PYTHON, "Use the exact business Python interpreter.");
  process.umask(0o077);
  const evidence = resolve(".pkm-test-evidence");
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(evidence, "skill-paper-trash-package-"));
  const brand = { schema: "pkm.skill-paper-trash-fixture/v1", id: randomUUID(), directory };
  await writeFile(join(directory, "brand.json"), JSON.stringify(brand), { mode: 0o600 });
  let fixture;
  t.after(async () => {
    if (!fixture) {
      assert.deepEqual(JSON.parse(await readFile(join(directory, "brand.json"))), brand);
      await rm(directory, { recursive: true, force: true });
    }
  });
  const extension = join(directory, "extension");
  const archive = process.env.PKM_LEGACY_VSIX;
  assert.equal(hash(await readFile(archive)), originalSha256);
  await mkdir(extension, { mode: 0o700 });
  execFileSync(process.env.PKM_TEST_PYTHON, ["-I", "-B", "-c", `
import json,stat,sys,zipfile
from pathlib import Path,PurePosixPath
root=Path(sys.argv[1])
with zipfile.ZipFile(sys.argv[2]) as archive:
 metadata=json.loads(archive.read("extension/package.json"))
 assert (metadata["publisher"],metadata["name"],metadata["version"])==("Uone","personal-knowledge","4.0.22")
 names=set()
 total=0
 for info in archive.infolist():
  name=info.filename
  if not name.startswith("extension/"): continue
  member=name[len("extension/"):]
  if not (member=="package.json" or member.startswith(("dist/","resources/","node_modules/","modules/"))): continue
  path=PurePosixPath(member)
  if name in names or path.is_absolute() or ".." in path.parts or "\\\\" in member or ":" in member:
   raise ValueError("Unsafe or duplicate original release member")
  names.add(name)
  total+=info.file_size
  if stat.S_ISLNK(info.external_attr>>16) or info.file_size>16*1024*1024 or total>128*1024*1024:
   raise ValueError("Unbounded original release member")
  target=root.joinpath(*path.parts)
  target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
  if not info.is_dir():
   with target.open("xb") as output: output.write(archive.read(info))
`, extension, archive], { cwd: directory, stdio: "pipe", timeout: 30000 });
  // The shared fixture's outer process supervisor is test custody, not Original business code.
  const hostExtension = process.env.PKM_COMPATIBILITY_EXTENSION || resolve("../personal-knowledge-vscode");
  await copyFile(join(hostExtension, "resources/next_mcp_subreaper.py"), join(extension, "resources/next_mcp_subreaper.py"));
  const oracleDirectory = join(directory, "oracle");
  await mkdir(oracleDirectory, { mode: 0o700 });
  const oracle = pinnedOriginalKnowledgeWriterFixture({
    directory: oracleDirectory, legacyVsix: archive, python: process.env.PKM_TEST_PYTHON,
  });
  const oracleRoot = join(oracleDirectory, "library");
  await mkdir(oracleRoot, { mode: 0o700 });
  const documents = oracle.run(oracleRoot, `
    const rows = [];
    for (const [kind, area] of [["skill","skills"],["paper","papers"]]) {
      for (const lane of ["Original","Adapter","Reviewed"]) {
        const name = "TrashBasic" + kind + lane, slug = "Acceptance/" + name;
        store[kind + "Upsert"]({ slug, title: name, name, category: "Acceptance", type: "general",
          tags: ["trash-basic"], content: "Trash exact Unicode 字节\\r\\n![pair](" + name + ".assets/bytes.bin?q=1#view)\\r\\n" });
        assets.saveMarkdownAsset(root, area, slug + ".md", "bytes.bin", Buffer.from(input.bytes));
        const key = kind === "skill" ? name : slug, before = store[kind + "Get"](key);
        store[kind + "Upsert"]({ ...before, tags: before.tags, content: before.content + "Revision two.\\r\\n" });
        rows.push({ kind, area, lane, name, slug, path: slug + ".md", before: store[kind + "Get"](key) });
      }
      store[kind + "Upsert"]({ slug: "Private/TrashSecret" + kind, title: "TrashSecret" + kind,
        name: "TrashSecret" + kind, category: "Private", type: "general",
        content: "Synthetic private fixture marker\\n" + (input.shared
          ? "![shared](../Acceptance/TrashBasic" + kind + "Original.assets/bytes.bin)\\n" : "") });
      privacy.setTopLevelPrivacy(area, "Private", true);
    }
    return rows;
  `, { bytes: [...assetBytes], shared });
  const previous = process.env.PKM_COMPATIBILITY_EXTENSION;
  try {
    process.env.PKM_COMPATIBILITY_EXTENSION = extension;
    fixture = await compatibilityMcpFixture(t, { setup: async ({ base, root }) => {
      await writeFile(join(base, "trash-fixture.json"), JSON.stringify({ ...brand, root }), { mode: 0o600 });
      for (const [, area] of kinds) await cp(join(oracleRoot, area), join(root, area), { recursive: true });
      await cp(join(oracleRoot, ".pkm"), join(root, ".pkm"), { recursive: true });
    } });
  } finally {
    if (previous === undefined) delete process.env.PKM_COMPATIBILITY_EXTENSION;
    else process.env.PKM_COMPATIBILITY_EXTENSION = previous;
    if (fixture) t.after(async () => {
      assert.deepEqual(JSON.parse(await readFile(join(directory, "brand.json"))), brand);
      await rm(directory, { recursive: true, force: true });
      await assert.rejects(lstat(directory), { code: "ENOENT" });
    });
  }
  t.after(async () => {
    await assert.rejects(lstat(fixture.base), { code: "ENOENT" });
    t.diagnostic("Original/A MCP transports closed before owned roots and pinned release/oracle were removed.");
  });
  const supervisedPids = [];
  async function connect(original = false) {
    const connected = await fixture.connect(original);
    assert(Number.isSafeInteger(connected.transport.pid) && connected.transport.pid > 0);
    supervisedPids.push(connected.transport.pid);
    return connected;
  }
  fixture.retainCleanup(async () => {
    assert((await lstat(fixture.root)).isDirectory(), "Check process exit before removing the owned MCP root.");
    for (const pid of supervisedPids)
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, `Owned MCP supervisor ${pid} must exit before root cleanup.`);
  });
  const trace = [];
  async function contract(client, leaf) {
    const reply = await client.callTool({ name: "capabilities_describe", arguments: { operation: `mcp.tool.${leaf}` } });
    assert.notEqual(reply.isError, true, JSON.stringify(reply));
    const result = value(reply);
    assert.equal(result.id, `mcp.tool.${leaf}`);
    assert.equal(result.transportName, leaf);
    return result;
  }
  async function call(client, lane, leaf, args, { readLane = false } = {}) {
    const description = await contract(client, leaf);
    const tool = readLane || description.readOnly ? "capability_read" : "capability_call";
    const reply = await client.callTool({ name: tool,
      arguments: { operation: description.id, version: description.version, arguments: args } });
    trace.push({ lane, operation: description.id, tool, isError: reply.isError === true });
    return reply;
  }
  async function state() {
    const rows = [];
    async function walk(path, relative) {
      let stat;
      try { stat = await lstat(path); }
      catch (error) { if (error.code === "ENOENT") return; throw error; }
      assert(!stat.isSymbolicLink());
      rows.push([relative, stat.ino, stat.isDirectory() ? null : hash(await readFile(path))]);
      if (stat.isDirectory())
        for (const name of (await readdir(path)).sort()) await walk(join(path, name), `${relative}/${name}`);
    }
    for (const [, area] of kinds) await walk(join(fixture.root, area), area);
    await walk(join(fixture.root, ".pkm/state/knowledge-deletions.json"), ".pkm/state/knowledge-deletions.json");
    return rows;
  }
  async function assertOwnership() {
    for (const name of ["core.sqlite", ".pkm-next-workspace", "boards"])
      assert(!(await readdir(fixture.root)).includes(name));
    assert.deepEqual(JSON.parse(await readFile(join(fixture.base, "trash-fixture.json"))), { ...brand, root: fixture.root });
    assert.equal(hash(await readFile(archive)), originalSha256);
    oracle.assertPinned();
  }
  return { ...fixture, connect, extension, oracle, oracleRoot, documents, trace, contract, call, state, assertOwnership };
}

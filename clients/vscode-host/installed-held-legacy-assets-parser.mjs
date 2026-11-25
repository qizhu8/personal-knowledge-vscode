import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { installedKnowledgeMoveFixtureUtilities as u } from "./installed-native-knowledge-move.mjs";

const held = new WeakMap(), execute = promisify(execFile);
function fail(code) { throw Object.assign(new Error(code), { code }); }
async function archiveBytes(pin) {
  if (!pin || typeof pin.vsixPath !== "string" || !isAbsolute(pin.vsixPath) || resolve(pin.vsixPath) !== pin.vsixPath
    || !/^[a-f0-9]{64}$/.test(pin.vsixSha256)) fail("HELD_OLD_LEGACY_PARSER_EXACT_PIN_REQUIRED");
  const stat = await lstat(pin.vsixPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 268_435_456
    || await realpath(pin.vsixPath) !== pin.vsixPath) fail("HELD_OLD_LEGACY_PARSER_ARCHIVE_CHANGED");
  const bytes = await readFile(pin.vsixPath);
  if (u.hash(bytes) !== pin.vsixSha256) fail("HELD_OLD_LEGACY_PARSER_ARCHIVE_CHANGED");
  return bytes;
}

/** Pure held-code extraction only; caller independently brand-checks its cold fixture before this pre-B0 call. */
export async function prepareInstalledHeldOldLegacyParser({ directory, heldOldParser, python }) {
  if (!heldOldParser) return undefined;
  await u.privateDirectory(directory, "HELD_OLD_LEGACY_PARSER_PRIVATE_DIRECTORY_REQUIRED");
  if (typeof python !== "string" || !isAbsolute(python)) fail("HELD_OLD_LEGACY_PARSER_EXPLICIT_PYTHON_REQUIRED");
  const bytes = await archiveBytes(heldOldParser), extracted = join(directory, "held-old-legacy-parser");
  await mkdir(extracted, { mode: 0o700 });
  execFileSync(python, ["-I", "-B", "-c", `
import io,stat,sys,zipfile
from pathlib import Path,PurePosixPath
root=Path(sys.argv[1]).resolve();total=0;count=0
prefix="extension/next-runtime/server/"
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as archive:
 names=archive.namelist()
 selected=[n for n in names if n==prefix+"package.json" or n.startswith(prefix+"dist/") or n.startswith(prefix+"node_modules/")]
 for name in selected:
  info=archive.getinfo(name)
  if info.is_dir():continue
  member=name[len(prefix):];path=PurePosixPath(member);count+=1;total+=info.file_size
  if names.count(name)!=1 or path.is_absolute() or ".." in path.parts or "\\\\" in member or ":" in member:
   raise ValueError("Unsafe or duplicate held runtime member")
  if stat.S_ISLNK(info.external_attr>>16) or info.file_size>16777216 or total>536870912 or count>50000:
   raise ValueError("Unbounded or linked held runtime member")
  target=root.joinpath(*path.parts);target.resolve().relative_to(root)
  target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
  with target.open("xb") as output:output.write(archive.read(info))
 if not (root/"package.json").is_file() or not (root/"dist/document-lifecycle.js").is_file() or not (root/"dist/document-legacy-assets.js").is_file():
  raise ValueError("Held native legacy parser is missing")
`, extracted], { input: bytes, cwd: directory, timeout: 60000, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 1_048_576 });
  const oldSource = await readFile(join(extracted, "dist/document-legacy-assets.js"), "utf8");
  if (oldSource.includes("pkm.document-legacy-assets.dispositions/v2")) fail("HELD_OLD_LEGACY_PARSER_MUST_PRECEDE_RETENTION");
  const files = await u.files(extracted), value = Object.freeze({ kind: "pkm.held-old-legacy-parser/v1",
    vsixPath: heldOldParser.vsixPath, vsixSha256: heldOldParser.vsixSha256 });
  held.set(value, { pin: { ...heldOldParser }, extracted, files: u.hashes(files) });
  return value;
}

/** Imports only a schema executor in a write/worker/process-denied child; never opens Owner/Storage or an engine. */
export async function verifyInstalledHeldOldLegacyParser(value, relocationJson) {
  const state = held.get(value);
  if (!state) fail("HELD_OLD_LEGACY_PARSER_ACTUAL_PREPARATION_REQUIRED");
  if (typeof relocationJson !== "string" || Buffer.byteLength(relocationJson) > 65536)
    fail("HELD_OLD_LEGACY_PARSER_BOUNDED_REAL_PLAN_REQUIRED");
  const plan = JSON.parse(relocationJson);
  assert.equal(plan.legacyAssets?.protocol, "pkm.document-legacy-assets.dispositions/v2");
  assert(plan.legacyAssets.copies.some(copy => copy.disposition === "retain"));
  await archiveBytes(state.pin); assert.deepEqual(u.hashes(await u.files(state.extracted)), state.files);
  const program = `
    import assert from "node:assert/strict";
    import net from "node:net"; import tls from "node:tls";
    import http from "node:http"; import https from "node:https"; import dgram from "node:dgram";
    import sqlite from "node:sqlite";
    import { syncBuiltinESMExports } from "node:module";
    const deny=()=>{throw new Error("Held schema probe grants no network authority.");};
    net.connect=net.createConnection=net.Socket.prototype.connect=net.Server.prototype.listen=deny;
    tls.connect=http.request=http.get=https.request=https.get=dgram.createSocket=globalThis.fetch=deny;
    globalThis.WebSocket=deny;
    sqlite.DatabaseSync=class {constructor(){throw new Error("Held schema probe grants no database or engine authority.");}};
    sqlite.backup=deny;
    syncBuiltinESMExports();
    const {deserializeDocumentLifecyclePlan}=await import("./dist/document-lifecycle.js");
    const wire=JSON.parse(process.argv[1]);
    const baseline=structuredClone(wire);delete baseline.legacyAssets.protocol;
    for(const copy of baseline.legacyAssets.copies)delete copy.disposition;
    assert.equal(deserializeDocumentLifecyclePlan(JSON.stringify(baseline)).kind,"document-lifecycle");
    assert.throws(()=>deserializeDocumentLifecyclePlan(JSON.stringify(wire)),
      error=>["INVALID_DOCUMENT","INVALID_WORKSPACE"].includes(error.code));
    console.log(JSON.stringify({oldRemoveShapeAccepted:true,newRetainShapeRefused:true,
      pureSchemaProbe:true,noOwnerStorageEngineOpened:true}));
  `;
  const output = await execute(process.execPath, ["--experimental-permission", `--allow-fs-read=${state.extracted}`,
    "--input-type=module", "-e", program, relocationJson], {
    cwd: state.extracted, env: { PATH: process.env.PATH ?? "", HOME: state.extracted, NODE_OPTIONS: "",
      TMPDIR: state.extracted, TMP: state.extracted, TEMP: state.extracted },
    timeout: 30000, encoding: "utf8", maxBuffer: 1_048_576,
  });
  const proof = JSON.parse(output.stdout);
  assert.equal(proof.newRetainShapeRefused, true);
  await archiveBytes(state.pin); assert.deepEqual(u.hashes(await u.files(state.extracted)), state.files);
  return { ...proof, heldVsixSha256: state.pin.vsixSha256, explicitHeldArchiveProbe: true };
}

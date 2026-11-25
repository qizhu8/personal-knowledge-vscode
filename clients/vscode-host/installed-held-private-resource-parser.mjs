import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { installedKnowledgeMoveFixtureUtilities as u } from "./installed-native-knowledge-move.mjs";

const states = new WeakMap(), execute = promisify(execFile);
function fail(code) { throw Object.assign(new Error(code), { code }); }
async function pinnedBytes(pin) {
  if (!pin || !isAbsolute(pin.vsixPath ?? "") || resolve(pin.vsixPath) !== pin.vsixPath || !/^[a-f0-9]{64}$/.test(pin.vsixSha256))
    fail("HELD_PRIVATE_PARSER_EXACT_PIN_REQUIRED");
  const stat = await lstat(pin.vsixPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 268435456 || await realpath(pin.vsixPath) !== pin.vsixPath)
    fail("HELD_PRIVATE_PARSER_ARCHIVE_CHANGED");
  const bytes = await readFile(pin.vsixPath);
  if (u.hash(bytes) !== pin.vsixSha256) fail("HELD_PRIVATE_PARSER_ARCHIVE_CHANGED");
  return bytes;
}
export async function prepareInstalledHeldPrivateResourceParser({ directory, heldOldPrivateParser, python }) {
  if (!heldOldPrivateParser) return undefined;
  await u.privateDirectory(directory, "HELD_PRIVATE_PARSER_PRIVATE_DIRECTORY_REQUIRED");
  if (!isAbsolute(python ?? "")) fail("HELD_PRIVATE_PARSER_EXPLICIT_PYTHON_REQUIRED");
  const bytes = await pinnedBytes(heldOldPrivateParser), extracted = join(directory, "held-old-private-resource-parser");
  await mkdir(extracted, { mode: 0o700 });
  execFileSync(python, ["-I", "-B", "-c", `
import io,stat,sys,zipfile
from pathlib import Path,PurePosixPath
root=Path(sys.argv[1]).resolve();count=0;total=0;prefix="extension/next-runtime/server/"
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as archive:
 names=archive.namelist()
 for name in names:
  if not (name==prefix+"package.json" or name.startswith(prefix+"dist/") or name.startswith(prefix+"node_modules/")):continue
  info=archive.getinfo(name)
  if info.is_dir():continue
  member=name[len(prefix):];path=PurePosixPath(member);count+=1;total+=info.file_size
  if names.count(name)!=1 or path.is_absolute() or ".." in path.parts or "\\\\" in member or ":" in member:
   raise ValueError("Unsafe held parser member")
  if stat.S_ISLNK(info.external_attr>>16) or info.file_size>16777216 or total>536870912 or count>50000:
   raise ValueError("Unbounded held parser member")
  target=root.joinpath(*path.parts);target.resolve().relative_to(root)
  target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
  with target.open("xb") as output:output.write(archive.read(info))
 if not (root/"dist/document-lifecycle.js").is_file():raise ValueError("Missing held parser")
`, extracted], { input: bytes, cwd: directory, timeout: 60000, maxBuffer: 1048576 });
  const source = await readFile(join(extracted, "dist/document-legacy-assets.js"), "utf8");
  const lifecycle = await readFile(join(extracted, "dist/document-lifecycle.js"), "utf8");
  if (!source.includes("pkm.document-legacy-assets.dispositions/v2")
    || lifecycle.includes("pkm.document-private-resource-publication/v1") || lifecycle.includes("private-resource-publication"))
    fail("HELD_PRIVATE_PARSER_SHARED_V2_ONLY_REQUIRED");
  const value = Object.freeze({ kind: "pkm.held-private-resource-parser/v1", vsixSha256: heldOldPrivateParser.vsixSha256 });
  states.set(value, { extracted, pin: { ...heldOldPrivateParser }, files: u.hashes(await u.files(extracted)) });
  return value;
}
export async function verifyInstalledHeldPrivateResourceParser(value, publicRelocationJson, privateRelocationJson) {
  const state = states.get(value);
  if (!state) fail("HELD_PRIVATE_PARSER_ACTUAL_PREPARATION_REQUIRED");
  for (const json of [publicRelocationJson, privateRelocationJson])
    if (typeof json !== "string" || Buffer.byteLength(json) > 65536) fail("HELD_PRIVATE_PARSER_BOUNDED_ACTUAL_PLANS_REQUIRED");
  assert.equal(JSON.parse(publicRelocationJson).legacyAssets?.protocol, "pkm.document-legacy-assets.dispositions/v2");
  assert.equal(JSON.parse(privateRelocationJson).legacyAssets?.protocol, "pkm.document-private-resource-publication/v1");
  await pinnedBytes(state.pin); assert.deepEqual(u.hashes(await u.files(state.extracted)), state.files);
  const program = `
    import assert from "node:assert/strict";
    import net from "node:net";import tls from "node:tls";import http from "node:http";import https from "node:https";
    import dgram from "node:dgram";import sqlite from "node:sqlite";import {syncBuiltinESMExports} from "node:module";
    const deny=()=>{throw new Error("Pure held parser has no network/database/engine authority");};
    net.connect=net.createConnection=net.Socket.prototype.connect=net.Server.prototype.listen=tls.connect=deny;
    http.request=http.get=https.request=https.get=dgram.createSocket=globalThis.fetch=globalThis.WebSocket=deny;
    sqlite.DatabaseSync=class{constructor(){deny();}};sqlite.backup=deny;syncBuiltinESMExports();
    const {deserializeDocumentLifecyclePlan}=await import("./dist/document-lifecycle.js");
    assert.equal(deserializeDocumentLifecyclePlan(process.argv[1]).kind,"document-lifecycle");
    assert.throws(()=>deserializeDocumentLifecyclePlan(process.argv[2]),error=>["INVALID_DOCUMENT","INVALID_WORKSPACE"].includes(error.code));
    console.log(JSON.stringify({actualPublicV2Accepted:true,actualPrivateV1Refused:true,pureSchemaProbe:true,noOwnerStorageEngineOpened:true}));
  `;
  const output = await execute(process.execPath, ["--experimental-permission", `--allow-fs-read=${state.extracted}`,
    "--input-type=module", "-e", program, publicRelocationJson, privateRelocationJson], {
    cwd: state.extracted, env: { PATH: process.env.PATH ?? "", HOME: state.extracted, NODE_OPTIONS: "",
      TMPDIR: state.extracted, TMP: state.extracted, TEMP: state.extracted }, timeout: 30000, maxBuffer: 1048576, encoding: "utf8",
  });
  const proof = JSON.parse(output.stdout);
  assert.equal(proof.actualPrivateV1Refused, true);
  await pinnedBytes(state.pin); assert.deepEqual(u.hashes(await u.files(state.extracted)), state.files);
  return { ...proof, heldVsixSha256: state.pin.vsixSha256, explicitHeldArchiveProbe: true };
}

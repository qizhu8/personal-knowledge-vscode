import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { installedKnowledgeMoveFixtureUtilities as u } from "./installed-native-knowledge-move.mjs";
import { installedNativeSkillPaperTrashParserPackets } from "./installed-native-skill-paper-trash.mjs";

const states = new WeakMap(), execute = promisify(execFile);
const modulePath = "dist/original-native-trash-contracts.js";
function fail(code) { throw Object.assign(new Error(code), { code }); }
async function archive(pin) {
  if (!pin || !isAbsolute(pin.vsixPath ?? "") || resolve(pin.vsixPath) !== pin.vsixPath
    || !/^[a-f0-9]{64}$/.test(pin.vsixSha256)) fail("HELD_TRASH_PARSER_EXACT_ARCHIVE_PIN_REQUIRED");
  const stat = await lstat(pin.vsixPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 268435456
    || await realpath(pin.vsixPath) !== pin.vsixPath) fail("HELD_TRASH_PARSER_ARCHIVE_CHANGED");
  const bytes = await readFile(pin.vsixPath);
  if (u.hash(bytes) !== pin.vsixSha256) fail("HELD_TRASH_PARSER_ARCHIVE_CHANGED");
  return bytes;
}
async function current(state) {
  await archive(state.pin);
  assert.deepEqual(u.hashes(await u.files(state.extracted)), state.files, "Held parser closure changed after extraction.");
}
export async function prepareInstalledHeldTrashParser({ directory, heldOldTrashParser, python }) {
  if (!heldOldTrashParser) return undefined;
  await u.privateDirectory(directory, "HELD_TRASH_PARSER_PRIVATE_DIRECTORY_REQUIRED");
  if (!isAbsolute(python ?? "")) fail("HELD_TRASH_PARSER_EXPLICIT_PYTHON_REQUIRED");
  const bytes = await archive(heldOldTrashParser), extracted = join(directory, "held-old-trash-parser");
  await mkdir(extracted, { mode: 0o700 });
  try {
    const extraction = JSON.parse(execFileSync(python, ["-I", "-B", "-c", `
import hashlib,io,json,re,stat,sys,zipfile
from pathlib import Path,PurePosixPath
root=Path(sys.argv[1]);prefix="extension/next-runtime/server/"
modules={
 "dist/original-native-trash-contracts.js","dist/original-mcp-native-action-contracts.js",
 "dist/action-runtime-contracts.js","dist/original-mcp-action-call-contracts.js",
 "dist/action-compiler-contracts.js","dist/document-path.js",
 "dist/domain/action-compiler-validation.js","dist/domain/action-source-identity.js",
 "dist/domain/action-source-v2-original.js","dist/domain/action-source-v1-original.js",
 "dist/domain/action-compiler-original.js","dist/domain/project-recipes-workflow-contracts.js",
 "dist/domain/project-recipes-value-contracts.js"}
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as archive:
 names=archive.namelist()
 def read(name):
  if names.count(name)!=1:raise ValueError("Missing or duplicate held Trash member: "+name)
  info=archive.getinfo(name)
  if info.is_dir() or stat.S_ISLNK(info.external_attr>>16) or info.file_size>8388608:raise ValueError("Unsafe held Trash member")
  return archive.read(info)
 manifestBytes=read("extension/next-runtime/manifest.json");manifest=json.loads(manifestBytes)
 if manifest.get("schema")!="pkm.next-payload/v1":raise ValueError("Held Trash parser requires a sealed production payload")
 selected=[prefix+"package.json"]+[prefix+member for member in sorted(modules)]
 selected+=sorted(name for name in names if name.startswith(prefix+"node_modules/zod/") and not archive.getinfo(name).is_dir())
 if len(selected)>5000:raise ValueError("Unbounded Zod dependency closure")
 pins={};total=0
 for name in selected:
  member=name[len(prefix):];path=PurePosixPath(member)
  if path.is_absolute() or ".." in path.parts or "\\\\" in member or ":" in member:raise ValueError("Unsafe held Trash path")
  data=read(name);total+=len(data)
  if total>39845888:raise ValueError("Held Trash schema closure exceeds 38 MiB")
  sha=hashlib.sha256(data).hexdigest()
  if manifest["files"].get("server/"+member)!=sha:raise ValueError("Held Trash closure differs from sealed manifest")
  if member in modules:
   dependencies=re.findall(r'^(?:import|export)[^;]*?\\bfrom\\s+["\\x27]([^"\\x27]+)["\\x27]',data.decode(),re.M)
   for dependency in dependencies:
    if dependency.startswith("."):
     resolved=str(PurePosixPath(member).parent/dependency)
     import posixpath
     if posixpath.normpath(resolved) not in modules:raise ValueError("Unapproved held Trash module dependency: "+dependency)
    elif dependency not in {"crypto","node:crypto","node:fs","node:path","zod"}:raise ValueError("Unapproved held Trash external dependency")
   if re.search(r'\\bimport\\s*\\(|\\brequire\\s*\\(',data.decode()):raise ValueError("Dynamic dependency is outside the closed held Trash parser")
  target=root.joinpath(*path.parts);target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
  with target.open("xb") as out:out.write(data)
  pins[member]=sha
 print(json.dumps({"files":pins,"manifest":manifest,"manifestSha256":hashlib.sha256(manifestBytes).hexdigest()}))
`, extracted], { input: bytes, cwd: directory, timeout: 60000, maxBuffer: 8388608,
      env: { PATH: process.env.PATH ?? "", HOME: directory, TMPDIR: directory, PYTHONDONTWRITEBYTECODE: "1" } }));
    const { manifest } = extraction;
    assert.equal(u.hash(JSON.stringify(manifest.files)), manifest.buildId);
    if (heldOldTrashParser.buildId && heldOldTrashParser.buildId !== manifest.buildId) fail("HELD_TRASH_PARSER_BUILD_PIN_CHANGED");
    if (heldOldTrashParser.moduleSha256 && heldOldTrashParser.moduleSha256 !== extraction.files[modulePath])
      fail("HELD_TRASH_PARSER_MODULE_PIN_CHANGED");
    const source = await readFile(join(extracted, modulePath), "utf8");
    if (!source.includes("pkm.original-native-trash-request/v1") || source.includes("pkm.original-native-trash-request/v2")
      || !source.includes('area: z.literal("notes")') || !source.includes("export function parseOriginalNativeTrashPayload"))
      fail("HELD_TRASH_PARSER_NOTE_V1_SOURCE_REQUIRED");
    const value = Object.freeze({ kind: "pkm.held-trash-parser/v1", vsixSha256: heldOldTrashParser.vsixSha256,
      buildId: manifest.buildId, manifestSha256: extraction.manifestSha256, moduleSha256: extraction.files[modulePath] });
    const state = { pin: { ...heldOldTrashParser }, extracted, value, files: u.hashes(await u.files(extracted)) };
    states.set(value, state); await current(state); return value;
  } catch (error) { await rm(extracted, { recursive: true, force: true }); throw error; }
}
const parserProgram = `
import assert from "node:assert/strict";
import net from "node:net";import tls from "node:tls";import http from "node:http";import https from "node:https";
import dgram from "node:dgram";import sqlite from "node:sqlite";import {syncBuiltinESMExports} from "node:module";
const deny=()=>{throw new Error("Pure held Trash parser has no engine, network or SQLite authority");};
net.connect=net.createConnection=net.Socket.prototype.connect=net.Server.prototype.listen=tls.connect=deny;
http.request=http.get=https.request=https.get=dgram.createSocket=globalThis.fetch=globalThis.WebSocket=deny;
sqlite.DatabaseSync=class{constructor(){deny();}};sqlite.backup=deny;syncBuiltinESMExports();
for(const permission of ["fs.write","child","worker","addons"])assert.equal(process.permission.has(permission),false);
const {originalNativeTrashRequestSchema,parseOriginalNativeTrashPayload}=await import("./dist/original-native-trash-contracts.js");
const wire=JSON.parse(process.argv[1]);
const control=wire.noteV1Control;
assert.equal(control.payload.request.schema,"pkm.original-native-trash-request/v1");
assert.equal(originalNativeTrashRequestSchema.safeParse(control.payload.request).success,true);
parseOriginalNativeTrashPayload(control.payload,control.session);
const refused=[];
for(const packet of wire.currentPackets){
 assert.equal(packet.payload.request.schema,"pkm.original-native-trash-request/v2");
 const area=packet.payload.request.subject.area;assert(["skills","papers"].includes(area));
 assert.equal(process.permission.has("fs.read",packet.payload.request.subject.root),false);
 assert.equal(originalNativeTrashRequestSchema.safeParse(packet.payload.request).success,false);
 assert.throws(()=>parseOriginalNativeTrashPayload(packet.payload,packet.session),error=>error.name==="ZodError");
 refused.push({area,requestSha256:packet.payload.requestSha256,operationId:packet.payload.request.subject.operationId});
}
console.log(JSON.stringify({compatibleNoteV1DtoAccepted:true,noteControlSchemaOnly:true,refused,
 pureSealedReceiverSchemaProbe:true,oldOwnerServingQualified:false,oldNativeServiceDispatchQualified:false,
 noFsWritesWorkersChildrenAddonsNetworkOrSqlite:true}));
`;
async function probe(value, noteV1Control, currentPackets) {
  const state = states.get(value);
  if (!state) fail("HELD_TRASH_PARSER_ACTUAL_PREPARATION_REQUIRED");
  await current(state);
  if (!noteV1Control?.payload || !noteV1Control?.session) fail("HELD_TRASH_PARSER_EXPLICIT_NOTE_SCHEMA_CONTROL_REQUIRED");
  const wire = JSON.stringify({ noteV1Control, currentPackets });
  if (Buffer.byteLength(wire) > 262144) fail("HELD_TRASH_PARSER_BOUNDED_PACKETS_REQUIRED");
  const output = await execute(process.execPath, ["--experimental-permission", `--allow-fs-read=${state.extracted}`,
    "--no-addons", "--input-type=module", "-e", parserProgram, wire], {
    cwd: state.extracted, env: { PATH: process.env.PATH ?? "", HOME: state.extracted, NODE_OPTIONS: "",
      TMPDIR: state.extracted, TMP: state.extracted, TEMP: state.extracted }, timeout: 30000, maxBuffer: 1048576, encoding: "utf8",
  });
  const proof = JSON.parse(output.stdout);
  await current(state);
  return { ...proof, explicitHeldArchiveProbe: true, heldVsixSha256: value.vsixSha256, heldPayloadBuildId: value.buildId,
    heldManifestSha256: value.manifestSha256, heldModuleSha256: value.moduleSha256, heldImportClosure: [...state.files] };
}
/** This control has no current v2 witness and never qualifies version rejection or serving. */
export async function verifyInstalledHeldTrashNoteSchemaControl(value, { noteV1Control }) {
  return { ...await probe(value, noteV1Control, []), currentV2RefusalQualified: false };
}
/** Uses only pure copies already linked to genuine current UI and canonical Core receipts. */
export async function verifyInstalledHeldTrashParser(value, { sourceFixture, noteV1Control }) {
  if (!states.has(value)) fail("HELD_TRASH_PARSER_ACTUAL_PREPARATION_REQUIRED");
  const currentPackets = installedNativeSkillPaperTrashParserPackets(sourceFixture);
  assert.deepEqual(currentPackets.map(packet => packet.payload.request.subject.area), ["skills", "papers"]);
  const proof = await probe(value, noteV1Control, currentPackets);
  assert.deepEqual(proof.refused, currentPackets.map(packet => ({ area: packet.payload.request.subject.area,
    requestSha256: packet.payload.requestSha256, operationId: packet.payload.request.subject.operationId })));
  return { ...proof, genuineCurrentSkillPaperV2Refused: true, currentV2RefusalQualified: true,
    nativeAuthorityFromPacketCopies: false };
}

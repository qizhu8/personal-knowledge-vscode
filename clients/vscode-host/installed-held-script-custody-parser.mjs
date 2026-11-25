import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { installedKnowledgeMoveFixtureUtilities as u } from "./installed-native-knowledge-move.mjs";

const execute = promisify(execFile), prepared = new WeakMap();
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const modulePath = "dist/original-mcp-root-custody.js";
function fail(code) { throw Object.assign(new Error(code), { code }); }
async function archive(pin) {
  if (!pin || !isAbsolute(pin.vsixPath ?? "") || resolve(pin.vsixPath) !== pin.vsixPath
    || !/^[a-f0-9]{64}$/.test(pin.vsixSha256))
    fail("HELD_SCRIPT_PARSER_EXACT_ARCHIVE_PIN_REQUIRED");
  const stat = await lstat(pin.vsixPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 268435456
    || await realpath(pin.vsixPath) !== pin.vsixPath)
    fail("HELD_SCRIPT_PARSER_ARCHIVE_CHANGED");
  const bytes = await readFile(pin.vsixPath);
  if (hash(bytes) !== pin.vsixSha256) fail("HELD_SCRIPT_PARSER_ARCHIVE_CHANGED");
  return bytes;
}
async function checkFiles(state) {
  await archive(state.pin);
  for (const [member, sha256] of Object.entries(state.files)) {
    const path = join(state.extracted, member), stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid()
      || hash(await readFile(path)) !== sha256)
      fail("HELD_SCRIPT_PARSER_MEMBER_CHANGED");
  }
  assert.deepEqual(u.hashes(await u.files(state.extracted)).sort((a, b) => a.path.localeCompare(b.path)), Object.entries(state.files)
    .map(([path, sha256]) => ({ path, sha256 })).sort((a, b) => a.path.localeCompare(b.path)));
}

/** Pre-B0 extraction from an explicit sealed archive; no old owner, storage or engine is created. */
export async function prepareInstalledHeldScriptCustodyParser({ installed, componentFixture, heldOldScriptParser, python }) {
  if (!heldOldScriptParser) return undefined;
  await (await u.load(installed, "original-mcp-component-recovery")).assertOriginalMcpColdComponentFixture(componentFixture);
  const directory = componentFixture.directory;
  await u.privateDirectory(directory, "HELD_SCRIPT_PARSER_PRIVATE_FIXTURE_REQUIRED");
  if (!isAbsolute(python ?? "")) fail("HELD_SCRIPT_PARSER_EXACT_PYTHON_REQUIRED");
  const bytes = await archive(heldOldScriptParser), extracted = join(directory, "held-old-script-custody-parser");
  await mkdir(extracted, { mode: 0o700 });
  try {
  const extraction = JSON.parse(execFileSync(python, ["-I", "-B", "-c", `
import hashlib,io,json,re,stat,sys,zipfile
from pathlib import Path,PurePosixPath
root=Path(sys.argv[1]);prefix="extension/next-runtime/server/"
modules={"dist/original-mcp-root-custody.js","dist/host-composition-legacy-batch15-errors.js",
 "dist/legacy-content-privacy.js","dist/fresh-note-query-contracts.js"}
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as archive:
 names=archive.namelist()
 def read(name):
  if names.count(name)!=1:raise ValueError("Missing or duplicate held Script parser member: "+name)
  info=archive.getinfo(name)
  if info.is_dir() or stat.S_ISLNK(info.external_attr>>16) or info.file_size>8388608:
   raise ValueError("Unsafe held Script parser member")
  return archive.read(info)
 manifestBytes=read("extension/next-runtime/manifest.json");manifest=json.loads(manifestBytes)
 if manifest.get("schema")!="pkm.next-payload/v1":raise ValueError("Held Script parser must be a sealed production payload")
 selected=[prefix+"package.json"]+[prefix+member for member in modules]
 selected+=sorted(name for name in names if name.startswith(prefix+"node_modules/zod/") and not archive.getinfo(name).is_dir())
 if len(selected)>5000:raise ValueError("Unbounded held Zod dependency closure")
 pins={};total=0
 for name in selected:
  member=name[len(prefix):];path=PurePosixPath(member)
  if path.is_absolute() or ".." in path.parts or "\\\\" in member or ":" in member:
   raise ValueError("Unsafe held Script parser path")
  data=read(name);total+=len(data)
  if total>67108864:raise ValueError("Unbounded held Script parser bytes")
  sha=hashlib.sha256(data).hexdigest()
  if manifest["files"].get("server/"+member)!=sha:raise ValueError("Held Script parser member differs from sealed manifest")
  if member in modules:
   for dependency in re.findall(r'\\bfrom\\s+["\\x27]([^"\\x27]+)["\\x27]',data.decode()):
    allowed={"node:crypto","node:fs","node:path","zod","./host-composition-legacy-batch15-errors.js",
     "./legacy-content-privacy.js","./fresh-note-query-contracts.js"}
    if dependency not in allowed:raise ValueError("Held Script parser needs an unapproved import: "+dependency)
  target=root.joinpath(*path.parts);target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
  with target.open("xb") as output:output.write(data)
  pins[member]=sha
 print(json.dumps({"files":pins,"manifest":manifest,"manifestSha256":hashlib.sha256(manifestBytes).hexdigest()}))
`, extracted], { input: bytes, cwd: directory, timeout: 60000, maxBuffer: 8388608,
    env: { PATH: process.env.PATH ?? "", HOME: directory, TMPDIR: directory, PYTHONDONTWRITEBYTECODE: "1" } }));
  const manifest = extraction.manifest;
  assert.equal(hash(JSON.stringify(manifest.files)), manifest.buildId, "The actual held payload build must match its complete sealed file manifest.");
  if (heldOldScriptParser.buildId && heldOldScriptParser.buildId !== manifest.buildId)
    fail("HELD_SCRIPT_PARSER_BUILD_PIN_CHANGED");
  if (heldOldScriptParser.moduleSha256 && heldOldScriptParser.moduleSha256 !== extraction.files[modulePath])
    fail("HELD_SCRIPT_PARSER_MODULE_PIN_CHANGED");
  const source = await readFile(join(extracted, modulePath), "utf8");
  if (!source.includes("pkm.original-mcp-custody/v1") || !source.includes("pkm.original-mcp-root/v1")
    || source.includes("pkm.original-mcp-custody/v2") || source.includes("pkm.original-mcp-root/v2")
    || !source.includes("export const originalMcpPlanSchema") || !source.includes("export const originalMcpJournalSchema"))
    fail("HELD_SCRIPT_PARSER_V1_ONLY_SOURCE_REQUIRED");
  const value = Object.freeze({ kind: "pkm.held-original-script-custody-parser/v1",
    vsixSha256: heldOldScriptParser.vsixSha256, buildId: manifest.buildId,
    manifestSha256: extraction.manifestSha256, moduleSha256: extraction.files[modulePath] });
  const state = { pin: { ...heldOldScriptParser }, extracted, files: extraction.files, componentFixture, value };
  prepared.set(value, state); await checkFiles(state); return value;
  } catch (error) {
    await rm(extracted, { recursive: true, force: true });
    throw error;
  }
}

/** The child receives actual v2 control DTOs but can read only the closed held parser/dependency directory. */
export async function verifyInstalledHeldScriptCustodyParser(value, { currentPlan }) {
  const state = prepared.get(value);
  if (!state) fail("HELD_SCRIPT_PARSER_ACTUAL_PREPARATION_REQUIRED");
  await checkFiles(state);
  const root = state.componentFixture.root, journalPath = join(root, ".pkm-next-original-mcp.json");
  const stat = await lstat(journalPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid()
    || stat.mode & 0o077 || stat.size > 65536)
    fail("HELD_SCRIPT_PARSER_ACTUAL_PRIVATE_JOURNAL_REQUIRED");
  const bytes = await readFile(journalPath), journal = JSON.parse(bytes);
  assert.equal(journal.schema, "pkm.original-mcp-root/v2");
  assert.equal(journal.plan.schema, "pkm.original-mcp-custody/v2");
  assert.equal(journal.plan.root, root);
  assert.deepEqual(journal.plan, currentPlan, "Probe the actual component's current v2 plan, not a synthetic source permission.");
  const { planSha256, ...planBody } = currentPlan, { journalSha256, ...journalBody } = journal;
  assert.equal(hash(JSON.stringify(planBody)), planSha256);
  assert.equal(hash(JSON.stringify(journalBody)), journalSha256);
  const wire = JSON.stringify({ plan: currentPlan, journal });
  if (Buffer.byteLength(wire) > 131072) fail("HELD_SCRIPT_PARSER_BOUNDED_CURRENT_DTOS_REQUIRED");
  const program = `
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import net from "node:net";import tls from "node:tls";import http from "node:http";import https from "node:https";
import dgram from "node:dgram";import sqlite from "node:sqlite";import {syncBuiltinESMExports} from "node:module";
const deny=()=>{throw new Error("Held Script schemas grant no network, database or engine authority");};
net.connect=net.createConnection=net.Socket.prototype.connect=net.Server.prototype.listen=tls.connect=deny;
http.request=http.get=https.request=https.get=dgram.createSocket=globalThis.fetch=globalThis.WebSocket=deny;
sqlite.DatabaseSync=class{constructor(){deny();}};sqlite.backup=deny;syncBuiltinESMExports();
for(const permission of ["fs.write","child","worker","addons"])assert.equal(process.permission.has(permission),false);
const {originalMcpPlanSchema,originalMcpJournalSchema}=await import("./dist/original-mcp-root-custody.js");
const wire=JSON.parse(process.argv[1]),sha=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const {planSha256:_planPin,...fields}=wire.plan;
const body={...fields,schema:"pkm.original-mcp-custody/v1"},legacyPlan={...body,planSha256:sha(body)};
const {journalSha256:_journalPin,...journalFields}=wire.journal;
const legacyBody={...journalFields,schema:"pkm.original-mcp-root/v1",plan:legacyPlan};
const legacyJournal={...legacyBody,journalSha256:sha(legacyBody)};
assert.equal(originalMcpPlanSchema.safeParse(legacyPlan).success,true);
assert.equal(originalMcpJournalSchema.safeParse(legacyJournal).success,true);
assert.equal(originalMcpPlanSchema.safeParse(wire.plan).success,false);
assert.equal(originalMcpJournalSchema.safeParse(wire.journal).success,false);
console.log(JSON.stringify({compatibleV1PlanDtoAccepted:true,compatibleV1JournalDtoAccepted:true,
 actualCurrentV2PlanRefused:true,actualCurrentV2JournalRefused:true,pureSchemaProbe:true,
 oldOwnerServingQualified:false,noFsWritesWorkersChildrenNetworkOrSqlite:true}));
`;
  const output = await execute(process.execPath, ["--experimental-permission", `--allow-fs-read=${state.extracted}`,
    "--input-type=module", "-e", program, wire], {
    cwd: state.extracted, env: { PATH: process.env.PATH ?? "", HOME: state.extracted, NODE_OPTIONS: "",
      TMPDIR: state.extracted, TMP: state.extracted, TEMP: state.extracted },
    timeout: 30000, maxBuffer: 1048576, encoding: "utf8",
  });
  const proof = JSON.parse(output.stdout);
  assert.equal(proof.actualCurrentV2PlanRefused, true); assert.equal(proof.actualCurrentV2JournalRefused, true);
  await checkFiles(state); assert.deepEqual(await readFile(journalPath), bytes);
  return { ...proof, explicitHeldArchiveProbe: true, sourceClassifiedV1Only: true,
    heldVsixSha256: state.value.vsixSha256, heldPayloadBuildId: state.value.buildId,
    heldManifestSha256: state.value.manifestSha256, heldModuleSha256: state.value.moduleSha256, heldImportClosure: { ...state.files },
    currentPlanSha256: planSha256, currentJournalSha256: journalSha256 };
}

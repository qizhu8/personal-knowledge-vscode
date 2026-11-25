import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import ts from "typescript";

assert.equal(process.env.PKM_TEST_ISOLATED_NETWORK, "1", "Run through tests/framework/isolate.py; no uncontained oracle.");
const project = resolve(import.meta.dirname, "..");
const archive = process.env.PKM_LEGACY_VSIX;
const releaseSha256 = "1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27";
const memberSha256 = "8e06b2ef4de7abc5be6ca855a8c148241b3a4a79e22593d1b4d976f5899788af";
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
assert(archive, "PKM_LEGACY_VSIX must select sealed Original22, never an unsealed Source oracle.");
assert.equal(sha(await readFile(archive)), releaseSha256);

async function sourceModule(name, replacements = {}) {
  const source = await readFile(join(project, "src", name), "utf8");
  let code = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  for (const [specifier, url] of Object.entries({ zod: import.meta.resolve("zod"), ...replacements }))
    code = code.replaceAll(`from "${specifier}"`, `from "${url}"`);
  return `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
}
const pathModule = await sourceModule("document-path.ts");
const { planOriginalKnowledgeRecovery } = await import(await sourceModule("original-knowledge-recovery-planner.ts", {
  "./document-path.js": pathModule,
}));
const oracleProgram = String.raw`
import hashlib,json,sys,zipfile
from pathlib import Path
request=json.load(sys.stdin); parent=Path(request["parent"]).resolve(strict=True)
root=Path(request["root"]).resolve(strict=True); evidence=Path(request["evidence"]).resolve(strict=True)
if json.loads((parent/"owner.json").read_text())!={"brand":"original-recovery-planner","parent":str(parent)}:
 raise ValueError("Disposable recovery fixture brand required")
for path in (root,evidence):
 path.relative_to(parent)
 if path==parent:raise ValueError("Owned disposable child required")
archive=Path(sys.argv[1]).read_bytes()
if hashlib.sha256(archive).hexdigest()!=sys.argv[2]:raise ValueError("Wrong sealed Original22")
with zipfile.ZipFile(__import__("io").BytesIO(archive)) as package:
 name="extension/resources/knowledge_recovery.py"
 if package.namelist().count(name)!=1:raise ValueError("Missing/duplicate Original recovery")
 source=package.read(name)
 if hashlib.sha256(source).hexdigest()!=sys.argv[3]:raise ValueError("Recovery member changed")
 metadata=json.loads(package.read("extension/package.json"))
 if (metadata["publisher"],metadata["name"],metadata["version"])!=("Uone","personal-knowledge","4.0.22"):
  raise ValueError("Wrong sealed identity")
namespace={"__name__":"sealed_original22_recovery"}
exec(compile(source,name,"exec"),namespace)
# Record the actual decorators only; execute the unmodified sealed business functions.
tools={};annotations={}
class Registration:
 def tool(self,**options):
  def register(function):
   tools[function.__name__]=function;annotations[function.__name__]=options["annotations"];return function
  return register
namespace["register_knowledge_recovery_tools"](Registration(),str(root))
try:
 result=tools[request["tool"]](**request["arguments"])
 print(json.dumps({"ok":True,"value":result,"annotations":annotations[request["tool"]]}))
except Exception as error:
 print(json.dumps({"ok":False,"error":str(error),"type":type(error).__name__}))
`;
async function fixture(t) {
  const parent = join(project, "tests", `.original-recovery-planner-${randomUUID()}`);
  await mkdir(parent, { mode: 0o700 });
  await writeFile(join(parent, "owner.json"), JSON.stringify({ brand: "original-recovery-planner", parent }), { mode: 0o600 });
  t.after(async () => {
    assert.deepEqual(JSON.parse(await readFile(join(parent, "owner.json"), "utf8")),
      { brand: "original-recovery-planner", parent });
    await rm(parent, { recursive: true });
  });
  const root = join(parent, "root"), evidence = join(parent, "evidence");
  await mkdir(join(root, "notes", "Public"), { recursive: true, mode: 0o700 });
  await mkdir(join(evidence, "blobs"), { recursive: true, mode: 0o700 });
  const rows = [
    { path: "notes/Public/Missing.md", mode: "100755",
      bytes: Buffer.from("---\r\nknowledgeId: raw-preserved-id\r\nrevision: 7\r\nunknown: retained\r\n---\r\nExact bytes.\r\n") },
    { path: "skills/Public/Identical.md", mode: "100755", bytes: Buffer.from("---\nname: Exact\n---\nSkill bytes.\n") },
    { path: "notes/Public/Occupied.md", mode: "100644", bytes: Buffer.from("Historical content must not replace occupied bytes.\n") },
  ].map(row => ({ ...row, sha256: sha(row.bytes) }));
  await mkdir(join(root, "skills", "Public"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, rows[1].path), rows[1].bytes);
  await writeFile(join(root, rows[2].path), "Existing user bytes.\n");
  const plan = { schema: "pkm.knowledge-recovery/v1", knowledgeRoot: root,
    provenance: { source: "synthetic-byte-evidence", neverNativeAuthority: true },
    files: rows.map(({ bytes: _, ...row }) => row) };
  const planBytes = Buffer.from(JSON.stringify(plan, null, 2));
  await writeFile(join(evidence, "plan.json"), planBytes);
  for (const row of rows) await writeFile(join(evidence, "blobs", row.sha256), row.bytes);
  const capture = async () => ({
    knowledgeRoot: root, planBytes: await readFile(join(evidence, "plan.json")), expectedPlanSha256: sha(planBytes),
    blobs: new Map(await Promise.all(rows.map(async row => [row.sha256, await readFile(join(evidence, "blobs", row.sha256))]))),
    destinations: new Map(await Promise.all(rows.map(async row => {
      const path = join(root, row.path), info = await lstat(path).catch(error => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      return [row.path, !info ? { kind: "missing" } : info.isFile() && !info.isSymbolicLink() && info.nlink === 1
        ? { kind: "regular", bytes: await readFile(path) } : { kind: "unsafe" }];
    }))),
  });
  const oracle = (tool, arguments_ = {}) => JSON.parse(execFileSync(process.env.PKM_TEST_PYTHON || "python3",
    ["-I", "-B", "-c", oracleProgram, archive, releaseSha256, memberSha256], {
      input: JSON.stringify({ parent, root, evidence, tool, arguments: { evidence_directory: evidence, ...arguments_ } }),
      encoding: "utf8", cwd: parent, timeout: 30_000, maxBuffer: 64 * 1024,
      env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1" },
    }));
  return { parent, root, evidence, rows, plan, planBytes, capture, oracle };
}
async function tree(root) {
  const result = [];
  async function visit(path, relative) {
    const stat = await lstat(path, { bigint: true });
    result.push({ path: relative, mode: String(stat.mode), size: String(stat.size),
      inode: String(stat.ino), mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs),
      sha256: stat.isFile() ? sha(await readFile(path)) : null });
    if (stat.isDirectory()) for (const name of (await readdir(path)).sort()) await visit(join(path, name), `${relative}/${name}`);
  }
  await visit(root, ".");
  return result;
}

test("pure captured preview equals sealed Original22, verifies every blob and performs zero writes", async t => {
  const f = await fixture(t), before = await tree(f.parent), captured = await f.capture();
  const expected = f.oracle("knowledge_recovery_preview");
  assert.equal(expected.ok, true);
  assert.deepEqual(expected.annotations, { readOnlyHint: true });
  assert.deepEqual(planOriginalKnowledgeRecovery(captured), expected.value);
  assert.deepEqual(expected.value.counts, { restore: 1, identical: 1, "preserve-existing": 1 });
  assert.deepEqual(await tree(f.parent), before, "No Knowledge, evidence, audit or control writes from preview.");
  assert.deepEqual(await f.capture(), captured, "Planner must not mutate evidence or observations.");
});

test("plan mismatch and tampered blobs fail before any writes, including blobs of occupied destinations", async t => {
  const f = await fixture(t), before = await tree(f.root);
  const capture = await f.capture();
  assert.throws(() => planOriginalKnowledgeRecovery({ ...capture, expectedPlanSha256: "0".repeat(64) }),
    { code: "RECOVERY_PLAN_HASH_MISMATCH" });
  const mismatch = f.oracle("knowledge_recovery_apply", { approved_plan_sha256: "0".repeat(64) });
  assert.equal(mismatch.ok, false); assert.match(mismatch.error, /changed after approval/);
  await writeFile(join(f.evidence, "plan.json"), Buffer.concat([f.planBytes, Buffer.from("\n")]));
  assert.throws(() => planOriginalKnowledgeRecovery({ ...capture,
    planBytes: Buffer.concat([f.planBytes, Buffer.from("\n")]),
  }), { code: "RECOVERY_PLAN_HASH_MISMATCH" });
  await writeFile(join(f.evidence, "plan.json"), f.planBytes);
  await writeFile(join(f.evidence, "blobs", f.rows[2].sha256), "Tampered occupied-row source.");
  const tampered = await f.capture();
  assert.throws(() => planOriginalKnowledgeRecovery(tampered), { code: "RECOVERY_BLOB_HASH_MISMATCH" });
  const actual = f.oracle("knowledge_recovery_preview");
  assert.equal(actual.ok, false); assert.match(actual.error, /blob hash mismatch/);
  assert.deepEqual(await tree(f.root), before);
  assert.equal((await readdir(f.evidence)).some(name => name.startsWith("result-")), false);
});
test("sealed Original22 apply is missing-only, preserves occupied bytes and raw identity/revision, and audits its write", async t => {
  const f = await fixture(t), occupied = await tree(join(f.root, "notes", "Public", "Occupied.md"));
  const before = planOriginalKnowledgeRecovery(await f.capture());
  const actual = f.oracle("knowledge_recovery_apply", { approved_plan_sha256: before.plan_sha256 });
  assert.equal(actual.ok, true);
  assert.deepEqual(actual.annotations, { readOnlyHint: false, destructiveHint: false });
  const { report, ...counts } = actual.value;
  assert.deepEqual(counts, { ok: true, restored: 1, identical: 1, preserved_existing: 1 });
  assert.equal(resolve(report, ".."), f.evidence);
  assert.match(report.split("/").at(-1), /^result-\d{8}T\d{12}\.json$/);
  const audit = JSON.parse(await readFile(report, "utf8"));
  assert.deepEqual(Object.keys(audit), ["schema", "knowledge_root", "plan_sha256", "started_at",
    "restored", "identical", "preserved_existing", "completed_at"]);
  assert.equal(audit.schema, "pkm.knowledge-recovery-result/v1");
  assert.equal(audit.knowledge_root, f.root); assert.equal(audit.plan_sha256, sha(f.planBytes));
  assert.deepEqual(audit.restored, [f.rows[0].path]);
  assert.deepEqual(audit.identical, [f.rows[1].path]);
  assert.deepEqual(audit.preserved_existing, [f.rows[2].path]);
  assert.deepEqual(await readFile(join(f.root, f.rows[0].path)), f.rows[0].bytes);
  assert.equal((await lstat(join(f.root, f.rows[0].path))).mode & 0o777, 0o755);
  assert.deepEqual(await tree(join(f.root, "notes", "Public", "Occupied.md")), occupied);
  const after = f.oracle("knowledge_recovery_preview");
  assert.equal(after.ok, true);
  assert.deepEqual(planOriginalKnowledgeRecovery(await f.capture()), after.value);
  assert.deepEqual(after.value.counts, { restore: 0, identical: 2, "preserve-existing": 1 });
});

test("pure validation requires explicit destination observations and refuses unsafe, duplicate, foreign-root and nonportable paths", async t => {
  const f = await fixture(t), capture = await f.capture();
  const withPlan = plan => {
    const planBytes = Buffer.from(JSON.stringify(plan));
    return { ...capture, planBytes, expectedPlanSha256: sha(planBytes) };
  };
  assert.throws(() => planOriginalKnowledgeRecovery({ ...capture, destinations: new Map() }),
    { code: "RECOVERY_DESTINATION_OBSERVATION_REQUIRED" });
  const unsafe = new Map(capture.destinations); unsafe.set(f.rows[0].path, { kind: "unsafe" });
  assert.throws(() => planOriginalKnowledgeRecovery({ ...capture, destinations: unsafe }),
    { code: "RECOVERY_UNSAFE_DESTINATION" });
  assert.throws(() => planOriginalKnowledgeRecovery(withPlan({ ...f.plan, knowledgeRoot: f.evidence })),
    { code: "RECOVERY_ROOT_MISMATCH" });
  assert.throws(() => planOriginalKnowledgeRecovery(withPlan({ ...f.plan, files: [f.plan.files[0], f.plan.files[0]] })),
    { code: "RECOVERY_DUPLICATE_DESTINATION" });
  for (const path of ["notes/../Escape.md", "notes/.trash/X.md", "notes/System/X.md", "papers/X.md", "notes/X.assets/a.bin"])
    assert.throws(() => planOriginalKnowledgeRecovery(withPlan({ ...f.plan, files: [{ ...f.plan.files[0], path }] })),
      { code: "RECOVERY_PORTABLE_MARKDOWN_REQUIRED" });
});

test("aggregate inspected source and destination bytes accept the exact bound and refuse one extra byte before hashing", () => {
  const source = Buffer.from("x"), path = "notes/Public/Bound.md";
  const planBytes = Buffer.from(JSON.stringify({
    schema: "pkm.knowledge-recovery/v1", knowledgeRoot: "/synthetic-no-filesystem-access",
    files: [{ path, sha256: sha(source), mode: "100644" }],
  }));
  const capture = {
    knowledgeRoot: "/synthetic-no-filesystem-access", planBytes, expectedPlanSha256: sha(planBytes),
    blobs: new Map([[sha(source), source]]),
    destinations: new Map([[path, { kind: "regular", bytes: Buffer.alloc(16_777_215) }]]),
  };
  assert.deepEqual(planOriginalKnowledgeRecovery(capture).counts, { restore: 0, identical: 0, "preserve-existing": 1 });
  assert.throws(() => planOriginalKnowledgeRecovery({
    ...capture, destinations: new Map([[path, { kind: "regular", bytes: Buffer.alloc(16_777_216) }]]),
  }), { code: "RECOVERY_CAPTURE_TOO_LARGE" });
});

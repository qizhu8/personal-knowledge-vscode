import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { sha256 } from "./script-basic-fixture.mjs";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function originalScriptWorkerFixture(t, f) {
  const directory = dirname(f.oracleRoot), release = join(directory, "release");
  f.oracle.assertPinned();
  const evidence = JSON.parse(execFileSync(process.env.PKM_TEST_PYTHON, ["-I", "-B", "-c", `
import hashlib,json,posixpath,re,stat,sys,zipfile
from pathlib import Path
root=Path(sys.argv[1])
with zipfile.ZipFile(sys.argv[2]) as archive:
 names=archive.namelist()
 pending=["dist/retrieval/retrieval-worker.js","dist/knowledge/storage.js"]
 members={}
 def read(member):
  name="extension/"+member
  if names.count(name)!=1: raise ValueError("Missing or duplicate original worker member")
  info=archive.getinfo(name)
  if info.is_dir() or stat.S_ISLNK(info.external_attr>>16) or info.file_size>8*1024*1024:
   raise ValueError("Unsafe original worker member")
  return archive.read(info)
 while pending:
  member=pending.pop()
  if member in members: continue
  if not member.startswith("dist/") or ".." in member.split("/"): raise ValueError("Unsafe worker dependency")
  data=read(member);members[member]=data
  for dependency in re.findall(r'require\\(["\\x27]([^"\\x27]+)["\\x27]\\)',data.decode()):
   if dependency.startswith("."):
    target=posixpath.normpath(posixpath.join(posixpath.dirname(member),dependency))
    pending.append(target if target.endswith(".js") else target+".js")
 for name in names:
  relative=name.removeprefix("extension/")
  if re.fullmatch(r"resources/retrieval[^/]*\\.(?:py|json|txt)",relative) or relative=="resources/vendor/adaptive_skill_retrieval-0.3.0.dev2026100504-py3-none-any.whl":
   members[relative]=read(relative)
 extension=read("dist/extension.js").decode()
 version=re.search(r'const RETRIEVAL_ENGINE_VERSION = "([^"]+)";',extension).group(1)
 configuration=re.search(r'const RETRIEVAL_CONFIGURATION_HASH = .*?\\.update\\("([^"]+)"\\)\\.digest\\("hex"\\);',extension).group(1)
 if len(members)>64 or sum(map(len,members.values()))>32*1024*1024: raise ValueError("Unbounded original worker runtime")
 pins={}
 for member,data in members.items():
  target=root/member
  target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
  if target.exists():
   if target.is_symlink() or target.read_bytes()!=data: raise ValueError("Substituted original worker module")
  else:
   with target.open("xb") as output: output.write(data)
  pins[member]=hashlib.sha256(data).hexdigest()
 print(json.dumps({"files":pins,"engineVersion":version,"configurationHash":hashlib.sha256(configuration.encode()).hexdigest()}))
`, release, process.env.PKM_LEGACY_VSIX], {
    cwd: directory, env: { ...process.env, TMPDIR: join(directory, "scratch") },
    encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024,
  }));
  async function assertPinned() {
    f.oracle.assertPinned();
    for (const [member, hash] of Object.entries(evidence.files)) {
      const path = join(release, member), stat = await lstat(path);
      assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
      assert.equal(sha256(await readFile(path)), hash);
    }
  }
  await assertPinned();
  const require = createRequire(join(release, "package.json"));
  const { RetrievalWorkerManager } = require(join(release, "dist/retrieval/retrieval-worker.js"));
  const snapshots = require(join(release, "dist/retrieval/retrieval-snapshot.js"));
  const scripts = require(join(release, "dist/knowledge/storage.js"));
  const store = require(join(release, "dist/knowledge/filestore.js"));
  const home = join(f.base, "home"), state = join(home, "retrieval", sha256(f.root).slice(0, 16));
  const manager = new RetrievalWorkerManager(state, join(release, "resources/retrieval_worker.py"),
    process.env.PKM_TEST_PYTHON, evidence.engineVersion, evidence.configurationHash);
  await assert.rejects(lstat(join(state, "worker.json")), { code: "ENOENT" }, "Only the real worker may publish its first descriptor.");
  let endpoint, closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    endpoint ??= manager.readEndpoint();
    const pid = endpoint?.pid ?? manager.readWorkerLockPid();
    if (!pid || !manager.processAlive(pid)) return;
    if (endpoint) await manager.request(endpoint, "/shutdown", "POST", {});
    else process.kill(pid, "SIGTERM");
    for (let i = 0; manager.processAlive(pid) && i < 200; i++) await delay(25);
    assert.equal(manager.processAlive(pid), false, "The actual original worker must exit before its fixture is removed.");
  }
  f.retainCleanup(close);
  async function source() {
    await assertPinned();
    const brand = JSON.parse(await readFile(join(f.base, "script-fixture.json")));
    assert.equal(brand.schema, "pkm.script-basic-fixture/v1");
    assert.equal(brand.base, f.base);
    assert.equal(await lstat(join(f.root, "scripts/Private")).catch(error => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    }), undefined, "This normal original startup has a complete public fixture corpus, not a forged private source grant.");
    scripts.setStorePath(f.root); store.setStorePath(f.root);
    const rows = scripts.scriptList().flatMap(row => {
      const detail = scripts.scriptGet(row.path);
      return detail ? [{ ...row, ...detail, extension: ".py" }] : [];
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].path, f.path);
    assert.equal(rows[0].content, await readFile(join(f.root, "scripts", f.path), "utf8"));
    const snapshot = snapshots.createRetrievalSnapshot({
      skills: store.skillList().flatMap(row => { const detail = store.skillGet(row.name); return detail ? [{ ...row, ...detail }] : []; }),
      notes: store.noteList(undefined, Number.MAX_SAFE_INTEGER, true),
      papers: store.paperList().flatMap(row => { const detail = store.paperGet(row.slug); return detail ? [{ ...row, ...detail }] : []; }),
      scripts: rows, recipes: [], subscriptionGroups: [], readSubscription() { throw new Error("No subscription corpus exists."); },
    });
    return { snapshot, indexed: snapshot.documents.map(snapshots.indexedRetrievalDocument) };
  }
  async function sync() {
    const before = await source();
    const mode = await manager.sync(before.snapshot);
    const ready = await manager.waitUntilReady(before.snapshot.corpus_revision);
    endpoint = manager.readEndpoint();
    assert(endpoint && manager.processAlive(endpoint.pid));
    assert.deepEqual((await source()).snapshot, before.snapshot, "Controlled index source must remain exact through real asynchronous publication.");
    return { ...before, mode, ready, endpoint };
  }
  return { manager, sync, close, state, evidence };
}

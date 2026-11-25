import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import ts from "typescript";
import { pinnedOriginalKnowledgeWriterFixture } from "./original-knowledge-writer-fixture.mjs";

export const researchOriginalReleasePins = Object.freeze({
  "4.0.22": "1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27",
  "4.0.27": "d9deb3f1664496342ee1397c78748cb020fdf65aac0978bbbb43b880d5d2f1be",
});
export const researchOriginalTools = Object.freeze(["get_research", "list_research", "search_research", "paper_graph"]);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const mcpMember = "dist/mcp/mcp.js";
const wheel = "resources/vendor/adaptive_skill_retrieval-0.3.0.dev2026100504-py3-none-any.whl";
const extract = String.raw`
import hashlib,json,re,stat,sys,zipfile
from pathlib import Path,PurePosixPath
root=Path(sys.argv[1]);version=sys.argv[3]
with zipfile.ZipFile(sys.argv[2]) as archive:
 names=archive.namelist()
 def read(member):
  name="extension/"+member
  if names.count(name)!=1:raise ValueError("Missing/duplicate sealed Research member")
  info=archive.getinfo(name)
  if info.is_dir() or stat.S_ISLNK(info.external_attr>>16) or info.file_size>4*1024*1024:raise ValueError("Unsafe Research member")
  return archive.read(info)
 package=json.loads(read("package.json"))
 if (package["publisher"],package["name"],package["version"])!=("Uone","personal-knowledge",version):raise ValueError("Wrong Original version")
 pending=["dist/mcp/mcp.js","resources/retrieval_worker.py",sys.argv[4],"dist/retrieval/retrieval-snapshot.js"]
 result={};total=0
 while pending:
  member=pending.pop()
  if member in result:continue
  p=PurePosixPath(member)
  if p.is_absolute() or ".." in p.parts or "\\" in member or ":" in member:raise ValueError("Unsafe member path")
  data=read(member);total+=len(data)
  if total>16*1024*1024 or len(result)>100:raise ValueError("Research dependency closure unbounded")
  target=root/member;target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
  if target.exists():
   if target.read_bytes()!=data:raise ValueError("Existing sealed dependency differs")
  else:
   with target.open("xb") as out:out.write(data)
  target.chmod(0o600)
  result[member]=hashlib.sha256(data).hexdigest()
  if member.endswith(".js") and member!="dist/mcp/mcp.js":
   for dependency in re.findall(r'require\(["\'](\.[^"\']*)["\']\)',data.decode()):
    dependency=str(PurePosixPath(member).parent/dependency)
    # Normalize only archive member names; never a host filesystem path.
    parts=[]
    for part in PurePosixPath(dependency).parts:
     if part=="..":parts.pop()
     elif part!=".":parts.append(part)
    dependency="/".join(parts)
    if not dependency.endswith(".js"):dependency+=".js"
    pending.append(dependency)
 print(json.dumps(result))
`;

const execute = String.raw`
import ast,datetime,hashlib,json,math,os,re,socket,sqlite3,sys,threading,time,urllib.error,urllib.parse,urllib.request,uuid
from pathlib import Path
from typing import Any,Optional,List
request=json.load(sys.stdin)
STORE=Path(request["root"]);PAPERS=STORE/"papers";NOTES=STORE/"notes";SKILLS=STORE/"skills"
SUBSCRIPTIONS=STORE/"subscriptions/cache";RETRIEVAL_STATE=STORE/".pkm/state/retrieval"
_COLLECTOR_SESSION_ID="closed-original-research-oracle"
def forbidden(*args,**kwargs):raise RuntimeError("Closed Research oracle forbids network")
socket.create_connection=forbidden;socket.socket.connect=forbidden;urllib.request.urlopen=forbidden
functions={node.name:node for node in ast.parse(Path(request["source"]).read_text()).body if isinstance(node,(ast.FunctionDef,ast.AsyncFunctionDef))}
needed={request["tool"]};pending=list(needed)
while pending:
 node=functions[pending.pop()]
 for child in ast.walk(node):
  if isinstance(child,ast.Name) and isinstance(child.ctx,ast.Load) and child.id in functions and child.id not in needed:
   needed.add(child.id);pending.append(child.id)
body=[]
for name in sorted(needed):
 node=functions[name];node.decorator_list=[];body.append(node)
exec(compile(ast.Module(body=body,type_ignores=[]),"<sealed-original-research-mcp>","exec"))
if request.get("snapshot") is not None:
 # Only the /get transport is replaced, by the actual sealed Original worker executor.
 # The MCP validation, type filter, worker lookup, revision and content hash stay genuine.
 sys.path.insert(0,str(Path(request["release"])/request["wheel"]))
 from adaptive_skill_retrieval import ContentType,SkillDocument
 worker=ast.parse((Path(request["release"])/"resources/retrieval_worker.py").read_text())
 names={"source_content_type","matches_content_types","make_document","get_source"}
 exec(compile(ast.Module(body=[node for node in worker.body if isinstance(node,ast.FunctionDef) and node.name in names],type_ignores=[]),"<sealed-original-research-worker>","exec"))
 snapshot=request["snapshot"];documents=[make_document(value) for value in snapshot["documents"]]
 ready_source_values={doc.version:{**value,"content_type":source_content_type(value),"content_hash":doc.version.content_hash} for doc,value in zip(documents,snapshot["documents"])}
 ready_revision=snapshot["corpus_revision"];ready_generation=1;building_revision="";engine_lock=threading.Lock()
 original_transport=_retrieval_request
 def _retrieval_request(route,payload=None):
  if route=="/get":return get_source(payload)
  return original_transport(route,payload)
value=globals()[request["tool"]](**request["arguments"])
try:value=json.loads(value)
except (TypeError,ValueError):pass
print(json.dumps(value,ensure_ascii=False))
`;

function producer(bytes) {
  const tree = ts.createSourceFile("sealed-original-mcp.js", bytes.toString(), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const templates = [];
  function visit(node) {
    if (ts.isCallExpression(node) && node.arguments[0]?.getText(tree) === "serverPy"
      && ts.isTemplateExpression(node.arguments[1])) {
      const template = node.arguments[1];
      templates.push(template.head.text + template.templateSpans.map(span => `__CAPTURE_ONLY__${span.literal.text}`).join(""));
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  const source = templates.find(template => researchOriginalTools.every(tool => template.includes(`def ${tool}(`)));
  assert(source, "All four exact Research executors must exist in this sealed binary, not current Source.");
  return source;
}

/** A genuine27 pin is observed for contract comparison, never substituted for mandatory22 semantics. */
export async function inspectSealedResearchRelease({ legacyVsix, version, python }) {
  assert.equal(hash(await readFile(legacyVsix)), researchOriginalReleasePins[version], "Wrong sealed Original oracle.");
  const bytes = execFileSync(python, ["-I", "-B", "-c",
    "import sys,zipfile;sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read('extension/dist/mcp/mcp.js'))", legacyVsix]);
  const source = producer(bytes);
  const contracts = JSON.parse(execFileSync(python, ["-I", "-B", "-c", String.raw`
import ast,json,sys
s=sys.stdin.read();t=ast.parse(s);names=set(sys.argv[1:])
print(json.dumps({n.name:{"arguments":[a.arg for a in n.args.args],"bodySha256":__import__("hashlib").sha256(ast.dump(n,include_attributes=False).encode()).hexdigest()} for n in t.body if isinstance(n,ast.FunctionDef) and n.name in names}))
`, ...researchOriginalTools], { input: source, encoding: "utf8" }));
  return { version, packageSha256: researchOriginalReleasePins[version], mcpMemberSha256: hash(bytes), contracts };
}

/** Own closed public copy only; never execute Original code on Parent's admitted native Root. */
export async function createInstalledResearchBasicOracle({ directory, legacyVsix, python }) {
  if (!isAbsolute(directory) || resolve(directory) !== directory || await realpath(directory) !== directory)
    throw new Error("Canonical owned closed Research oracle directory required.");
  const writer = pinnedOriginalKnowledgeWriterFixture({ directory, legacyVsix, python });
  const release = join(directory, "release");
  const members = JSON.parse(execFileSync(python, ["-I", "-B", "-c", extract, release, legacyVsix, "4.0.22", wheel],
    { encoding: "utf8", cwd: directory, env: { ...process.env, TMPDIR: join(directory, "scratch"), PYTHONDONTWRITEBYTECODE: "1" },
      stdio: ["pipe", "pipe", "pipe"], timeout: 30000 }));
  const source = join(directory, "research-original22.py"), bytes = await readFile(join(release, mcpMember));
  await writeFile(source, producer(bytes), { flag: "wx", mode: 0o600 });
  const sourceSha256 = hash(await readFile(source)), root = join(directory, "closed-research-public");
  await mkdir(root, { mode: 0o700 });
  for (const area of ["notes", "skills", "papers"]) await mkdir(join(root, area), { mode: 0o700 });
  async function assertPinned() {
    writer.assertPinned();
    for (const [member, sha256] of [[source, sourceSha256], ...Object.entries(members).map(([name, sha]) => [join(release, name), sha])]) {
      const stat = await lstat(member);
      assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid() && !(stat.mode & 0o077));
      assert.equal(hash(await readFile(member)), sha256);
    }
  }
  return {
    root, writer, sourceSha256, mcpMemberSha256: hash(bytes), members,
    async snapshot() {
      await assertPinned();
      return writer.run(root, `
        const snapshot = require(process.argv[1]+"/dist/retrieval/retrieval-snapshot.js");
        const value = snapshot.createRetrievalSnapshot({
          skills:store.skillList().map(row=>store.skillGet(row.name)).filter(Boolean),
          notes:store.noteList().map(row=>store.noteGet(row.slug)).filter(Boolean),
          papers:store.paperList().map(row=>store.paperGet(row.slug)).filter(Boolean),
          scripts:[],recipes:[],subscriptionGroups:[],readSubscription(){throw Error("No subscriptions in closed Research oracle");}
        });
        return {...value,documents:value.documents.map(snapshot.indexedRetrievalDocument)};
      `);
    },
    async invoke(tool, args, candidateRoot = root) {
      if (candidateRoot !== root || await realpath(root) !== root || !researchOriginalTools.includes(tool))
        throw Object.assign(new Error("INSTALLED_RESEARCH_CLOSED_ORACLE_ROOT_REQUIRED"), { code: "INSTALLED_RESEARCH_CLOSED_ORACLE_ROOT_REQUIRED" });
      await assertPinned();
      const canonical = tool === "get_research" && /^(?:pkm:\/\/knowledge\/|knowledge_)/.test(String(args.id || args.slug || ""));
      const snapshot = canonical ? await this.snapshot() : undefined;
      const result = JSON.parse(execFileSync(python, ["-I", "-B", "-c", execute], {
        input: JSON.stringify({ root, source, release, wheel, tool, arguments: args, snapshot }), encoding: "utf8",
        cwd: directory, env: { PATH: process.env.PATH, HOME: join(directory, "home"), TMPDIR: join(directory, "scratch"),
          PYTHONDONTWRITEBYTECODE: "1" }, stdio: ["pipe", "pipe", "pipe"], timeout: 30000, maxBuffer: 4_194_304,
      }));
      await assertPinned(); return result;
    },
  };
}

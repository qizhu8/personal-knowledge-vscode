import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { readOriginalSource } from "../scripts/migration.mjs";
import { pinnedOriginalKnowledgeWriterFixture } from "./original-knowledge-writer-fixture.mjs";

const sourceSha256 = "2a5f623b20b71e3d3ce12283db1fbcb01fb5fa4b43ebbf29d2fd9a28a992f948";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const tools = ["add_note", "get_note", "update_note", "list_notes", "search_notes",
  "add_paper", "get_paper", "update_paper", "list_papers", "search_papers"];
const members = ["resources/knowledge_mutations.py", "resources/knowledge_mutations.js",
  "resources/note_inventory.py", "resources/recipe_runtime.py"];

const program = String.raw`
import ast,datetime,hashlib,inspect,json,os,re,socket,sqlite3,subprocess,sys,time,urllib.error,urllib.parse,urllib.request,uuid
from pathlib import Path
from typing import Any,Optional,List
request=json.load(sys.stdin)
STORE=Path(request["root"]);NOTES=STORE/"notes";PAPERS=STORE/"papers"
RETRIEVAL_STATE=STORE/".pkm/state/retrieval"
_COLLECTOR_SESSION_ID="closed-original-note-paper-oracle"
_KNOWLEDGE_NODE=request["node"];_KNOWLEDGE_EXTENSION=request["release"]
def forbidden(*args,**kwargs):raise RuntimeError("Closed Original oracle forbids network access")
socket.create_connection=forbidden;socket.socket.connect=forbidden;urllib.request.urlopen=forbidden
sources=[Path(request["source"]),Path(request["release"])/"resources/recipe_runtime.py"]
functions={}
for path in sources:
 tree=ast.parse(path.read_text())
 for node in tree.body:
  if isinstance(node,(ast.FunctionDef,ast.AsyncFunctionDef)):
   functions.setdefault(node.name,node)
needed={request["tool"]};pending=list(needed)
while pending:
 name=pending.pop();node=functions[name]
 for child in ast.walk(node):
  if isinstance(child,ast.Name) and isinstance(child.ctx,ast.Load) and child.id in functions and child.id not in needed:
   needed.add(child.id);pending.append(child.id)
selected=[]
for name in sorted(needed):
 node=functions[name];node.decorator_list=[];selected.append(node)
exec(compile(ast.Module(body=selected,type_ignores=[]),"<pinned-original-4.0.22-tools>","exec"))
# Only the real Original mutation function is loaded; registration has no place in a closed oracle.
mutation=Path(request["release"])/"resources/knowledge_mutations.py"
tree=ast.parse(mutation.read_text());node=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=="write_markdown")
namespace={**globals(),"__file__":str(mutation)}
exec(compile(ast.Module(body=[node],type_ignores=[]),str(mutation),"exec"),namespace)
write_markdown=namespace["write_markdown"]
inventory=Path(request["release"])/"resources/note_inventory.py"
namespace={"__file__":str(inventory),"__name__":"closed_original_inventory"}
exec(compile(inventory.read_text(),str(inventory),"exec"),namespace)
note_inventory_page=namespace["note_inventory_page"]
value=globals()[request["tool"]](**request["arguments"])
try:value=json.loads(value)
except (TypeError,ValueError):pass
print(json.dumps(value,ensure_ascii=False))
`;

/** The only executable Oracle root is its own closed copy, never an admitted native Root. */
export async function createInstalledNotePaperBasicOracle({ directory, legacyVsix, python }) {
  if (!isAbsolute(directory) || resolve(directory) !== directory || await realpath(directory) !== directory)
    throw new Error("Canonical owned Original oracle directory required.");
  const writer = pinnedOriginalKnowledgeWriterFixture({ directory, legacyVsix, python });
  const bytes = await readOriginalSource("src/mcp/mcp.ts", { sha256: sourceSha256, dataset: "linux-candidate-originals" });
  assert.equal(hash(bytes), sourceSha256);
  const tree = ts.createSourceFile("original-mcp.ts", bytes.toString(), ts.ScriptTarget.Latest, true);
  let template;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === "fs.writeFileSync"
      && node.arguments[0]?.getText(tree) === "serverPy" && ts.isTemplateExpression(node.arguments[1])
      && node.arguments[1].head.text.includes("PKM MCP Server"))
      template = node.arguments[1].head.text + node.arguments[1].templateSpans.map(span =>
        `__CAPTURE_ONLY__${span.literal.text}`).join("");
    ts.forEachChild(node, visit);
  }
  visit(tree); assert(template, "The SHA-pinned Original Python producer must be present.");
  const source = join(directory, "original-tools.py"), release = join(directory, "release");
  await writeFile(source, template, { mode: 0o600, flag: "wx" });
  await mkdir(join(release, "resources"), { mode: 0o700 });
  writer.assertPinned();
  execFileSync(python, ["-I", "-B", "-c", `
import stat,sys,zipfile
from pathlib import Path
with zipfile.ZipFile(sys.argv[2]) as archive:
 for member in sys.argv[3:]:
  name="extension/"+member
  if archive.namelist().count(name)!=1:raise ValueError("Missing or duplicate Original oracle member")
  info=archive.getinfo(name)
  if info.is_dir() or stat.S_ISLNK(info.external_attr>>16) or info.file_size>2*1024*1024:
   raise ValueError("Unsafe Original oracle member")
  with (Path(sys.argv[1])/member).open("xb") as out:out.write(archive.read(info))
`, release, legacyVsix, ...members], { cwd: directory, env: { ...process.env,
    TMPDIR: join(directory, "scratch"), PYTHONDONTWRITEBYTECODE: "1" }, stdio: "pipe", timeout: 30000 });
  const pins = await Promise.all([source, ...members.map(member => join(release, member))]
    .map(async path => [path, hash(await readFile(path))]));
  const root = join(directory, "closed-note-paper-oracle");
  await mkdir(root, { mode: 0o700 });
  for (const area of ["notes", "papers"]) await mkdir(join(root, area), { mode: 0o700 });
  return {
    root, writer, sourceSha256,
    async invoke(tool, args, candidateRoot = root) {
      if (candidateRoot !== root || await realpath(root) !== root
        || relative(directory, root).includes(sep) || !tools.includes(tool))
        throw Object.assign(new Error("INSTALLED_NOTE_PAPER_CLOSED_ORACLE_ROOT_REQUIRED"),
          { code: "INSTALLED_NOTE_PAPER_CLOSED_ORACLE_ROOT_REQUIRED" });
      for (const [path, sha256] of pins) {
        const stat = await lstat(path);
        assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid());
        assert.equal(hash(await readFile(path)), sha256);
      }
      writer.assertPinned();
      const value = JSON.parse(execFileSync(python, ["-I", "-B", "-c", program], {
        input: JSON.stringify({ root, source, release, node: process.execPath, tool, arguments: args }),
        cwd: directory, env: { PATH: process.env.PATH, HOME: join(directory, "home"),
          TMPDIR: join(directory, "scratch"), PYTHONDONTWRITEBYTECODE: "1" },
        encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 30000, maxBuffer: 4_194_304,
      }));
      writer.assertPinned(); return value;
    },
  };
}

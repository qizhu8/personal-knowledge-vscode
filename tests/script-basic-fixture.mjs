import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { compatibilityMcpFixture, compatibilityMcpValue } from "./compatibility-mcp-fixture.mjs";
import { pinnedOriginalKnowledgeWriterFixture } from "./original-knowledge-writer-fixture.mjs";
import { readOriginalSource } from "../scripts/migration.mjs";
import { runLegacyMcpPython } from "../src/legacy-mcp-python.ts";

export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
export const resultValue = compatibilityMcpValue;

async function originalScriptReader(directory, oracle) {
  oracle.assertPinned();
  const release = join(directory, "release"), members = ["dist/knowledge/storage.js", "dist/knowledge/knowledge-locator.js"];
  execFileSync(process.env.PKM_TEST_PYTHON, ["-I", "-B", "-c", `
import stat,sys,zipfile
from pathlib import Path
root=Path(sys.argv[1])
with zipfile.ZipFile(sys.argv[2]) as archive:
 for member in sys.argv[3:]:
  name="extension/"+member
  if archive.namelist().count(name)!=1: raise ValueError("Duplicate original Script reader")
  info=archive.getinfo(name)
  if info.is_dir() or stat.S_ISLNK(info.external_attr>>16) or info.file_size>2*1024*1024:
   raise ValueError("Unsafe original Script reader")
  target=root/member
  with target.open("xb") as output: output.write(archive.read(info))
`, release, process.env.PKM_LEGACY_VSIX, ...members], {
    cwd: directory, env: { ...process.env, TMPDIR: join(directory, "scratch") }, timeout: 30000, stdio: "pipe",
  });
  const pins = await Promise.all(members.map(async member => [member, sha256(await readFile(join(release, member)))]));
  return async (root, path) => {
    oracle.assertPinned();
    for (const [member, hash] of pins) assert.equal(sha256(await readFile(join(release, member))), hash);
    return oracle.run(root, `
      const scripts = require(process.argv[1] + "/dist/knowledge/storage.js");
      scripts.setStorePath(root);
      return { row: scripts.scriptGet(input.path), listed: scripts.scriptList(),
        filename: scripts.scriptSearch("scriptbasicfilenamesentinel"), body: scripts.scriptSearch(input.marker) };
    `, { path, marker: (await readFile(join(root, "scripts", path), "utf8")).split("\r\n")[0].slice(2) });
  };
}

let snapshotOracle;
async function originalSnapshot() {
  if (!snapshotOracle) snapshotOracle = (async () => {
    execFileSync(process.execPath, [join(import.meta.dirname, "../scripts/capture-legacy-retrieval.mjs"), "--check"], {
      cwd: join(import.meta.dirname, ".."), stdio: "pipe", timeout: 30000,
    });
    const metadata = JSON.parse(await readFile(new URL("../migration/links-provenance.json", import.meta.url)));
    const pin = metadata.files.find(row => row.source === "src/retrieval/retrieval-snapshot.ts");
    assert(pin, "Require the independently captured original snapshot source.");
    const bytes = await readOriginalSource(pin.source, { sha256: pin.sourceSha256, dataset: "linux-candidate-originals" });
    assert.equal(sha256(bytes), pin.sourceSha256);
    const ast = ts.createSourceFile("original-snapshot.ts", bytes.toString("utf8"), ts.ScriptTarget.Latest, true);
    const source = ast.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(ast)).join("\n");
    return import(`data:text/javascript;base64,${Buffer.from(
      `import {createHash} from "node:crypto";import {compileKnowledgeLinksV1} from ${
        JSON.stringify(pathToFileURL(join(import.meta.dirname, "../dist/domain/knowledge-contracts.js")).href)};\n`
      + ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText,
    ).toString("base64")}`);
  })();
  return snapshotOracle;
}

export async function scriptBasicFixture(t, { includePrivate = true } = {}) {
  assert(process.env.PKM_TEST_WORKSPACE, "Use the existing isolated test framework.");
  assert(process.env.PKM_TEST_PYTHON, "Use the exact business virtualenv interpreter.");
  process.umask(0o077);
  const path = "Tools/scriptbasicfilenamesentinel.py", privatePath = "Private/scriptbasicprivatesentinel.py";
  const first = "# scriptbasicbodysentinelold\r\n# exact Unicode 字节 — no execution\r\n";
  const fresh = "# scriptbasicbodysentinelfresh\r\n# fresh Unicode 字节 — no execution\r\n";
  const secret = "# scriptbasicprivatesentinelbody — must never be read or executed\r\n";
  const brand = randomUUID();
  let oracle, oracleRoot, brandPath, readOriginalScript, privateInitial;
  const f = await compatibilityMcpFixture(t, { setup: async ({ base, root }) => {
    brandPath = join(base, "script-fixture.json");
    await writeFile(brandPath, JSON.stringify({ schema: "pkm.script-basic-fixture/v1", brand, base }), { mode: 0o600 });
    for (const area of ["scripts/Tools", ...(includePrivate ? ["scripts/Private"] : [])])
      await mkdir(join(root, area), { recursive: true, mode: 0o700 });
    await writeFile(join(root, "scripts", path), first, { mode: 0o600 });
    if (includePrivate) {
      await writeFile(join(root, "scripts", privatePath), secret, { mode: 0o600 });
      privateInitial = await lstat(join(root, "scripts", privatePath), { bigint: true });
    }
    const oracleDirectory = join(base, "script-oracle");
    await mkdir(oracleDirectory, { mode: 0o700 });
    oracle = pinnedOriginalKnowledgeWriterFixture({
      directory: oracleDirectory, legacyVsix: process.env.PKM_LEGACY_VSIX,
      python: process.env.PKM_TEST_PYTHON,
    });
    oracleRoot = join(oracleDirectory, "library");
    await mkdir(join(oracleRoot, "scripts/Tools"), { recursive: true, mode: 0o700 });
    await writeFile(join(oracleRoot, "scripts", path), first, { mode: 0o600 });
    readOriginalScript = await originalScriptReader(oracleDirectory, oracle);
    const policy = oracle.run(oracleRoot,
      'privacy.setTopLevelPrivacy("scripts", "Private", input.includePrivate); return { raw: fs.readFileSync(path.join(root, ".pkm/content-privacy.json"), "utf8") };',
      { includePrivate });
    await mkdir(join(root, ".pkm"), { mode: 0o700 });
    await writeFile(join(root, ".pkm/content-privacy.json"), policy.raw, { mode: 0o600 });
  } });
  async function editExpected(expected, next) {
    const currentBrand = JSON.parse(await readFile(brandPath));
    assert.deepEqual(currentBrand, { schema: "pkm.script-basic-fixture/v1", brand, base: f.base });
    const ownedPath = join(f.root, "scripts", path), stat = await lstat(ownedPath);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid() && stat.nlink === 1);
    assert.equal(sha256(await readFile(ownedPath)), sha256(expected), "External fixture edit requires its exact expected bytes.");
    assert.equal(sha256(await readFile(join(oracleRoot, "scripts", path))), sha256(expected));
    await writeFile(ownedPath, next, { mode: 0o600 });
    await writeFile(join(oracleRoot, "scripts", path), next, { mode: 0o600 });
  }
  async function snapshot(generation) {
    const reader = await readOriginalScript(oracleRoot, path);
    assert.equal(reader.listed.length, 1, JSON.stringify(reader));
    assert.equal(reader.filename.length, 1);
    assert.equal(reader.body.length, 1, "Actual original Script storage search includes body; no Note/Paper assumption.");
    const scripts = [{ ...reader.listed[0], ...reader.row, extension: ".py" }];
    assert.equal(scripts[0].path, path);
    assert.equal(scripts[0].content, await readFile(join(f.root, "scripts", path), "utf8"));
    const original = await originalSnapshot();
    const projected = original.createRetrievalSnapshot({
      skills: [], notes: [], papers: [], scripts, recipes: [], subscriptionGroups: [],
      readSubscription() { throw new Error("No subscription/source authority is granted by this fixture."); },
    });
    return { ...projected, generation, documents: projected.documents.map(original.indexedRetrievalDocument) };
  }
  async function lexical(snapshot, tool, args) {
    const response = await runLegacyMcpPython(new URL("../compat/legacy-knowledge-mcp.py", import.meta.url).pathname, [], {
      tool, arguments: args, files: [], recipes: [], retrievalSnapshot: snapshot,
    });
    assert.deepEqual(JSON.parse(response.text), response.value, "The Source Python adapter returns one exact result representation.");
    return response.value;
  }
  return { ...f, path, privatePath, first, fresh, secret, privateInitial, oracle, oracleRoot, editExpected, snapshot, lexical,
    originalReader: () => readOriginalScript(oracleRoot, path) };
}

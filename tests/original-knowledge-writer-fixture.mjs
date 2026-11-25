import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const project = resolve(import.meta.dirname, "..");
const releaseSha256 = "1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27";
const members = [
  "package.json", "dist/knowledge/filestore.js", "dist/knowledge/content-privacy.js",
  "dist/knowledge/knowledge-contracts.js", "dist/knowledge/knowledge-deletion-journal.js",
  "dist/knowledge/markdown-assets.js", "dist/knowledge/note-work-items.js",
  "dist/knowledge/todo-board.js", "dist/runtime/cross-process-lock.js",
];

export function originalKnowledgeWriterFixture(parent) {
  const directory = realpathSync(parent), local = relative(realpathSync(join(project, "tests")), directory);
  if (directory !== resolve(parent) || !local || isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`))
    throw new Error("The original Knowledge writer requires an owned disposable fixture beneath tests/.");
  return pinnedOriginalKnowledgeWriterFixture({ directory, legacyVsix: process.env.PKM_LEGACY_VSIX });
}

/** Extraction/execution only; the installed caller separately brand-checks its cold fixture. */
export function pinnedOriginalKnowledgeWriterFixture({ directory, legacyVsix: archive, python = "python3" }) {
  const parent = lstatSync(directory);
  if (!isAbsolute(directory) || resolve(directory) !== directory || realpathSync(directory) !== directory
    || !parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid() || parent.mode & 0o077)
    throw new Error("The original Knowledge writer requires a canonical owned private fixture directory.");
  const archiveStat = archive && lstatSync(archive);
  if (!archiveStat || !archiveStat.isFile() || archiveStat.isSymbolicLink() || archiveStat.nlink !== 1
    || archiveStat.size > 256 * 1024 * 1024)
    throw new Error("Set PKM_LEGACY_VSIX to the independently pinned original 4.0.22 package.");
  const bytes = readFileSync(archive);
  if (createHash("sha256").update(bytes).digest("hex") !== releaseSha256)
    throw new Error(`The original Knowledge writer VSIX SHA256 must equal ${releaseSha256}.`);
  const release = join(directory, "release"), home = join(directory, "home"), scratch = join(directory, "scratch");
  for (const path of [release, home, scratch]) mkdirSync(path, { mode: 0o700 });
  const env = { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home,
    TMPDIR: scratch, TMP: scratch, TEMP: scratch, PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1" };
  execFileSync(python, ["-I", "-B", "-c", `
import io,json,stat,sys,zipfile
from pathlib import Path,PurePosixPath
root=Path(sys.argv[1]).resolve()
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as archive:
 names=archive.namelist()
 metadata=json.loads(archive.read("extension/package.json"))
 if (metadata["publisher"],metadata["name"],metadata["version"])!=("Uone","personal-knowledge","4.0.22"):
  raise ValueError("Unexpected original Knowledge release")
 total=0
 for member in sys.argv[2:]:
  path=PurePosixPath(member)
  if path.is_absolute() or ".." in path.parts or "\\\\" in member or ":" in member:
   raise ValueError("Unsafe Knowledge release member")
  name="extension/"+member
  if names.count(name)!=1: raise ValueError("Missing or duplicate original Knowledge member")
  info=archive.getinfo(name)
  total+=info.file_size
  if info.is_dir() or stat.S_ISLNK(info.external_attr>>16) or info.file_size>2*1024*1024 or total>8*1024*1024:
   raise ValueError("Unbounded original Knowledge member")
  target=root.joinpath(*path.parts)
  target.resolve().relative_to(root)
  target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
  with target.open("xb") as output: output.write(archive.read(info))
`, release, ...members], { input: bytes, cwd: directory, env, timeout: 30000, maxBuffer: 1024 * 1024 });
  const hashes = new Map(members.map(member => [member, createHash("sha256").update(readFileSync(join(release, member))).digest("hex")]));
  function assertPinned() {
    if (createHash("sha256").update(readFileSync(archive)).digest("hex") !== releaseSha256)
      throw new Error("The independently pinned original Knowledge package changed.");
    for (const [member, expected] of hashes) {
      const path = join(release, member), stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
        || createHash("sha256").update(readFileSync(path)).digest("hex") !== expected)
        throw new Error("Original writer member changed.");
    }
  }
  return {
    originalPackageSha256: releaseSha256,
    assertPinned,
    run(root, script, input = {}) {
      assertPinned();
      const localRoot = relative(directory, resolve(root));
      if (!localRoot || isAbsolute(localRoot) || localRoot === ".." || localRoot.startsWith(`..${sep}`)
        || realpathSync(root) !== resolve(root))
        throw new Error("The original writer may access only its disposable canonical fixture roots.");
      const result = JSON.parse(execFileSync(process.execPath, ["-e", `
        const fs = require("node:fs"), path = require("node:path"), net = require("node:net");
        net.connect = net.createConnection = () => { throw new Error("Oracle network access is forbidden."); };
        const store = require(process.argv[1] + "/dist/knowledge/filestore.js");
        const assets = require(process.argv[1] + "/dist/knowledge/markdown-assets.js");
        const privacy = require(process.argv[1] + "/dist/knowledge/content-privacy.js");
        const root = process.argv[2], input = JSON.parse(fs.readFileSync(0, "utf8"));
        store.setStorePath(root); privacy.setPrivacyStoreRoot(root);
        const value = (() => { ${script} })();
        console.log(JSON.stringify(value));
      `, release, root], { input: JSON.stringify(input), encoding: "utf8", cwd: directory, env,
        timeout: 30000, maxBuffer: 4 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] }));
      assertPinned();
      return result;
    },
  };
}

export const seedOriginalKnowledge = `
  const rows = {};
  for (const [kind, area] of [["note", "notes"], ["skill", "skills"], ["paper", "papers"]]) {
    const row = { slug: "Old/Before", title: "Before", name: "Before", category: "Old", type: "general",
      tags: ["retained"], content: "Original body\\n![paired](Before.assets/opaque.bin?q=1#view)\\n" };
    store[kind + "Upsert"](row);
    assets.saveMarkdownAsset(root, area, "Old/Before.md", "opaque.bin", Buffer.from([255, 0, 128, 9]));
    if (input.sharedCompanion) {
      store[kind + "Upsert"]({ ...row, slug: "Old/Shared", title: "Shared", name: "Shared",
        content: "Original shared body\\n![paired](Shared.assets/opaque.bin)\\n" });
      assets.saveMarkdownAsset(root, area, "Old/Shared.md", "opaque.bin", Buffer.from([255, 0, 128, 9]));
    }
    store[kind + "Upsert"]({ ...row, slug: "Private/Secret", title: "Secret", name: "Secret", category: "Private",
      content: input.sharedCompanion ? "Private marker\\n![shared](../Old/Shared.assets/opaque.bin)\\n"
        : input.shared ? "Private marker\\n![shared](../Old/Before.assets/opaque.bin)\\n" : "Private marker\\n" });
    if (input.configurePrivacy !== false) privacy.setTopLevelPrivacy(area, "Private", true);
    rows[kind] = store[kind + "Get"](kind === "skill" ? "Before" : "Old/Before");
  }
  return rows;
`;

export const moveOriginalKnowledge = `
  const kind = input.kind, key = input.key || (kind === "skill" ? "Before" : "Old/Before");
  const before = store[kind + "Get"](key);
  const name = input.name || (kind === "skill" ? "Before" : "After"), category = input.category || "New";
  store[kind + "Upsert"]({ ...before, title: name, name, category,
    tags: typeof before.tags === "string" ? JSON.parse(before.tags) : before.tags,
    content: input.content ?? "Changed body\\n![paired](Before.assets/opaque.bin?q=1#view)\\n" });
  return store[kind + "Get"](kind === "skill" ? name : category + "/" + name);
`;

export const seedOriginalLegacyKnowledge = `
  const rows = {}, namespace = input.privateSource ? "Private/_assets" : "_assets";
  for (const [kind, area] of [["note", "notes"], ["skill", "skills"], ["paper", "papers"]]) {
    const paired = input.paired && kind === "note";
    const forms = input.parserForms ? '<img src="../' + namespace + '/a.PNG?html=1#image">\\n'
      + "[legacy]: <../" + namespace + "/b.BIN?definition=1#doc>\\n"
      + "\`![ignored](../" + namespace + "/a.PNG)\`\\n\`\`\`md\\n![example](../" + namespace + "/b.BIN)\\n\`\`\`\\n" : "";
    const content = input.withoutLegacy ? "Original legacy body\\nNo resource references.\\n"
      : "Original legacy body\\n![one](../" + namespace + "/a.PNG?q=1#view)\\n[other](../"
        + namespace + "/b.BIN)\\n" + forms + (paired ? "[kept](Before.assets/existing.bin)\\n" : "");
    store[kind + "Upsert"]({ slug: "Old/Before", title: "Before", name: "Before", category: "Old",
      type: "general", tags: ["retained"], content,
      ...(input.parserForms && kind === "paper" ? { file: "../" + namespace + "/a.PNG?file=1#attachment" } : {}) });
    if (paired) assets.saveMarkdownAsset(root, area, "Old/Before.md", "existing.bin", Buffer.from([9,8,7]));
    for (const [name, data] of [["a.PNG",[255,0,128,9]],["b.BIN",[1,2,3,4,5]]]) {
      if (input.withoutLegacy) continue;
      const bytes = Buffer.from(data), relative = namespace + "/" + name;
      assets.importMarkdownAssetBundle(root, [{ type: area, path: relative, data: bytes.toString("base64"),
        digest: "sha256:" + require("node:crypto").createHash("sha256").update(bytes).digest("hex") }],
        [{ area, path: "Old/Before.md", content }]);
    }
    store[kind + "Upsert"]({ slug: "Private/Secret", title: "Secret", name: "Secret", category: "Private",
      type: "general", content: "Retained private legacy marker\\n"
        + (input.shared ? "![shared](../" + namespace + "/a.PNG)\\n" : "") });
    if (input.publicReferrer)
      store[kind + "Upsert"]({ slug: "Old/Referrer", title: "Referrer", name: "Referrer", category: "Old",
        type: "general", content: "Public legacy referrer\\n![shared](../" + namespace + "/a.PNG)\\n" });
    if (input.configurePrivacy !== false) privacy.setTopLevelPrivacy(area, "Private", true);
    rows[kind] = store[kind + "Get"](kind === "skill" ? "Before" : "Old/Before");
  }
  return rows;
`;

export const seedOriginalPublicLegacyCompanion = `
  const rows = {}, bytes = Buffer.from([70,71,72,73]);
  for (const [kind, area] of [["note","notes"],["skill","skills"],["paper","papers"]]) {
    const content = "PUBLIC_SHARED_LEGACY_OWNER\\n![shared](../_assets/shared.PNG?shared=1#view)\\n";
    store[kind + "Upsert"]({ slug: "Old/Shared", title: "Shared", name: "Shared", category: "Old",
      type: "general", content });
    store[kind + "Upsert"]({ slug: "Old/Referrer", title: "Referrer", name: "Referrer", category: "Old",
      type: "general", content: "PUBLIC_SHARED_LEGACY_REFERRER\\n![shared](../_assets/shared.PNG)\\n" });
    assets.importMarkdownAssetBundle(root, [{ type: area, path: "_assets/shared.PNG", data: bytes.toString("base64"),
      digest: "sha256:" + require("node:crypto").createHash("sha256").update(bytes).digest("hex") }],
      [{ area, path: "Old/Shared.md", content }]);
    rows[kind] = store[kind + "Get"](kind === "skill" ? "Shared" : "Old/Shared");
  }
  return rows;
`;

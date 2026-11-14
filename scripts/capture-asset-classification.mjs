import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dirname, "../legacy");
const sources = {
  engine: "src/knowledge/asset-classification.ts",
  frontmatter: "src/knowledge/filestore.ts",
  identity: "src/knowledge/knowledge-contracts.ts",
  privacy: "src/knowledge/content-privacy.ts",
  script: "src/sync/github-sync-script-identity.ts",
};
const sha = value => createHash("sha256").update(value).digest("hex");
const expected = {
  engine: "862d3566db8a8bd45b670ba2e5ed3de2ce0570693f92f0730249add8d19e7523",
  frontmatter: "c5c3a9761562818529a00aedb96aef254bef34dc80a4ed31f31efd39bc7a97a5",
  identity: "0f4c453b726e70df7c3e8df3e4eb253114d89d4cb88eb8ce3e4f561bf336ab2f",
  privacy: "3f609926211c2a33344b090dc8877531ca26916431779d818df64b28a426a40b",
  script: "cb4a8fbe28d08ffc1dd018cd788bc3c61c61ae9bddf1919acc16348d36bf8fbb",
};
const modules = {}, pins = {};
for (const [name, path] of Object.entries(sources)) {
  const raw = readFileSync(resolve(root, path), "utf8");
  if (sha(raw) !== expected[name]) throw new Error(`Original classification source changed: ${path}`);
  pins[path] = sha(raw);
  let source = raw;
  if (name === "frontmatter") {
    const ast = ts.createSourceFile(path, raw, ts.ScriptTarget.Latest, true);
    const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "parseStoreFrontmatter");
    if (!fn) throw new Error("Original frontmatter parser is absent.");
    source = fn.getText(ast);
  }
  modules[name] = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}
const output = `"use strict";\n// Generated from exact original sources; capture script checks every byte.\n`
  + `const sources=${JSON.stringify(modules)};\nfunction create(fsOverride){const cache={};\n`
  + `function load(name){if(cache[name])return cache[name].exports;const m={exports:{}};cache[name]=m;`
  + `const deps={"./filestore":"frontmatter","./knowledge-contracts":"identity","./content-privacy":"privacy","../sync/github-sync-script-identity":"script"};`
  + `new Function("require","module","exports",sources[name])(id=>{if(deps[id])return load(deps[id]);`
  + `if(id==="fs"&&fsOverride)return fsOverride;if(["fs","path","crypto"].includes(id))return require(id);`
  + `if(id==="../runtime/cross-process-lock")return{withCrossProcessLockSync(){throw Error("Captured planner cannot publish effects");}};`
  + `if(id==="../workflows/project-filesystem-store")return{withFsRetry(){throw Error("Captured planner cannot publish effects");}};`
  + `throw Error("Uncaptured classification dependency");},m,m.exports);return m.exports;}return load;}\n`
  + `exports.preview=(root,fs)=>create(fs)("engine").previewAssetClassification(root);\n`
  + `exports.isPrivate=(root,asset,fs)=>{const p=create(fs)("privacy");p.setPrivacyStoreRoot(root);const [area,...parts]=asset.split("/");return p.isContentPathPrivate(area==="components"?"scripts":area,parts.join("/"));};\n`;
const target = resolve(root, "next-server/compat/legacy-asset-classification.cjs");
const provenance = resolve(root, "next-server/compat/legacy-asset-classification-pins.json");
const serialized = JSON.stringify({ schema: 1, sources: pins, captureSha256: sha(output) }, null, 2) + "\n";
if (process.argv.includes("--check")) {
  if (readFileSync(target, "utf8") !== output || readFileSync(provenance, "utf8") !== serialized)
    throw new Error("Original classification capture drift.");
} else {
  writeFileSync(target, output);
  writeFileSync(provenance, serialized);
}
console.log("Classification: exact original planner, parser, identity, privacy and script identity captures verified.");

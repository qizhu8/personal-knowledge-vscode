#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, mkdir, rm, writeFile, lstat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";
import { initialize, Storage } from "../dist/storage.js";
import { STORAGE_OWNER_DDL } from "../dist/storage-owner-schema.js";
import { RootOwner } from "../dist/root-owner.js";
import { initializeFreshNoteQuerySchema, FRESH_NOTE_QUERY_DERIVED_TABLES } from "../dist/fresh-note-query-model.js";
import { bootstrapHash, bootstrapSchemaHash, bootstrapTableRows } from "../dist/storage-startup-classification.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "src/storage-bootstrap-profile.ts");
const script = "scripts/generate-storage-bootstrap-profile.mjs";
export async function bootstrapSourceFiles() {
  const seen = new Set(["src/storage-bootstrap-profile.ts"]);
  const result = [];
  async function visit(path) {
    if (seen.has(path)) return;
    seen.add(path);
    const text = await readFile(join(root, path), "utf8");
    result.push({ path, sha256: createHash("sha256").update(text).digest("hex") });
    const parsed = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const dependencies = [];
    function walk(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier
        && ts.isStringLiteral(node.moduleSpecifier)) dependencies.push(node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
        && ts.isStringLiteral(node.arguments[0])) dependencies.push(node.arguments[0].text);
      ts.forEachChild(node, walk);
    }
    walk(parsed);
    for (const dependency of dependencies.filter(name => name.startsWith(".") && name.endsWith(".js"))) {
      const target = relative(root, resolve(root, dirname(path), dependency.replace(/\.js$/, ".ts"))).split("\\").join("/");
      assert(target.startsWith("src/"), `Unexpected bootstrap dependency ${target}`);
      await visit(target);
    }
  }
  for (const path of ["src/storage-worker.ts", "src/storage.ts", "src/native-runtime.ts", "src/workspace-validation.ts",
    "src/fresh-note-query-model.ts"]) await visit(path);
  const text = await readFile(join(root, script), "utf8");
  result.push({ path: script, sha256: bootstrapHash(text) });
  return result.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}
async function observe(directory) {
  const workspace = join(directory, "root");
  await initialize(workspace);
  const storage = await Storage.open(workspace);
  try {
    const db = storage.connectNative();
    try {
      const databaseVersion = Number(db.prepare("PRAGMA user_version").get().user_version);
      assert.equal(databaseVersion, 23, "A new canonical database version requires an explicit new bootstrap profile.");
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({ name }) => {
        if (name === "native_runtime_owner") return { name, role: "owner" };
        if (name === "documents") return { name, role: "documents" };
        const rows = bootstrapTableRows(db, name);
        assert(!rows.includes(workspace), `Root-dependent seed ${name} cannot become a plain-root seed.`);
        return rows === "[]" ? { name, role: "empty" } : { name, role: "seed", rows };
      });
      assert.equal(tables.find(table => table.name === "receipts").role, "empty");
      const base = { databaseVersion, schemaSha256: bootstrapSchemaHash(db), tables };
      const derived = await observeDerived(db, storage, workspace, base);
      return { base, derived };
    } finally { db.close(); }
  } finally { await storage.close(); }
}
async function observeDerived(db, owner, workspace, base) {
  const stat = await lstat(workspace, { bigint: true });
  const workspaceId = await owner.workspaceId(), rootPin = `${stat.dev}:${stat.ino}`;
  const before = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name").all();
  initializeFreshNoteQuerySchema(db, { assert() { owner.assertWorkspaceLease(); return { workspaceId, rootPin }; } });
  const after = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name").all();
  for (const object of before) assert.deepEqual(after.find(row => row.name === object.name), object,
    `Derived initialization changed canonical object ${object.name}`);
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name);
  const added = names.filter(name => !base.tables.some(table => table.name === name));
  assert.deepEqual(added, [...FRESH_NOTE_QUERY_DERIVED_TABLES].sort(), "Every derived table, including FTS shadows, needs an exact exported role.");
  const tables = names.map(name => base.tables.find(table => table.name === name) ?? { name, role: "derived" });
  for (const table of base.tables) {
    if (table.role === "seed") assert.equal(bootstrapTableRows(db, table.name), table.rows);
    if (table.role === "empty") assert.equal(bootstrapTableRows(db, table.name), "[]");
  }
  return { databaseVersion: base.databaseVersion, schemaSha256: bootstrapSchemaHash(db), tables };
}
async function observeOwnerOnly(directory) {
  const workspace = join(directory, "owner-only");
  await initialize(workspace);
  const owner = await RootOwner.acquire(workspace);
  try {
    const db = owner.connectNative();
    try {
      db.exec(STORAGE_OWNER_DDL);
      owner.acquireWorkspaceLease();
      return await observeDerived(db, owner, workspace, {
        databaseVersion: 0, tables: [{ name: "native_runtime_owner", role: "owner" }],
      });
    } finally { db.close(); }
  } finally { await owner.close(); }
}
export async function generateBootstrapProfile({ check = false } = {}) {
  const directory = join(root, ".migration-test-work", `root-owner-profile-${randomUUID()}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const sourceFiles = await bootstrapSourceFiles();
    const first = join(directory, "first"), second = join(directory, "second");
    await mkdir(first, { mode: 0o700 });
    await mkdir(second, { mode: 0o700 });
    const observation = await observe(first);
    assert.deepEqual(await observe(second), observation, "Canonical schema/bootstrap seeds must be reproducible across actual independent full initializations.");
    const ownerOnly = await observeOwnerOnly(directory);
    assert.deepEqual(await bootstrapSourceFiles(), sourceFiles, "Canonical sources changed during profile generation.");
    const db = new DatabaseSync(":memory:");
    let ownerSchemaSha256;
    try { db.exec(STORAGE_OWNER_DDL); ownerSchemaSha256 = bootstrapSchemaHash(db); }
    finally { db.close(); }
    const profile = { schema: "pkm.storage-bootstrap-profile/v1", sourceSha256: bootstrapHash(JSON.stringify(sourceFiles)),
      sourceFiles, ...observation.base, ownerSchemaSha256, derivedProfiles: [observation.derived, ownerOnly] };
    const json = JSON.stringify(profile);
    const generated = "// Generated from actual canonical Storage.open; do not edit migration SQL here.\n"
      + `export const STORAGE_BOOTSTRAP_PROFILE_JSON = ${JSON.stringify(json)};\n`
      + `export const STORAGE_BOOTSTRAP_PROFILE_SHA256 = ${JSON.stringify(bootstrapHash(json))};\n`;
    if (check) assert(await readFile(output, "utf8") === generated, "Storage bootstrap profile is stale; rebuild then regenerate it.");
    else await writeFile(output, generated);
    return { sourceFiles: sourceFiles.length, tables: observation.base.tables.length, schemaSha256: observation.base.schemaSha256,
      sourceSha256: profile.sourceSha256 };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  assert(process.argv.slice(2).every(arg => arg === "--check"), "Usage: node scripts/generate-storage-bootstrap-profile.mjs [--check]");
  console.log(JSON.stringify(await generateBootstrapProfile({ check: process.argv.includes("--check") })));
}

import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import ts from "typescript";
import { inspectLegacyProtectedSnapshotFixture } from "../dist/legacy-protected-snapshot-fixture.js";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "../legacy");
async function original() {
  const text = await readFile(join(project, "src/subscriptions/subscriptions.ts"), "utf8");
  const file = ts.createSourceFile("subscriptions.ts", text, ts.ScriptTarget.Latest, true);
  const names = ["hash", "deriveSecretKeys", "encryptSnapshot", "unique", "tagsOf"];
  const declarations = names.map(name => file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)?.getText(file));
  assert(declarations.every(Boolean));
  const typeNames = file.statements.find(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(item => item.name.getText(file) === "SHARED_CONTENT_TYPES")).getText(file);
  const cls = file.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "SharedMarketManager");
  const method = cls.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(file) === "buildSummary").getText(file);
  const program = `${typeNames}\n${declarations.join("\n")}\nclass Original {state; constructor(privateKey) {this.state={privateKey};} ${method} }\nglobalThis.original={hash,deriveSecretKeys,encryptSnapshot,Original};`;
  const output = ts.transpileModule(program, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const sandbox = { ...crypto, Buffer, exports: {} };
  runInNewContext(output, sandbox);
  return sandbox.original;
}
async function fixture() {
  const legacy = await original(), pair = crypto.generateKeyPairSync("ed25519");
  const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const secret = crypto.randomBytes(32).toString("base64url"), salt = crypto.randomBytes(16).toString("base64url");
  const keys = legacy.deriveSecretKeys(secret, salt);
  const bundle = { from: "Synthetic fixture", created_at: "", version: "3",
    notes: [{ slug: "Private/Fixture", content: "# Synthetic shared knowledge\n" }] };
  const plaintext = Buffer.from(JSON.stringify(bundle));
  const ciphertext = legacy.encryptSnapshot(plaintext, keys.contentKey);
  const manager = new legacy.Original(privateKey);
  const summary = manager.buildSummary("synthetic-share", "Synthetic", 1, ciphertext, bundle, true, salt);
  const binding = { root: "/private/fixture/knowledge", profile: "/private/fixture/profile",
    nodeId: crypto.createHash("sha256").update(publicKey).digest("hex"), shareId: "synthetic-share",
    revision: 1, publicKey, secretSalt: salt, authVerifier: keys.authVerifier.toString("base64url"),
    plaintextHash: legacy.hash(plaintext), summary };
  keys.authVerifier.fill(0); keys.contentKey.fill(0);
  let allowed = true, supplied = secret, calls = 0, issued;
  const authority = {
    async authorize(candidate) {
      calls++;
      return allowed && candidate.root === binding.root && candidate.profile === binding.profile
        && candidate.nodeId === binding.nodeId && candidate.shareId === binding.shareId;
    },
    async secret() { issued = supplied === undefined ? undefined : Buffer.from(supplied); return issued; },
  };
  return { binding, ciphertext, secret, authority, manager, bundle,
    setSecret(value) { supplied = value; }, revoke() { allowed = false; },
    get calls() { return calls; }, get issued() { return issued; } };
}
test("actual legacy crypto and signed summary validate without persisting or returning credentials", async () => {
  const f = await fixture();
  const result = await inspectLegacyProtectedSnapshotFixture(f.binding, f.ciphertext, f.authority);
  assert.deepEqual(result, { plaintextSha256: f.binding.plaintextHash, itemCount: 1 });
  assert.equal(f.calls, 2);
  assert(f.issued.every(byte => byte === 0));
  assert(!JSON.stringify(result).includes(f.secret));
  assert(!JSON.stringify(result).includes("Synthetic shared knowledge"));
});
test("wrong or missing secret, altered identity, ciphertext, and revoked authority fail closed", async () => {
  const f = await fixture();
  f.setSecret("wrong-secret");
  await assert.rejects(inspectLegacyProtectedSnapshotFixture(f.binding, f.ciphertext, f.authority), { code: "SNAPSHOT_DENIED" });
  assert(f.issued.every(byte => byte === 0));
  f.setSecret(undefined);
  await assert.rejects(inspectLegacyProtectedSnapshotFixture(f.binding, f.ciphertext, f.authority), { code: "SNAPSHOT_DENIED" });
  f.setSecret(f.secret);
  for (const binding of [{ ...f.binding, nodeId: "0".repeat(64) }, { ...f.binding, root: "/other" },
    { ...f.binding, shareId: "another-share" }, { ...f.binding, secretSalt: crypto.randomBytes(16).toString("base64url") }])
    await assert.rejects(inspectLegacyProtectedSnapshotFixture(binding, f.ciphertext, f.authority), { code: "SNAPSHOT_DENIED" });
  const tampered = Buffer.from(f.ciphertext); tampered[30] ^= 1;
  await assert.rejects(inspectLegacyProtectedSnapshotFixture(f.binding, tampered, f.authority), { code: "SNAPSHOT_DENIED" });
  f.revoke();
  await assert.rejects(inspectLegacyProtectedSnapshotFixture(f.binding, f.ciphertext, f.authority), { code: "SNAPSHOT_DENIED" });
});
test("authenticated ciphertext corruption and revocation during secret retrieval fail closed", async () => {
  const f = await fixture();
  const envelope = JSON.parse(f.ciphertext.toString("utf8"));
  const tag = Buffer.from(envelope.tag, "base64url"); tag[0] ^= 1;
  envelope.tag = tag.toString("base64url");
  const wire = Buffer.from(JSON.stringify(envelope));
  const summary = f.manager.buildSummary(f.binding.shareId, "Synthetic", 1, wire, f.bundle, true, f.binding.secretSalt);
  await assert.rejects(inspectLegacyProtectedSnapshotFixture({ ...f.binding, summary }, wire, f.authority), { code: "SNAPSHOT_DENIED" });
  assert(f.issued.every(byte => byte === 0));
  await assert.rejects(inspectLegacyProtectedSnapshotFixture({ ...f.binding, plaintextHash: `sha256:${"0".repeat(64)}` },
    f.ciphertext, f.authority), { code: "SNAPSHOT_DENIED" });
  const authority = {
    authorize: f.authority.authorize,
    async secret(binding, signal) { const result = await f.authority.secret(binding, signal); f.revoke(); return result; },
  };
  await assert.rejects(inspectLegacyProtectedSnapshotFixture(f.binding, f.ciphertext, authority), { code: "SNAPSHOT_DENIED" });
  assert(f.issued.every(byte => byte === 0));
});
test("caller mutation during authority suspension cannot replace the verified summary", async () => {
  const f = await fixture();
  const original = f.authority.authorize;
  f.authority.authorize = async binding => {
    f.binding.summary.counts.notes = 999;
    return original(binding);
  };
  const result = await inspectLegacyProtectedSnapshotFixture(f.binding, f.ciphertext, f.authority);
  assert.equal(result.itemCount, 1);
  assert(f.issued.every(byte => byte === 0));
});

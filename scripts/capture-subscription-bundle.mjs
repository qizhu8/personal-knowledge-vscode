import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const original = resolve(root, "legacy");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const specifications = [
  ["src/subscriptions/subscriptions.ts", ["hash", "deriveSecretKeys", "encryptSnapshot", "nodeIdForPublicKey", "withoutSignature", "verifyShareSummary"]],
  ["src/subscriptions/subscription-materialize-worker.ts", ["decryptTransfer", "decryptSnapshot"]],
  ["src/subscriptions/subscription-fork.ts", ["forkPackage", "safeTarget", "relativeDisplay"]],
];
const files = [];
const functions = [];
for (const [source, names] of specifications) {
  const bytes = await readFile(resolve(original, source));
  const tree = ts.createSourceFile(source, bytes.toString(), ts.ScriptTarget.Latest, true);
  for (const name of names) {
    const node = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    if (!node) throw new Error(`Original function missing: ${name}`);
    functions.push(node.getText(tree).replace(/^(?:export )?function /, "export function "));
  }
  files.push({ source, sourceSha256: hash(bytes), functions: names });
}
const captured = "src/domain/subscription-bundle-original.ts";
const text = "// @ts-nocheck\n// Generated executable original cryptographic helpers; regenerate with capture-subscription-bundle.mjs.\n"
  + "import { createHash, createHmac, scryptSync, randomBytes, createCipheriv, createDecipheriv, verify } from 'node:crypto';\n"
  + "import * as fs from 'node:fs';\nimport * as path from 'node:path';\n"
  + ts.transpileModule(functions.join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ES2022 } }).outputText;
await writeFile(resolve(root, captured), text);
const references = await Promise.all([
  "src/subscriptions/subscription-gateway-entry.ts", "src/sync/sync-server.ts", "src/knowledge/storage.ts",
].map(async source => ({ source, sourceSha256: hash(await readFile(resolve(original, source))) })));
const native = await Promise.all([
  "src/subscription-bundle.ts", "src/domain/subscription-bundle-validation.ts", "src/domain/subscription-bundle-staging.ts",
  "src/subscription-bundle-apply.ts", "src/subscription-bundle-apply-files.ts", "src/subscription-bundle-apply-contracts.ts",
  "tests/subscription-bundle-apply.test.mjs",
  "tests/subscription-bundle.test.mjs", "scripts/capture-subscription-bundle.mjs",
].map(async file => ({ file, sha256: hash(await readFile(resolve(root, file))) })));
await writeFile(resolve(root, "migration/subscription-bundle-provenance.json"), JSON.stringify({
  schema: "pkm.domain-capture/v1", files, sourceReferences: references, captured, capturedSha256: hash(text), native,
  formats: {
    snapshot: "Original v:1 alg:A256GCM JSON with base64url iv(12), ciphertext, tag(16), AES-256-GCM.",
    transfer: "Original PKMENC1\\n + IV(12) + ciphertext + tag(16), AES-256-GCM.",
    keys: "Original scrypt(secret,base64url salt,32); HMAC-SHA256 pkm-share-auth:v1 / pkm-share-content:v1.",
    transferKey: "Original HMAC(authVerifier, pkm-transfer:v1:subscriberNodeId:shareId:revision:actualPort:ticket); native resolver owns tickets.",
    signature: "Original verify(null, JSON.stringify(summary without signature), publisher publicKey, base64url signature).",
    package: "Original version:'3' JSON package name/files path/content; UTF-8 files, not a compressed archive.",
  },
  qualification: "Runtime-generated synthetic keys only. No sockets/native secrets/broker. Native epoch and policy revision are host fences, NOT original wire fields. In-memory verified extraction plus ephemeral no-follow staging under exclusively host-owned non-group/world-writable root; concurrent same-user ancestor renames are outside the root contract (Node lacks openat). Open Markdown can use existing SubscriptionApplyHost; encrypted Markdown/assets/packages use SubscriptionBundleApplyHost with a separate authenticated ciphertext/plaintext/native grant binding, strict serialized GLOBAL journal intent and ordered recognized-before/after recovery. Original source collectionHash is NEVER replaced by plaintext. Integration must inject the shared GLOBAL workspace cross-process writer lock, unique opId transaction/intent CAS/receipt/identity/package reservations and native authenticated grant/ACL/secret-epoch policy lookup; no shared production DB/API was edited or fake private package journal installed. Versions other than original JSON v3, other nonempty content kinds and archives fail closed. Original package fork executed for byte/identity/provenance comparison, never a production write adapter. Source references are inspection only, not executable lineage.",
}, null, 2) + "\n");
for (const item of [...files, ...references]) {
  if (hash(await readFile(resolve(original, item.source))) !== item.sourceSha256) throw new Error("Original source changed during capture.");
}
console.log("Captured original subscription bundle crypto and source pins.");

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import ts from "typescript";

const nextRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const originalRoot = resolve(nextRoot, "legacy");
const hash = value => createHash("sha256").update(value).digest("hex");
const source = "src/subscriptions/subscriptions.ts";
const bytes = await readFile(resolve(originalRoot, source));
const tree = ts.createSourceFile(source, bytes.toString(), ts.ScriptTarget.Latest, true);
const names = ["hash", "nodeIdForPublicKey", "withoutSignature", "verifyShareSummary"];
const functions = names.map(name => {
  const node = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (!node) throw new Error(`Missing original ${name}`);
  return node.getText(tree);
});
const captured = "src/domain/subscription-transport-original-summary.ts";
const text = "// @ts-nocheck\n// Repeatable original executable signature verification capture.\nimport { createHash, verify } from 'node:crypto';\n"
  + ts.transpileModule(functions.join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ES2022 } }).outputText;
await writeFile(resolve(nextRoot, captured), text);
const sources = [source, "src/subscriptions/subscription-gateway-entry.ts", "src/subscriptions/subscription-mqtt-client.ts",
  "src/subscriptions/subscription-materialize-worker.ts", "src/subscriptions/subscription-fork.ts",
  "src/subscriptions/subscription-acl.ts", "src/subscriptions/subscription-ip-policy.ts"];
const sourcePins = await Promise.all(sources.map(async source => ({ source, sourceSha256: hash(await readFile(resolve(originalRoot, source))) })));
const files = [{ ...sourcePins[0], captured, capturedSha256: hash(text), functions: names }];
// Protocol/policy inspection is not executable lineage for the native socket/staging implementation.
const sourceReferences = sourcePins.slice(1);
const implementationPaths = [
  "src/subscription-transport.ts", "src/subscription-transport-contracts.ts",
  "src/domain/subscription-transport-protocol.ts", "src/domain/subscription-transport-socket.ts", "src/domain/subscription-transport-staging.ts",
  "tests/subscription-transport.test.mjs", "tests/subscription-transport-fixtures.mjs",
  "scripts/capture-subscription-transport.mjs",
];
const native = await Promise.all(implementationPaths.map(async file => ({ file, sha256: hash(await readFile(resolve(nextRoot, file))) })));
await writeFile(resolve(nextRoot, "migration/subscription-transport-provenance.json"), JSON.stringify({
  schema: "pkm.domain-capture/v1", originalRoot, nextRoot, files, sourceReferences, native,
  capture: { path: captured, sha256: hash(text), functions: names },
  protocol: {
    summary: "GET /v1/shares/{shareId}/summary: signed ShareSummary; conditional 304 is not fresh authorization.",
    ticket: "POST /v1/shares/{shareId}/sync-ticket: brokerUrl,ticket,expiresAt,revision,collectionHash",
    bundle: "GET /sync/bundle: one-use Bearer ticket; open application/json; no Range/resume protocol",
    mqtt: "pkm/v1/nodes/{nodeId}/shares/{shareId}/summary, MQTT 3.1.1 websocket: untrusted refresh hints only",
  },
  qualification: "Original signature verifier executed. HTTP socket adapter defaults disabled; all tests synthetic loopback only. Open JSON Markdown/assets supported; secret-protected encryption, package file arrays and other content kinds explicitly unsupported; original has no archive wire format. Fork delegates to SubscriptionApplyHost and preserves original Markdown IDs/aliases/bytes; distinct destination/path-derived implicit identity, not fabricated rekeying. Readonly mirror retains source identity in an immutable verified snapshot, outside writable knowledge areas. Shared global DB hooks required, no production private DB.",
}, null, 2) + "\n");
for (const item of sourcePins) if (hash(await readFile(resolve(originalRoot, item.source))) !== item.sourceSha256) throw new Error("Original changed during capture");
console.log("Captured original signed subscription summary verifier and gateway provenance.");

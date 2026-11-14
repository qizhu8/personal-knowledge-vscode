import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import ts from "typescript";

const nextRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const originalRoot = resolve(nextRoot, "legacy");
const source = "src/subscriptions/subscription-fork.ts";
const captured = "src/domain/subscription-apply-original-fork.ts";
const hash = value => createHash("sha256").update(value).digest("hex");
const original = await readFile(resolve(originalRoot, source));
const text = "// @ts-nocheck\n// Repeatable original executable capture; synthetic fixture use only.\n" + ts.transpileModule(original.toString("utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ES2022 },
}).outputText;
await writeFile(resolve(nextRoot, captured), text);
const provenance = {
  schema: "pkm.domain-capture/v1",
  transformation: "TypeScript transpileModule ES2023/ES2022, type-only dependency removed; original filesystem fork and identity-preserving byte writes executed only against synthetic disposable fixtures.",
  files: [{ source, captured, sourceSha256: hash(original), capturedSha256: hash(text) }],
  requiredDependencies: {},
  qualification: "Supplied plaintext snapshot only: no Broker, download, outbound transport or private knowledge. File forks preserve original IDs/aliases/Markdown bytes. The next workspace does not create original .gitkeep markers because its Markdown scanner rejects hidden entries. Recipes/packages are not supported by this adapter.",
};
await writeFile(resolve(nextRoot, "migration/subscription-apply-provenance.json"), JSON.stringify(provenance, null, 2) + "\n");
if (hash(await readFile(resolve(originalRoot, source))) !== provenance.files[0].sourceSha256
  || hash(await readFile(resolve(nextRoot, captured))) !== provenance.files[0].capturedSha256) throw new Error("Capture changed while pinning.");
console.log("Captured and verified original subscription file fork.");

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(root, "legacy");
const source = "src/sync/github-sync.ts";
const text = await readFile(resolve(repository, source), "utf8");
const tree = ts.createSourceFile(source, text, ts.ScriptTarget.Latest, true);
const declaration = name => {
  const nodes = tree.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (nodes.length !== 1) throw new Error(`Capture boundary changed: ${name}`);
  return nodes[0].getText(tree);
};
const version = JSON.parse(await readFile(resolve(repository, "package.json"), "utf8")).version;
const profileSource = "src/chat/persona-profiles.ts";
const profileText = await readFile(resolve(repository, profileSource), "utf8");
const profileTree = ts.createSourceFile(profileSource, profileText, ts.ScriptTarget.Latest, true);
const profileDeclarations = ["PersonaProfile", "PersonaResponseStyle", "idValid", "fields", "responseStyleKeys", "recordKeys", "validResponseStyle", "validatePersona", "portablePersonaPath"].map(name => {
  const nodes = profileTree.statements.filter(node =>
    (ts.isInterfaceDeclaration(node) || ts.isFunctionDeclaration(node)) ? node.name?.text === name
      : ts.isVariableStatement(node) && node.declarationList.declarations.some(item => item.name.getText(profileTree) === name));
  if (nodes.length !== 1) throw new Error(`Profile capture boundary changed: ${name}`);
  return nodes[0].getText(profileTree);
});
const output = `// Captured publication wire serialization; REST transport is a new, disabled adapter.
type GitHubSyncManagedFile = {
  path: string; type: string; itemId: string; member: string; category: string; privacy: "public" | "private"; digest: string;
  content?: unknown; sourceDigest?: unknown; rawSnapshot?: unknown; sourceLocator?: unknown; baseIntegrityEvidence?: unknown;
};
type GitHubSyncDeletionEvidence = { type: string; itemId: string; deletedAt: string; category?: string; privacy?: "public" | "private" };
const GITHUB_SYNC_MANIFEST_SCHEMA = 3;
export const GITHUB_SYNC_EXTENSION_VERSION = ${JSON.stringify(version)};
const GITHUB_SYNC_REQUIRED_CAPABILITIES = ["explicit-deletions", "stable-entity-identity"] as const;
const GITHUB_SYNC_SUPPORTED_CAPABILITIES = new Set<string>([...GITHUB_SYNC_REQUIRED_CAPABILITIES, "entity-partial-progress", "action-library-assets", "profile-cards"]);
export const MANIFEST_PATH = ".pkm-github-sync.json";

${declaration("manifestJson")}

${profileDeclarations.join("\n\n")}
`;
const hash = value => createHash("sha256").update(value).digest("hex");
const provenance = JSON.stringify({
  schema: "pkm.domain-capture/v1",
  actualRootSha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim(),
  transformation: "Exact AST capture of manifestJson and private Profile validation/path helpers with literal version/constants and type-only substitutions. Original transport is Git CLI force-with-lease, not REST. New REST adapter requires native expected-commit CAS authority; no production cutover or network default.",
  files: [{ source, sourceSha256: hash(text), captured: "src/domain/sync-transport-original.ts", capturedSha256: hash(output) },
    { source: profileSource, sourceSha256: hash(profileText), captured: "src/domain/sync-transport-original.ts", capturedSha256: hash(output) }],
  inspectedSources: await Promise.all(["src/sync/github-sync-publication-plan.ts", "src/sync/github-sync-recovery.ts", "src/sync/github-sync-credentials.ts", "src/sync/github-sync-profiles.ts", "next-server/src/sync-plan.ts", "next-server/src/sync-apply.ts"].map(async path => ({
    path, sha256: hash(await readFile(resolve(repository, path))),
  }))),
}, null, 2) + "\n";
if (process.argv.slice(2).some(arg => arg !== "--check")) throw new Error("Usage: capture-sync-transport.mjs [--check]");
for (const [path, value] of [["src/domain/sync-transport-original.ts", output], ["migration/sync-transport-provenance.json", provenance]]) {
  if (process.argv.includes("--check")) {
    if (await readFile(resolve(root, path), "utf8") !== value) throw new Error(`Capture differs: ${path}`);
  } else await writeFile(resolve(root, path), value);
}

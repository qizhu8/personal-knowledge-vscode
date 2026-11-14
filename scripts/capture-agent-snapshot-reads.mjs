import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(root, "legacy");
const source = "src/agent-sessions/agent-snapshots.ts";
const runtime = "resources/agent_session_runtime.py";
const regression = "tests/test-agent-session-mcp-runtime.py";
const hash = value => createHash("sha256").update(value).digest("hex");
const text = await readFile(resolve(repository, source), "utf8");
const parsed = ts.createSourceFile(source, text, ts.ScriptTarget.Latest, true);
const names = ["AgentSnapshotSummary", "AgentSnapshotContents", "snapshotCapture", "snapshotSummary"];
const declarations = names.map(name => {
  const matches = parsed.statements.filter(node => node.name?.text === name);
  if (matches.length !== 1) throw new Error(`Snapshot capture boundary changed: ${name}`);
  return matches[0].getText(parsed).replace(/^function /, "export function ");
});
const original = "src/domain/agent-snapshot-reads-original.ts";
await writeFile(resolve(root, original), `// Pure original Snapshot contracts and summary rules; regenerate with capture-agent-snapshot-reads.mjs.\n${declarations.join("\n\n")}\n`);
const runtimeText = await readFile(resolve(repository, runtime), "utf8");
const functions = ["_snapshot_capture", "_snapshot_summary", "_snapshot_text", "_snapshot_read_projection"];
const projection = functions.map(name => {
  const match = runtimeText.match(new RegExp(`^def ${name}\\([^]*?(?=^def |\\s*$)`, "m"));
  // Boundaries are top-level definitions, not blank lines within a function.
  const start = runtimeText.indexOf(`def ${name}(`);
  if (!match || start < 0) throw new Error(`Snapshot runtime capture boundary changed: ${name}`);
  const next = runtimeText.indexOf("\ndef ", start + 1);
  return runtimeText.slice(start, next < 0 ? undefined : next).trimEnd();
}).join("\n\n");
const regressionTarget = "tests/agent-snapshot-reads-original.mjs";
await writeFile(resolve(root, regressionTarget),
  `// Captured pure Python projection and original regression source; no host registration is executed.\n`
  + `export const originalProjection = ${JSON.stringify("SESSION_SUMMARY_CHARACTER_LIMIT = 1000\n\n" + projection)};\n`
  + `export const originalRegressionSource = ${JSON.stringify(await readFile(resolve(repository, regression), "utf8"))};\n`);
const mappings = [
  [source, original], [runtime, regressionTarget], [regression, regressionTarget],
  [runtime, "src/domain/agent-snapshot-reads-projection.ts"],
  [source, "src/agent-snapshot-reads-contracts.ts"], [source, "src/agent-snapshot-reads.ts"],
  [regression, "tests/agent-snapshot-reads.test.mjs"],
  [regression, "tests/agent-snapshot-reads-fixtures.mjs"],
];
const files = await Promise.all(mappings.map(async ([source, captured]) => ({
  source, captured, sourceSha256: hash(await readFile(resolve(repository, source))),
  capturedSha256: hash(await readFile(resolve(root, captured))),
})));
await writeFile(resolve(root, "migration/agent-snapshot-reads-provenance.json"), JSON.stringify({
  schema: "pkm.next.domain-capture/v1",
  notes: "Immutable read port; original automatic encryption migration intentionally unavailable. Magic Code is an identifier, not authentication. Python oracle is pure projection only; regression source is captured as text, never executed.",
  files,
}, null, 2) + "\n");

import { readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(packageRoot, "legacy");
export const hash = value => createHash("sha256").update(value).digest("hex");
// Authentication datasets are not native implementation qualifications. In particular,
// compiler-candidate-432 retains its immutable UNQUALIFIED provenance marker.
const originalArchive = {
  path: "migration/evidence/action-authentication-originals.zip",
  sha256: "42aa101cdd1601caeda9e5213a1b0995abdbdec76d6997908f31d2879c295552",
};
const knowledgeArchive = {
  path: "migration/evidence/knowledge-authentication-originals.zip",
  sha256: "700e32a19db9fa4dec300d0e8e0ea218b0a67856dee37baebce27f608af36d74",
};
const runtimeArchive = {
  path: "migration/evidence/runtime-authentication-originals.zip",
  sha256: "1993f0e5070d748237ccba13a3fea70cdcc3a26a2e8f6db509d4e9dd7649ef82",
};
const candidateOriginalArchive = {
  path: "migration/evidence/linux-candidate-source-originals.zip",
  sha256: "2215bb438c49defba69ff65b16d9075fb7a1d67425b6fb9493b5c89823a498dd",
};
const runtimeMembers = Object.fromEntries([
  ["tests/test-api-chat.js", "5e137991a892"],
  ["src/runtime/pkm-service.ts", "663a189e3966"],
  ["src/retrieval/retrieval-worker.ts", "a7235794858f"],
  ["resources/retrieval_worker.py", "3c51c84d821e"],
  ["src/workflows/project-model.ts", "505f56e2351a"],
  ["resources/recipe_runtime.py", "8fb3baf4e7f7"],
].map(([path, generation]) => [`source:${path}`, `${generation}/source/${path}`]));
const knowledgeMembers = Object.fromEntries([
  "src/knowledge/filestore.ts", "src/knowledge/markdown-assets.ts",
  "tests/test-note-work-item-lifecycle.js", "next-server/src/domain/note-work-items.ts",
  "resources/knowledge_mutations.py", "tests/test-markdown-owned-assets.js",
].map(path => [`source:${path}`, `knowledge-historical-c5c3a9/source/${path}`]));
const authenticationDatasets = {
  ...Object.fromEntries([
    "chat-turn", "model-provider", "runtime-process", "workflow-compiler", "workflow-executor",
  ].map(name => [`runtime-${name}-historical`, {
    manifest: `${name}-provenance.json`, archive: runtimeArchive, archived: runtimeMembers,
  }])),
  "runtime-retrieval-evidence-historical": {
    evidenceManifest: "retrieval-runtime-provenance.json",
    archive: runtimeArchive,
    archived: runtimeMembers,
  },
  ...Object.fromEntries([
    "document-lifecycle", "folder-lifecycle", "resource-lifecycle", "trash-lifecycle", "knowledge-mutations",
  ].map(name => [`knowledge-${name}-historical`, {
    manifest: `${name}-provenance.json`, archive: knowledgeArchive, archived: knowledgeMembers,
  }])),
  "knowledge-inline-note-historical": {
    sourcePins: "src/legacy-inline-note-contracts.ts",
    archive: knowledgeArchive,
    archived: knowledgeMembers,
  },
  "knowledge-mutations-producer-historical": {
    producerManifest: "knowledge-mutations-provenance.json",
    archive: knowledgeArchive,
    archived: {
      "source:scripts/capture-knowledge-mutations.mjs": "knowledge-producer-c472d0/source/scripts/capture-knowledge-mutations.mjs",
    },
  },
  "compiler-candidate-432": {
    manifest: "action-compiler-provenance.json",
    archived: { "source:resources/action_modules.py": "compiler-candidate-432/source/resources/action_modules.py" },
  },
  "runtime-historical-3d": {
    records: [{
      source: "src/components/action-components.ts",
      sourceSha256: "8aeb4f1c2d34d1bbbdc8956689fe0b6f9cc10512a3be6e294d8d3ed5e7068d28",
      captured: "src/domain/action-compiler-original.ts",
      capturedSha256: "3d9241d1d182f3066afe092cfe566d5b49f2b0e719cbe177b1435d1f589e06bc",
    }],
    archived: { "captured:src/domain/action-compiler-original.ts": "runtime-historical-3d/source-capture/src/domain/action-compiler-original.ts" },
  },
  "approval-historical-71ddd": {
    manifest: "approval-bridge-provenance.json",
    archived: { "source:src/chat/api-chat-view.ts": "approval-historical-71ddd/source/src/chat/api-chat-view.ts" },
  },
  "action-mcp-release-4.0.22": {
    records: [{
      source: "resources/action_modules.py",
      sourceSha256: "8b939ae9a2de32c5cc0e99538c8ff5722f3a9c7f6f69bd169baf3675788c2a55",
    }, {
      source: "resources/action_run_store.py",
      sourceSha256: "ae79232105b21940f0addc26f1fc28a125a158ec60af7558d374f3f16531c479",
    }],
    archived: { "source:resources/action_modules.py": "action-mcp-release-4.0.22/source/resources/action_modules.py" },
  },
  "knowledge-mcp-release-4.0.22": {
    records: [{
      source: "resources/action_runtime.py",
      sourceSha256: "be8823458bc20b4e095b62f2b8a8208a101bc6da6158f7a0b7e449609802d19f",
    }],
    archived: { "source:resources/action_runtime.py": "knowledge-mcp-release-4.0.22/source/resources/action_runtime.py" },
  },
};
const manifestDatasets = {
  ...Object.fromEntries([
    "chat-turn", "model-provider", "runtime-process", "workflow-compiler", "workflow-executor",
  ].map(name => [`${name}-provenance.json`, `runtime-${name}-historical`])),
  "action-compiler-provenance.json": "compiler-candidate-432",
  "approval-bridge-provenance.json": "approval-historical-71ddd",
  ...Object.fromEntries([
    "document-lifecycle", "folder-lifecycle", "resource-lifecycle", "trash-lifecycle", "knowledge-mutations",
  ].map(name => [`${name}-provenance.json`, `knowledge-${name}-historical`])),
};
function evidenceError(reason, message) {
  return Object.assign(new Error(message), { evidenceReason: reason });
}
function resolveInside(root, path) {
  const full = resolve(root, path);
  const local = relative(resolve(root), full);
  if (!local || local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) {
    throw new Error(`Capture provenance path escapes its declared root: ${path}`);
  }
  return full;
}
function captureRecords(metadata) {
  return Array.isArray(metadata.files) ? metadata.files.map(record => record.captured !== undefined ? record : {
    ...record,
    captured: metadata.capture?.path ?? metadata.captured,
    capturedSha256: metadata.capture?.sha256 ?? metadata.capturedSha256,
  }) : Array.isArray(metadata.captures) ? metadata.captures.map(record => ({
    source: record.source,
    captured: record.destination,
    sourceSha256: record.sourceSha256,
    capturedSha256: record.captureSha256,
  })) : [];
}
let candidateInputs;
async function nativeExpectation(path, expected, root, kind) {
  const qualification = process.env.PKM_TEST_QUALIFICATION;
  if (!qualification) return expected;
  if (qualification !== "linux-candidate") throw new Error("Unknown explicit test qualification.");
  if (resolve(root) !== packageRoot) return expected;
  candidateInputs ??= (async () => {
    const metadata = JSON.parse(await readFile(resolve(packageRoot, "migration/linux-candidate-inputs.json"), "utf8"));
    if (metadata.schema !== "pkm.linux-candidate-inputs/v1"
      || metadata.scope !== "isolated-linux-pkm-v5-candidate-not-production-or-windows"
      || metadata.status !== "unverified-input-snapshot"
      || !Array.isArray(metadata.files) || !Array.isArray(metadata.historicalManifests)) {
      throw new Error("Malformed Linux candidate input snapshot.");
    }
    for (const pin of metadata.historicalManifests) {
      if (hash(await readFile(resolveInside(packageRoot, pin.file))) !== pin.sha256) {
        throw new Error(`Historical manifest changed after candidate preparation: ${pin.file}`);
      }
    }
    return metadata;
  })();
  const metadata = await candidateInputs;
  const pin = metadata.files.find(pin => pin.file === path
    && pin.historical.some(row => row.sha256 === expected && row.role === kind));
  if (!pin) return expected;
  if (!/^[a-f0-9]{64}$/.test(pin.sha256)) throw new Error(`Invalid candidate digest: ${path}`);
  return pin.sha256;
}
async function readArchiveMember(archive, member, archiveSha256) {
  if (!member || member.includes("\\") || member.includes(":") || member.includes("\0")
    || member.startsWith("/") || member.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error(`Invalid capture archive member path: ${member}`);
  }
  if (!/^[a-f0-9]{64}$/.test(archiveSha256 ?? "")) throw new Error("Archive authentication requires its SHA256.");
  const info = await stat(archive);
  if (!info.isFile() || info.size > 64 * 1024 * 1024) throw new Error("Capture archive is not a bounded regular file.");
  const bytes = await readFile(archive);
  if (hash(bytes) !== archiveSha256) throw evidenceError("archive-hash-changed", "Capture archive SHA256 changed.");
  const result = spawnSync("python", ["-I", "-B", "-c", `
import io,stat,sys,zipfile
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as archive:
 matches=[info for info in archive.infolist() if info.filename==sys.argv[1]]
 if not matches: sys.exit(4)
 if len(matches)!=1: raise ValueError("Duplicate capture archive member")
 info=matches[0]
 if info.is_dir() or stat.S_IFMT(info.external_attr>>16) not in (0,stat.S_IFREG) or info.file_size>16*1024*1024:
  raise ValueError("Capture member is not a bounded regular file")
 sys.stdout.buffer.write(archive.read(info))
`, member], { input: bytes, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status === 4) throw evidenceError("missing", `Capture archive member is missing: ${member}`);
  if (result.status !== 0) throw evidenceError("invalid-archive",
    `Invalid capture archive member ${member}: ${result.stderr.toString("utf8").slice(-2048)}`);
  return result.stdout;
}
export async function readOriginalSource(path, {
  root, kind = "source", sha256, archiveSha256, dataset,
} = {}) {
  if (!["source", "captured"].includes(kind) || !/^[a-f0-9]{64}$/.test(sha256 ?? "")
    || typeof path !== "string" || !path || isAbsolute(path) || path.includes("\0")) {
    throw new Error("Malformed original-source byte request.");
  }
  root ??= kind === "source" ? repository : packageRoot;
  if (dataset === "linux-candidate-originals") {
    if (kind !== "source") throw evidenceError("generation-mismatch", "Candidate originals contain source bytes only.");
    const metadata = JSON.parse(await readFile(resolve(packageRoot, "migration/evidence/linux-candidate-source-originals.json"), "utf8"));
    if (metadata.members.some(row => row.path === path && row.sha256 === sha256)) {
      return readOriginalSource(`${candidateOriginalArchive.path}!/${sha256}/source/${path}`, {
        root: packageRoot, kind, sha256, archiveSha256: candidateOriginalArchive.sha256,
      });
    }
    dataset = undefined;
  }
  if (dataset !== undefined) {
    if (!Object.hasOwn(authenticationDatasets, dataset)) throw new Error("Unknown authentication dataset.");
    const binding = authenticationDatasets[dataset];
    let records = binding.manifest
      ? captureRecords(JSON.parse(await readFile(resolve(packageRoot, "migration", binding.manifest), "utf8"))) : binding.records;
    if (binding.evidenceManifest) {
      records = JSON.parse(await readFile(resolve(packageRoot, "migration", binding.evidenceManifest), "utf8")).sourceEvidence;
    }
    if (binding.producerManifest) {
      const { script } = JSON.parse(await readFile(resolve(packageRoot, "migration", binding.producerManifest), "utf8"));
      records = [{ source: script?.path, sourceSha256: script?.sha256 }];
    }
    if (binding.sourcePins) {
      const text = await readFile(resolve(packageRoot, binding.sourcePins), "utf8");
      const ast = ts.createSourceFile(binding.sourcePins, text, ts.ScriptTarget.Latest, true);
      const declaration = ast.statements.filter(ts.isVariableStatement)
        .flatMap(statement => [...statement.declarationList.declarations])
        .find(node => node.name.getText(ast) === "legacyInlineNoteSourcePins");
      const pins = declaration?.initializer;
      if (!pins || !ts.isCallExpression(pins) || pins.expression.getText(ast) !== "Object.freeze"
        || pins.arguments.length !== 1 || !ts.isObjectLiteralExpression(pins.arguments[0])) {
        throw new Error("Malformed inline-note source pin binding.");
      }
      records = pins.arguments[0].properties.map(property => {
        if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.name)
          || !ts.isStringLiteral(property.initializer)) throw new Error("Malformed inline-note source pin.");
        return { source: property.name.text, sourceSha256: property.initializer.text };
      });
    }
    if (!records.some(record => record[kind] === path && record[`${kind}Sha256`] === sha256)) {
      throw evidenceError("generation-mismatch", `No exact ${dataset}/${kind}/${path} digest binding.`);
    }
    const member = binding.archived[`${kind}:${path}`];
    if (member) {
      const archive = binding.archive ?? originalArchive;
      path = `${archive.path}!/${member}`;
      root = packageRoot;
      archiveSha256 = archive.sha256;
    }
  }
  const parts = path.split("!/");
  if (parts.length > 2) throw new Error("Malformed capture archive path.");
  const full = resolveInside(root, parts[0]);
  const actualRoot = await realpath(root), actualPath = await realpath(full);
  resolveInside(actualRoot, relative(actualRoot, actualPath));
  const bytes = parts.length === 2 ? await readArchiveMember(actualPath, parts[1], archiveSha256) : await readFile(actualPath);
  if (hash(bytes) !== sha256) throw evidenceError("hash-changed", `Original ${kind} bytes changed: ${path}`);
  return bytes;
}
export async function checkCaptureRecords(records, sourceRoot = repository, capturedRoot = packageRoot, { dataset } = {}) {
  const issues = [];
  for (const record of records) {
    if (!record || typeof record !== "object"
      || ![record.source, record.captured].every(value => typeof value === "string" && value.length > 0)
      || ![record.sourceSha256, record.capturedSha256].every(value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value))) throw new Error("Malformed domain-capture provenance.");
    for (const [kind, root, path, expected] of [
      ["source", sourceRoot, record.source, record.sourceSha256],
      ["captured", capturedRoot, record.captured, record.capturedSha256],
    ]) {
      try {
        const archived = dataset && authenticationDatasets[dataset]?.archived[`${kind}:${path}`];
        const qualified = kind === "captured" && !archived
          ? await nativeExpectation(path, expected, root, kind) : expected;
        await readOriginalSource(path, {
          root, kind, sha256: qualified,
          dataset: kind === "source" && resolve(root) === repository
            && process.env.PKM_TEST_QUALIFICATION === "linux-candidate"
            ? "linux-candidate-originals" : qualified === expected ? dataset : undefined,
          archiveSha256: kind === "captured" ? record.capturedArchiveSha256 : record.archiveSha256,
        });
      } catch (error) {
        if (error.evidenceReason || error.code === "ENOENT") {
          issues.push({ kind, path, reason: error.evidenceReason ?? "missing" });
        } else throw error;
      }
    }
  }
  return issues;
}
async function checkHashRecords(records, root, kind) {
  const issues = [];
  for (const record of records) {
    if (!record || typeof record.file !== "string" || !record.file
      || typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.sha256)) {
      throw new Error(`Malformed ${kind}-pin provenance.`);
    }
    const full = resolveInside(root, record.file);
    const expected = kind === "native" ? await nativeExpectation(record.file, record.sha256, root, kind) : record.sha256;
    let actual;
    try {
      actual = hash(kind === "source" && resolve(root) === repository
        && process.env.PKM_TEST_QUALIFICATION === "linux-candidate"
        ? await readOriginalSource(record.file, { sha256: expected, dataset: "linux-candidate-originals" })
        : await readFile(full));
    } catch (error) {
      if (error.evidenceReason === "hash-changed") actual = "hash-changed";
      else if (error.code !== "ENOENT" && error.evidenceReason !== "missing") throw error;
    }
    if (actual !== expected) issues.push({
      kind, path: record.file, reason: actual === undefined ? "missing" : "hash-changed",
    });
  }
  return issues;
}
export async function checkSourceRecords(records, root = repository) {
  if (!Array.isArray(records)) throw new Error("Malformed source-only provenance.");
  return checkHashRecords(records.map(record => ({ file: record?.path, sha256: record?.sha256 })), root, "source");
}
export async function checkNativeRecords(records, root = packageRoot) {
  return checkHashRecords(records, root, "native");
}
export function checkQualificationStatus(metadata, name) {
  if (metadata.qualificationStatus === undefined) return [];
  const status = metadata.qualificationStatus;
  if (!status || typeof status !== "object" || status.state !== "unqualified"
    || typeof status.reason !== "string" || !status.reason.trim()) {
    throw new Error(`Malformed capture qualification status: ${name}`);
  }
  return [{ kind: "qualification", path: `migration/${name}`, reason: "unqualified" }];
}
export async function captureStatus() {
  const records = [];
  const captureIssues = [];
  const sourceReferences = [];
  const native = [];
  const sourceOnlyIssues = [];
  const qualificationIssues = [];
  for (const name of (await readdir(resolve(packageRoot, "migration"))).filter(file => /(?:^|-)provenance\.json$/.test(file)).sort()) {
    const metadata = JSON.parse(await readFile(resolve(packageRoot, "migration", name), "utf8"));
    qualificationIssues.push(...checkQualificationStatus(metadata, name));
    if (metadata.schema === "pkm.original-source-references/v1") {
      if (!Array.isArray(metadata.originalSources) || metadata.originalSources.length === 0) {
        throw new Error(`Malformed original-source reference provenance: ${name}`);
      }
      sourceReferences.push(...metadata.originalSources);
      continue;
    }
    if (metadata.schema === "pkm.legacy-state-import-provenance/v1") {
      if (!Array.isArray(metadata.originalSources) || metadata.originalSources.length === 0
        || !Array.isArray(metadata.nativeSeamPins) || metadata.nativeSeamPins.length === 0) {
        throw new Error(`Malformed source-only import provenance: ${name}`);
      }
      if (metadata.nativeSeamPins.some(record => typeof record?.path !== "string" || !record.path.startsWith("next-server/"))) {
        throw new Error(`Malformed next-server pin path in source-only import provenance: ${name}`);
      }
      sourceOnlyIssues.push(...await checkSourceRecords(metadata.originalSources));
      native.push(...metadata.nativeSeamPins.map(record => ({ file: record.path.slice("next-server/".length), sha256: record.sha256 })));
      continue;
    }
    if (metadata.schema === "pkm.next.native-composition/v1") {
      if (!Array.isArray(metadata.captures) || metadata.captures.length !== 0
        || !Array.isArray(metadata.implementation) || metadata.implementation.length === 0
        || !Array.isArray(metadata.reuse) || metadata.reuse.length === 0) {
        throw new Error(`Malformed native-only composition provenance: ${name}`);
      }
      native.push(...[...metadata.implementation, ...metadata.reuse].map(record => ({
        file: record.path, sha256: record.sha256,
      })));
      continue;
    }
    const entries = captureRecords(metadata);
    if (entries.length === 0) throw new Error(`Capture provenance contains no records: ${name}`);
    records.push(...entries);
    captureIssues.push(...await checkCaptureRecords(entries, repository, packageRoot, { dataset: manifestDatasets[name] }));
    if (metadata.native !== undefined) {
      if (!Array.isArray(metadata.native)) throw new Error(`Malformed native-capture provenance: ${name}`);
      native.push(...metadata.native);
    }
    if (metadata.nextServerEvidence !== undefined) {
      if (!Array.isArray(metadata.nextServerEvidence)) throw new Error(`Malformed next-server evidence provenance: ${name}`);
      native.push(...metadata.nextServerEvidence.map(record => ({
        file: record.source,
        sha256: record.sha256 ?? record.sourceSha256,
      })));
    }
  }
  const nativeQualification = JSON.parse(await readFile(resolve(packageRoot, "migration/native-qualification.json"), "utf8"));
  if (nativeQualification.schema !== "pkm.native-qualification/v1"
    || !Array.isArray(nativeQualification.native) || !nativeQualification.native.length) {
    throw new Error("Native-only qualification must contain exact implementation pins, not fabricated original-source captures.");
  }
  native.push(...nativeQualification.native);
  if (!records.length) throw new Error("No domain-capture provenance exists; qualification cannot proceed.");
  return {
    records: records.length, nativeRecords: native.length,
    sourceReferences: sourceReferences.length,
    issues: [...captureIssues, ...sourceOnlyIssues, ...qualificationIssues,
      ...await checkSourceRecords(sourceReferences), ...await checkNativeRecords(native)],
  };
}
export async function filesUnder(directory, { excludeHiddenDirectories = false } = {}) {
  const result = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    if (entry.isSymbolicLink()) continue;
    const full = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (excludeHiddenDirectories && entry.name.startsWith(".")) continue;
      result.push(...await filesUnder(full, { excludeHiddenDirectories }));
    }
    else if (entry.isFile()) result.push(full);
  }
  return result;
}
export async function implementationDigest() {
  const files = [
    ...await filesUnder(resolve(packageRoot, "src")),
    ...await filesUnder(resolve(packageRoot, "tests"), { excludeHiddenDirectories: true }),
    ...await filesUnder(resolve(packageRoot, "scripts")),
    ...(await filesUnder(resolve(packageRoot, "compat"))).filter(file => file.endsWith(".py")),
    ...["note_inventory.py", "capability_api.py", "todo_api.py", "mcp_call_guard.py", "recipe_runtime.py",
      "knowledge_mutations.py", "knowledge_mutations.js", "knowledge_recovery.py", "agent_session_runtime.py", "retrieval_worker.py",
      "retrieval_solutions.py", "retrieval_solution_resources.py", "retrieval_runtime.py",
      "retrieval_serving.py", "retrieval_solution_index.py", "retrieval-model-requirements.txt",
      "knowledge_snapshots.py", "action_modules.py", "action_run_store.py",
      "vendor/adaptive_skill_retrieval-0.3.0.dev2026100504-py3-none-any.whl"]
      .map(file => resolve(repository, "resources", file)),
    ...["registry.ts", "memory-contract.ts"].map(file => resolve(repository, "src/capabilities", file)),
    ...["src/chat/api-chat-mcp.ts", "src/mcp/mcp.ts", "src/mcp/mcp-lifecycle.ts", "src/knowledge/filestore.ts",
      "src/retrieval/retrieval-snapshot.ts", "src/retrieval/retrieval-worker.ts",
      "src/knowledge/storage.ts", "src/subscriptions/subscriptions.ts", "src/extension.ts",
      "src/knowledge/knowledge-contracts.ts", "src/knowledge/knowledge-deletion-journal.ts",
      "src/knowledge/markdown-assets.ts", "src/knowledge/note-work-items.ts", "src/knowledge/todo-board.ts",
      "src/runtime/cross-process-lock.ts",
      "dist/knowledge/filestore.js", "dist/knowledge/knowledge-contracts.js",
      "dist/knowledge/knowledge-deletion-journal.js", "dist/knowledge/markdown-assets.js",
      "dist/knowledge/note-work-items.js", "dist/knowledge/todo-board.js", "dist/runtime/cross-process-lock.js"]
      .map(file => resolve(repository, file)),
    ...await filesUnder(resolve(packageRoot, "browser")),
    ...await filesUnder(resolve(packageRoot, "clients/vscode")),
    ...(await filesUnder(resolve(packageRoot, "experimental")))
      .filter(file => /\.(?:mjs|mts|py)$/.test(file)),
    ...(await readdir(resolve(packageRoot, "clients/vscode-host"), { withFileTypes: true }))
      .filter(entry => entry.isFile() && /\.(?:ts|mjs|cjs|json)$/.test(entry.name))
      .map(entry => resolve(packageRoot, "clients/vscode-host", entry.name)),
    ...["vscode-client-integration.mjs", "vscode-client-boundaries.mjs"]
      .map(file => resolve(repository, "tests", file)),
    ...["browser-client-protocol.test.mjs", "browser-client-dom.test.mjs", "browser-client-fixture.mjs"]
      .map(file => resolve(repository, "tests", file)),
    ...(await filesUnder(resolve(packageRoot, "compute"))).filter(file => file.endsWith(".py")),
    ...["package.json", "package-lock.json", "tsconfig.json"].map(file => resolve(packageRoot, file)),
    ...(await readdir(resolve(packageRoot, "migration"))).filter(file => /(?:^|-)provenance\.json$/.test(file)).map(file => resolve(packageRoot, "migration", file)),
    resolve(packageRoot, "migration/native-qualification.json"),
  ];
  return hash(JSON.stringify(await Promise.all(files.sort().map(async file => [relative(packageRoot, file), hash(await readFile(file))]))));
}
async function inventory() {
  const files = [
    ...await filesUnder(resolve(repository, "src")),
    ...(await readdir(resolve(repository, "resources"))).filter(name => /\.(py|js)$/.test(name)).map(name => resolve(repository, "resources", name)),
  ].sort();
  const sources = [];
  const surfaces = [];
  for (const file of files) {
    const path = relative(repository, file).replaceAll("\\", "/");
    const content = await readFile(file, "utf8");
    const hostDependencies = [...new Set([...content.matchAll(/(?:from\s+|require\(\s*)["'](vscode(?:\/[^"']*)?)["']/g)].map(match => match[1]))];
    sources.push({ path, sha256: hash(content), lines: content.split("\n").length, hostDependencies });
    for (const match of content.matchAll(/@mcp\.tool\([^\n]*\)\s*\n\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/g)) {
      surfaces.push({ kind: "mcp-declaration", name: match[1], path, line: content.slice(0, match.index).split("\n").length });
    }
    if (path.endsWith(".ts")) {
      const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
      function visit(node) {
        if (ts.isObjectLiteralExpression(node)) {
          const properties = node.properties.filter(ts.isPropertyAssignment);
          const property = name => properties.find(item => item.name.getText(source).replaceAll(/["']/g, "") === name);
          const identity = property("name") ?? property("id");
          const toolLike = property("parameters") || property("inputSchema") || property("execute") || property("permission");
          if (identity && ts.isStringLiteral(identity.initializer) && toolLike) {
            surfaces.push({ kind: "typescript-contract-candidate", name: identity.initializer.text, path, line: source.getLineAndCharacterOfPosition(identity.getStart(source)).line + 1 });
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  }
  const packageSource = await readFile(resolve(repository, "package.json"), "utf8");
  const manifest = JSON.parse(packageSource);
  const commands = (manifest.contributes?.commands ?? []).map(item => item.command);
  const configurations = manifest.contributes?.configuration;
  const configurationKeys = (Array.isArray(configurations) ? configurations : [configurations]).flatMap(item => Object.keys(item?.properties ?? {})).sort();
  const legacyTests = [];
  for (const entry of (await readdir(resolve(repository, "tests"), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    if (!entry.isFile() || !/^test-.*\.(js|mjs|py|ts)$/.test(entry.name)) continue;
    const path = `tests/${entry.name}`;
    legacyTests.push({ path, sha256: hash(await readFile(resolve(repository, path))) });
  }
  const packageSha256 = hash(packageSource);
  return {
    schema: "pkm.migration-inventory/v1",
    measurement: "Source snapshot, not runtime enabled tools, semantic parity or implementation completion. Dynamic registrations and external providers require separate runtime qualification.",
    revision: hash(JSON.stringify({ packageSha256, sources, surfaces, commands, configurationKeys, legacyTests })),
    packageSha256, sources, surfaces, commands, configurationKeys, legacyTests,
  };
}
async function progress() {
  const manifest = JSON.parse(await readFile(resolve(packageRoot, "migration/manifest.json"), "utf8"));
  const snapshot = JSON.parse(await readFile(resolve(packageRoot, "migration/inventory.json"), "utf8"));
  const current = await inventory();
  const snapshotFresh = snapshot.revision === current.revision;
  const captures = await captureStatus();
  let verified = false;
  let evidence;
  try { evidence = JSON.parse(await readFile(resolve(packageRoot, "migration/verification.json"), "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (evidence) verified = evidence.passed === true && evidence.digest === await implementationDigest() && captures.issues.length === 0;
  const accepted = manifest.workstreams.filter(item => item.state === "accepted" && item.parity).length;
  const rows = manifest.workstreams.map(item => {
    const status = item.id === "core" && item.state === "implemented" ? (verified ? "foundation-tested" : "implemented / needs revalidation") : item.state;
    return `| ${item.id} | ${item.title} | ${status} | ${item.parity ? "yes" : "no"} |`;
  });
  const report = [
    "# PKM full migration progress", "",
    `Full migration acceptance: **${accepted}/${manifest.workstreams.length} workstreams**. This is an acceptance checklist count, NOT an effort/feature-weighted percentage.`,
    `\`[${"#".repeat(accepted)}${"-".repeat(manifest.workstreams.length - accepted)}]\``, "",
    `Foundation tests: **${verified ? "PASS (current implementation fingerprint)" : "NOT VERIFIED for current implementation"}**.`,
    `Domain capture provenance: **${captures.issues.length === 0 ? "CURRENT" : "STALE - re-capture changed source and revalidate"}**, ${captures.records} source/capture pairs and ${captures.sourceReferences} separately checked original-source references (not captured-code claims).`,
    `Native implementation qualification: **${captures.issues.some(issue => issue.kind === "native") ? "STALE" : "CURRENT"}**, ${captures.nativeRecords} exact pins checked. Batch14 paused Snapshot restore/inline Note writer, Batch15 fixture-only Skill/assets, Batch16 strict classification and derived-memory logical forget, Batch17 fixture-only classified restore adoption, Batch18 single-workspace paired memory-engine backup/restore, Batch19 separately registered original-compatible classification/adoption, Batch20 canonical Skill source installation/adoption, Batch21 managed Skill source removal, Batch22 old Skill-source bridging, Batch23 receipt-bound subscription identity, Batch24 isolated VS Code host, Batch25 complete Sync entity restore, and Batch26 Manager client workflow are bounded implementation pins, not original-source reuse or full-parity claims.`,
    ...captures.issues.map(issue => `- Capture ${issue.kind} ${issue.reason}: \`${issue.path}\`.`),
    `Legacy inventory: **${snapshotFresh ? "CURRENT" : "STALE - run npm run migration:inventory"}**, ${snapshot.sources.length} source files, ${snapshot.surfaces.length} static contract/tool declarations, ${snapshot.commands.length} extension commands, ${snapshot.configurationKeys.length} configuration keys.`,
    `Legacy regression scope: **${snapshot.legacyTests.length} test files** recorded with hashes. These old-suite tests have NOT been qualified against the new server.`,
    "Static declarations may include aliases or candidates and omit dynamic registrations; these counts are NOT the number of migrated capabilities.", "",
    `Storage policy: ${manifest.storagePolicy}`,
    `Cutover: ${manifest.cutover}`, "",
    "## Delivered so far (not full migration acceptance)", "",
    ...manifest.delivered.flatMap(item => [
      `- **${item.title}** - [evidence](./${item.evidence}).`,
      `  Limitation: ${item.limitations}`,
    ]), "",
    "## Full workstream gates", "",
    "| Workstream | Scope | State | Legacy parity accepted |",
    "| --- | --- | --- | --- |", ...rows, "",
    "## Completion rules", "",
    "- Implemented is not accepted. Foundation tests do not establish parity for other workstreams.",
    "- Each workstream requires mapped legacy contracts, implementation, targeted parity/failure tests and explicit evidence before acceptance.",
    "- Existing source snapshot hashes expose scope changes; changed/new source requires re-inventory and review.",
    "- Knowledge Markdown/metadata/identity/assets must remain authoritative; a database-only CRUD prototype does not satisfy the knowledge gate.",
    "- Browser/Chat, retrieval learning, sync, collaboration and plugins remain incomplete until their own gates pass.",
    "- No real Knowledge Root is used for testing, migration or cutover.", "",
    "## Reproduce", "",
    "```sh", "npm run progress", "npm run migration:inventory # intentionally refresh the old-source scope snapshot",
    "npm test                   # build/test; writes fingerprinted verification only on success", "```", "",
    "See [manifest.json](./migration/manifest.json) for each gate's acceptance criteria and",
    "[inventory.json](./migration/inventory.json) for source paths/hashes and declaration locations.", "",
  ].join("\n");
  await writeFile(resolve(packageRoot, "MIGRATION.md"), report);
  console.log(report);
}
const command = process.argv[2];
if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  if (command === "inventory") {
    const snapshot = await inventory();
    await writeFile(resolve(packageRoot, "migration/inventory.json"), JSON.stringify(snapshot, null, 2) + "\n");
    console.log(`Inventoried ${snapshot.sources.length} sources and ${snapshot.surfaces.length} static declarations.`);
    await progress();
  } else if (command === "progress") await progress();
  else throw new Error("Usage: node scripts/migration.mjs inventory|progress");
}

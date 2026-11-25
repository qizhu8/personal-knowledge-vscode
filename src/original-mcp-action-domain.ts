import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, realpathSync, writeFileSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { z } from "zod";
import { CoreError, type Actor } from "./contracts.js";
import { RootOwner, assertRootOwner } from "./root-owner.js";
import { assertStorage, type Storage } from "./storage.js";
import { assertOriginalMcpNativeHost, type OriginalMcpNativeHost } from "./original-mcp-native-host.js";
import { verifyOriginalMcpNativeHostReceiptDatabase } from "./original-mcp-native-host-receipt.js";
import { assertOriginalMcpPrivacy, parseOriginalMcpPlan, originalMcpPrivateBytes,
  readOriginalMcpJournal, type OriginalMcpPlan } from "./original-mcp-root-custody.js";
import { openOriginalMcpCustodyReader } from "./original-mcp-root.js";
import { acquireLinuxRootWriterFence, isTrustedLinuxRootWriterFence, type LinuxRootWriterFence } from "./linux-root-writer-fence.js";
import { assertLinuxLegacyWritersQuiescent } from "./linux-legacy-writer-quiescence.js";
import { canonicalJson } from "./domain/project-recipes-workflow-contracts.js";
import { ACTION_SOURCE_IDENTITY } from "./domain/action-source-identity.js";
import { actionComponents, loadModuleSet, originalDefinitionValue,
  originalDigest, portableActionDefinition, schemaValueErrors } from "./domain/action-compiler-validation.js";
import { readActionCompiler } from "./action-compiler.js";
import { actionCheckpoint, checkActionCheckpointAnswer, type ActionCheckpoint } from "./action-runtime-checkpoints.js";
import type { ActionNativeAdapter, RecoveredActionRun } from "./action-runtime.js";
import { pureComponentAdapter } from "./action-pure-components.js";
import { createVscodeActionTrustBridge, type NativeActionSourceDecision } from "./vscode-action-trust-bridge.js";
import { resolveActionExecutable } from "./action-program-build.js";
import { appendOriginalActionValidation, originalActionValidationJob } from "./original-mcp-action-validation.js";
import { appendOriginalActionInvocation, originalActionCall, readOriginalActionInvocations, readOriginalActionInvocationsMetadata,
  type OriginalActionInvocation } from "./original-mcp-action-invocation.js";
import type { OriginalMcpNativeActionAuthority } from "./original-mcp-native-action-authority.js";
import { createOriginalMcpActionPrograms, type OriginalMcpActionProgramSelection } from "./original-mcp-action-program.js";
import type { HostServicesOptions } from "./host-services.js";

type Json = Record<string, any>;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const safe = z.string().min(1).max(2048).refine(value =>
  !isAbsolute(value) && value.split("/").every(part => !!part && part !== "." && part !== ".." && !/[\\:\u0000-\u001f]/u.test(part)));
const actionId = z.string().regex(/^[a-z][a-z0-9_.-]{2,100}$/);
const runId = z.string().regex(/^action_run_[a-f0-9]{32}$/);
const sourceFile = z.strictObject({ path: safe, sha256: digest, bytes: z.number().safe().int().nonnegative(),
  role: z.enum(["definition", "module", "asset", "state", "toolchain"]), blob: z.string().regex(/^\d{6}$/) });
const toolchain = z.strictObject({ path: z.string().min(1), sha256: digest, bytes: z.number().safe().int().positive(),
  identity: z.string(), role: z.enum(["runtime", "compiler"]), capsulePath: safe });
const sourceSelection = z.strictObject({
  actionId, implementationId: z.string().min(1), sourcePath: safe,
});
const capsuleSchema = z.strictObject({
  schema: z.literal("pkm.original-mcp-action-custody/v1"), scope: z.literal("selected-actions-and-runs/v1"),
  root: z.string(), device: z.string(), inode: z.string(), workspacePlanSha256: digest, inventorySha256: digest,
  profileSha256: digest, operatorId: z.string().min(1), sourceIdentity: z.string(), backup: z.string(),
  files: z.array(sourceFile).min(1).max(4096), toolchains: z.array(toolchain).max(64),
  selections: z.array(sourceSelection).min(1).max(128), runIds: z.array(runId).max(1024),
  absentPaths: z.array(safe).max(4096),
  directories: z.array(z.strictObject({ path: safe, members: z.array(z.string()).max(4096) })).max(4096),
  capsuleSha256: digest,
});
export type OriginalMcpActionCustody = z.infer<typeof capsuleSchema>;
export interface OriginalMcpActionSelection {
  definitions: { path: string; sha256: string }[];
  moduleSets: { path: string; manifestSha256: string }[];
  assets: { path: string; sha256: string }[];
  toolchains: { path: string; sha256: string; role: "runtime" | "compiler" }[];
  selections: z.infer<typeof sourceSelection>[];
  runIds: string[];
  stateFiles: string[];
}
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const jsonHash = (value: unknown) => hash(canonicalJson(value));
const fail = (message: string, code = "NATIVE_AUTHORITY_REQUIRED"): never => { throw new CoreError(code, message); };
const pin = (s: Stats) => [s.dev, s.ino, s.uid, s.mode, s.nlink, s.size, s.mtimeMs, s.ctimeMs].join(":");
const object = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
function privateDirectory(path: string) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path
    || stat.uid !== process.getuid?.() || (stat.mode & 0o7077) !== 0) fail("Action custody requires a canonical owned private directory.");
}
function rootFile(root: string, path: string, maximum = 33_554_432) {
  safe.parse(path);
  let directory = root;
  for (const part of path.split("/").slice(0, -1)) {
    directory = join(directory, part);
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o7002) !== 0)
      fail("Action source ancestors changed or became linked.");
  }
  const file = join(root, path), before = lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== process.getuid?.()
    || (before.mode & 0o7002) !== 0 || before.size > maximum) fail("Action source is unsafe or exceeds its selected-file bound.");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (pin(before) !== pin(fstatSync(fd))) fail("Action source changed while opening.");
    const bytes = readFileSync(fd);
    if (bytes.length > maximum || pin(before) !== pin(fstatSync(fd)) || pin(before) !== pin(lstatSync(file)))
      fail("Action source changed while reading.");
    return bytes;
  } finally { closeSync(fd); }
}
function executable(path: string, expected: string, role: "runtime" | "compiler", capsulePath: string) {
  digest.parse(expected);
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path) fail("Pin the independently resolved canonical toolchain executable.");
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || (before.mode & 0o6022) !== 0 || (before.mode & 0o111) === 0
    || before.size > 134_217_728) fail("Toolchain identity is unsafe or unbounded.");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (pin(before) !== pin(fstatSync(fd))) fail("Toolchain identity changed.");
    const bytes = readFileSync(fd);
    if (hash(bytes) !== expected || pin(before) !== pin(fstatSync(fd)) || pin(before) !== pin(lstatSync(path)))
      fail("Independently pinned toolchain bytes changed.", "CONFLICT");
    return { proof: { path, sha256: expected, bytes: bytes.length, identity: pin(before), role, capsulePath }, content: bytes };
  } finally { closeSync(fd); }
}
function durable(path: string, bytes: Uint8Array | string) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}
function syncDirectory(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function decode(bytes: Uint8Array): Json {
  const value: unknown = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
  if (!object(value)) return fail("Expected an original Action JSON object.", "INVALID_DOCUMENT");
  const pending: unknown[] = [value];
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === "number" && Number.isInteger(item) && !Number.isSafeInteger(item))
      fail("ACTION_JSON_INTEGER_UNSUPPORTED: preserve exact original numeric bytes for native reconciliation.");
    if (Array.isArray(item)) pending.push(...item);
    else if (object(item)) pending.push(...Object.values(item));
  }
  return value;
}

/** Separate selected-source B0; auxiliaries in the base v1 custody are not silently treated as backed. */
export async function captureOriginalMcpActionCustody(inputPlan: OriginalMcpPlan,
  input: { backup: string; selection: OriginalMcpActionSelection },
  options: { writerFence?: LinuxRootWriterFence } = {}): Promise<OriginalMcpActionCustody> {
  const plan = parseOriginalMcpPlan(inputPlan), selection = structuredClone(input.selection);
  if (resolve(input.backup) !== input.backup || input.backup === plan.root || input.backup.startsWith(plan.root + sep)
    || plan.root.startsWith(input.backup + sep) || input.backup === plan.backup || input.backup.startsWith(plan.backup + sep)
    || plan.backup.startsWith(input.backup + sep)) fail("Action B0 must be a new disjoint private capsule.");
  privateDirectory(dirname(input.backup));
  const fence = options.writerFence ?? await acquireLinuxRootWriterFence(plan.root);
  if (!isTrustedLinuxRootWriterFence(fence, plan.root)) fail("The actual branded original-root writer fence is required.");
  let reader: Awaited<ReturnType<typeof openOriginalMcpCustodyReader>> | undefined;
  try {
    fence.assertHeld(); await assertLinuxLegacyWritersQuiescent(plan.root);
    const custodyReader = await openOriginalMcpCustodyReader(plan); reader = custodyReader;
    await custodyReader.read(".pkm/content-privacy.json", 2_097_152);
    const files = new Map<string, { bytes: Buffer; role: z.infer<typeof sourceFile>["role"] }>();
    const absentPaths: string[] = [], directories: { path: string; members: string[] }[] = [];
    let total = 0;
    const add = (path: string, bytes: Buffer, role: z.infer<typeof sourceFile>["role"], expected?: string) => {
      safe.parse(path);
      if (files.has(path)) fail("Selected Action custody files must be unique.");
      if (expected !== undefined && hash(bytes) !== digest.parse(expected)) fail("Selected Action source bytes differ from their independent pin.", "CONFLICT");
      total += bytes.length;
      if (files.size >= 4096 || total > 268_435_456) fail("Selected Action capsule exceeds its explicit domain bounds.", "RESOURCE_LIMIT");
      files.set(path, { bytes, role });
    };
    for (const item of selection.definitions) {
      if (!/^actions\/[a-z][a-z0-9_.-]{2,100}\.json$/.test(item.path)) fail("Select exact original registry definitions.");
      add(item.path, rootFile(plan.root, item.path), "definition", item.sha256);
    }
    for (const item of selection.assets) {
      if (!item.path.startsWith("action-sources/") && !item.path.startsWith("scripts/"))
        fail("Source assets require an explicit supported original source root.");
      add(item.path, rootFile(plan.root, item.path), "asset", item.sha256);
    }
    for (const item of selection.moduleSets) {
      if (!/^action-module-sets\/[a-z][a-z0-9_.-]{2,100}\/[1-9]\d*$/.test(item.path)) fail("Select an exact original ModuleSet version directory.");
      const path = `${item.path}/manifest.json`, bytes = rootFile(plan.root, path), manifest = decode(bytes);
      add(path, bytes, "module", item.manifestSha256);
      if (!object(manifest.files) || Object.keys(manifest.files).length > 499) fail("Invalid bounded ModuleSet inventory.");
      for (const [member, sha] of Object.entries(manifest.files)) {
        safe.parse(member);
        add(`${item.path}/${member}`, rootFile(plan.root, `${item.path}/${member}`), "module", String(sha));
      }
    }
    for (const id of selection.runIds) {
      runId.parse(id);
      const prefix = `.pkm/state/actions/runs/${id}`;
      const members = readdirSync(join(plan.root, prefix)).sort();
      const unknown = members.filter(name => !["run.json", "cancel.json", "checkpoints", "steps", "step-events",
        "input.json", "program.json", "program-result.json"].includes(name));
      if (unknown.length) fail(`Unknown old Run sidecars (${unknown.join(", ")}) require a separate native reconciliation parser.`);
      directories.push({ path: prefix, members });
      const path = `${prefix}/run.json`;
      add(path, await custodyReader.read(path, 16_777_216), "state");
      for (const name of ["input.json", "program.json", "program-result.json"]) {
        if (members.includes(name)) {
          const member = `${prefix}/${name}`;
          add(member, await custodyReader.read(member, 1_048_576), "state");
        }
      }
      for (const optional of [`${prefix}/cancel.json`, `.pkm/state/actions/launch-journal/${id}.json`]) {
        if (lstatSync(join(plan.root, optional), { throwIfNoEntry: false }))
          add(optional, await custodyReader.read(optional, 16_777_216), "state");
        else absentPaths.push(optional);
      }
      for (const directory of ["checkpoints", "steps", "step-events"]) {
        const absolute = join(plan.root, prefix, directory);
        if (!lstatSync(absolute, { throwIfNoEntry: false })) continue;
        const stat = lstatSync(absolute);
        if (!stat.isDirectory() || stat.isSymbolicLink()) fail("Original run evidence must remain in real custody directories.");
        const members = readdirSync(absolute).sort();
        directories.push({ path: `${prefix}/${directory}`, members });
        for (const name of members) {
          if (!/^(?:checkpoint_)?[a-f0-9]{32,64}\.json$/.test(name)) fail("Unknown historical Action evidence requires a separate parser.");
          const member = `${prefix}/${directory}/${name}`;
          add(member, await custodyReader.read(member, 1_048_576), "state");
        }
      }
    }
    for (const path of selection.stateFiles) {
      if (path !== ".pkm/state/actions/validation-queue.json" && !/^\.pkm\/state\/actions\/validations\/[a-z][a-z0-9_.-]{2,100}\.json$/.test(path))
        fail("Old trust, policy, host credentials and launcher tokens are not state-admission inputs.");
      add(path, await custodyReader.read(path, 16_777_216), "state");
    }
    if (lstatSync(join(plan.root, ".pkm/state/actions/validation-queue.json"), { throwIfNoEntry: false })
      && !selection.stateFiles.includes(".pkm/state/actions/validation-queue.json"))
      fail("ACTION_VALIDATION_QUEUE_SELECTION_REQUIRED: existing queue state cannot become successful empty native history.");
    const toolchains = selection.toolchains.map((item, index) => {
      const path = `native-toolchains/${String(index + 1).padStart(6, "0")}`;
      const captured = executable(item.path, item.sha256, item.role, path);
      add(path, captured.content, "toolchain", item.sha256);
      return captured.proof;
    });
    const root = lstatSync(plan.root, { bigint: true });
    if (String(root.dev) !== plan.device || String(root.ino) !== plan.inode) fail("Original Action root identity changed.");
    const selections = z.array(sourceSelection).min(1).max(128).parse(selection.selections);
    if (new Set(selections.map(item => item.actionId)).size !== selections.length) fail("Select each original Action exactly once.");
    mkdirSync(input.backup, { mode: 0o700 }); mkdirSync(join(input.backup, "blobs"), { mode: 0o700 });
    const records = [...files].sort(([a], [b]) => a.localeCompare(b)).map(([path, value], index) => {
      const blob = String(index + 1).padStart(6, "0");
      durable(join(input.backup, "blobs", blob), value.bytes);
      return { path, sha256: hash(value.bytes), bytes: value.bytes.length, role: value.role, blob };
    });
    const body = { schema: "pkm.original-mcp-action-custody/v1" as const, scope: "selected-actions-and-runs/v1" as const,
      root: plan.root, device: plan.device, inode: plan.inode, workspacePlanSha256: plan.planSha256,
      inventorySha256: plan.inventorySha256, profileSha256: plan.profileSha256, operatorId: plan.operatorId,
      sourceIdentity: ACTION_SOURCE_IDENTITY.identity, backup: input.backup, files: records, toolchains, selections,
      runIds: z.array(runId).max(1024).parse(selection.runIds) };
    const bodyWithAbsence = { ...body, absentPaths, directories };
    const capsule = capsuleSchema.parse({ ...bodyWithAbsence, capsuleSha256: jsonHash(bodyWithAbsence) });
    fence.assertHeld(); await assertLinuxLegacyWritersQuiescent(plan.root);
    for (const record of records) {
      if (record.role === "toolchain") continue;
      const actual = record.role === "state" ? await custodyReader.read(record.path, 33_554_432)
        : rootFile(plan.root, record.path);
      if (hash(actual) !== record.sha256) fail("Action source changed while sealing B0.");
    }
    for (const item of toolchains) executable(item.path, item.sha256, item.role, item.capsulePath);
    checkControlInventory(capsule);
    if (Buffer.byteLength(canonicalJson(capsule)) > 4_194_304) fail("Action custody manifest exceeds its explicit domain bound.", "RESOURCE_LIMIT");
    syncDirectory(join(input.backup, "blobs"));
    durable(join(input.backup, "complete.json"), canonicalJson(capsule)); syncDirectory(input.backup); syncDirectory(dirname(input.backup));
    return capsule;
  } finally { reader?.close(); if (!options.writerFence) await fence.release(); }
}
function checkControlInventory(custody: OriginalMcpActionCustody) {
  for (const path of custody.absentPaths) if (lstatSync(join(custody.root, path), { throwIfNoEntry: false }))
    fail("An absent-at-B0 cancellation/launch control appeared; no continuation may replay.", "RECOVERY_CONFLICT");
  for (const directory of custody.directories) {
    const path = join(custody.root, directory.path), stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || canonicalJson(readdirSync(path).sort()) !== canonicalJson(directory.members))
      fail("Selected old Run evidence/control membership changed.", "RECOVERY_CONFLICT");
  }
}

function capsule(input: OriginalMcpActionCustody, plan: OriginalMcpPlan) {
  const value = capsuleSchema.parse(input), { capsuleSha256, ...body } = value;
  if (jsonHash(body) !== capsuleSha256 || value.root !== plan.root || value.device !== plan.device || value.inode !== plan.inode
    || value.workspacePlanSha256 !== plan.planSha256 || value.inventorySha256 !== plan.inventorySha256
    || value.profileSha256 !== plan.profileSha256 || value.operatorId !== plan.operatorId)
    fail("Action custody is not bound to this exact original B0/root/profile.", "RECOVERY_CONFLICT");
  privateDirectory(value.backup); privateDirectory(join(value.backup, "blobs"));
  if (!originalMcpPrivateBytes(join(value.backup, "complete.json"), 4_194_304).equals(Buffer.from(canonicalJson(value))))
    fail("The independently retained Action capsule seal changed.", "RECOVERY_CONFLICT");
  if (new Set(value.files.map(item => item.path)).size !== value.files.length
    || new Set(value.files.map(item => item.blob)).size !== value.files.length) fail("Duplicate Action capsule inventory.");
  const allowed = new Set(value.files.map(item => item.blob));
  if (readdirSync(value.backup).sort().join(",") !== "blobs,complete.json"
    || readdirSync(join(value.backup, "blobs")).some(name => !allowed.has(name))) fail("Unknown Action capsule payload.");
  const files = new Map<string, Buffer>();
  for (const record of value.files) {
    const bytes = originalMcpPrivateBytes(join(value.backup, "blobs", record.blob), Math.max(1, record.bytes));
    if (bytes.length !== record.bytes || hash(bytes) !== record.sha256) fail("Action capsule bytes changed.", "RECOVERY_CONFLICT");
    files.set(record.path, bytes);
  }
  for (const proof of value.toolchains) {
    const record = value.files.find(item => item.path === proof.capsulePath);
    if (!record || record.role !== "toolchain" || record.sha256 !== proof.sha256 || record.bytes !== proof.bytes)
      fail("Native executable-byte custody is incomplete.", "RECOVERY_CONFLICT");
  }
  return { value, files };
}
type NativeSource = { actionId: string; definition: Json; source: RecoveredActionRun["source"]; selectedActionId?: string;
  implementation: Json; selectionId: string; definitionDigest: string; sourcePath: string; nativeControl: boolean };
function sources(custody: OriginalMcpActionCustody, files: Map<string, Buffer>): NativeSource[] {
  if (custody.sourceIdentity !== ACTION_SOURCE_IDENTITY.identity) fail("ACTION_SOURCE_IDENTITY_REQUIRED: independently select the exact original/native compiler identity.");
  return custody.selections.map(selection => {
    let source: RecoveredActionRun["source"], definition: Json, selectedActionId: string | undefined;
    if (selection.sourcePath.startsWith("actions/")) {
      const bytes = files.get(selection.sourcePath);
      if (!bytes) return fail("Selected registry definition has no independent Action custody.");
      const raw = decode(bytes), native = originalDefinitionValue(raw);
      if (raw.content_hash !== undefined && raw.content_hash !== native.content_hash)
        return fail("ACTION_SOURCE_IDENTITY_REQUIRED: archived source digests cannot be silently upgraded.");
      if (raw.knowledgeId !== undefined && raw.knowledgeId !== `action_${originalDigest(selection.actionId).slice(0, 24)}`) {
        const member = `definitions/${selection.actionId}.json`;
        const unsigned = { schema: "pkm.action.module-set/v1", module_set_id: `original.registry-${hash(selection.actionId).slice(0, 24)}`,
          version: 1, name: "Original registry compiler snapshot", actions: [selection.actionId],
          files: { [member]: hash(bytes) }, resources: {},
          provenance: { source: selection.sourcePath, sourceSha256: hash(bytes), authority: "none; compiler representation only" } };
        source = { kind: "moduleSet", manifest: { ...unsigned, package_hash: originalDigest(unsigned) },
          files: { [member]: bytes.toString("utf8") }, enabled: true };
        selectedActionId = selection.actionId;
      } else {
        source = { kind: "inline", definition: z.json().parse(Object.fromEntries(Object.entries(portableActionDefinition(raw))
          .filter(([key]) => key !== "knowledgeId"))) };
      }
      definition = native;
    } else {
      const manifestPath = `${selection.sourcePath}/manifest.json`, bytes = files.get(manifestPath);
      if (!bytes) return fail("Selected ModuleSet has no exact independently sealed manifest.");
      const manifest = decode(bytes), members: Record<string, string> = {};
      for (const member of Object.keys(manifest.files ?? {})) {
        const raw = files.get(`${selection.sourcePath}/${member}`);
        if (!raw) return fail("The independently backed ModuleSet closure is incomplete.");
        members[member] = new TextDecoder("utf8", { fatal: true }).decode(raw);
      }
      const snapshot = { kind: "moduleSet" as const, manifest: z.json().parse(manifest), files: members, enabled: true };
      const loaded = loadModuleSet(snapshot), found = loaded.definitions.get(selection.actionId);
      if (!found) return fail("The exact selected Action is absent from its original ModuleSet.");
      source = snapshot; definition = found; selectedActionId = selection.actionId;
      const authored = decode(files.get(`${selection.sourcePath}/definitions/${selection.actionId}.json`)!);
      if (authored.content_hash !== undefined && authored.content_hash !== definition.content_hash)
        return fail("ACTION_SOURCE_IDENTITY_REQUIRED: the original package revision needs its exact compiler identity.");
    }
    const compiled = readActionCompiler({ operation: "action.definition.compile",
      args: { source, ...(selectedActionId ? { actionId: selectedActionId } : {}) } }) as Json;
    if (compiled.status !== "valid" || compiled.definitionDigest !== definition.content_hash || definition.action_id !== selection.actionId)
      return fail("ACTION_SOURCE_IDENTITY_REQUIRED: exact original source pins do not compile on this native engine.");
    const implementation = definition.implementations.find((item: Json, index: number) =>
      (typeof item.id === "string" ? item.id : `index:${index}`) === selection.implementationId);
    if (!implementation) return fail("Select an implementation explicitly present in the exact source.");
    if (!["program", "pipeline"].includes(implementation.kind))
      return fail("ACTION_NATIVE_SOURCE_HANDLER_REQUIRED: this source kind needs its exact executable/credential/state producer before admission.");
    const platform = process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "Darwin" : "Linux";
    const architecture = process.arch === "x64" ? "x86_64" : process.arch;
    if (!implementation.platforms.includes(platform) || implementation.architectures?.length && !implementation.architectures.includes(architecture))
      return fail("The selected historical implementation is incompatible with this native target.");
    if (implementation.kind === "program") {
      for (const [program, role] of [[implementation.program, "runtime"], [implementation.build?.program, "compiler"]] as const) {
        if (program === undefined) continue;
        if (typeof program !== "string" || program.includes("${") || program.startsWith("pkm://"))
          return fail("ACTION_EXECUTABLE_BINDING_REQUIRED: resource/build executable projection needs its exact native producer.");
        const resolved = resolveActionExecutable(program);
        const proof = custody.toolchains.find(item => item.path === resolved && item.role === role);
        if (!proof) return fail("ACTION_TOOLCHAIN_PIN_REQUIRED: every selected runtime/compiler needs independently pinned bytes.");
      }
      for (const path of [...implementation.files ?? [], ...implementation.build?.source_files ?? []]) {
        const rel = isAbsolute(path) ? relative(custody.root, path).split(sep).join("/") : path;
        if (!files.has(rel)) return fail("Selected executable source files are not independently backed.");
      }
    }
    const nativeControl = implementation.kind === "pipeline" && !Object.keys(definition.dependencies ?? {}).length
      && definition.effects.every((effect: string) => ["pure", "human-input"].includes(effect))
      && implementation.steps.every((step: Json) => ["core.checkpoint", "core.wait"].includes(step.component)
        || ["core.constant", "core.math-expression", "core.cast", "core.lookup"].includes(step.component) && step.implementation === "javascript");
    return { actionId: selection.actionId, definition: compiled.definition, source, selectedActionId, implementation, selectionId: selection.implementationId,
      definitionDigest: compiled.definitionDigest, sourcePath: selection.sourcePath, nativeControl };
  });
}

const footprintDdl = `
CREATE TABLE original_mcp_action_footprints(receipt_sha256 TEXT PRIMARY KEY,payload TEXT NOT NULL);
CREATE TRIGGER original_mcp_action_footprints_no_update BEFORE UPDATE ON original_mcp_action_footprints
BEGIN SELECT RAISE(ABORT,'Action native footprint immutable'); END;
CREATE TRIGGER original_mcp_action_footprints_no_delete BEFORE DELETE ON original_mcp_action_footprints
BEGIN SELECT RAISE(ABORT,'Action native footprint immutable'); END;`;
const footprintSchema = z.strictObject({
  schema: z.literal("pkm.original-mcp-action-footprint/v1"), root: z.string(), workspaceId: z.string().uuid(),
  custodyPlanSha256: digest, profileSha256: digest, capsuleSha256: digest,
  namespaces: z.tuple([z.literal(".pkm-action-authority")]), gitProtection: z.literal("/.pkm-*"),
  b1Qualification: z.literal("B1_UNQUALIFIED"), executionGrant: z.literal(false), receiptSha256: digest,
});
/** Staging footprint only: actual Storage + selected cold B0, never an Action or human grant. */
export async function declareOriginalMcpActionNativeFootprint(storage: Storage, input: OriginalMcpActionCustody) {
  assertStorage(storage); storage.assertWorkspaceLease();
  const journal = assertOriginalMcpPrivacy(storage.workspaceRoot());
  if (!journal) return fail("Original Action native footprint requires actual original-root custody.");
  const checked = capsule(input, journal.plan);
  return storage.withWorkspaceExclusive(() => {
    const prior = verifyOriginalMcpActionNativeFootprint(storage.workspaceRoot());
    if (prior) {
      if (prior.capsuleSha256 !== checked.value.capsuleSha256) fail("Another Action footprint already owns this native namespace.", "CONFLICT");
      return prior;
    }
    if (lstatSync(join(storage.workspaceRoot(), ".pkm-action-authority"), { throwIfNoEntry: false }))
      fail("An undeclared Action native endpoint must be preserved and independently reconciled.");
    const body = { schema: "pkm.original-mcp-action-footprint/v1" as const, root: storage.workspaceRoot(),
      workspaceId: journal.workspaceId, custodyPlanSha256: journal.plan.planSha256, profileSha256: journal.plan.profileSha256,
      capsuleSha256: checked.value.capsuleSha256, namespaces: [".pkm-action-authority"] as [".pkm-action-authority"],
      gitProtection: "/.pkm-*" as const, b1Qualification: "B1_UNQUALIFIED" as const, executionGrant: false as const };
    const receipt = footprintSchema.parse({ ...body, receiptSha256: jsonHash(body) }), database = storage.connectNative();
    try {
      database.exec("BEGIN IMMEDIATE");
      try {
        database.exec(footprintDdl);
        database.prepare("INSERT INTO original_mcp_action_footprints VALUES(?,?)").run(receipt.receiptSha256, canonicalJson(receipt));
        storage.assertWorkspaceLease(); database.exec("COMMIT");
      } catch (error) { if (database.isTransaction) database.exec("ROLLBACK"); throw error; }
      return receipt;
    } finally { database.close(); }
  });
}
/** Fixed optional native path verifier for original-root layout/Git/B1 integration; never an authority grant. */
export function verifyOriginalMcpActionNativeFootprint(root: string, supplied?: DatabaseSync) {
  const journal = readOriginalMcpJournal(root);
  if (!journal) return;
  const database = supplied ?? new DatabaseSync(join(root, "core.sqlite"), { readOnly: true });
  try {
    if (database.prepare("PRAGMA database_list").all().find(row => row.name === "main")?.file !== join(root, "core.sqlite"))
      fail("Action footprint verification requires the actual canonical database.", "RECOVERY_CONFLICT");
    if (!database.prepare("SELECT 1 FROM sqlite_master WHERE name='original_mcp_action_footprints'").get()) return;
    const expected = new DatabaseSync(":memory:");
    try {
      expected.exec(footprintDdl);
      const schema = (db: DatabaseSync) => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name LIKE 'original_mcp_action_footprints%' ORDER BY name").all();
      if (canonicalJson(schema(expected)) !== canonicalJson(schema(database))) fail("Action native footprint schema changed.", "RECOVERY_CONFLICT");
    } finally { expected.close(); }
    const rows = database.prepare("SELECT * FROM original_mcp_action_footprints").all();
    if (rows.length !== 1) fail("Action native footprint ownership is ambiguous.", "RECOVERY_CONFLICT");
    const receipt = footprintSchema.parse(JSON.parse(String(rows[0]!.payload))), { receiptSha256, ...body } = receipt;
    if (receiptSha256 !== jsonHash(body) || receiptSha256 !== rows[0]!.receipt_sha256
      || rows[0]!.payload !== canonicalJson(receipt) || receipt.root !== root || receipt.workspaceId !== journal.workspaceId
      || receipt.custodyPlanSha256 !== journal.plan.planSha256 || receipt.profileSha256 !== journal.plan.profileSha256)
      fail("Action native footprint lost its exact root/profile/B0 binding.", "RECOVERY_CONFLICT");
    const directory = join(root, ".pkm-action-authority");
    if (lstatSync(directory, { throwIfNoEntry: false })) {
      privateDirectory(directory);
      if (readdirSync(directory).some(name => name !== "host-authority.json")) fail("Unknown native Action private state requires explicit B1 review.");
      const config = decode(originalMcpPrivateBytes(join(directory, "host-authority.json"), 8192));
      if (config.schema !== "pkm.action.host-authority/v1" || config.store_path !== root || config.host !== "127.0.0.1"
        || !Number.isSafeInteger(config.port) || config.port < 1 || config.port > 65535
        || !digest.safeParse(config.token).success || typeof config.trust_epoch !== "string" || config.trust_epoch.length > 256)
        fail("The declared native Action endpoint is malformed.", "RECOVERY_CONFLICT");
    }
    return receipt;
  } finally { if (!supplied) database.close(); }
}
const domainDdl = `
CREATE TABLE original_mcp_action_domain_intents(receipt_sha256 TEXT PRIMARY KEY,payload TEXT NOT NULL);
CREATE TABLE original_mcp_action_domain_commits(receipt_sha256 TEXT PRIMARY KEY);
CREATE TRIGGER original_mcp_action_domain_intents_no_update BEFORE UPDATE ON original_mcp_action_domain_intents
BEGIN SELECT RAISE(ABORT,'Action source admission immutable'); END;
CREATE TRIGGER original_mcp_action_domain_intents_no_delete BEFORE DELETE ON original_mcp_action_domain_intents
BEGIN SELECT RAISE(ABORT,'Action source admission immutable'); END;
CREATE TRIGGER original_mcp_action_domain_commits_no_update BEFORE UPDATE ON original_mcp_action_domain_commits
BEGIN SELECT RAISE(ABORT,'Action source commit immutable'); END;
CREATE TRIGGER original_mcp_action_domain_commits_no_delete BEFORE DELETE ON original_mcp_action_domain_commits
BEGIN SELECT RAISE(ABORT,'Action source commit immutable'); END;`;
export const originalMcpActionOptionalSchemaGroups = [
  { ddl: footprintDdl, tables: ["original_mcp_action_footprints"] },
  { ddl: domainDdl, tables: ["original_mcp_action_domain_intents", "original_mcp_action_domain_commits"] },
] as const;
const receiptSchema = z.strictObject({
  schema: z.literal("pkm.original-mcp-action-domain/v1"), root: z.string(), workspaceId: z.string().uuid(),
  custodyPlanSha256: digest, profileSha256: digest, nativeHostReceiptSha256: digest,
  capsuleSha256: digest, sourceIdentity: z.string(), sourceSha256: digest, nativeActionEpoch: z.string().min(1),
  actorId: z.literal("mcp:external"), sourcePaths: z.array(safe), runIds: z.array(runId),
  actionIds: z.array(actionId),
  approvalDigest: digest, imports: z.array(z.json()), jobs: z.array(originalActionValidationJob),
  historicalValidations: z.array(z.json()), legacyRuns: z.array(z.json()), receiptSha256: digest,
  nativeActionDecision: z.strictObject({
    schema: z.literal("pkm.native-action-source-decision/v1"), scope: z.literal("original-action-source-state/v1"),
    root: z.string(), workspaceId: z.string().uuid(), actorId: z.literal("mcp:external"), profileSha256: digest,
    epoch: z.string(), capsuleSha256: digest, requestSha256: digest, decisionId: z.string(), expiresAtMs: z.number().safe().int(),
    noExecution: z.literal(true),
  }),
});
export type OriginalMcpActionDomainReceipt = z.infer<typeof receiptSchema>;
interface DomainPolicyState {
  storage: Storage; host: OriginalMcpNativeHost; custody: OriginalMcpActionCustody;
  files: Map<string, Buffer>; sources: NativeSource[];
  authority: ReturnType<typeof createVscodeActionTrustBridge>;
  revoked: boolean; importing: boolean; receiptSha256?: string; expiresAtMs: number;
  decision?: NativeActionSourceDecision;
  invocationGrants: Map<string, { receiptSha256: string; expiresAtMs: number }>;
  creatingInvocation?: { runId: string; sourceDigest: string; inputDigest: string };
  producerCurrent?: () => void;
  programs?: ReturnType<typeof createOriginalMcpActionPrograms>;
}
export interface OriginalMcpActionNativePolicy {
  readonly options: { hostServices: { action: { adapters: Readonly<Record<string, ActionNativeAdapter>>;
    process?: NonNullable<HostServicesOptions["action"]>["process"] } } };
  close(): Promise<void>;
}
const nativePolicies = new WeakMap<object, DomainPolicyState>();
const activePolicies = new WeakMap<Storage, OriginalMcpActionNativePolicy>();
function context(storage: Storage, host: OriginalMcpNativeHost) {
  assertStorage(storage); storage.assertWorkspaceLease(); assertOriginalMcpNativeHost(host, storage);
  const journal = assertOriginalMcpPrivacy(storage.workspaceRoot());
  if (!journal || !host.receipt.domains.includes("mcp-public")) return fail("An actual same-owner original-root/native profile is required.");
  return journal;
}
function nativeEpoch(state: DomainPolicyState) {
  context(state.storage, state.host);
  state.producerCurrent?.();
  if (state.revoked) return fail("The native Action source session was revoked.");
  const directory = join(state.storage.workspaceRoot(), ".pkm-action-authority");
  privateDirectory(directory);
  const config = decode(originalMcpPrivateBytes(join(directory, "host-authority.json"), 8192));
  if (config.schema !== "pkm.action.host-authority/v1" || config.store_path !== state.storage.workspaceRoot()
    || config.host !== "127.0.0.1" || config.trust_epoch !== state.host.receipt.epoch)
    return fail("ACTION_NATIVE_EPOCH_BINDING_REQUIRED: a new Action producer must bind to the current native profile epoch; archived authority is never inherited.");
  const trust = state.authority.current();
  if (!trust.trustedWorkspace || trust.workspaceId !== state.host.receipt.workspaceId
    || trust.actorId !== "mcp:external" || trust.epoch !== state.host.receipt.epoch)
    return fail("ACTION_NATIVE_TRUST_REQUIRED: current native Action trust is separate from the model/public grant.");
  return trust;
}
function live(state: DomainPolicyState) {
  nativeEpoch(state);
  if (!state.decision || state.decision.expiresAtMs <= Date.now()) return fail("The exact native Action source decision expired.");
  if (!state.importing && (!state.receiptSha256 || state.expiresAtMs <= Date.now()))
    return fail("ACTION_DOMAIN_SESSION_REQUIRED: fresh exact native Action source/state admission is required.");
}
async function verifySelected(state: DomainPolicyState) {
  const journal = context(state.storage, state.host), checked = capsule(state.custody, journal.plan);
  const reader = await openOriginalMcpCustodyReader(journal.plan);
  try {
    for (const record of checked.value.files) {
      if (record.role === "toolchain") continue;
      const bytes = record.role === "state" ? await reader.read(record.path, Math.max(1, record.bytes)) : rootFile(journal.plan.root, record.path);
      if (hash(bytes) !== record.sha256) fail("Admitted original Action bytes changed; preserve them for reconciliation.", "RECOVERY_CONFLICT");
    }
    reader.assertCurrent();
  } finally { reader.close(); }
  for (const proof of checked.value.toolchains) {
    if (canonicalJson(executable(proof.path, proof.sha256, proof.role, proof.capsulePath).proof) !== canonicalJson(proof))
      fail("The independently pinned native toolchain identity changed.", "RECOVERY_CONFLICT");
  }
  checkControlInventory(checked.value);
}
function sourceCurrent(state: DomainPolicyState) {
  for (const file of state.custody.files) {
    if (file.role === "toolchain") continue;
    let bytes: Buffer;
    try { bytes = rootFile(state.custody.root, file.path, Math.max(1, file.bytes)); }
    catch (error) {
      if (error instanceof CoreError && error.code === "NATIVE_AUTHORITY_REQUIRED")
        return fail("Admitted original Action source/state identity or size changed.", "RECOVERY_CONFLICT");
      throw error;
    }
    if (hash(bytes) !== file.sha256)
      fail("Admitted original Action source/state changed; current review is required.", "RECOVERY_CONFLICT");
  }
  checkControlInventory(state.custody);
}
function policyState(policy: OriginalMcpActionNativePolicy, storage: Storage, host: OriginalMcpNativeHost) {
  const state = nativePolicies.get(policy);
  if (!state || state.storage !== storage || state.host !== host) return fail("An actual same-owner concrete native Action policy is required; callback/JSON grants are invalid.");
  return state;
}
async function nativeReview(state: DomainPolicyState, requestDigest: string, operation: string) {
  await state.authority.refresh();
  const current = nativeEpoch(state);
  await verifySelected(state);
  for (const source of state.sources) {
    if (!await state.authority.authorize(source.actionId, source.definitionDigest, current.epoch))
      fail("The current native Action host denied this exact source revision.");
    nativeEpoch(state);
  }
  const decision = await state.authority.authorizeSourceAdmission({
    schema: "pkm.native-action-source-request/v1", root: state.storage.workspaceRoot(), workspaceId: state.host.receipt.workspaceId,
    actorId: "mcp:external", profileSha256: state.host.receipt.profileSha256, epoch: current.epoch,
    capsuleSha256: state.custody.capsuleSha256, requestSha256: requestDigest, operation, noExecution: true,
    sources: state.sources.map(source => ({ actionId: source.actionId, contentHash: source.definitionDigest,
      implementationSha256: originalDigest(source.implementation), effects: [...source.definition.effects] })),
  });
  nativeEpoch(state);
  await verifySelected(state);
  if (decision.expiresAtMs <= Date.now()) fail("The native Action source decision expired during byte verification.");
  state.decision = decision;
  return decision;
}

/**
 * Concrete existing native Action RPC only. No caller-supplied authorization callback,
 * old worker token, model-host approval or persisted receipt can construct this live policy.
 */
export async function createOriginalMcpActionNativePolicy(storage: Storage, host: OriginalMcpNativeHost,
  input: OriginalMcpActionCustody, options: { nativeAuthority?: OriginalMcpNativeActionAuthority;
    localPrograms?: readonly OriginalMcpActionProgramSelection[] } = {}): Promise<OriginalMcpActionNativePolicy> {
  const journal = context(storage, host), checked = capsule(input, journal.plan);
  let producerCurrent: (() => void) | undefined;
  if (host.receipt.authorityId.startsWith("native-rpc:") || options.nativeAuthority) {
    const producer: typeof import("./original-mcp-native-action-authority.js") = await import("./original-mcp-native-action-authority.js");
    const authority = options.nativeAuthority;
    producer.assertOriginalMcpNativeActionAuthority(authority, storage, host);
    if (authority.capsuleSha256 !== checked.value.capsuleSha256) fail("NATIVE_ACTION_PRODUCER_CAPSULE_MISMATCH");
    producerCurrent = () => producer.assertOriginalMcpNativeActionAuthority(authority, storage, host);
  }
  const footprint = verifyOriginalMcpActionNativeFootprint(storage.workspaceRoot());
  if (!footprint || footprint.capsuleSha256 !== checked.value.capsuleSha256)
    return fail("Declare the exact private Action native endpoint footprint before starting its producer.");
  const authority = createVscodeActionTrustBridge({ workspaceRoot: storage.workspaceRoot(),
    workspaceId: journal.workspaceId, actorId: "mcp:external", nativeEndpoint: true });
  const state: DomainPolicyState = { storage, host, custody: checked.value, files: checked.files,
    sources: sources(checked.value, checked.files), authority, revoked: false, importing: false, expiresAtMs: 0,
    invocationGrants: new Map(), ...(producerCurrent ? { producerCurrent } : {}) };
  await authority.refresh(); nativeEpoch(state); await verifySelected(state);
  const adapters: Record<string, ActionNativeAdapter> = {};
  const components = actionComponents();
  for (const name of ["core.constant", "core.math-expression", "core.cast", "core.lookup", "core.checkpoint", "core.wait"]) {
    const definition = components[name]!;
    const packaged = pureComponentAdapter(`component:${name}`, originalDigest(definition.output_schema));
    const allowed = (binding: Parameters<ActionNativeAdapter["authorizeDefinition"]>[0], inputs?: Record<string, unknown>) => {
      try {
        live(state);
        sourceCurrent(state);
        const source = state.sources.find(item => item.definitionDigest === binding.executableDigest && item.nativeControl);
        const component = originalDigest(binding.definition) === originalDigest(definition);
        const creating = state.creatingInvocation;
        const creation = !!creating && creating.sourceDigest === binding.executableDigest
          && state.invocationGrants.has(creating.runId)
          && (!inputs || creating.inputDigest === originalDigest(inputs));
        return binding.actorId === "mcp:external" && binding.workspaceId === journal.workspaceId && !!source
          && originalDigest(source.implementation) === originalDigest(binding.implementation)
          && binding.step?.component === name
          && originalDigest(binding.step) === originalDigest(source.implementation.steps.find((step: Json) => step.id === binding.nodeId))
          && (component || inputs !== undefined && creation && originalDigest(binding.definition) === originalDigest(source.definition))
          && (creation || state.importing || executionBindingIsAuthorized(state, binding.executableDigest, binding.nodeId))
          && (!packaged || !component || packaged.authorizeDefinition(binding));
      } catch { return false; }
    };
    adapters[`component:${name}`] = {
      id: `original-custody-${name}`, version: 1, outputContractDigest: originalDigest(definition.output_schema),
      authorizationDigest: jsonHash({ capsuleSha256: state.custody.capsuleSha256, component: definition }),
      authorizeDefinition: binding => allowed(binding), authorizeData: binding => allowed(binding, binding.inputs),
      async execute(invocation, execution) {
        await authority.refresh(); live(state);
        sourceCurrent(state); execution.signal.throwIfAborted();
        const call = readOriginalActionInvocations(storage, host.receipt.workspaceId).find(item => item.runId === invocation.runId);
        if (call) assertInvocationGrant(state, call);
        else if (!readReceipt(storage)?.receipt.runIds.includes(invocation.runId))
          fail("ACTION_EFFECT_CONSENT_REQUIRED: source custody alone cannot execute a new Run.", "ACCESS_DENIED");
        if (!packaged) throw new CoreError("NOT_AVAILABLE", "Intrinsic checkpoint dispatch must be owned by the canonical Action engine.");
        return packaged.execute(invocation, execution);
      },
    };
  }
  if (options.localPrograms?.length) state.programs = createOriginalMcpActionPrograms({
    storage, host, custody: state.custody, selections: options.localPrograms, sources: state.sources,
    check() { nativeEpoch(state); sourceCurrent(state); if (state.receiptSha256) live(state); },
    async refresh() { await authority.refresh(); live(state); sourceCurrent(state); },
    consent: (request, signal) => authority.authorizeProgram(request, signal),
    authorize(binding, inputs) {
      try {
        live(state); sourceCurrent(state);
        const source = state.sources.find(source => source.actionId === binding.actionId
          && source.definitionDigest === binding.executableDigest && state.programs?.has(source.actionId));
        if (!source || !binding.runId || binding.actorId !== "mcp:external" || binding.workspaceId !== journal.workspaceId || binding.nodeId !== "action"
          || originalDigest(binding.definition) !== originalDigest(source.definition)
          || originalDigest(binding.implementation) !== originalDigest(source.implementation)) return false;
        const creating = state.creatingInvocation;
        return !!creating && creating.runId === binding.runId && creating.sourceDigest === binding.executableDigest && state.programs!.hasGrant(creating.runId)
          && (inputs === undefined || creating.inputDigest === originalDigest(inputs))
          || executionBindingIsAuthorized(state, binding.executableDigest, binding.nodeId, binding.runId);
      } catch { return false; }
    },
  });
  const close = async () => { state.revoked = true; state.expiresAtMs = 0; state.invocationGrants.clear();
    state.programs?.close(); await authority.close?.(); };
  host.signal.addEventListener("abort", () => { void close(); }, { once: true });
  const policy = Object.freeze({ options: { hostServices: { action: { adapters: Object.freeze(adapters),
    ...(state.programs ? { process: { commands: state.programs.commands, limits: { graceMs: 50, closeDrainMs: 2000 } } } : {}) } } }, close });
  nativePolicies.set(policy, state);
  storage.retainNativeCleanup({ release: close });
  return policy;
}
function uuidFromHash(value: string) {
  const raw = hash(value).slice(0, 32).split(""); raw[12] = "4"; raw[16] = "8";
  const hex = raw.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function historicalCheckpoint(value: unknown, run: string, state: "waiting" | "resolved" | "expired" | "cancelled"): ActionCheckpoint {
  if (!object(value)) return fail("Historical checkpoint must be a typed original object.", "INVALID_DOCUMENT");
  const normalized = { ...value, state, resume_token: randomBytes(24).toString("hex"),
    remaining_seconds: Math.min(Number(value.remaining_seconds ?? 300), 86_400), presentation: value.presentation ?? "json" };
  const checked = actionCheckpoint.parse(normalized);
  if (checked.run_id !== run || originalDigest(checked.proposal) !== checked.proposal_digest)
    fail("Historical checkpoint identity/proposal changed.", "RECOVERY_CONFLICT");
  if (state === "resolved" && (!checked.answer || originalDigest(checked.answer) !== checked.answer_digest))
    fail("Historical checkpoint answer receipt is invalid.", "RECOVERY_CONFLICT");
  return checked;
}
function planImport(state: DomainPolicyState) {
  const imports: RecoveredActionRun[] = [], legacyRuns: Json[] = [], historicalValidations: Json[] = [];
  for (const id of state.custody.runIds) {
    const bytes = state.files.get(`.pkm/state/actions/runs/${id}/run.json`);
    if (!bytes) return fail("Selected original Run has no independently backed bytes.");
    const run = decode(bytes), source = state.sources.find(item => item.actionId === run.action_id);
    if (!source || run.run_id !== id || run.schema !== "pkm.action.run/v1" || run.content_hash !== source.definitionDigest
      || !object(run.definition) || originalDefinitionValue(run.definition).content_hash !== source.definitionDigest
      || !object(run.inputs) || schemaValueErrors(source.definition.input_schema, run.inputs).length)
      return fail("Historical Run/source/input identity requires exact native reconciliation.", "RECOVERY_CONFLICT");
    const notifications = z.array(z.strictObject({ sequence: z.number().safe().int().positive(), run_id: runId,
      kind: z.string().min(1), at: z.number().finite(), payload: z.record(z.string(), z.json()) })).max(256).parse(run.notifications ?? []);
    const sequence = z.number().safe().int().nonnegative().parse(run.event_sequence ?? 0);
    if (notifications.some((event, index) => event.run_id !== id || event.sequence > sequence
      || index > 0 && event.sequence <= notifications[index - 1]!.sequence))
      return fail("Historical retained notification identity/cursor is invalid.", "RECOVERY_CONFLICT");
    const completed: RecoveredActionRun["completed"] = {}, history: ActionCheckpoint[] = [];
    for (const [path, content] of state.files) {
      if (path.startsWith(`.pkm/state/actions/runs/${id}/checkpoints/`)) {
        const record = decode(content);
        history.push(historicalCheckpoint(record, id, record.state === "resolved" ? "resolved" : record.state === "cancelled" ? "cancelled" : "expired"));
      }
      if (path.startsWith(`.pkm/state/actions/runs/${id}/steps/`)) {
        const receipt = decode(content);
        const step = source.implementation.steps?.find((item: Json) => item.id === receipt.key);
        if (receipt.schema !== "pkm.action.step-receipt/v1" || receipt.state !== "completed" || !step
          || receipt.definition_digest !== originalDigest(step) || !object(receipt.output))
          return fail("Historical step has no exact supported completion receipt; reconcile rather than replay.", "RECOVERY_CONFLICT");
        completed[String(step.id)] = z.record(z.string(), z.json()).parse(receipt.output);
      }
    }
    let target: RecoveredActionRun["state"] = ["failed", "cancelled"].includes(run.state) ? run.state : "unknown";
    let checkpoint: ActionCheckpoint | undefined;
    const cancellation = state.files.get(`.pkm/state/actions/runs/${id}/cancel.json`);
    const launchJournal = state.files.get(`.pkm/state/actions/launch-journal/${id}.json`);
    const pendingProgram = state.files.has(`.pkm/state/actions/runs/${id}/program.json`);
    if (cancellation && decode(cancellation).requested !== true) fail("Malformed old cancellation denial.", "RECOVERY_CONFLICT");
    if (launchJournal) {
      const pending = decode(launchJournal);
      if (pending.record?.run_id !== id || pending.receipt?.run_id !== id
        || pending.receipt?.fingerprint !== run.execution?.invocationFingerprint)
        fail("Conflicting original launch journal requires exact offline recovery.", "RECOVERY_CONFLICT");
    }
    const flatWaiting = run.state === "waiting" && source.nativeControl && !run.parent_run_id && run.root_run_id === id
      && !cancellation && !launchJournal
      && object(run.checkpoint) && source.implementation.steps.some((step: Json) => step.id === run.checkpoint.step
        && ["core.checkpoint", "core.wait"].includes(step.component)) && ["human", "event", "timer"].includes(run.checkpoint.trigger?.kind);
    if (flatWaiting) {
      if (!object(run.execution) || run.execution.phase !== "waiting" || run.execution.workerPid != null)
        return fail("A historical worker/phase is unresolved; it cannot be resumed.", "RECOVERY_CONFLICT");
      const implementationEvidence = [...state.files].find(([path]) => path.startsWith(`.pkm/state/actions/runs/${id}/step-events/`)
        && decode(state.files.get(path)!).key === "__implementation__");
      const observed = implementationEvidence && decode(implementationEvidence[1]);
      if (!observed || observed.schema !== "pkm.action.component-events/v1" || observed.state !== "waiting"
        || observed.definition_digest !== originalDigest(source.implementation))
        return fail("A suspended Run lacks an exact pinned implementation observation.", "RECOVERY_CONFLICT");
      checkpoint = historicalCheckpoint(run.checkpoint, id, "waiting"); target = "waiting";
      const position = source.implementation.steps.findIndex((step: Json) => step.id === checkpoint!.step);
      if (source.implementation.steps.slice(0, position).some((step: Json) => !completed[step.id])
        || Object.keys(completed).some(key => source.implementation.steps.findIndex((step: Json) => step.id === key) >= position))
        return fail("The suspended continuation lacks exact prior receipts or already-started future work.", "RECOVERY_CONFLICT");
    } else if (run.state === "succeeded" && !cancellation && !launchJournal && !pendingProgram) {
      if (!object(run.output) || schemaValueErrors(source.definition.output_schema, run.output).length)
        return fail("Historical successful output violates its pinned source.", "RECOVERY_CONFLICT");
      if (source.implementation.kind === "program") {
        const input = state.files.get(`.pkm/state/actions/runs/${id}/input.json`);
        const result = state.files.get(`.pkm/state/actions/runs/${id}/program-result.json`);
        if (!input || !result || originalDigest(decode(input)) !== originalDigest(run.inputs))
          return fail("Historical program completion has no exact persisted input/result evidence.", "RECOVERY_CONFLICT");
        const receipt = decode(result);
        if (receipt.ok !== true || receipt.cancelled || receipt.timed_out || receipt.stdout_truncated !== false
          || typeof receipt.stdout !== "string" || Buffer.byteLength(receipt.stdout) > 65_536)
          return fail("Historical program result was not proven complete.", "RECOVERY_CONFLICT");
        const decoded = decode(Buffer.from(receipt.stdout));
        if (source.implementation.result_protocol === "pkm.action.result/v1" && (decoded.ok !== true || !object(decoded.output)))
          return fail("Historical strict program protocol does not prove a successful output.", "RECOVERY_CONFLICT");
        const output = source.implementation.result_protocol === "pkm.action.result/v1" && decoded.ok === true ? decoded.output : decoded;
        if (originalDigest(output) !== originalDigest(run.output))
          return fail("Historical stdout receipt conflicts with the original typed output.", "RECOVERY_CONFLICT");
        completed.action = z.record(z.string(), z.json()).parse(output); target = "succeeded";
      }
      else if (source.implementation.kind === "pipeline"
        && source.implementation.steps.every((step: Json) => completed[step.id])) target = "succeeded";
    }
    if (run.state === "cancelled" || cancellation && run.state === "waiting") {
      target = "cancelled";
      if (run.checkpoint) history.push(historicalCheckpoint(run.checkpoint, id, "cancelled"));
    }
    imports.push({
      operationId: uuidFromHash(`${state.custody.capsuleSha256}:${id}`), runId: id, source: source.source,
      previousVersion: z.number().safe().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1).parse(run.execution?.version ?? 0),
      ...(source.selectedActionId ? { actionId: source.selectedActionId } : {}),
      expectedDefinitionDigest: source.definitionDigest, implementationId: source.selectionId,
      inputs: z.record(z.string(), z.json()).parse(run.inputs), state: target, sourceReceiptSha256: state.custody.capsuleSha256,
      completed, history: history.sort((a, b) => a.created_at - b.created_at), ...(checkpoint ? { checkpoint } : {}),
      ...(target === "succeeded" ? { expectedOutput: z.record(z.string(), z.json()).parse(run.output) } : {}),
    });
    const archived = structuredClone(run);
    delete archived.capability_hash; delete archived.launcher_pid; delete archived.worker_pid;
    if (object(archived.execution)) { delete archived.execution.workerPid; delete archived.execution.heartbeat_at; delete archived.execution.lease_expires_at; }
    if (object(archived.checkpoint)) {
      archived.checkpoint.legacy_resume_token_sha256 = hash(String(archived.checkpoint.resume_token));
      delete archived.checkpoint.resume_token;
    }
    legacyRuns.push(archived);
  }
  const jobs: z.infer<typeof originalActionValidationJob>[] = [];
  const queueBytes = state.files.get(".pkm/state/actions/validation-queue.json");
  if (queueBytes) {
    const queue = decode(queueBytes);
    if (queue.schema !== "pkm.action.validation-queue/v1" || !object(queue.jobs) || Object.keys(queue.jobs).length > 2048)
      fail("Invalid bounded original Action qualification queue.", "INVALID_DOCUMENT");
    for (const [id, record] of Object.entries(queue.jobs)) {
      if (!object(record) || record.job_id !== id || !state.sources.some(item =>
        item.actionId === record.action_id && item.definitionDigest === record.content_hash))
        return fail("Historical validation job lost its exact source admission.", "RECOVERY_CONFLICT");
      const target = record.state === "cancelled" || record.state === "failed" ? record.state
        : record.state === "queued" ? "blocked" : "outcome_unknown";
      jobs.push(originalActionValidationJob.parse({
        job_id: id, key: record.key, action_id: record.action_id, content_hash: record.content_hash,
        priority: record.priority, allow_effects: record.allow_effects, queued_at: record.queued_at,
        state: target, stage: target === "blocked" ? "fresh_native_code_review_required" : "historical_qualification_not_current",
        depends_on: record.depends_on, ...(record.run_id ? { run_id: record.run_id } : {}),
      }));
    }
  }
  for (const [path, bytes] of state.files) if (path.startsWith(".pkm/state/actions/validations/")) {
    const validation = decode(bytes);
    if (validation.schema !== "pkm.action.validation/v1" || !state.sources.some(item =>
      item.actionId === validation.action_id && item.definitionDigest === validation.content_hash))
      fail("Historical qualification has no exact current source binding.", "RECOVERY_CONFLICT");
    historicalValidations.push({ path, sha256: hash(bytes), record: validation, admission: "historical-only; not current readiness" });
  }
  return { imports, jobs, legacyRuns, historicalValidations };
}
function readReceipt(storage: Storage, supplied?: DatabaseSync) {
  const database = supplied ?? storage.connectNative();
  try { return readOriginalMcpActionDomainMetadata(storage.workspaceRoot(), database); }
  finally { if (!supplied) database.close(); }
}
/** Historical metadata only; no policy, invocation grant or live Host is constructed. */
export function readOriginalMcpActionDomainMetadata(root: string, database: DatabaseSync) {
  const journal = assertOriginalMcpPrivacy(root);
  if (!journal) return;
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE name='original_mcp_action_domain_intents'").get()) return;
  const expected = new DatabaseSync(":memory:");
  try {
    expected.exec(domainDdl);
    const schema = (db: DatabaseSync) => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name LIKE 'original_mcp_action_domain_%' ORDER BY name").all();
    if (canonicalJson(schema(expected)) !== canonicalJson(schema(database))) fail("Action domain schema changed.", "RECOVERY_CONFLICT");
  } finally { expected.close(); }
  const rows = database.prepare("SELECT * FROM original_mcp_action_domain_intents").all();
  if (rows.length !== 1) fail("Conflicting original Action source admission requires offline review.", "RECOVERY_CONFLICT");
  const row = rows[0]!, receipt = receiptSchema.parse(JSON.parse(String(row.payload))), { receiptSha256, ...body } = receipt;
  if (receiptSha256 !== row.receipt_sha256 || receiptSha256 !== jsonHash(body) || String(row.payload) !== canonicalJson(receipt)
    || receipt.root !== root || receipt.workspaceId !== journal.workspaceId || receipt.custodyPlanSha256 !== journal.plan.planSha256
    || receipt.profileSha256 !== journal.plan.profileSha256) fail("Action domain root/owner/profile binding changed.", "RECOVERY_CONFLICT");
  const nativeHost = verifyOriginalMcpNativeHostReceiptDatabase(database, journal, receipt.nativeHostReceiptSha256), decision = receipt.nativeActionDecision;
  if (nativeHost.profileSha256 !== receipt.profileSha256 || nativeHost.epoch !== receipt.nativeActionEpoch
    || decision.root !== receipt.root || decision.workspaceId !== receipt.workspaceId || decision.profileSha256 !== receipt.profileSha256
    || decision.epoch !== receipt.nativeActionEpoch || decision.capsuleSha256 !== receipt.capsuleSha256
    || decision.requestSha256 !== receipt.approvalDigest)
    fail("The immutable Action receipt has no exact native identity/source decision binding.", "RECOVERY_CONFLICT");
  if (database.prepare("SELECT 1 FROM original_mcp_action_domain_commits WHERE receipt_sha256<>? LIMIT 1").get(receiptSha256))
    fail("Orphan immutable Action source commitment requires offline review.", "RECOVERY_CONFLICT");
  return { receipt, committed: !!database.prepare("SELECT 1 FROM original_mcp_action_domain_commits WHERE receipt_sha256=?").get(receiptSha256) };
}
export function assertOriginalMcpActionDomainSession(storage: Storage, host: OriginalMcpNativeHost): OriginalMcpActionDomainReceipt {
  const policy = activePolicies.get(storage);
  if (!policy) return fail("ORIGINAL_ACTION_SOURCE_ADMISSION_REQUIRED: old Action source/run authority has not been rebound.");
  const state = policyState(policy, storage, host); live(state);
  sourceCurrent(state);
  const admitted = readReceipt(storage);
  if (!admitted?.committed || admitted.receipt.receiptSha256 !== state.receiptSha256)
    return fail("The exact source/state admission has no canonical commit.");
  return admitted.receipt;
}

/** Import transactions invoke the existing Action engine; no successful run/qualification rows are invented. */
export async function admitOriginalMcpActionDomain(owner: RootOwner, actor: Readonly<Actor>, host: OriginalMcpNativeHost,
  policy: OriginalMcpActionNativePolicy) {
  assertRootOwner(owner);
  const { storage, runtime } = await owner.ensureFull(), state = policyState(policy, storage, host), journal = context(storage, host);
  if (actor.id !== "mcp:external" || !actor.canWrite || actor.boardWorker || actor.recipeProtocol)
    return fail("Exact native Action admission requires the fixed writable external actor.", "ACCESS_DENIED");
  const engine = runtime.services.hostServices?.actionRuntime;
  if (!engine) return fail("The canonical native Action engine must be composed before state import.");
  const previous = readReceipt(storage), planned = previous ? undefined : planImport(state);
  if (previous && previous.receipt.capsuleSha256 !== state.custody.capsuleSha256)
    return fail("A different source capsule cannot overwrite the immutable Action domain.", "CONFLICT");
  const approvalDigest = previous?.receipt.approvalDigest ?? jsonHash({ capsuleSha256: state.custody.capsuleSha256,
    imports: planned!.imports, jobs: planned!.jobs, sourceIdentity: state.custody.sourceIdentity });
  const decision = await nativeReview(state, approvalDigest, previous?.committed ? "Reactivate exact original Action source/state" : "Admit exact original Action source/state");
  return storage.withWorkspaceExclusive(() => {
    nativeEpoch(state);
    if (decision.expiresAtMs <= Date.now()) return fail("Native Action admission expired before persistence.");
    const database = storage.connectNative();
    try {
      let existing = readReceipt(storage, database);
      if (!existing) {
        const body = {
          schema: "pkm.original-mcp-action-domain/v1" as const, root: storage.workspaceRoot(), workspaceId: journal.workspaceId,
          custodyPlanSha256: journal.plan.planSha256, profileSha256: journal.plan.profileSha256,
          nativeHostReceiptSha256: host.receipt.receiptSha256, capsuleSha256: state.custody.capsuleSha256,
          sourceIdentity: state.custody.sourceIdentity, sourceSha256: jsonHash(state.custody.files),
          nativeActionEpoch: host.receipt.epoch, actorId: "mcp:external" as const,
          sourcePaths: state.custody.files.filter(file => file.role !== "state").map(file => file.path),
          runIds: state.custody.runIds, approvalDigest, ...planned,
          actionIds: state.sources.map(source => source.actionId),
          nativeActionDecision: decision,
        };
        const receipt = receiptSchema.parse({ ...body, receiptSha256: jsonHash(body) });
        database.exec("BEGIN IMMEDIATE");
        try {
          database.exec(domainDdl);
          database.prepare("INSERT INTO original_mcp_action_domain_intents VALUES(?,?)").run(receipt.receiptSha256, canonicalJson(receipt));
          database.exec("COMMIT");
        } catch (error) { if (database.isTransaction) database.exec("ROLLBACK"); throw error; }
        existing = { receipt, committed: false };
      }
      if (!existing.committed) {
        if (decision.expiresAtMs <= Date.now()) return fail("Native Action admission expired before engine import.");
        state.importing = true;
        try { engine.importRecoveredBatch(actor.id, existing.receipt.imports.map(recoveredInput)); }
        finally { state.importing = false; }
        database.exec("BEGIN IMMEDIATE");
        try {
          for (const job of existing.receipt.jobs) appendOriginalActionValidation(database, journal.workspaceId, job);
          database.prepare("INSERT INTO original_mcp_action_domain_commits VALUES(?)").run(existing.receipt.receiptSha256);
          nativeEpoch(state);
          if (decision.expiresAtMs <= Date.now()) fail("Native Action admission expired before publication commit.");
          database.exec("COMMIT");
        } catch (error) { if (database.isTransaction) database.exec("ROLLBACK"); throw error; }
      }
      state.receiptSha256 = existing.receipt.receiptSha256;
      state.expiresAtMs = decision.expiresAtMs;
      activePolicies.set(storage, policy);
      return { schema: "pkm.original-mcp-action-domain-session/v1" as const, receiptSha256: state.receiptSha256,
        capsuleSha256: state.custody.capsuleSha256, importedRunIds: [...state.custody.runIds],
        expiresAtMs: state.expiresAtMs, automaticReplay: false as const };
    } finally { database.close(); }
  });
}
function assertInvocationGrant(state: DomainPolicyState, call: OriginalActionInvocation) {
  live(state);
  const grant = state.invocationGrants.get(call.runId);
  if (!grant || grant.receiptSha256 !== call.receiptSha256 || grant.expiresAtMs <= Date.now()
    || call.sourceReceiptSha256 !== state.receiptSha256 || call.capsuleSha256 !== state.custody.capsuleSha256)
    fail("ACTION_CONTINUATION_APPROVAL_REQUIRED: this exact Run has no current native invocation consent.", "ACCESS_DENIED");
}
function invocationMatchesSnapshot(call: OriginalActionInvocation, snapshot: Json) {
  return snapshot.runId === call.runId && snapshot.actionId === call.request.action_id
    && snapshot.definitionDigest === call.request.content_hash && originalDigest(snapshot.inputs) === originalDigest(call.request.inputs)
    && originalDigest(snapshot.sourceSnapshot) === call.sourceSnapshotSha256
    && originalDigest(snapshot.implementation) === call.implementationSha256;
}
function executionBindingIsAuthorized(state: DomainPolicyState, definitionDigest: string, nodeId: string, runId?: string) {
  const database = state.storage.connectNative();
  try {
    // The existing engine marks a node running before calling its adapter. Check every
    // matching active binding so a parallel unconsented Run cannot borrow another grant.
    const active = database.prepare(
      "SELECT snapshot FROM action_runtime_runs WHERE actor_id='mcp:external' AND json_extract(snapshot,'$.state')='running' AND json_extract(snapshot,'$.definitionDigest')=?")
      .all(definitionDigest).map(row => decode(Buffer.from(String(row.snapshot))))
      .filter(run => (!runId || run.runId === runId) && run.nodes.some((node: Json) => node.nodeId === nodeId && node.state === "running"));
    if (!active.length) return false;
    const calls = readOriginalActionInvocations(state.storage, state.host.receipt.workspaceId);
    const receipt = readReceipt(state.storage)?.receipt;
    return active.every(run => {
      const call = calls.find(item => item.runId === run.runId);
      if (!call) {
        if (!receipt?.runIds.includes(run.runId)) return false;
        verifyImportedRun(database, receipt, run.runId);
        return true;
      }
      try {
        assertInvocationGrant(state, call);
        return invocationMatchesSnapshot(call, run)
          && (!state.programs?.has(call.request.action_id) || state.programs.hasGrant(run.runId));
      } catch { return false; }
    });
  } finally { database.close(); }
}
function invocationSource(state: DomainPolicyState, request: z.infer<typeof originalActionCall>) {
  const source = state.sources.find(item => item.actionId === request.action_id);
  if (!source) return fail("ORIGINAL_ACTION_SOURCE_ADMISSION_REQUIRED: select and admit this exact Action first.");
  if (source.definitionDigest !== request.content_hash) fail("Pin the current Action definition.", "CONFLICT");
  if (!source.nativeControl && !state.programs?.has(source.actionId))
    fail("ACTION_NATIVE_EFFECT_HANDLER_REQUIRED: new calls support only admitted flat pure/human-input native pipelines.");
  if (Object.keys(source.definition.casts ?? {}).length)
    fail("ACTION_NATIVE_CAST_ADMISSION_REQUIRED: authored invocation casts need their exact native producer.");
  if (source.source.kind === "moduleSet" && loadModuleSet(source.source).definitions.size !== 1)
    fail("ACTION_SELECTED_MEMBER_CREATE_REQUIRED: multi-action packages need an explicit native create selector.");
  if (typeof source.implementation.id !== "string") {
    const platform = process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "Darwin" : "Linux";
    const compatible = source.definition.implementations.filter((item: Json) => item.platforms.includes(platform));
    if (compatible.length > 1)
      fail("ACTION_NATIVE_IMPLEMENTATION_SELECTOR_REQUIRED: ambiguous id-less targets require their explicit native selector.");
  }
  const errors = schemaValueErrors(source.definition.input_schema, request.inputs);
  if (errors.length || !new AjvJsonSchemaValidator().getValidator(source.definition.input_schema)(request.inputs).valid)
    fail(`Action input violates its pinned schema${errors.length ? `: ${errors[0]}` : "."}`, "INVALID_ARGUMENT");
  return source;
}
async function invocationConsent(state: DomainPolicyState, source: NativeSource, binding: Json, signal?: AbortSignal) {
  const combined = AbortSignal.any([state.host.signal, ...(signal ? [signal] : [])]);
  combined.throwIfAborted();
  await state.authority.refresh(); combined.throwIfAborted(); live(state); sourceCurrent(state);
  if (!await state.authority.authorize(source.actionId, source.definitionDigest, state.host.receipt.epoch))
    fail("The native Action host denied this exact source revision.", "ACCESS_DENIED");
  combined.throwIfAborted();
  const exact = structuredClone(binding);
  let abort!: () => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(combined.reason);
    combined.addEventListener("abort", abort, { once: true });
    if (combined.aborted) abort();
  });
  let consented: boolean;
  try {
    consented = await Promise.race([state.authority.authorizeEffects(source.actionId, source.definitionDigest,
      state.host.receipt.epoch, {
        kind: "pipeline", components: source.implementation.steps.map((step: Json) => String(step.component)),
        stepCount: source.implementation.steps.length, effects: [...source.definition.effects],
        inputDigest: originalDigest(exact),
        inputPreview: canonicalJson(exact).slice(0, 4096),
      }), interrupted]);
  } finally { combined.removeEventListener("abort", abort); }
  combined.throwIfAborted();
  await state.authority.refresh(); live(state); sourceCurrent(state);
  combined.throwIfAborted();
  if (!consented) fail("ACTION_EFFECT_CONSENT_REQUIRED: the native operator denied this exact invocation.", "ACCESS_DENIED");
}

/** New invocation authority is consumed before creation and never reconstructed from the SQL receipt. */
export async function invokeOriginalMcpAction(owner: RootOwner, actor: Readonly<Actor>, host: OriginalMcpNativeHost,
  input: Record<string, unknown>, signal?: AbortSignal) {
  assertRootOwner(owner);
  signal?.throwIfAborted();
  const { storage, runtime } = await owner.ensureFull();
  if (actor.id !== "mcp:external" || !actor.canWrite || actor.boardWorker || actor.recipeProtocol)
    fail("Original Action invocation requires the fixed writable external actor.", "ACCESS_DENIED");
  const receipt = assertOriginalMcpActionDomainSession(storage, host), state = policyState(activePolicies.get(storage)!, storage, host);
  const request = originalActionCall.parse(input);
  if (request.trigger !== null) fail("ACTION_NATIVE_SCHEDULE_REQUIRED: planned triggers require their native admission producer.");
  if (request.project_id !== null) fail("ACTION_NATIVE_PROJECT_BINDING_REQUIRED: project-scoped calls require their native project authority.");
  const source = invocationSource(state, request), requestSha256 = jsonHash(request);
  const engine = runtime.services.hostServices?.actionRuntime;
  if (!engine) return fail("ACTION_NATIVE_ENGINE_REQUIRED: the canonical Action engine is unavailable.");
  function existing() {
    const prior = readOriginalActionInvocations(storage, host.receipt.workspaceId)
      .find(item => item.request.idempotency_key === request.idempotency_key);
    if (!prior) return undefined;
    if (prior.requestSha256 !== requestSha256) fail("Invocation key reused with different inputs or revision.", "CONFLICT");
    try { engine!.get(actor.id, prior.runId); }
    catch (error) {
      if (error instanceof CoreError && error.code === "NOT_FOUND")
        fail("ACTION_INVOCATION_RECONCILIATION_REQUIRED: consumed admission has no published Run; do not replay.");
      throw error;
    }
    return { runId: prior.runId, launchReused: true };
  }
  const prior = existing();
  if (prior) return prior;
  const operationId = uuidFromHash(`${host.receipt.workspaceId}\0${actor.id}\0${request.idempotency_key}`);
  const id = `action_run_${operationId.replaceAll("-", "")}`, deadline = Date.now() + 300_000;
  let localProgram: OriginalActionInvocation["localProgram"];
  if (state.programs?.has(source.actionId)) {
    localProgram = await state.programs.approve({ root: storage.workspaceRoot(), workspaceId: host.receipt.workspaceId, actorId: "mcp:external",
      profileSha256: host.receipt.profileSha256, epoch: host.receipt.epoch, capsuleSha256: state.custody.capsuleSha256,
      sourceReceiptSha256: receipt.receiptSha256, nativeHostReceiptSha256: host.receipt.receiptSha256,
      runId: id, request, implementationSha256: originalDigest(source.implementation),
      inputSha256: originalDigest(request.inputs), deadline }, signal);
  } else {
    await invocationConsent(state, source, { schema: "pkm.original-action-invocation-consent/v1", operation: "action_call",
      run_id: id, request, sourceReceiptSha256: receipt.receiptSha256,
      capsuleSha256: state.custody.capsuleSha256, implementationSha256: originalDigest(source.implementation),
      deadline, automaticReplay: false }, signal);
  }
  return storage.withWorkspaceExclusive(() => {
    signal?.throwIfAborted(); assertOriginalMcpActionDomainSession(storage, host);
    const racing = existing();
    if (racing) return racing;
    if (Date.now() >= deadline) fail("Invocation consent expired before creation.", "CONFLICT");
    if (typeof source.implementation.id === "string")
      engine.selectImplementation(actor.id, source.source, source.definitionDigest, source.selectionId);
    const database = storage.connectNative();
    let call: OriginalActionInvocation;
    try {
      database.exec("BEGIN IMMEDIATE");
      call = appendOriginalActionInvocation(database, {
        schema: "pkm.original-mcp-action-invocation/v1", workspaceId: host.receipt.workspaceId, actorId: "mcp:external",
        sourceReceiptSha256: receipt.receiptSha256, capsuleSha256: state.custody.capsuleSha256,
        implementationSha256: originalDigest(source.implementation), sourceSnapshotSha256: originalDigest(source.source), request, requestSha256,
        runId: id, operationId, deadline, nativeActionEpoch: host.receipt.epoch, approvedAt: Date.now(),
        ...(localProgram ? { localProgram } : {}),
      });
      signal?.throwIfAborted(); live(state); sourceCurrent(state);
      database.exec("COMMIT");
    } catch (error) { if (database.isTransaction) database.exec("ROLLBACK"); throw error; }
    finally { database.close(); }
    state.invocationGrants.set(id, { receiptSha256: call.receiptSha256, expiresAtMs: deadline });
    state.creatingInvocation = { runId: id, sourceDigest: source.definitionDigest, inputDigest: originalDigest(request.inputs) };
    try {
      engine.create(actor.id, { operationId, runId: id, source: source.source,
        expectedDefinitionDigest: source.definitionDigest, deadline, inputs: request.inputs });
    } catch (error) { state.invocationGrants.delete(id); throw error; }
    finally { state.creatingInvocation = undefined; }
    runtime.services.hostServices!.wake();
    return { runId: id, launchReused: false };
  });
}

export async function authorizeOriginalMcpActionContinuation(owner: RootOwner, actor: Readonly<Actor>, host: OriginalMcpNativeHost,
  tool: "action_checkpoint_respond" | "action_run_wake", args: Json, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const { storage, runtime } = await owner.ensureFull();
  if (actor.id !== "mcp:external" || !actor.canWrite || actor.boardWorker || actor.recipeProtocol)
    fail("Native continuation requires the fixed writable external actor.", "ACCESS_DENIED");
  const call = readOriginalActionInvocations(storage, host.receipt.workspaceId).find(item => item.runId === args.run_id);
  if (!call) return;
  assertOriginalMcpActionDomainSession(storage, host);
  const state = policyState(activePolicies.get(storage)!, storage, host);
  await state.authority.refresh(); live(state); sourceCurrent(state);
  try { assertInvocationGrant(state, call); return; }
  catch (error) { if (!(error instanceof CoreError) || error.code !== "ACCESS_DENIED") throw error; }
  const engine = runtime.services.hostServices!.actionRuntime, current = engine.get(actor.id, call.runId);
  const checkpoint = engine.checkpoints(actor.id, call.runId).checkpoints.at(-1);
  if (current.state !== "waiting" || !checkpoint || checkpoint.state !== "waiting")
    return fail("Only this exact waiting Run may receive a new continuation consent.", "CONFLICT");
  if (tool === "action_checkpoint_respond") {
    if (checkpoint.resume_token !== args.resume_token || checkpoint.proposal_digest !== args.proposal_digest
      || checkpoint.checkpoint_id !== args.checkpoint_id || checkpoint.trigger.kind !== "human")
      fail("The exact current checkpoint token/proposal is required.", "ACCESS_DENIED");
    checkActionCheckpointAnswer(checkpoint, args.answer);
  } else if (checkpoint.trigger.kind !== "event" || checkpoint.trigger.name !== args.event_name)
    fail("The wake event must match this exact waiting Run.", "CONFLICT");
  const source = invocationSource(state, call.request);
  await invocationConsent(state, source, { schema: "pkm.original-action-invocation-consent/v1", operation: tool,
    run_id: call.runId, expected_version: current.version, request: call.request, response: args,
    sourceReceiptSha256: call.sourceReceiptSha256, capsuleSha256: call.capsuleSha256,
    implementationSha256: call.implementationSha256, automaticReplay: false }, signal);
  signal?.throwIfAborted(); assertOriginalMcpActionDomainSession(storage, host);
  if (engine.get(actor.id, call.runId).version !== current.version)
    fail("The Run changed during continuation consent.", "CONFLICT");
  state.invocationGrants.set(call.runId, { receiptSha256: call.receiptSha256,
    expiresAtMs: Date.now() + Math.min(300_000, checkpoint.remaining_seconds * 1000) });
}

export async function originalMcpActionBlockedContinuations(storage: Storage, host: OriginalMcpNativeHost) {
  const policy = activePolicies.get(storage), state = policy && policyState(policy, storage, host);
  if (state) await state.authority.refresh();
  const database = storage.connectNative();
  try {
    return readOriginalActionInvocations(storage, host.receipt.workspaceId).flatMap(call => {
      const row = database.prepare("SELECT snapshot FROM action_runtime_runs WHERE actor_id=? AND run_id=?").get("mcp:external", call.runId);
      if (!row || !["ready", "running", "waiting", "cancelling"].includes(String(decode(Buffer.from(String(row.snapshot))).state))) return [];
      try { if (state) { assertInvocationGrant(state, call); return []; } } catch {}
      return [call.runId];
    });
  } finally { database.close(); }
}
function recoveredInput(value: unknown): RecoveredActionRun {
  const schema = z.strictObject({
    operationId: z.uuid(), runId, previousVersion: z.number().safe().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1),
    source: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("inline"), definition: z.json() }),
      z.strictObject({ kind: z.literal("moduleSet"), manifest: z.json(), files: z.record(z.string(), z.string()), enabled: z.boolean().optional() }),
    ]), actionId: z.string().optional(), expectedDefinitionDigest: digest, implementationId: z.string(),
    inputs: z.record(z.string(), z.json()), state: z.enum(["unknown", "waiting", "succeeded", "failed", "cancelled"]),
    sourceReceiptSha256: digest, completed: z.record(z.string(), z.record(z.string(), z.json())),
    checkpoint: actionCheckpoint.optional(), history: z.array(actionCheckpoint),
    expectedOutput: z.record(z.string(), z.json()).optional(),
  });
  return schema.parse(value);
}
export function originalMcpActionRunIsAdmitted(storage: Storage, id: string): boolean {
  return readReceipt(storage)?.receipt.runIds.includes(id) ?? false;
}
export function originalMcpActionRunNeedsAdmission(storage: Storage, id: string): boolean {
  if (!runId.safeParse(id).success || !readOriginalMcpJournal(storage.workspaceRoot())) return false;
  return !!lstatSync(join(storage.workspaceRoot(), ".pkm/state/actions/runs", id, "run.json"), { throwIfNoEntry: false });
}
export function originalMcpActionValidationNeedsAdmission(storage: Storage) {
  const root = storage.workspaceRoot();
  if (!readOriginalMcpJournal(root)) return false;
  return !!lstatSync(join(root, ".pkm/state/actions/validation-queue.json"), { throwIfNoEntry: false });
}
export function assertOriginalMcpActionRecoveryCoverage(storage: Storage, host: OriginalMcpNativeHost) {
  const path = join(storage.workspaceRoot(), ".pkm/state/actions/runs");
  if (!lstatSync(path, { throwIfNoEntry: false })) return;
  const ids = readdirSync(path).filter(name => runId.safeParse(name).success);
  if (!ids.length) return;
  const receipt = assertOriginalMcpActionDomainSession(storage, host);
  if (ids.some(id => !receipt.runIds.includes(id)))
    fail("ORIGINAL_ACTION_RUN_COVERAGE_REQUIRED: unselected old work cannot be reported as recovered.");
}
export function originalMcpActionSourceIsAdmitted(storage: Storage, id: string): boolean {
  return readReceipt(storage)?.receipt.actionIds.includes(id) ?? false;
}
export function assertOriginalMcpActionImplementation(storage: Storage, host: OriginalMcpNativeHost, id: string, implementationId: string) {
  assertOriginalMcpActionDomainSession(storage, host);
  const state = policyState(activePolicies.get(storage)!, storage, host);
  if (!state.sources.some(source => source.actionId === id && source.selectionId === implementationId))
    fail("ACTION_IMPLEMENTATION_READMISSION_REQUIRED: changing the backed target binding requires a new exact native source review.");
}
export function readOriginalMcpActionSource(storage: Storage, host: OriginalMcpNativeHost, id: string) {
  assertOriginalMcpActionDomainSession(storage, host);
  const state = policyState(activePolicies.get(storage)!, storage, host);
  const source = state.sources.find(item => item.actionId === id);
  return source ? structuredClone(source.definition) : undefined;
}
export function readOriginalMcpActionAuthoringSources(storage: Storage, host: OriginalMcpNativeHost) {
  if (!readReceipt(storage)) return [];
  assertOriginalMcpActionDomainSession(storage, host);
  const state = policyState(activePolicies.get(storage)!, storage, host), seen = new Set<string>();
  return state.sources.flatMap(item => {
    if (item.source.kind === "moduleSet") {
      const key = item.actionId;
      if (seen.has(key)) return [];
      seen.add(key);
      const manifest = item.source.manifest as Json;
      const { package_hash: _packageHash, ...body } = manifest;
      const unsigned = { ...body, actions: [item.actionId],
        resources: manifest.resources?.[item.actionId] ? { [item.actionId]: manifest.resources[item.actionId] } : {} };
      return [{ ...structuredClone(item.source), manifest: { ...unsigned, package_hash: originalDigest(unsigned) } }];
    }
    const member = `definitions/${item.actionId}.json`, content = canonicalJson(portableActionDefinition(item.definition));
    const unsigned = { schema: "pkm.action.module-set/v1", module_set_id: `original.registry-${hash(item.actionId).slice(0, 24)}`,
      version: 1, name: "Admitted original registry compiler snapshot", actions: [item.actionId],
      files: { [member]: hash(content) }, resources: {},
      provenance: { source: item.sourcePath, authority: "compiler representation; not invocation authority" } };
    return [{ kind: "moduleSet" as const, manifest: { ...unsigned, package_hash: originalDigest(unsigned) },
      files: { [member]: content }, enabled: true }];
  });
}
/** Read-only selected B0 descriptors for the Core-owned native producer endpoint. Never an admission. */
export function readOriginalMcpActionCustodySources(storage: Storage, host: OriginalMcpNativeHost, input: OriginalMcpActionCustody) {
  const journal = context(storage, host), checked = capsule(input, journal.plan);
  return sources(checked.value, checked.files).map(source => ({
    actionId: source.actionId, contentHash: source.definitionDigest, implementationSha256: originalDigest(source.implementation),
    effects: [...source.definition.effects] as string[], nativeControl: source.nativeControl,
    components: source.implementation.kind === "pipeline" ? source.implementation.steps.map((step: Json) => String(step.component)) : [],
    ...(source.implementation.kind === "program" ? { program: structuredClone(source.implementation) } : {}),
  }));
}
export function originalMcpActionRunOrigin(storage: Storage, host: OriginalMcpNativeHost, id: string) {
  const receipt = assertOriginalMcpActionDomainSession(storage, host);
  const database = storage.connectNative();
  try { verifyImportedRun(database, receipt, id); } finally { database.close(); }
  return receipt.legacyRuns.map(value => z.record(z.string(), z.json()).parse(value)).find(value => value.run_id === id);
}
function verifyImportedRun(database: DatabaseSync, receipt: OriginalMcpActionDomainReceipt, id: string) {
  const expected = receipt.imports.map(recoveredInput).find(value => value.runId === id);
  const row = database.prepare("SELECT snapshot FROM action_runtime_runs WHERE actor_id='mcp:external' AND run_id=?").get(id);
  const snapshot = row && decode(Buffer.from(String(row.snapshot)));
  if (!expected || !snapshot || snapshot.runId !== id || snapshot.originalAdmissionSha256 !== receipt.capsuleSha256
    || snapshot.definitionDigest !== expected.expectedDefinitionDigest || originalDigest(snapshot.sourceSnapshot) !== originalDigest(expected.source)
    || originalDigest(snapshot.inputs) !== originalDigest(expected.inputs) || snapshot.selectedActionId !== expected.actionId)
    fail("Canonical Action state lost its exact source/input/owner admission.", "RECOVERY_CONFLICT");
}
export function originalMcpActionRelatedRuns(storage: Storage, host: OriginalMcpNativeHost, id: string) {
  const receipt = assertOriginalMcpActionDomainSession(storage, host);
  const records = receipt.legacyRuns.map(value => z.record(z.string(), z.json()).parse(value));
  const selected = records.find(value => value.run_id === id);
  if (!selected) return [id];
  const root = selected.root_run_id ?? selected.run_id;
  return records.filter(value => (value.root_run_id ?? value.run_id) === root).map(value => runId.parse(value.run_id));
}
export function readOriginalMcpActionModuleSets(storage: Storage, host: OriginalMcpNativeHost) {
  assertOriginalMcpActionDomainSession(storage, host);
  const state = policyState(activePolicies.get(storage)!, storage, host), seen = new Set<string>();
  const modules = state.sources.flatMap(source => {
    if (source.source.kind !== "moduleSet" || !source.sourcePath.startsWith("action-module-sets/")) return [];
    const loaded = loadModuleSet(source.source), key = `${loaded.projection.module_set_id}/${loaded.projection.version}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ ...loaded.projection, enabled: false }];
  });
  return { ok: true, module_sets: modules };
}
export function verifyOriginalMcpActionDomain(storage: Storage, supplied?: DatabaseSync) {
  assertStorage(storage); storage.assertWorkspaceLease();
  const database = supplied ?? storage.connectNative();
  try { return verifyOriginalMcpActionDomainReadState(storage.workspaceRoot(), database); }
  finally { if (!supplied) database.close(); }
}
export function verifyOriginalMcpActionDomainReadState(root: string, database: DatabaseSync) {
  const admitted = readOriginalMcpActionDomainMetadata(root, database);
  if (!admitted?.committed) return fail("The original Action source/state publication is incomplete.", "RECOVERY_REQUIRED");
  for (const id of admitted.receipt.runIds) verifyImportedRun(database, admitted.receipt, id);
  for (const call of readOriginalActionInvocationsMetadata(database, admitted.receipt.workspaceId)) {
    if (call.sourceReceiptSha256 !== admitted.receipt.receiptSha256 || call.capsuleSha256 !== admitted.receipt.capsuleSha256
      || call.localProgram && (call.localProgram.request.root !== root
        || call.localProgram.request.profileSha256 !== admitted.receipt.profileSha256))
      fail("Native invocation lost its exact source/root/profile receipt.", "RECOVERY_CONFLICT");
    const row = database.prepare("SELECT snapshot FROM action_runtime_runs WHERE actor_id=? AND run_id=?").get("mcp:external", call.runId);
    const snapshot = row && decode(Buffer.from(String(row.snapshot)));
    if (!snapshot) continue; // Consumed admission without a Run remains evidence, never a replay grant.
    if (!invocationMatchesSnapshot(call, snapshot))
      fail("Native invocation lost its exact input/implementation receipt.", "RECOVERY_CONFLICT");
  }
  return admitted.receipt;
}
export async function reconcileOriginalMcpActionRun(owner: RootOwner, actor: Readonly<Actor>, host: OriginalMcpNativeHost,
  input: { run_id: string; expected_version: number; kind?: string; evidence?: Record<string, unknown> | null; outcome?: string | null }) {
  const { storage, runtime } = await owner.ensureFull(), receipt = assertOriginalMcpActionDomainSession(storage, host);
  if (!actor.canWrite || actor.id !== "mcp:external" || actor.boardWorker) fail("Native Action reconciliation requires write authority.", "ACCESS_DENIED");
  if (!receipt.runIds.includes(input.run_id) || (input.kind ?? "manual") !== "manual")
    fail("ACTION_NATIVE_RECONCILER_REQUIRED: only an admitted Run with exact manual evidence is supported.");
  const expectedVersion = z.number().safe().int().positive().parse(input.expected_version);
  const outcome = z.enum(["succeeded", "failed", "cancelled", "review"]).parse(input.outcome);
  const evidence = z.record(z.string(), z.unknown()).parse(input.evidence);
  if (typeof evidence.reason !== "string" || !evidence.reason.trim()) fail("Explicit manual evidence reason is required.", "INVALID_ARGUMENT");
  const current = runtime.services.hostServices!.actionRuntime.get(actor.id, input.run_id);
  if (current.state !== "unknown" || current.version !== expectedVersion)
    fail("Reconciliation requires this admitted Run's exact current uncertain revision.", "CONFLICT");
  const policy = activePolicies.get(storage)!, state = policyState(policy, storage, host);
  await nativeReview(state, jsonHash({ receiptSha256: receipt.receiptSha256, request: input }), "Manually reconcile original Action evidence; NO replay");
  return storage.withWorkspaceExclusive(() => {
    live(state);
    return runtime.services.hostServices!.actionRuntime.reconcileRecovered(actor.id, {
      runId: runId.parse(input.run_id), expectedVersion,
      sourceReceiptSha256: receipt.capsuleSha256, outcome, evidence,
    });
  });
}

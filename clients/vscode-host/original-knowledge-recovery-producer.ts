import * as vscode from "vscode";
import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { documentPath } from "../../src/document-path.js";
import { originalMcpNativeSigner } from "./original-mcp-native-identity.js";
import {
  originalRecoveryDigest as digest, originalRecoveryPhase1Methods, originalRecoverySignedSessionSchema,
  originalRecoverySourcePayloadSchema, originalRecoveryRepairPayloadSchema,
  originalRecoverySourceResultSchema, originalRecoveryRepairResultSchema, validateOriginalRecoveryEvidence,
  parseOriginalRecoveryPhase1Payload, originalRecoveryIdentitySchema,
  type OriginalRecoveryEvidence,
  type OriginalRecoverySignedSession, type OriginalRecoveryPhase1Method,
} from "../../src/original-knowledge-recovery-contracts.js";

function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
type Identity = z.infer<typeof originalRecoveryIdentitySchema>;
function identity(stat: BigIntStats): Identity {
  return {
    device: String(stat.dev), inode: String(stat.ino), uid: String(stat.uid), mode: Number(stat.mode & 0o777n), links: Number(stat.nlink),
    size: Number(stat.size), mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs),
  };
}
async function directory(path: string) {
  if (await realpath(path) !== path) fail("RECOVERY_UNSAFE_EVIDENCE");
  for (let current = path; ; current = dirname(current)) {
    const stat = await lstat(current, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o002n) fail("RECOVERY_UNSAFE_EVIDENCE");
    if (dirname(current) === current) break;
  }
  const stat = await lstat(path, { bigint: true });
  if (stat.uid !== BigInt(process.getuid!()) || stat.mode & 0o077n) fail("RECOVERY_UNSAFE_EVIDENCE");
  return identity(stat);
}
async function anchoredDirectory(path: string, expected: Identity) {
  let file = await open("/", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const part of path.split("/").filter(Boolean)) {
      const next = await open(`/proc/self/fd/${file.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        const stat = await next.stat({ bigint: true });
        if (!stat.isDirectory() || stat.mode & 0o002n) fail("RECOVERY_UNSAFE_EVIDENCE");
      } catch (error) { await next.close(); throw error; }
      const previous = file; file = next; await previous.close();
    }
    if (digest(identity(await file.stat({ bigint: true }))) !== digest(expected)) fail("RECOVERY_EVIDENCE_CHANGED");
    return file;
  } catch (error) { await file.close(); throw error; }
}
async function boundedFile(directory: FileHandle, name: string, maximum: number, current: () => void) {
  current();
  const path = `/proc/self/fd/${directory.fd}/${name}`, before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.uid !== BigInt(process.getuid!())
    || before.mode & 0o7002n || before.size > BigInt(maximum)) fail("RECOVERY_UNSAFE_EVIDENCE");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (digest(identity(await file.stat({ bigint: true }))) !== digest(identity(before))) fail("RECOVERY_EVIDENCE_CHANGED");
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let size = 0;
    while (size < bytes.length) {
      current();
      const result = await file.read(bytes, size, bytes.length - size, size);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    current();
    if (size !== Number(before.size) || digest(identity(await file.stat({ bigint: true }))) !== digest(identity(before))
      || digest(identity(await lstat(path, { bigint: true }))) !== digest(identity(before))) fail("RECOVERY_EVIDENCE_CHANGED");
    return { identity: identity(before), bytes: bytes.subarray(0, size) };
  } finally { await file.close(); }
}
async function inspectSelectedEvidence(path: string, root: string, expected: Identity,
  current: () => void): Promise<OriginalRecoveryEvidence> {
  current();
  const selected = await anchoredDirectory(path, expected);
  try {
    const directoryIdentity = identity(await selected.stat({ bigint: true }));
    const planFile = await boundedFile(selected, "plan.json", 2_097_152, current);
    const plan = z.object({
      schema: z.literal("pkm.knowledge-recovery/v1"), knowledgeRoot: z.literal(root),
      files: z.array(z.strictObject({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
        mode: z.enum(["100644", "100755"]) })).length(1),
    }).parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(planFile.bytes)));
    const row = plan.files[0]!, [area, ...parts] = row.path.split("/");
    if (!["notes", "skills"].includes(area!) || !documentPath.safeParse(parts.join("/")).success
      || ["system", "_assets"].includes(parts[0]?.toLowerCase() ?? "")) fail("RECOVERY_PHASE1_SCOPE_REQUIRED");
    const blobs = await open(`/proc/self/fd/${selected.fd}/blobs`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    let blob;
    try {
      const stat = await blobs.stat({ bigint: true });
      if (!stat.isDirectory() || stat.uid !== BigInt(process.getuid!()) || stat.mode & 0o077n) fail("RECOVERY_UNSAFE_EVIDENCE");
      blob = await boundedFile(blobs, row.sha256, 16_777_216, current);
    } finally { await blobs.close(); }
    if (createHash("sha256").update(blob.bytes).digest("hex") !== row.sha256) fail("RECOVERY_BLOB_HASH_MISMATCH");
    current();
    if (digest(await directory(path)) !== digest(directoryIdentity)) fail("RECOVERY_EVIDENCE_CHANGED");
    const body = {
      schema: "pkm.original-recovery-evidence/v1" as const, directory: path, directoryIdentity,
      knowledgeRoot: root, planSha256: createHash("sha256").update(planFile.bytes).digest("hex"),
      planIdentity: planFile.identity, files: [{ ...row, identity: blob.identity }],
    };
    return validateOriginalRecoveryEvidence({ ...body, manifestSha256: digest(body) });
  } finally { await selected.close(); }
}
async function settled<T>(work: Thenable<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(Object.assign(new Error("RECOVERY_NATIVE_CANCELLED"), { code: "RECOVERY_NATIVE_CANCELLED" }));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(work).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

/** HELD leaf only: no activation/transport registration until Parent coordinates shared wiring. */
export async function createOriginalKnowledgeRecoveryProducer(context: vscode.ExtensionContext, options: {
  session: OriginalRecoverySignedSession; signal: AbortSignal; assertCurrent(): void;
}) {
  const signer = await originalMcpNativeSigner(context);
  const session = originalRecoverySignedSessionSchema.parse(structuredClone(options.session));
  const lifetime = new AbortController(), retired = new Set<string>();
  const sources = new Map<string, { evidence: OriginalRecoveryEvidence; publicDigest: string; expiresAtMs: number; signal: AbortSignal }>();
  let pending = false;
  function current(signal?: AbortSignal) {
    signer.assertCurrent(); options.assertCurrent();
    if (lifetime.signal.aborted || options.signal.aborted || signer.signal.aborted || signal?.aborted) fail("RECOVERY_NATIVE_CANCELLED");
    if (!vscode.workspace.isTrusted || session.activationId !== signer.activationId || session.epoch !== signer.activationId
      || session.identitySha256 !== signer.identity.sha256 || session.binding.profileSha256 !== signer.identity.profileSha256
      || session.binding.payloadBuildId !== signer.payloadBuildId || session.binding.hostEntrySha256 !== signer.hostEntrySha256)
      fail("RECOVERY_SIGNED_BINDING_MISMATCH");
  }
  let workspaceChange: vscode.Disposable | undefined;
  const dispose = () => {
    if (!lifetime.signal.aborted) lifetime.abort();
    sources.clear(); retired.clear();
    const workspaceSubscription = workspaceChange; workspaceChange = undefined;
    try { workspaceSubscription?.dispose(); }
    finally {
      options.signal.removeEventListener("abort", dispose); signer.signal.removeEventListener("abort", dispose);
      const index = context.subscriptions.indexOf(subscription);
      if (index !== -1) context.subscriptions.splice(index, 1);
    }
  };
  const subscription = { dispose };
  try {
    workspaceChange = vscode.workspace.onDidChangeWorkspaceFolders(dispose);
    options.signal.addEventListener("abort", dispose, { once: true }); signer.signal.addEventListener("abort", dispose, { once: true });
    current();
    context.subscriptions.push(subscription);
  } catch (error) { dispose(); throw error; }
  async function handle(method: OriginalRecoveryPhase1Method, value: unknown, requestId: string, signal: AbortSignal) {
    current(signal); z.string().uuid().parse(requestId);
    parseOriginalRecoveryPhase1Payload(method, structuredClone(value), session);
    if (pending || retired.has(requestId) || retired.size >= 2048) fail("RECOVERY_NATIVE_REQUEST_BUSY_OR_REPLAY");
    retired.add(requestId); pending = true;
    const combined = AbortSignal.any([lifetime.signal, options.signal, signer.signal, signal]);
    try {
      if (method === originalRecoveryPhase1Methods.source) {
        const payload = originalRecoverySourcePayloadSchema.parse(value), request = payload.request;
        const selected = await settled(vscode.window.showOpenDialog({
          canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
          title: "Select external PKM recovery evidence (read-only; no Knowledge repair)",
          openLabel: "Select evidence only",
        }), combined);
        current(combined);
        const path = selected?.length === 1 && selected[0]?.scheme === "file" ? selected[0].fsPath : undefined;
        if (!path || path !== request.publicRequest.arguments.evidence_directory) return null;
        if (path === session.binding.root || path.startsWith(session.binding.root + "/") || session.binding.root.startsWith(path + "/"))
          fail("RECOVERY_EXTERNAL_EVIDENCE_REQUIRED");
        const selectedIdentity = await directory(path);
        const answer = await settled(vscode.window.showWarningMessage(
          "Allow bounded read of this native-selected external recovery evidence only?",
          { modal: true, detail: JSON.stringify({ directory: path, directoryIdentity: selectedIdentity, requestSha256: payload.requestSha256,
            scope: "One Note/Skill Markdown plan only. No Knowledge writes, audit writes, private/Paper/assets/fullRoot or repair authority." }, null, 2) },
          "Deny", "Read selected evidence only"), combined);
        current(combined);
        if (answer !== "Read selected evidence only") return null;
        const evidence = await inspectSelectedEvidence(path, session.binding.root, selectedIdentity, () => current(combined));
        for (const [id, entry] of sources) if (entry.expiresAtMs <= Date.now() || entry.signal.aborted) sources.delete(id);
        if (sources.size >= 128 || sources.has(request.operationId)) fail("RECOVERY_NATIVE_SOURCE_LEDGER_FULL_OR_REPLAY");
        const decision = { decision: "approve" as const, actorId: "mcp:external" as const, decisionId: randomUUID(),
          operationId: request.operationId, requestSha256: payload.requestSha256, epoch: session.epoch, expiresAtMs: Date.now() + 120000 };
        const result = originalRecoverySourceResultSchema.parse({ decision, evidence, evidenceSha256: digest(evidence) });
        sources.set(request.operationId, { evidence: structuredClone(evidence), publicDigest: digest(request.publicRequest),
          expiresAtMs: decision.expiresAtMs, signal: AbortSignal.any([lifetime.signal, options.signal, signer.signal]) });
        return result;
      }
      const payload = originalRecoveryRepairPayloadSchema.parse(value), request = payload.request;
      const source = sources.get(request.operationId);
      if (!source || source.signal.aborted || source.expiresAtMs <= Date.now()
        || source.publicDigest !== digest(request.publicRequest) || digest(source.evidence) !== digest(request.evidence))
        fail("RECOVERY_GENUINE_SOURCE_GRANT_REQUIRED");
      sources.delete(request.operationId);
      const actual = await inspectSelectedEvidence(source.evidence.directory, session.binding.root,
        source.evidence.directoryIdentity, () => current(combined));
      if (digest(actual) !== digest(source.evidence)) fail("RECOVERY_EVIDENCE_CHANGED");
      const answer = await settled(vscode.window.showWarningMessage(
        "Repair ONE registered PUBLIC, unshared, asset-free missing Note/Skill owner?",
        { modal: true, detail: JSON.stringify({ owner: request.owner, evidence: request.evidence,
          requestSha256: payload.requestSha256, repairPlanSha256: request.repairPlanSha256,
          scope: "Exact retained hash/raw ID/revision/mode only; exclusive no-overwrite publication, external evidence audit and same-owner custody/index/receipt successor. No unknown owner, private/Paper/assets/fullRoot or arbitrary crash recovery." }, null, 2) },
        "Deny", "Repair this exact missing owner"), combined);
      current(combined);
      if (source.expiresAtMs <= Date.now()) fail("RECOVERY_NATIVE_EXPIRED");
      if (answer !== "Repair this exact missing owner") return null;
      return originalRecoveryRepairResultSchema.parse({
        decision: "approve", actorId: "mcp:external", decisionId: randomUUID(),
        operationId: request.operationId, requestSha256: payload.requestSha256, epoch: session.epoch,
        expiresAtMs: Math.min(source.expiresAtMs, Date.now() + 120000),
      });
    } finally { pending = false; }
  }
  return Object.freeze({ methods: Object.values(originalRecoveryPhase1Methods), signal: lifetime.signal, handle, dispose });
}

import { fstatSync, lstatSync, readdirSync } from "node:fs";
import { join, posix } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { CoreError } from "./contracts.js";
import { documentPath } from "./document-path.js";
import { decodeMarkdown, decodeMarkdownPath } from "./markdown.js";
import { markdownReferences, localAssetReference } from "./domain/markdown-assets.js";
import { originalMcpPrivateTopLevels, readOriginalMcpJournal } from "./original-mcp-root-custody.js";
import { originalRecoveryDigest as digest, validateOriginalRecoveryRegisteredOwner, type OriginalRecoveryEvidence } from "./original-knowledge-recovery-contracts.js";
import { originalRecoveryIndexRow, originalRecoveryPredecessor, originalRecoveryRegistrationDigest } from "./original-knowledge-recovery-state.js";
import {
  readRecoveryFileAt, recoveryFileIdentity, withRecoveryDirectory, withRecoveryParent,
} from "./original-knowledge-recovery-files.js";
import type { OriginalRecoveryCapture, OriginalRecoveryObservation } from "./original-knowledge-recovery-planner.js";
import { assertStorage, type Storage } from "./storage.js";
import { openOriginalMcpCustodyReader } from "./original-mcp-root.js";
import { assertOriginalRecoverySourceGrant, originalRecoveryApprovedEvidence,
  type OriginalRecoveryPhase1Port, type OriginalRecoverySourceGrant } from "./original-knowledge-recovery-native.js";

export interface OriginalRecoveryCustodyProof { readonly kind: "pkm.original-recovery-custody-proof/v1" }
const proofs = new WeakMap<object, { storage: Storage; reader: Awaited<ReturnType<typeof openOriginalMcpCustodyReader>>;
  row: Record<string, unknown>; active: boolean }>();
export async function captureOriginalRecoveryCustodyProof(storage: Storage, port: OriginalRecoveryPhase1Port,
  source: OriginalRecoverySourceGrant): Promise<OriginalRecoveryCustodyProof> {
  assertStorage(storage); assertOriginalRecoverySourceGrant(port, source);
  const evidence = originalRecoveryApprovedEvidence(port, source), row = evidence.files[0]!;
  const [area, top] = row.path.split("/");
  if (originalMcpPrivateTopLevels(storage.workspaceRoot(), area!).has(top!)) fail("Private recovery owner remains denied.");
  const journal = readOriginalMcpJournal(storage.workspaceRoot());
  if (!journal || evidence.knowledgeRoot !== storage.workspaceRoot()) fail("Recovery custody belongs to another Root.");
  const reader = await openOriginalMcpCustodyReader(journal!.plan);
  try {
    const entry = reader.entry(row.path);
    if (!entry || entry.kind !== "file") fail("Unknown absent ownership cannot be admitted by a recovery plan.");
    const proof = Object.freeze({ kind: "pkm.original-recovery-custody-proof/v1" as const });
    proofs.set(proof, { storage, reader, row: { ...entry }, active: true }); return proof;
  } catch (error) { reader.close(); throw error; }
}
export function readOriginalRecoveryCustodyProof(storage: Storage, value: OriginalRecoveryCustodyProof) {
  const proof = proofs.get(value);
  if (!proof || proof.storage !== storage || !proof.active) fail("A genuine same-owner custody reader is required.");
  proof!.reader.assertCurrent(); storage.assertWorkspaceLease();
  return { row: { ...proof!.row }, current: () => {
    if (!proof!.active) fail("Recovery custody capture closed.");
    proof!.reader.assertCurrent(); storage.assertWorkspaceLease();
  } };
}
export function closeOriginalRecoveryCustodyProof(value: OriginalRecoveryCustodyProof) {
  const proof = proofs.get(value);
  if (proof && proof.active) { proof.active = false; proof.reader.close(); }
}

const fail = (message: string): never => { throw new CoreError("ACCESS_DENIED", message); };
function referenceProof(root: string, target: string, source: Buffer, current: () => void,
  ownStage?: { path: string; identity: ReturnType<typeof recoveryFileIdentity> }) {
  if (markdownReferences(source.toString("utf8")).some(reference => localAssetReference(reference.value)))
    fail("Phase1 owner must be asset/local-reference free.");
  let entries = 0, bytes = source.length;
  for (const area of ["notes", "skills", "papers"]) {
    const privateNames = originalMcpPrivateTopLevels(root, area);
    const visit = (path: string, depth: number) => {
      current();
      if (depth > 16) fail("Phase1 reference proof exceeds its bounded namespace.");
      withRecoveryDirectory(path, fd => {
        const names = readdirSync(`/proc/self/fd/${fd}`);
        if (names.length > 1024) fail("Phase1 reference proof exceeds its bounded entries.");
        for (const name of names) {
          if (++entries > 2048) fail("Phase1 reference proof exceeds its bounded entries.");
          const full = join(path, name), stat = lstatSync(`/proc/self/fd/${fd}/${name}`, { bigint: true });
          if (stat.isSymbolicLink()) fail("Phase1 reference proof refuses links.");
          if (ownStage && posix.relative(root, full) === ownStage.path) {
            if (digest(recoveryFileIdentity(stat)) !== digest(ownStage.identity)) fail("The exclusive recovery stage changed.");
            continue;
          }
          if (depth === 0 && privateNames.has(name)) {
            fail("A private referrer namespace cannot be inspected under PUBLIC recovery consent; an unshared proof is unavailable.");
          }
          if (name === ".trash" || name === ".gitkeep") continue;
          if (name.startsWith(".") || name === "_assets" || /\.assets$/i.test(name))
            fail("Phase1 reference proof refuses unknown/resource subtrees.");
          if (stat.isDirectory()) { visit(full, depth + 1); continue; }
          const relative = posix.relative(join(root, area), full);
          if (!stat.isFile() || !documentPath.safeParse(relative).success) fail("Phase1 namespace contains an unknown reference source.");
          if (`${area}/${relative}` === target) continue;
          bytes += Number(stat.size);
          if (bytes > 16_777_216) fail("Phase1 reference bytes exceed their aggregate bound.");
          const read = readRecoveryFileAt(fd, name, 16_777_216 - (bytes - Number(stat.size)), current);
          const doc = decodeMarkdown("recovery-reference", read.bytes.toString("utf8"), relative, area as "notes" | "skills" | "papers");
          const file = doc.metadata.get("file");
          const references = [...markdownReferences(doc.raw).map(reference => reference.value), ...(typeof file === "string" ? [file] : [])];
          for (const reference of references) {
            const local = localAssetReference(reference);
            if (local && posix.normalize(posix.join(area, posix.dirname(relative), local)) === target)
              fail("The registered recovery owner has another public referrer.");
          }
        }
      });
    };
    if (lstatSync(join(root, area), { throwIfNoEntry: false })) visit(join(root, area), 0);
  }
}
/** Reads an already registered owner/index; never rescans it into a new identity. */
export function assembleRecoveryOwner(db: DatabaseSync, root: string, evidence: OriginalRecoveryEvidence,
  source: { planBytes: Buffer; bytes: Buffer }, custodyRow: Record<string, unknown>,
  binding: { nativeHostReceiptSha256: string; epoch: string; ownerId: string; fence: number }, current: () => void,
  ownStage?: { path: string; identity: ReturnType<typeof recoveryFileIdentity> }) {
  current();
  const journal = readOriginalMcpJournal(root), row = evidence.files[0]!, [area, ...parts] = row.path.split("/"), path = parts.join("/");
  if (!journal || !["notes", "skills"].includes(area!) || !documentPath.safeParse(path).success
    || originalMcpPrivateTopLevels(root, area!).has(parts[0]!) || ["system", "_assets"].includes(parts[0]!.toLowerCase()))
    fail("Recovery owner is not an admitted PUBLIC Note/Skill.");
  const match = db.prepare("SELECT id FROM documents WHERE area=? AND path=? AND deleted=0").all(area!, path);
  if (match.length !== 1) fail("Recovery cannot adopt an unknown/ambiguous absent document.");
  const index = originalRecoveryIndexRow(db, String(match[0]!.id)), decoded = decodeMarkdownPath(source.bytes.toString("utf8"), path, area as "notes" | "skills");
  const knowledgeId = decoded.metadata.get("knowledgeId");
  if (!Buffer.from(source.bytes.toString("utf8")).equals(source.bytes) || typeof knowledgeId !== "string"
    || decoded.record.id !== index.id || decoded.record.sha256 !== index.sha256 || decoded.record.revision !== index.revision
    || decoded.metadata.has("memory") || decoded.metadata.get("documentKind") === "todo-board"
    || custodyRow.path !== row.path || custodyRow.kind !== "file" || custodyRow.sha256 !== index.sha256
    || row.sha256 !== index.sha256 || ![0o644, 0o755].includes(Number(custodyRow.mode))
    || row.mode !== (custodyRow.mode === 0o755 ? "100755" : "100644"))
    fail("Retained registered raw identity/hash/mode proof is absent; the public plan is not authority.");
  for (const sibling of [row.path.replace(/\.md$/i, ".assets"),
    `boards/${path.replace(/\.md$/i, "")}/pkm-todo-board.json`])
    if (lstatSync(join(root, sibling), { throwIfNoEntry: false })) fail("Phase1 cannot repair assets/Boards or missing parent trees.");
  referenceProof(root, row.path, source.bytes, current, ownStage);
  const owner = validateOriginalRecoveryRegisteredOwner({
    area, id: index.id, knowledgeId, path, revision: index.revision, sha256: index.sha256,
    bytes: source.bytes.length, mode: row.mode,
    registrationReceiptSha256: originalRecoveryRegistrationDigest(journal!.plan.planSha256, journal!.plan.inventorySha256, custodyRow, index),
    custodyPredecessorSha256: originalRecoveryPredecessor(db, root), indexRowSha256: digest(index),
    privacy: "public", deleted: false, documentKind: area === "notes" ? "note" : "skill", assets: [], referrers: [],
  });
  return withRecoveryParent(root, row.path, (fd, leaf) => {
    const named = lstatSync(`/proc/self/fd/${fd}/${leaf}`, { bigint: true, throwIfNoEntry: false });
    const destination: OriginalRecoveryObservation = !named ? { kind: "missing" }
      : { kind: "regular", bytes: readRecoveryFileAt(fd, leaf, 16_777_216 - source.bytes.length, current).bytes };
    const capture: OriginalRecoveryCapture = {
      knowledgeRoot: root, planBytes: source.planBytes, expectedPlanSha256: evidence.planSha256,
      blobs: new Map([[row.sha256, source.bytes]]), destinations: new Map([[row.path, destination]]),
    };
    const observation = {
      root, workspaceId: journal!.workspaceId, ...binding,
      rootIdentity: recoveryFileIdentity(lstatSync(root, { bigint: true })),
      parentIdentity: recoveryFileIdentity(fstatSync(fd, { bigint: true })), owner,
      destination: "missing" as const, pendingOperationIds: [] as string[],
    };
    current();
    return { owner, index, capture, observation, occupied: !!named };
  });
}

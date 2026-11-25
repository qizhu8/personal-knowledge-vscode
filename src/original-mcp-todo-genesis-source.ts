import type { DatabaseSync } from "node:sqlite";
import { isMainThread, parentPort } from "node:worker_threads";
import { CoreError } from "./contracts.js";
import { assertStorage, type Storage } from "./storage.js";
import { originalMcpTodoGenesisSourceControlForStorage, type OriginalMcpTodoGenesisSourceScope } from "./original-mcp-todo-genesis-native.js";
import { readOriginalMcpTodoGenesisSources } from "./original-mcp-todo-genesis.js";
import { validateOriginalMcpTodoGenesisProvenance, type OriginalMcpTodoGenesisProvenance } from "./original-mcp-todo-genesis-contracts.js";

export interface OriginalMcpTodoGenesisSourceControl {
  provenance: OriginalMcpTodoGenesisProvenance;
  revocation: SharedArrayBuffer;
}
type Lease = { ownerId?: string; fence?: number };
interface Authority {
  control: OriginalMcpTodoGenesisSourceControl;
  lease: Lease;
}
const live = new Map<string, Map<string, Authority>>();
function denied(): never {
  throw new CoreError("NATIVE_AUTHORITY_REQUIRED", "This exact genesis Board has no current native source authority.");
}
function checked(root: string, db: DatabaseSync, value: Authority) {
  const { request, decision } = validateOriginalMcpTodoGenesisProvenance(value.control.provenance);
  const owner = db.prepare("SELECT owner_id,fence,lease_until FROM native_runtime_owner WHERE singleton=1").get();
  if (request.root !== root || !(value.control.revocation instanceof SharedArrayBuffer)
    || value.control.revocation.byteLength !== 4 || Atomics.load(new Int32Array(value.control.revocation), 0) !== 0
    || decision.expiresAtMs <= Date.now() || !owner || owner.owner_id !== value.lease.ownerId
    || owner.fence !== value.lease.fence || Number(owner.lease_until) <= Date.now()) denied();
  const source = readOriginalMcpTodoGenesisSources(root, db).find(item => item.key === request.selection.boardSlug);
  if (!source || source.operationId !== request.operationId || source.sourceId !== request.selection.sourceId
    || source.provenance.workspaceId !== request.workspaceId || source.provenance.profileSha256 !== request.profileSha256
    || source.provenance.custodyPlanSha256 !== request.custodyPlanSha256 || source.provenance.catalogSha256 !== request.catalogSha256) denied();
  const host = db.prepare("SELECT payload FROM original_mcp_native_host_admissions WHERE receipt_sha256=?")
    .get(request.nativeHostReceiptSha256);
  if (!host) denied();
  const binding = JSON.parse(String(host.payload));
  if (binding.root !== root || binding.workspaceId !== request.workspaceId || binding.epoch !== request.nativeEpoch
    || binding.profileSha256 !== request.profileSha256 || binding.planSha256 !== request.custodyPlanSha256
    || binding.sourceCatalogSha256 !== request.catalogSha256) denied();
  return { source, request, decision };
}
function activate(root: string, db: DatabaseSync, control: OriginalMcpTodoGenesisSourceControl, lease: Lease) {
  const value = { control: { provenance: structuredClone(control.provenance), revocation: control.revocation }, lease: { ...lease } };
  const { source } = checked(root, db, value);
  let entries = live.get(root);
  if (!entries) { entries = new Map(); live.set(root, entries); }
  entries.set(source.key, value);
}
export function activateOriginalMcpTodoGenesisOwnerSource(storage: Storage, db: DatabaseSync,
  capsule: OriginalMcpTodoGenesisSourceScope, lease: Lease) {
  assertStorage(storage); storage.assertWorkspaceLease();
  activate(storage.workspaceRoot(), db, originalMcpTodoGenesisSourceControlForStorage(storage, capsule), lease);
}
/** Only the actual Storage worker accepts this already lease-checked private envelope. */
export function receiveOriginalMcpTodoGenesisSourceControl(root: string, db: DatabaseSync,
  control: OriginalMcpTodoGenesisSourceControl, lease: Lease) {
  if (isMainThread || !parentPort) denied();
  activate(root, db, control, lease);
}
export function readOriginalMcpTodoGenesisAuthority(root: string, db: DatabaseSync, actorId: string, boardSlug: string) {
  const value = live.get(root)?.get(boardSlug);
  if (!value || actorId !== "mcp:external") denied();
  return { ...checked(root, db, value), revocation: value.control.revocation };
}
export function originalMcpTodoGenesisAuthorizedKeys(root: string, db: DatabaseSync, actorId: string): Set<string> {
  const keys = new Set<string>();
  if (actorId !== "mcp:external") return keys;
  for (const [key, value] of live.get(root) ?? []) {
    try { checked(root, db, value); keys.add(key); } catch { /* Expired sources grant no discovery. */ }
  }
  return keys;
}

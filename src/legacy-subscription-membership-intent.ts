import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { CoreError } from "./contracts.js";
import { nativeSubscriptionChangeSha256, type GitHubRefreshChange } from "./native-subscription-priority.js";

export type MembershipIntent = {
  schema: "pkm.subscription-membership-intent/v1";
  workspaceId: string;
  operationId: string;
  action: "add" | "remove" | "priority" | "rename" | "refresh" | "github-refresh";
  publisherNodeId: string;
  shareId: string;
  subscriptionId: string | null;
  expectedHead: string | null;
  baselineSha256: string;
  requestSha256: string;
  githubRequest?: GitHubRefreshChange;
};

export type MembershipTerminal = {
  schema: "pkm.subscription-membership-terminal/v1";
  workspaceId: string;
  operationId: string;
  intentSha256: string;
  outcome: "committed" | "cancelled";
  head: string | null;
  stateSha256: string;
};
type Pending = { intent: MembershipIntent; fingerprint: string };
const operation = "subscription.membership.intent";
const actor = "native:subscription-membership";
const json = (value: unknown) => JSON.stringify(value);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const hex = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const uuid = (value: unknown): value is string => typeof value === "string"
  && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const workspace = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9-]{36}$/i.test(value);
const identifier = (value: unknown): value is string => typeof value === "string"
  && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const invalid = (): never => { throw new CoreError("IMPORT_RECEIPT_INVALID", "Subscription membership journal is invalid."); };
const conflict = (message: string): never => { throw new CoreError("CONFLICT", message); };
const schema = `
  CREATE TABLE IF NOT EXISTS subscription_membership_events (
    sequence INTEGER PRIMARY KEY, workspace_id TEXT NOT NULL, operation_id TEXT NOT NULL,
    kind TEXT NOT NULL, fingerprint TEXT NOT NULL UNIQUE, body TEXT NOT NULL,
    UNIQUE(operation_id,kind)
  );
  CREATE TRIGGER IF NOT EXISTS subscription_membership_events_no_update
    BEFORE UPDATE ON subscription_membership_events
    BEGIN SELECT RAISE(ABORT,'Immutable Subscription membership event'); END;
  CREATE TRIGGER IF NOT EXISTS subscription_membership_events_no_delete
    BEFORE DELETE ON subscription_membership_events
    BEGIN SELECT RAISE(ABORT,'Immutable Subscription membership event'); END;
`;

function validIntent(value: MembershipIntent): boolean {
  const keys = [
    "action", "baselineSha256", "expectedHead", "operationId", "publisherNodeId", "requestSha256",
    "schema", "shareId", "subscriptionId", "workspaceId",
  ];
  if (value?.action === "github-refresh") keys.push("githubRequest");
  keys.sort();
  let githubValid = false;
  if (value?.action === "github-refresh" && value.githubRequest) {
    try {
      githubValid = value.githubRequest.action === "github-refresh" && value.githubRequest.publisherNodeId === value.publisherNodeId
        && value.githubRequest.shareId === value.shareId && value.githubRequest.subscriptionId === value.subscriptionId
        && nativeSubscriptionChangeSha256(value.githubRequest) === value.requestSha256;
    } catch { return false; }
  }
  return value && json(Object.keys(value).sort()) === json(keys)
    && value.schema === "pkm.subscription-membership-intent/v1" && workspace(value.workspaceId)
    && uuid(value.operationId) && ["add", "remove", "priority", "rename", "refresh", "github-refresh"].includes(value.action)
    && (value.action === "github-refresh" ? githubValid : hex(value.publisherNodeId)) && identifier(value.shareId)
    && (value.action === "add" ? value.subscriptionId === null : identifier(value.subscriptionId))
    && (value.expectedHead === null || hex(value.expectedHead))
    && hex(value.baselineSha256) && hex(value.requestSha256);
}

function validTerminal(value: MembershipTerminal, pending: Pending): boolean {
  const intent = pending.intent;
  return value && json(Object.keys(value).sort()) === json([
    "head", "intentSha256", "operationId", "outcome", "schema", "stateSha256", "workspaceId",
  ]) && value.schema === "pkm.subscription-membership-terminal/v1"
    && value.workspaceId === intent.workspaceId && value.operationId === intent.operationId
    && value.intentSha256 === pending.fingerprint && hex(value.stateSha256)
    && (value.outcome === "cancelled"
      ? value.head === intent.expectedHead && value.stateSha256 === intent.baselineSha256
      : value.outcome === "committed" && hex(value.head) && value.head !== intent.expectedHead);
}

/** Revalidates the complete journal and its independent receipt anchors; never executes a host action. */
export function readMembershipIntent(db: DatabaseSync, workspaceId: string): Pending | undefined {
  db.exec("SAVEPOINT subscription_membership_read");
  try { return readMembershipJournal(db, workspaceId); }
  finally { db.exec("RELEASE subscription_membership_read"); }
}

function readMembershipJournal(db: DatabaseSync, workspaceId: string): Pending | undefined {
  if (!workspace(workspaceId)) return invalid();
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='subscription_membership_events'").get();
  const receiptTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='receipts'").get();
  if (!receiptTable) return invalid();
  const anchors = db.prepare("SELECT operation_id,fingerprint,result,actor_id FROM receipts WHERE operation=?").all(operation);
  if (!table) {
    if (anchors.length) return invalid();
    return undefined;
  }
  const rows = db.prepare("SELECT sequence,workspace_id,operation_id,kind,fingerprint,body FROM subscription_membership_events ORDER BY sequence").all();
  if (rows.length !== anchors.length) return invalid();
  let pending: Pending | undefined;
  const completed = new Set<string>();
  for (const [index, row] of rows.entries()) {
    const body = String(row.body), fingerprint = String(row.fingerprint);
    let value: any;
    try { value = JSON.parse(body); } catch { return invalid(); }
    if (!value || typeof value !== "object" || Array.isArray(value) || json(value) !== body
      || digest(body) !== fingerprint || row.sequence !== index + 1 || row.workspace_id !== workspaceId
      || row.operation_id !== value.operationId) return invalid();
    const anchor = anchors.find(item => item.operation_id === `subscription-membership:${row.kind}:${row.operation_id}`);
    if (!anchor || anchor.actor_id !== actor || anchor.fingerprint !== fingerprint
      || anchor.result !== json({ sequence: index + 1, fingerprint })) return invalid();
    if (row.kind === "intent") {
      if (pending || !validIntent(value) || value.workspaceId !== workspaceId || completed.has(value.operationId)) return invalid();
      pending = { intent: value, fingerprint };
    } else if (row.kind === "terminal") {
      if (!pending || !validTerminal(value, pending)) return invalid();
      completed.add(pending.intent.operationId);
      pending = undefined;
    } else return invalid();
  }
  return pending;
}

/** Returns the durable result for an operation without retrying its external action. */
export function readMembershipOutcome(db: DatabaseSync, workspaceId: string, operationId: string):
  { intent: MembershipIntent; terminal?: MembershipTerminal } | undefined {
  if (!uuid(operationId)) return invalid();
  db.exec("SAVEPOINT subscription_membership_outcome");
  try {
    readMembershipJournal(db, workspaceId);
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='subscription_membership_events'").get();
    if (!table) return undefined;
    const rows = db.prepare("SELECT kind,body FROM subscription_membership_events WHERE operation_id=? ORDER BY sequence").all(operationId);
    if (!rows.length) return undefined;
    return { intent: JSON.parse(String(rows[0]!.body)) as MembershipIntent,
      ...(rows.length === 2 ? { terminal: JSON.parse(String(rows[1]!.body)) as MembershipTerminal } : {}) };
  } finally { db.exec("RELEASE subscription_membership_outcome"); }
}

function append(db: DatabaseSync, workspaceId: string, operationId: string, kind: "intent" | "terminal", value: unknown): void {
  const body = json(value), fingerprint = digest(body);
  const sequence = Number(db.prepare("SELECT COUNT(*) AS count FROM subscription_membership_events").get()!.count) + 1;
  db.prepare("INSERT INTO subscription_membership_events(sequence,workspace_id,operation_id,kind,fingerprint,body) VALUES(?,?,?,?,?,?)")
    .run(sequence, workspaceId, operationId, kind, fingerprint, body);
  db.prepare("INSERT INTO receipts(operation_id,fingerprint,result,actor_id,operation,committed_at) VALUES(?,?,?,?,?,?)")
    .run(`subscription-membership:${kind}:${operationId}`, fingerprint, json({ sequence, fingerprint }),
      actor, operation, new Date().toISOString());
}

function requireTransaction(db: DatabaseSync, assertLease: () => void): void {
  if (!db.isTransaction) throw new CoreError("FORBIDDEN", "Subscription membership requires an exclusive transaction.");
  assertLease();
}

/** Caller holds the original state lock and Next writer fence, and has checked the exact admitted baseline. */
export function prepareMembershipIntent(db: DatabaseSync, intent: MembershipIntent, currentHead: string | null,
  assertLease: () => void): void {
  requireTransaction(db, assertLease);
  if (!validIntent(intent)) throw new CoreError("INVALID_ARGUMENT", "Subscription membership intent is invalid.");
  const pending = readMembershipIntent(db, intent.workspaceId);
  if (intent.expectedHead !== currentHead) return conflict("Subscription membership head changed.");
  if (pending) {
    if (json(pending.intent) === json(intent)) return;
    return conflict("A Subscription membership action requires explicit recovery.");
  }
  if (readMembershipOutcome(db, intent.workspaceId, intent.operationId))
    return conflict("Subscription membership operation is already resolved.");
  db.exec(schema);
  append(db, intent.workspaceId, intent.operationId, "intent", intent);
}

/**
 * Finish in the same transaction as the validated native publication. Cancellation is only
 * permitted for an exactly unchanged baseline; an unknown host outcome is never replayed.
 */
export function finishMembershipIntent(db: DatabaseSync, workspaceId: string, operationId: string,
  outcome: "committed" | "cancelled", head: string | null, stateSha256: string, assertLease: () => void): void {
  requireTransaction(db, assertLease);
  const pending = readMembershipIntent(db, workspaceId);
  if (!pending) {
    const previous = readMembershipOutcome(db, workspaceId, operationId);
    if (previous?.terminal && previous.terminal.outcome === outcome && previous.terminal.head === head
      && previous.terminal.stateSha256 === stateSha256) return;
    return conflict("Subscription membership intent is not pending.");
  }
  if (pending.intent.operationId !== operationId)
    return conflict("Subscription membership intent is not pending.");
  const terminal: MembershipTerminal = { schema: "pkm.subscription-membership-terminal/v1", workspaceId, operationId,
    intentSha256: pending.fingerprint, outcome, head, stateSha256 };
  if (!validTerminal(terminal, pending)) return conflict("Subscription membership outcome is not reconciled.");
  append(db, workspaceId, operationId, "terminal", terminal);
}

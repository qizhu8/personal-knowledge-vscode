import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { withCrossProcessLockSync } from "../runtime/cross-process-lock";
import type { ChatExecutionContext } from "./execution-context";

export type WorkerPhase = "running" | "awaiting-input" | "sleeping" | "complete" | "failed" | "cancelled";
export type WorkerDecisionReason = "clarification" | "suggestion" | "permission" | "runtime-limit" | "suspected-loop";
export type WorkerExecutionState = "pending" | "running" | "waiting-input" | "completed" | "failed" | "interrupted" | "cancelled";
export interface WorkerActivity {
  id: string;
  managerChatId: string;
  treeId: string;
  receiptId: string;
  temporary: boolean;
  state: WorkerExecutionState;
  attemptId?: string;
  decision?: { reason: WorkerDecisionReason; episodeId: string; detail: string; at: number; };
  reported?: string;
  activeMs?: number;
  reviewedAtMs?: number;
  stopRequested?: { reason: string; at: number };
}
export interface WorkerEvent { id: string; receiptId: string; phase: WorkerPhase; senderChatId?: string; message?: string; activityId?: string; attemptId?: string; reason?: WorkerDecisionReason; detail?: string; at?: number; episodeId?: string; }
export interface ChatWorkerState {
  treeId: string;
  parentChatId?: string;
  receiptId?: string;
  executionContext: ChatExecutionContext;
  sleeping: boolean;
  stopped: boolean;
  events: WorkerEvent[];
}
export interface WorkerSlot { receiptId: string; chatId: string; parentChatId: string; title: string; temporary?: boolean; released?: boolean; }
interface WorkerTree { schema: "pkm.chat.worker-tree/v1"; id: string; rootChatId: string; slots: WorkerSlot[]; approvedQuota?: number; }
export interface WorkerLimits { automatic: number; maximum: number; }

export function workerIsDescendant(slots: readonly WorkerSlot[], ancestorChatId: string, workerChatId: string): boolean {
  const parents = new Map(slots.filter(slot => !slot.released).map(slot => [slot.chatId, slot.parentChatId]));
  const visited = new Set<string>();
  let current = parents.get(workerChatId);
  while (current) {
    if (current === ancestorChatId) return true;
    if (visited.has(current)) throw new Error("Worker tree ancestry contains a cycle.");
    visited.add(current);
    current = parents.get(current);
  }
  return false;
}

export function workerLimits(automatic: number, maximum: number): WorkerLimits {
  if (!Number.isSafeInteger(automatic) || !Number.isSafeInteger(maximum) || automatic < 0 || maximum < 1 || maximum > 1000 || automatic > maximum) {
    throw new Error("Worker limits require 0 <= automatic <= maximum <= 1000.");
  }
  return { automatic, maximum };
}

export class WorkerTreeStore {
  constructor(private readonly directory: string) {}

  private file(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid worker tree identity.");
    return path.join(this.directory, `${id}.json`);
  }

  private read(id: string): WorkerTree {
    const file = this.file(id);
    if (fs.statSync(file).size > 5_000_000) throw new Error("Worker tree exceeds its storage boundary.");
    const tree = JSON.parse(fs.readFileSync(file, "utf8")) as WorkerTree;
    const uuid = (value: unknown) => typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
    if (tree.schema !== "pkm.chat.worker-tree/v1" || tree.id !== id || !uuid(tree.rootChatId) || !Array.isArray(tree.slots) || tree.slots.length > 10000
      || tree.slots.some(slot => !slot || !uuid(slot.chatId) || !uuid(slot.receiptId) || !uuid(slot.parentChatId) || typeof slot.title !== "string" || slot.title.length > 120
        || slot.temporary !== undefined && typeof slot.temporary !== "boolean" || slot.released !== undefined && typeof slot.released !== "boolean")
      || new Set(tree.slots.filter(slot => !slot.released).map(slot => slot.chatId)).size !== tree.slots.filter(slot => !slot.released).length
      || tree.approvedQuota !== undefined && (!Number.isSafeInteger(tree.approvedQuota) || tree.approvedQuota < 0 || tree.approvedQuota > 1000)) throw new Error("Invalid persisted worker tree.");
    return tree;
  }

  create(rootChatId: string): string {
    if (!/^[a-f0-9-]{36}$/.test(rootChatId)) throw new Error("Invalid root Chat identity.");
    const id = randomUUID();
    fs.mkdirSync(this.directory, { recursive: true });
    fs.writeFileSync(this.file(id), JSON.stringify({ schema: "pkm.chat.worker-tree/v1", id, rootChatId, slots: [] }), { flag: "wx" });
    return id;
  }

  count(id: string): number { return this.read(id).slots.filter(slot => !slot.released).length; }
  rootChatId(id: string): string { return this.read(id).rootChatId; }
  members(id: string): WorkerSlot[] { return this.read(id).slots; }
  contains(id: string, chatId: string): boolean {
    const tree = this.read(id);
    return tree.rootChatId === chatId || tree.slots.some(slot => !slot.released && slot.chatId === chatId);
  }
  quota(id: string, limits: WorkerLimits): number {
    workerLimits(limits.automatic, limits.maximum);
    const tree = this.read(id);
    return Math.min(limits.maximum, Math.max(limits.automatic, tree.approvedQuota ?? tree.slots.length));
  }

  private write(tree: WorkerTree): void {
    const file = this.file(tree.id);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(temporary, JSON.stringify(tree)); fs.renameSync(temporary, file); }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }

  release(id: string, receiptId: string): void {
    withCrossProcessLockSync(path.join(this.directory, `${id}.lock`), "Worker tree budget", () => {
      const tree = this.read(id);
      const slot = tree.slots.find(slot => slot.receiptId === receiptId);
      if (!slot) throw new Error("Worker receipt does not belong to this tree.");
      if (slot.released) return;
      slot.released = true;
      this.write(tree);
    });
  }

  reserve(id: string, parentChatId: string, titles: string[], limits: WorkerLimits, approvedTotal?: number, existingChatIds?: string[]): WorkerSlot[] {
    this.file(id);
    workerLimits(limits.automatic, limits.maximum);
    return withCrossProcessLockSync(path.join(this.directory, `${id}.lock`), "Worker tree budget", () => {
      const tree = this.read(id);
      if (parentChatId !== tree.rootChatId && !tree.slots.some(slot => !slot.released && slot.chatId === parentChatId)) throw new Error("The manager does not belong to this worker tree.");
      if (!titles.length || titles.length > limits.maximum || titles.some(title => !title.trim() || title.length > 120)) throw new Error("Choose bounded worker titles.");
      if (tree.slots.length + titles.length > 10000) throw new Error("Worker tree history is full. Start a new manager task.");
      const total = tree.slots.filter(slot => !slot.released).length + titles.length;
      if (total > limits.maximum) throw new Error(`Worker tree limit exceeded (${total} > ${limits.maximum}); no workers were spawned.`);
      if (approvedTotal !== undefined && (!Number.isSafeInteger(approvedTotal) || approvedTotal < total || approvedTotal > limits.maximum)) throw new Error("Choose a valid approved worker quota.");
      const quota = Math.min(limits.maximum, Math.max(limits.automatic, tree.approvedQuota ?? tree.slots.length));
      if (total > quota && (approvedTotal === undefined || total > approvedTotal)) throw new Error("This tree expansion requires explicit user approval.");
      tree.approvedQuota = Math.max(quota, approvedTotal || 0);
      if (existingChatIds && (existingChatIds.length !== titles.length || new Set(existingChatIds).size !== existingChatIds.length
        || existingChatIds.some(chatId => !/^[a-f0-9-]{36}$/.test(chatId) || chatId === tree.rootChatId || tree.slots.some(slot => !slot.released && slot.chatId === chatId)))) throw new Error("Choose distinct available existing worker Chats.");
      const slots = titles.map((title, index) => ({ receiptId: randomUUID(), chatId: existingChatIds?.[index] || randomUUID(), parentChatId, title, temporary: !existingChatIds }));
      tree.slots.push(...slots);
      this.write(tree);
      return slots;
    });
  }

}

export function validWorkerActivity(value: WorkerActivity): boolean {
    const uuid = (value: unknown) => typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
    return !!value && [value.id, value.managerChatId, value.treeId, value.receiptId].every(uuid)
      && typeof value.temporary === "boolean"
      && ["pending", "running", "waiting-input", "completed", "failed", "interrupted", "cancelled"].includes(value.state)
      && (value.attemptId === undefined || uuid(value.attemptId))
      && (value.activeMs === undefined || Number.isFinite(value.activeMs) && value.activeMs >= 0)
      && (value.reviewedAtMs === undefined || Number.isFinite(value.reviewedAtMs) && value.reviewedAtMs >= 0)
      && (value.reported === undefined || typeof value.reported === "string" && value.reported.length <= 200)
      && (value.stopRequested === undefined || Number.isFinite(value.stopRequested.at) && typeof value.stopRequested.reason === "string" && value.stopRequested.reason.length <= 500)
      && (value.decision === undefined || !!value.decision && ["clarification", "suggestion", "permission", "runtime-limit", "suspected-loop"].includes(value.decision.reason)
        && uuid(value.decision.episodeId) && Number.isFinite(value.decision.at) && typeof value.decision.detail === "string" && value.decision.detail.length <= 2000);
}

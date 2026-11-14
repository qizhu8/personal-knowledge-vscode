import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { CoreError, type StorageRequest } from "./contracts.js";
import { agentSnapshotReadDefinitions } from "./agent-snapshot-reads-contracts.js";
import { snapshotSummary } from "./domain/agent-snapshot-reads-original.js";
import { snapshotReadProjection } from "./domain/agent-snapshot-reads-projection.js";

export const AGENT_SNAPSHOT_READ_DIRECTORY = "agent-snapshot-reads";
export const agentSnapshotReadLimits = Object.freeze({
  fileBytes: 2 * 1024 * 1024, totalBytes: 32 * 1024 * 1024,
  files: 512, directoryEntries: 1024, depth: 32, jsonNodes: 100_000,
  records: 4096, messages: 10_000, page: 100,
});
const adapters = {
  encryptedPayload: "unavailable", networkRecovery: "unavailable",
  vscode: "unavailable", restore: "unavailable",
} as const;
const snapshotIdPattern = /^agent_snapshot_[A-Za-z0-9_-]+$/;
const sessionIdPattern = /^agent_session_[A-Za-z0-9_-]+$/;
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
type JsonRecord = Record<string, any>;
function fail(code: string, message: string): never { throw new CoreError(code, message); }
function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function invalid(message: string): never { return fail("INVALID_SNAPSHOT", message); }
function checkJson(value: unknown, depth = 0, budget = { nodes: 0 }): void {
  if (++budget.nodes > agentSnapshotReadLimits.jsonNodes || depth > agentSnapshotReadLimits.depth) {
    fail("RESOURCE_LIMIT", "Snapshot JSON exceeds the depth or node bound.");
  }
  if (Array.isArray(value)) {
    if (value.length > agentSnapshotReadLimits.messages) fail("RESOURCE_LIMIT", "Snapshot array exceeds the record bound.");
    for (const item of value) checkJson(item, depth + 1, budget);
  } else if (record(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) invalid("Snapshot contains unsafe object keys.");
      checkJson(item, depth + 1, budget);
    }
  }
}
function records(value: unknown, label: string, limit: number = agentSnapshotReadLimits.records): JsonRecord[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => !record(item))) invalid(`${label} must contain only objects.`);
  if (value.length > limit) fail("RESOURCE_LIMIT", `${label} exceeds the record bound.`);
  return value;
}
function optionalStrings(value: JsonRecord, keys: string[]) {
  for (const key of keys) if (value[key] !== undefined && value[key] !== null && typeof value[key] !== "string") {
    invalid(`Snapshot ${key} must be a string.`);
  }
}
function validateSnapshot(snapshot: unknown, identity: string): asserts snapshot is JsonRecord {
  if (!record(snapshot) || snapshot.schema !== "pkm.agent.snapshot/v1" || snapshot.snapshotId !== identity) {
    invalid("Agent Snapshot schema or filename identity is unsupported.");
  }
  if (typeof snapshot.magicCode !== "string" || !snapshot.magicCode.startsWith("PKM-SNAP-")
    || snapshot.magicCode.length > 160 || snapshot.magicCode !== snapshot.magicCode.trim().toUpperCase()) {
    invalid("Agent Snapshot Magic Code is invalid.");
  }
  optionalStrings(snapshot, ["name", "sourceSessionId", "sourceHostSessionId", "sourceHostKind",
    "task", "projectId", "reason", "createdAt"]);
  if (snapshot.agent !== undefined) {
    if (!record(snapshot.agent)) invalid("Snapshot agent must be an object.");
    optionalStrings(snapshot.agent, ["name", "product"]);
  }
  if (!record(snapshot.payload)) invalid("Snapshot payload must be an object.");
  if (snapshot.payload.algorithm !== undefined) {
    if (!["A256GCM-PKM-LOCAL-OBFUSCATION/v1", "A256GCM-PKM-INTERNAL/v1"].includes(snapshot.payload.algorithm)) {
      fail("ADAPTER_UNAVAILABLE", "The Snapshot payload algorithm is unavailable.");
    }
    if (["iv", "tag", "ciphertext"].some(key => typeof snapshot.payload[key] !== "string")) {
      invalid("Encrypted Snapshot envelope is malformed.");
    }
    if (!record(snapshot.capture)) invalid("Encrypted Snapshot requires original capture metadata for listing.");
  } else {
    validatePayload(snapshot.payload);
  }
  if (snapshot.capture !== undefined) {
    if (!record(snapshot.capture)) invalid("Snapshot capture must be an object.");
    for (const key of ["recipeRunCount", "todoCount"]) {
      if (!Number.isSafeInteger(snapshot.capture[key]) || snapshot.capture[key] < 0) invalid("Snapshot capture counts are invalid.");
    }
    if (snapshot.capture.checkpoint !== undefined && snapshot.capture.checkpoint !== null) {
      if (!record(snapshot.capture.checkpoint)) invalid("Snapshot capture checkpoint must be an object.");
      optionalStrings(snapshot.capture.checkpoint, ["checkpointId", "createdAt", "reason"]);
      if (!Number.isFinite(snapshot.capture.checkpoint.sequence)) invalid("Snapshot checkpoint sequence must be finite.");
    }
  }
}
function validatePayload(payload: JsonRecord): void {
  if (!record(payload.session) || !Array.isArray(payload.recipeRuns)) invalid("Agent Snapshot payload is not a canonical Session capture.");
  const session = payload.session;
  optionalStrings(session, ["task", "status", "summary", "projectId", "origin", "hostKind"]);
  for (const todo of records(session.todos, "Snapshot Todos")) {
    optionalStrings(todo, ["todoId", "title", "status", "actionType", "updatedAt", "details", "summary", "recipeRunId"]);
    if (todo.recipeRunIds !== undefined && (!Array.isArray(todo.recipeRunIds)
      || todo.recipeRunIds.some((id: unknown) => typeof id !== "string"))) invalid("Todo Recipe run identities must be strings.");
  }
  for (const checkpoint of records(session.checkpoints, "Snapshot checkpoints")) {
    optionalStrings(checkpoint, ["checkpointId", "createdAt", "reason"]);
    if (checkpoint.sequence !== undefined && checkpoint.sequence !== null && !Number.isFinite(checkpoint.sequence)) {
      invalid("Snapshot checkpoint sequence is invalid.");
    }
  }
  for (const run of records(payload.recipeRuns, "Snapshot Recipe runs")) {
    optionalStrings(run, ["runId", "recipeId", "recipeName", "status"]);
    if (run.nodes !== undefined && !record(run.nodes)) invalid("Recipe run nodes must be an object.");
    if (Object.keys(run.nodes || {}).length > agentSnapshotReadLimits.records) {
      fail("RESOURCE_LIMIT", "Recipe run nodes exceed the record bound.");
    }
    for (const node of Object.values(run.nodes || {})) {
      if (!record(node)) invalid("Recipe node must be an object.");
      optionalStrings(node, ["state"]);
    }
  }
  if (session.nativeChat !== undefined) {
    if (!record(session.nativeChat)) invalid("Snapshot nativeChat must be an object.");
    if (session.nativeChat.messageHistory !== undefined) {
      fail("ADAPTER_UNAVAILABLE", "Packed conversation history requires an unavailable adapter; transcript paths are never followed.");
    }
    for (const message of records(session.nativeChat.messages, "Snapshot messages", agentSnapshotReadLimits.messages)) {
      optionalStrings(message, ["role", "status", "content"]);
    }
  }
}
const sensitiveKey = /^(?:(?:(?:access|refresh|id|api|bearer)[_-]?)?tokens?|authorization|passwords?|(?:client[_-]?)?secrets?|(?:api|private)[_-]?keys?|credentials?|recovery|verifier)$/i;
function withoutCredentials(value: any): any {
  if (Array.isArray(value)) return value.map(withoutCredentials);
  if (record(value)) return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !sensitiveKey.test(key)).map(([key, item]) => [key, withoutCredentials(item)]));
  return value;
}

/**
 * Read explicitly staged original records only. The caller must pass StorageRequest
 * from the authenticated core; a Magic Code never grants authority or adopts a host.
 */
export async function readAgentSnapshots(root: string, request: StorageRequest): Promise<unknown> {
  const definition = agentSnapshotReadDefinitions.find(item => item.id === String(request.operation));
  if (!definition) fail("UNKNOWN_OPERATION", "Unknown Agent Snapshot read operation.");
  if (typeof request.actorId !== "string" || !request.actorId.trim()) fail("FORBIDDEN", "A trusted StorageRequest actor is required.");
  const parsed = definition.input.safeParse(request.args);
  if (!parsed.success) fail("INVALID_ARGUMENT", "Agent Snapshot read arguments are invalid.");
  const input = parsed.data;
  const workspace = resolve(root);
  const pins: Array<[string, string]> = [];
  let totalBytes = 0;
  let fileCount = 0;
  async function directory(directoryPath: string): Promise<boolean> {
    let stat;
    try { stat = await lstat(directoryPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    if (stat.isSymbolicLink() || !stat.isDirectory() || await realpath(directoryPath) !== directoryPath) {
      fail("UNSAFE_PATH", "Snapshot directories must be real, isolated directories.");
    }
    return true;
  }
  async function json(file: string, pinName?: string): Promise<unknown> {
    const stat = await lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile() || await realpath(file) !== file) fail("UNSAFE_PATH", "Snapshot input must be a regular file.");
    if (stat.size > agentSnapshotReadLimits.fileBytes || ++fileCount > agentSnapshotReadLimits.files) {
      fail("RESOURCE_LIMIT", "Snapshot file or file count exceeds the read bound.");
    }
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Buffer;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev) fail("CONFLICT", "Snapshot input changed while opening.");
      const buffer = Buffer.alloc(agentSnapshotReadLimits.fileBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const read = await handle.read(buffer, length, buffer.length - length, null);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (length > agentSnapshotReadLimits.fileBytes) fail("RESOURCE_LIMIT", "Snapshot file exceeds the byte bound.");
      const after = await handle.stat();
      if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || await realpath(file) !== file) {
        fail("CONFLICT", "Snapshot input changed during reading.");
      }
      bytes = buffer.subarray(0, length);
    } finally { await handle.close(); }
    totalBytes += bytes.length;
    if (totalBytes > agentSnapshotReadLimits.totalBytes) fail("RESOURCE_LIMIT", "Snapshot aggregate exceeds 32 MiB.");
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)); }
    catch { invalid("Snapshot input must be valid UTF-8 JSON."); }
    checkJson(value);
    if (pinName) pins.push([pinName, hash(bytes)]);
    return value;
  }
  if (!await directory(workspace)) fail("INVALID_WORKSPACE", "Isolated workspace does not exist.");
  const marker = await json(join(workspace, ".pkm-next-workspace"));
  if (!record(marker) || marker.schema !== "pkm.next-workspace/v2") fail("INVALID_WORKSPACE", "Use an isolated next-server workspace, never a Knowledge Root.");
  const staged = join(workspace, AGENT_SNAPSHOT_READ_DIRECTORY);
  const snapshots: JsonRecord[] = [];
  const counts = new Map<string, number>();
  async function scan(folder: string, pattern: RegExp, capture: boolean): Promise<void> {
    if (!await directory(folder)) return;
    let entries = 0;
    const dir = await opendir(folder);
    for await (const entry of dir) {
      if (++entries > agentSnapshotReadLimits.directoryEntries) fail("RESOURCE_LIMIT", "Snapshot directory entry bound exceeded.");
      if (!entry.name.endsWith(".json")) {
        // Never follow unrecognized entries or external transcript directories.
        if (entry.isSymbolicLink()) fail("UNSAFE_PATH", "Snapshot directory contains a symlink.");
        continue;
      }
      const id = entry.name.slice(0, -5);
      if (!pattern.test(id) || id.length > 160) invalid("Snapshot record filename identity is invalid.");
      const value = await json(join(folder, entry.name), `${capture ? "snapshot" : "session"}/${entry.name}`);
      if (capture) {
        validateSnapshot(value, id);
        snapshots.push(value);
      } else {
        if (!record(value) || value.schema !== "pkm.agent.session/v1" || value.sessionId !== id) invalid("Recovery-count Session schema or identity is invalid.");
        const provenance = value.provenance;
        if (provenance !== undefined && !record(provenance)) invalid("Session provenance must be an object.");
        if (provenance?.snapshotId !== undefined) {
          if (typeof provenance.snapshotId !== "string" || !snapshotIdPattern.test(provenance.snapshotId)) invalid("Session provenance Snapshot identity is invalid.");
          counts.set(provenance.snapshotId, (counts.get(provenance.snapshotId) || 0) + 1);
        }
      }
    }
  }
  if (await directory(staged)) {
    const pkm = join(staged, ".pkm");
    if (await directory(pkm)) {
      const state = join(pkm, "state");
      if (await directory(state)) {
        await scan(join(state, "agent-snapshots"), snapshotIdPattern, true);
        await scan(join(state, "agent-sessions"), sessionIdPattern, false);
      }
    }
  }
  const snapshotRevision = hash(JSON.stringify(pins.sort(([a], [b]) => a.localeCompare(b, "en"))));
  if (input.snapshotRevision !== undefined && input.snapshotRevision !== snapshotRevision) {
    fail("CONFLICT", "Staged Snapshot bytes changed; restart inspection or pagination.");
  }
  const magicCodes = new Set<string>();
  for (const snapshot of snapshots) {
    if (magicCodes.has(snapshot.magicCode)) invalid("Duplicate Snapshot Magic Code; no ambiguous fallback is allowed.");
    magicCodes.add(snapshot.magicCode);
  }
  const common = { ok: true as const, snapshotRevision, adapters };
  let result: unknown;
  if ("offset" in input) {
    const summaries = snapshots.map(snapshot => snapshotSummary(snapshot, counts.get(snapshot.snapshotId) || 0))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.snapshotId.localeCompare(b.snapshotId));
    result = {
      ...common, snapshots: summaries.slice(input.offset, input.offset + input.limit), total: summaries.length,
      nextOffset: input.offset + input.limit < summaries.length ? input.offset + input.limit : null,
    };
  } else {
    const snapshot = snapshots.find(item => "snapshotId" in input ? item.snapshotId === input.snapshotId : item.magicCode === input.magic_code);
    if (!snapshot) fail("NOT_FOUND", "Agent Snapshot was not found in the explicitly staged isolated records. Network recovery is unavailable.");
    if ("snapshotId" in input) {
      result = { ...common, snapshot: snapshotSummary(snapshot, counts.get(snapshot.snapshotId) || 0) };
    } else {
      if (snapshot.payload.algorithm !== undefined) {
        fail("ADAPTER_UNAVAILABLE", "Encrypted Snapshot payload decryption is unavailable; metadata remains readable. No migration or restore was attempted.");
      }
      result = { ...withoutCredentials(snapshotReadProjection(snapshot, snapshot.payload, input.recent_messages)), ...common };
    }
  }
  const output = definition.output.safeParse(result);
  if (!output.success) invalid("Snapshot projection does not match the captured read contract.");
  return output.data;
}

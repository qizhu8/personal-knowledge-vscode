import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CoreError } from "./host-composition-legacy-batch15-errors.js";
import { assertStorage, type Storage } from "./storage.js";
import {
  assertOriginalMcpNativeHost, originalMcpPublicRequestMatches, originalMcpRequestDigest,
  type OriginalMcpNativeHost,
} from "./original-mcp-native-host.js";

const input = z.strictObject({ limit: z.number().int().min(1).max(1000).default(100) });
const events = ["runtime.started", "mcp.call.started", "mcp.call.completed"] as const;
type Event = typeof events[number];
type Metadata = { readOnly?: boolean; outcome?: "success" | "failure"; durationMs?: number };
interface Row {
  schema: "pkm.diagnostic/v1"; at: string; pid: number; writerId: string; event: Event;
  component: "native-mcp"; recordIndex: number; dropped: number; persisted: false;
  readOnly?: boolean; outcome?: "success" | "failure"; durationMs?: number;
}
const capacity = 100_000;
function parseInput(raw: unknown) {
  const parsed = input.safeParse(raw);
  if (!parsed.success)
    throw new CoreError("INVALID_ARGUMENT", "Native diagnostics accept only an integer limit from 1 through 1000.");
  return parsed.data;
}

/** Ephemeral current-writer ring. No paths, caller strings, exceptions, or disk history enter it. */
export class NativeCurrentProcessDiagnosticWriter {
  readonly writerId = `${process.pid}-${randomUUID().replaceAll("-", "")}`;
  private readonly pid = process.pid;
  private readonly rows: Array<Readonly<Row> | undefined> = new Array(capacity);
  private index = 0;
  private length = 0;
  private dropped = 0;
  private closed = false;

  record(event: Event, metadata: Metadata = {}): void {
    if (this.closed || this.pid !== process.pid) return;
    if (!events.includes(event)) throw new CoreError("INVALID_ARGUMENT", "Invalid native diagnostic event.");
    const fields: Metadata = {};
    if (typeof metadata.readOnly === "boolean") fields.readOnly = metadata.readOnly;
    if (metadata.outcome === "success" || metadata.outcome === "failure") fields.outcome = metadata.outcome;
    if (typeof metadata.durationMs === "number" && Number.isFinite(metadata.durationMs) && metadata.durationMs >= 0)
      fields.durationMs = Math.min(metadata.durationMs, 86_400_000);
    if (this.length === capacity) this.dropped++;
    else this.length++;
    this.rows[this.index % capacity] = Object.freeze({
      schema: "pkm.diagnostic/v1", at: new Date().toISOString(), pid: this.pid, writerId: this.writerId,
      event, component: "native-mcp", recordIndex: ++this.index, dropped: this.dropped, persisted: false, ...fields,
    });
  }
  latest(limit: number) {
    parseInput({ limit });
    if (this.closed || this.pid !== process.pid)
      throw new CoreError("ACCESS_DENIED", "The native diagnostic writer is no longer current.");
    const records: Row[] = [];
    for (let index = this.index - Math.min(limit, this.length); index < this.index; index++)
      records.push({ ...this.rows[index % capacity]! });
    return { ok: true as const, writer_id: this.writerId, directory: "native:current-process",
      max_rows: capacity, dropped_records: this.dropped, records };
  }
  close(): void {
    if (this.closed) return;
    this.closed = true; this.rows.fill(undefined); this.length = 0;
  }
}

const sources = new WeakMap<OriginalMcpNativeHost, {
  storage: Storage; writer: NativeCurrentProcessDiagnosticWriter;
}>();
export function bindNativeCurrentProcessDiagnostics(storage: Storage, host: OriginalMcpNativeHost,
  writer: NativeCurrentProcessDiagnosticWriter): void {
  assertStorage(storage); assertOriginalMcpNativeHost(host, storage);
  if (!(writer instanceof NativeCurrentProcessDiagnosticWriter) || sources.has(host))
    throw new CoreError("ACCESS_DENIED", "The native diagnostic source must have one exact current host binding.");
  sources.set(host, { storage, writer });
  writer.record("runtime.started");
}

export function recordNativeCurrentProcessDiagnosticCall(storage: Storage, host: OriginalMcpNativeHost,
  event: "mcp.call.started" | "mcp.call.completed", metadata: Metadata): void {
  const source = sources.get(host);
  if (source?.storage !== storage) return;
  source.writer.record(event, metadata);
}

export function readNativeCurrentProcessDiagnostics(storage: Storage, host: OriginalMcpNativeHost,
  raw: unknown, signal?: AbortSignal) {
  assertStorage(storage); assertOriginalMcpNativeHost(host, storage);
  const args = parseInput(raw), source = sources.get(host);
  if (!source || source.storage !== storage || signal?.aborted
    || !originalMcpPublicRequestMatches(storage, host, {
      operation: "mcp.tool.diagnostics_latest", version: 1, tool: "diagnostics_latest", readOnly: true,
      arguments: raw as Record<string, unknown>, argumentsDigest: originalMcpRequestDigest(raw),
    })) throw new CoreError("ACCESS_DENIED", "Native diagnostics require their exact current public read approval.");
  const result = source.writer.latest(args.limit);
  assertOriginalMcpNativeHost(host, storage);
  if (signal?.aborted) throw new CoreError("ACCESS_DENIED", "Native diagnostic read was cancelled.");
  return result;
}

import { constants, closeSync, fstatSync, openSync, readFileSync, readSync, type Stats } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";

const handlePattern = /^process_[a-f0-9]{64}$/;
const foregroundPattern = /^foreground_(\d{13}-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/;
const recordSchema = z.object({
  schema: z.literal("pkm.chat.process/v1"), handle: z.string().regex(handlePattern),
  state: z.enum(["launching", "running", "paused", "complete", "failed", "cancelled", "timed-out", "output-limit", "unknown"]),
  spec: z.object({ program: z.string().min(1).max(1024).refine(value => !value.includes("\0")),
    arguments: z.array(z.string().refine(value => !value.includes("\0"))).max(32)
      .refine(value => JSON.stringify(value).length <= 8000),
    cwd: z.string().refine(isAbsolute), timeoutSeconds: z.number().int().min(1).max(86400) }),
  createdAt: z.number().finite(), updatedAt: z.number().finite(),
  stdoutBytes: z.number().int().nonnegative().safe(), stderrBytes: z.number().int().nonnegative().safe(),
  pausedAt: z.number().finite().optional(), pausedMs: z.number().int().nonnegative().safe().optional(),
  exitCode: z.number().int().nullable().optional(), exitSignal: z.string().nullable().optional(), detail: z.string().optional(),
}).strip();

/** Open each component relative to an owned directory descriptor, never following links. */
function openEvidence(root: string, components: string[], expectDirectory = false): number {
  let directory = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (let index = 0; index < components.length; index++) {
      const final = index === components.length - 1;
      const next = openSync(`/proc/self/fd/${directory}/${components[index]}`, constants.O_RDONLY | constants.O_NOFOLLOW
        | constants.O_NONBLOCK | (!final || expectDirectory ? constants.O_DIRECTORY : 0));
      closeSync(directory);
      directory = next;
    }
    const stat = fstatSync(directory);
    if (expectDirectory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)
      throw new Error("Original process evidence must be a single-link regular file or a directory.");
    const result = directory;
    directory = -1;
    return result;
  } finally { if (directory !== -1) closeSync(directory); }
}

function base(chatId: string): string[] {
  if (!/^[a-f0-9-]{36}$/.test(chatId)) throw new Error("Invalid original Chat identity.");
  return [".pkm", "state", "api-chat-tool-results", chatId];
}
function sameFile(a: Stats, b: Stats) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mode === b.mode && a.nlink === b.nlink
    && a.uid === b.uid && a.gid === b.gid
    && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
function assertUnchanged(root: string, components: string[], before: Stats, after: Stats, directory = false) {
  if (!sameFile(before, after)) throw new Error("Original process evidence changed while reading.");
  let reopened: number;
  try { reopened = openEvidence(root, components, directory); }
  catch { throw new Error("Original process evidence path changed while reading."); }
  try {
    if (!sameFile(before, fstatSync(reopened))) throw new Error("Original process evidence path changed while reading.");
  } finally { closeSync(reopened); }
}

function readOriginalProcessRecord(root: string, chatId: string, handle: string) {
  if (!handlePattern.test(handle)) throw new Error("Choose an exact original process handle.");
  const parts = [...base(chatId), "processes", handle, "record.json"];
  const fd = openEvidence(root, parts);
  try {
    const before = fstatSync(fd);
    if (before.size > 32_000) throw new Error("Original process record exceeds its bound.");
    const bytes = readFileSync(fd), after = fstatSync(fd);
    if (bytes.length !== before.size) throw new Error("Original process evidence changed while reading.");
    assertUnchanged(root, parts, before, after);
    const record = recordSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    if (record.handle !== handle) throw new Error("Original process evidence has a different handle.");
    return record;
  } finally { closeSync(fd); }
}

function publicRecord(record: ReturnType<typeof readOriginalProcessRecord>) {
  return ["launching", "running", "paused"].includes(record.state)
    ? { ...record, state: "unknown", detail: "Original supervisor ownership is not established; no historical PID was signalled." }
    : record;
}

export function originalProcessRecord(root: string, chatId: string, handle: string) {
  return publicRecord(readOriginalProcessRecord(root, chatId, handle));
}

export function originalProcessOutput(root: string, chatId: string, input: {
  handle: string; stream: "stdout" | "stderr"; start: number; length: number;
}) {
  input = z.strictObject({ handle: z.string(), stream: z.enum(["stdout", "stderr"]),
    start: z.number().int().nonnegative().safe(), length: z.number().int().min(1).max(12000) }).parse(input);
  const foreground = foregroundPattern.exec(input.handle);
  if (!foreground && !handlePattern.test(input.handle)) throw new Error("Choose an exact original process output handle.");
  const record = foreground ? undefined : readOriginalProcessRecord(root, chatId, input.handle);
  const state = record ? publicRecord(record).state : "foreground-log";
  const parts = foreground ? [...base(chatId), `${foreground[1]}.${input.stream}.log`]
    : [...base(chatId), "processes", input.handle, `${input.stream}.log`];
  let fd: number;
  try { fd = openEvidence(root, parts); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !record || !["launching", "cancelled"].includes(record.state)
      || record[input.stream === "stdout" ? "stdoutBytes" : "stderrBytes"] !== 0) throw error;
    const parentParts = parts.slice(0, -1), parent = openEvidence(root, parentParts, true);
    try {
      const before = fstatSync(parent);
      try {
        const appeared = openSync(`/proc/self/fd/${parent}/${parts.at(-1)}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        closeSync(appeared);
        throw new Error("Original process output appeared while reading.");
      } catch (missing) {
        if ((missing as NodeJS.ErrnoException).code !== "ENOENT") throw missing;
      }
      assertUnchanged(root, parentParts, before, fstatSync(parent), true);
      if (JSON.stringify(record) !== JSON.stringify(readOriginalProcessRecord(root, chatId, input.handle)))
        throw new Error("Original process record changed while reading output.");
      return { handle: input.handle, stream: input.stream, start: input.start, end: input.start,
        availableBytes: 0, text: "", state, pending: true };
    } finally { closeSync(parent); }
  }
  try {
    const before = fstatSync(fd), size = before.size;
    if (input.start > size) throw new Error("Output byte offset is beyond the available original evidence.");
    const buffer = Buffer.alloc(Math.min(input.length, size - input.start));
    let count = 0;
    while (count < buffer.length) {
      const read = readSync(fd, buffer, count, buffer.length - count, input.start + count);
      if (!read) break;
      count += read;
    }
    if (count !== buffer.length) throw new Error("Original process evidence changed while reading.");
    assertUnchanged(root, parts, before, fstatSync(fd));
    if (record && JSON.stringify(record) !== JSON.stringify(readOriginalProcessRecord(root, chatId, input.handle)))
      throw new Error("Original process record changed while reading output.");
    const result = (length: number) => ({ handle: input.handle, stream: input.stream, start: input.start,
      end: input.start + length, availableBytes: size, text: buffer.subarray(0, length).toString("utf8"), state,
      more: input.start + length < size, encoding: "utf8",
      note: "Offsets are bytes; split UTF-8 boundaries may display a replacement character. Original bytes remain unchanged." });
    let length = count;
    while (JSON.stringify(result(length)).length > 15000 && length > 0) length = Math.floor(length / 2);
    return result(length);
  } finally { closeSync(fd); }
}

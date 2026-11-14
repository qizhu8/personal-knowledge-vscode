import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { checkedDocumentPath, documentPath } from "./document-path.js";
import { compileKnowledgeIdentityV1, legacyKnowledgeAlias } from "./domain/knowledge-contracts.js";
import { decodeMarkdown } from "./markdown.js";

type RecordValue = Record<string, any>;
export const meetingSourceDigest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export function meetingNotePath(meeting: RecordValue): string {
  if (typeof meeting.markdownPath !== "string") throw new Error("Meeting Note path is missing.");
  const path = meeting.markdownPath.replace(/\\/g, "/");
  if (!documentPath.safeParse(path).success || !path.startsWith("Chatroom Meetings/"))
    throw new Error("Meeting Note path is outside the private Meeting collection.");
  return path;
}
export function validateMeetingSource(roomId: string, value: any) {
  if (value?.schema !== 1 || !Array.isArray(value.meetings) || value.meetings.length > 5000)
    throw new Error("Unsupported or oversized original Meeting state; no records were pruned.");
  const ids = new Set(), paths = new Set();
  for (const meeting of value.meetings) {
    if (!meeting || meeting.roomId !== roomId || typeof meeting.id !== "string" || !meeting.id
      || ids.has(meeting.id) || !["active", "adjourned", "trashed"].includes(meeting.status)
      || typeof meeting.startedAt !== "string" || !Number.isSafeInteger(meeting.revision) || meeting.revision < 1
      || !Array.isArray(meeting.topics) || !Array.isArray(meeting.events))
      throw new Error("Invalid or cross-Room original Meeting record; preserve the source.");
    const path = meetingNotePath(meeting);
    if (paths.has(path)) throw new Error("Original Meetings share a Note path; preserve the source.");
    ids.add(meeting.id); paths.add(path);
  }
  if (value.meetings.filter((meeting: RecordValue) => meeting.status === "active").length > 1)
    throw new Error("Original Room has multiple active Meetings; preserve the source.");
  return value;
}
export function readMeetingSourceText(file: string): string {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024)
    throw new Error("Meeting source must be a bounded regular file, not a link.");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const opened = fstatSync(fd);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error("Meeting source changed before reading.");
    bytes = readFileSync(fd);
  } finally { closeSync(fd); }
  const after = lstatSync(file);
  if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
    throw new Error("Meeting source changed while reading; preserve both versions.");
  const value = bytes.toString("utf8");
  if (!Buffer.from(value).equals(bytes)) throw new Error("Meeting source is not valid UTF-8; preserve its bytes.");
  return value;
}
function resolveRetainedMeetingNote(root: string, id: string, path: string): string {
  const original = checkedDocumentPath(root, path, false);
  try { lstatSync(original); return original; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const entries = readdirSync(dirname(original)).sort();
  if (entries.length > 5000) throw new Error("Meeting Note alias collection is oversized; preserve the source.");
  const alias = legacyKnowledgeAlias("note", path), matches: string[] = [];
  let bytes = 0;
  for (const name of entries) {
    const relative = join(dirname(path), name).replace(/\\/g, "/");
    if (!documentPath.safeParse(relative).success) continue;
    const candidate = checkedDocumentPath(root, relative, false);
    const text = readMeetingSourceText(candidate);
    bytes += Buffer.byteLength(text);
    if (bytes > 64 * 1024 * 1024) throw new Error("Meeting Note alias inventory exceeds 64 MiB; preserve the source.");
    let identity;
    try {
      const metadata = decodeMarkdown(id, text, relative).metadata.toJS({ maxAliasCount: 0 }) as RecordValue;
      identity = compileKnowledgeIdentityV1(Object.fromEntries(
        ["schema", "knowledgeId", "revision", "aliases"].map(key => [key, metadata[key]]),
      ));
    } catch { continue; }
    if (identity.ok && identity.model.aliases.includes(alias)) matches.push(candidate);
  }
  if (matches.length > 1) throw new Error("Meeting Note alias is ambiguous; preserve every source.");
  if (!matches.length) return original;
  return matches[0];
}
export function inspectRetainedMeetingSource(root: string, roomId: string,
  resolveNote: (id: string, path: string) => string = (id, path) => resolveRetainedMeetingNote(root, id, path)) {
  if (!/^[A-Za-z0-9_-]{6,80}$/.test(roomId)) throw new Error("Invalid Meeting Room identity.");
  let directory = root, canonical: string | null = null;
  for (const part of ["chatrooms", roomId, "meetings"]) {
    directory = join(directory, part);
    try {
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Meeting source parents must not be links.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { canonical, state: { schema: 1, meetings: [] }, notes: [] as RecordValue[], hash: meetingSourceDigest("absent") };
      throw error;
    }
  }
  try { canonical = readMeetingSourceText(join(directory, "canonical.json")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const state = canonical === null ? { schema: 1, meetings: [] } : validateMeetingSource(roomId, JSON.parse(canonical));
  let aggregateBytes = Buffer.byteLength(canonical ?? "");
  const resolvedPaths = new Set<string>();
  const notes: RecordValue[] = state.meetings.map((meeting: RecordValue) => {
    const path = meetingNotePath(meeting);
    let body: string | null = null;
    try {
      const resolved = resolveNote(meeting.id, path);
      if (resolvedPaths.has(resolved)) throw new Error("Original Meetings share a resolved Note; preserve the source.");
      resolvedPaths.add(resolved);
      body = readMeetingSourceText(resolved);
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || meeting.status !== "trashed") throw error;
    }
    aggregateBytes += Buffer.byteLength(body ?? "");
    if (aggregateBytes > 64 * 1024 * 1024) throw new Error("Original Meeting inventory exceeds 64 MiB; no records were pruned.");
    return { id: meeting.id, path, body, visible: meeting.status !== "trashed" };
  });
  return { canonical, state, notes,
    hash: meetingSourceDigest(JSON.stringify([canonical, notes.map((note: RecordValue) => [note.path, note.body])])) };
}

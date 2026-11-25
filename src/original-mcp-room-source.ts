import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { z } from "zod";
import { assertStorage, type Storage } from "./storage.js";
import { assertOriginalMcpNativeHost, type OriginalMcpNativeHost } from "./original-mcp-native-host.js";
import { assertOriginalMcpPrivacy } from "./original-mcp-root-custody.js";
import { openOriginalMcpCustodyReader } from "./original-mcp-root.js";
import { inspectLegacyChatroomArchive, inspectLegacyChatroomParticipants } from "./legacy-chatroom-continuation.js";
import { inspectRetainedMeetingSource } from "./next-room-meeting-source.js";
import { originalNativeRoomDigest, originalNativeRoomSourceSchema, type OriginalNativeRoomSource } from "./original-mcp-native-room-contracts.js";

function fail(code: string): never { throw Object.assign(new Error(code), { code }); }

/** Original-root read-only custody. Private Meeting Notes stay in place, never in the public Note projection. */
export async function inspectOriginalMcpRoomSource(storage: Storage, host: OriginalMcpNativeHost,
  roomId: string): Promise<OriginalNativeRoomSource> {
  const current = () => {
    assertStorage(storage); storage.assertWorkspaceLease(); assertOriginalMcpNativeHost(host, storage);
    const journal = assertOriginalMcpPrivacy(storage.workspaceRoot());
    if (!journal || journal.plan.planSha256 !== host.receipt.planSha256
      || journal.workspaceId !== host.receipt.workspaceId || journal.plan.profileSha256 !== host.receipt.profileSha256)
      fail("NATIVE_ROOM_ORIGINAL_OWNER_REQUIRED");
    return journal;
  };
  const journal = current(), root = storage.workspaceRoot();
  const archive = inspectLegacyChatroomArchive(root, roomId);
  const participants = inspectLegacyChatroomParticipants(root, roomId);
  const meetings = inspectRetainedMeetingSource(root, roomId);
  const database = new DatabaseSync(join(root, "chatrooms", roomId, "chatroom.db"), { readOnly: true });
  let metadata;
  try {
    database.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF");
    const rows = database.prepare("SELECT * FROM room_metadata WHERE room_id=? LIMIT 2").all(roomId);
    if (rows.length !== 1) fail("NATIVE_ROOM_OWNER_METADATA_REQUIRED");
    metadata = rows[0];
  } finally { database.close(); }
  const id = z.string().min(1).max(256);
  const nullable = (value: unknown) => value === undefined || value === null ? null : id.parse(value);
  const ownerInstallationId = id.parse(metadata.owner_installation_id);
  const hostParticipantId = nullable(metadata.host_participant_id);
  if (hostParticipantId && !participants.memberships.some(member =>
    member.participantId === hostParticipantId && member.kind === "human" && !member.forgottenAt && !member.temporary))
    fail("NATIVE_ROOM_HOST_PARTICIPANT_CONFLICT");
  const reader = await openOriginalMcpCustodyReader(journal.plan);
  try {
    const files: OriginalNativeRoomSource["files"] = [];
    for (const file of archive.files) {
      const bytes = await reader.read(file.path, 33_554_432);
      if (originalNativeRoomDigestBytes(bytes) !== file.sha256) fail("NATIVE_ROOM_ARCHIVE_CHANGED");
      files.push({ path: file.path, sha256: file.sha256 });
    }
    for (const note of meetings.notes) {
      const path = `notes/${note.path}`;
      if (note.body === null) {
        if (reader.entry(path)) fail("NATIVE_ROOM_MISSING_NOTE_CONFLICT");
        continue;
      }
      // Canonical paths only in this bounded slice. Renamed aliases remain intact and fail closed.
      const bytes = await reader.read(path, 16_777_216);
      if (!bytes.equals(Buffer.from(note.body, "utf8"))) fail("NATIVE_ROOM_PRIVATE_NOTE_CHANGED");
      files.push({ path, sha256: originalNativeRoomDigestBytes(bytes) });
    }
    current(); reader.assertCurrent();
    if (inspectLegacyChatroomArchive(root, roomId).sourceFingerprint !== archive.sourceFingerprint
      || originalNativeRoomDigest(inspectLegacyChatroomParticipants(root, roomId)) !== originalNativeRoomDigest(participants)
      || inspectRetainedMeetingSource(root, roomId).hash !== meetings.hash)
      fail("NATIVE_ROOM_SOURCE_CHANGED");
    const body = {
      schema: "pkm.original-native-room-source/v1" as const, root, workspaceId: host.receipt.workspaceId,
      custodyPlanSha256: journal.plan.planSha256, profileSha256: journal.plan.profileSha256,
      nativeHostReceiptSha256: host.receipt.receiptSha256, roomId, roomName: archive.name,
      sourceFingerprint: archive.sourceFingerprint, meetingSha256: meetings.hash, participantSha256: originalNativeRoomDigest(participants),
      ownerInstallationId, hostParticipantId, projectId: nullable(metadata.project_id), threadId: nullable(metadata.thread_id),
      hostCredentialHash: metadata.host_credential_hash, joinSecretHash: metadata.join_secret_hash,
      messages: archive.messages.length, participants: participants.memberships.length,
      meetings: meetings.state.meetings.length, privateNotes: meetings.notes.filter(note => note.body !== null).length,
      files: files.sort((left, right) => left.path.localeCompare(right.path)),
    };
    const result = originalNativeRoomSourceSchema.parse({ ...body, sourceSha256: originalNativeRoomDigest(body) });
    result.files.forEach(Object.freeze); Object.freeze(result.files);
    return Object.freeze(result);
  } finally { reader.close(); }
}

function originalNativeRoomDigestBytes(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }

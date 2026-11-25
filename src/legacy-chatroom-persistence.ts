import type { DatabaseSync } from "node:sqlite";

type JsonRecord = Record<string, any>;
export interface LegacyRoomState {
  roomId: string; roomName: string; state: "stored" | "active"; updatedAt: number;
  hostParticipantId?: string;
  messages: JsonRecord[]; identity: { memberships: JsonRecord[]; aliases: JsonRecord[]; pendingJoins: JsonRecord[] };
}
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const aliasKey = (alias: string) => alias.trim().normalize("NFKC").toLocaleLowerCase();

export function initializeLegacyRoomPersistence(database: DatabaseSync): void {
  database.exec(`CREATE TABLE IF NOT EXISTS legacy_room_runtime_schema(version INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS legacy_room_runtime_rooms(room_id TEXT PRIMARY KEY,source_fingerprint TEXT NOT NULL,state_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS legacy_room_runtime_files(room_id TEXT NOT NULL,file_id TEXT NOT NULL,owner_id TEXT NOT NULL,
      metadata_json TEXT NOT NULL,complete INTEGER NOT NULL,sha256 TEXT,data BLOB,PRIMARY KEY(room_id,file_id));
    CREATE TABLE IF NOT EXISTS legacy_room_runtime_chunks(room_id TEXT NOT NULL,file_id TEXT NOT NULL,sequence INTEGER NOT NULL,
      sha256 TEXT NOT NULL,data BLOB NOT NULL,PRIMARY KEY(room_id,file_id,sequence));
    CREATE TABLE IF NOT EXISTS legacy_room_runtime_resume(room_id TEXT NOT NULL,participant_id TEXT NOT NULL,
      client_key TEXT NOT NULL,secret_hash TEXT NOT NULL,PRIMARY KEY(room_id,participant_id));`);
  const versions = database.prepare("SELECT version FROM legacy_room_runtime_schema").all();
  if (!versions.length) database.prepare("INSERT INTO legacy_room_runtime_schema VALUES(1)").run();
  else if (versions.length !== 1 || versions[0].version !== 1) throw new Error("Unsupported native legacy Room runtime schema.");
}

/** The existing canonical Room persistence ABI, shared by local and native-owned retained Hubs. */
export function createLegacyRoomPersistence(options: {
  database: DatabaseSync;
  state(roomId: string): LegacyRoomState;
  change<T>(roomId: string, operation: (room: LegacyRoomState) => T): T;
}) {
  const { database, state, change } = options;
  const persistence = {
    async openRoom(id: string) { return { messages: copy(state(id).messages), replayed: 0 }; },
    async identityState(id: string) { return copy(state(id).identity); },
    async append(id: string, message: JsonRecord) {
      change(id, room => {
        const prior = room.messages.find(item => item.id === message.id);
        if (prior) { if (JSON.stringify(prior) !== JSON.stringify(message)) throw new Error("Message receipt conflict."); return; }
        if (room.messages.length >= 5000) throw new Error("Room history limit reached; no records were pruned.");
        room.messages.push(copy(message));
      });
    },
    async appendMany(id: string, messages: JsonRecord[]) { for (const message of messages) await persistence.append(id, message); },
    async recordLifecycle(id: string, type: string, next?: "stored" | "active", payload?: JsonRecord) {
      change(id, room => {
        if (next) room.state = next;
        if (type === "room.renamed") room.roomName = String(payload?.roomName);
        if (type === "room.host_assigned") {
          if (!room.identity.memberships.some(member => member.participantId === payload?.participantId && !member.forgottenAt))
            throw new Error("Native host assignment requires an admitted membership.");
          room.hostParticipantId = String(payload?.participantId);
          if (database.prepare("SELECT 1 FROM sqlite_schema WHERE name='next_room_host_successions'").get())
            database.prepare("UPDATE next_room_host_successions SET assigned_host=? WHERE room_id=?")
              .run(room.hostParticipantId, id);
        }
      });
    },
    async requestJoin(id: string, request: JsonRecord) {
      change(id, room => { if (!room.identity.pendingJoins.some(item => item.requestId === request.requestId))
        room.identity.pendingJoins.push({ ...copy(request), status: "pending" }); });
    },
    async resolveJoin(id: string, resolution: JsonRecord) {
      change(id, room => {
        const request = room.identity.pendingJoins.find(item => item.requestId === resolution.requestId);
        if (!request || request.status !== "pending") return;
        if (["new", "reuse"].includes(resolution.outcome)) {
          let member = room.identity.memberships.find(item => item.participantId === resolution.participantId);
          if (!member) {
            if (resolution.outcome !== "new" || room.identity.memberships.length >= 64) throw new Error("Invalid or excessive membership.");
            member = { participantId: resolution.participantId, kind: request.kind, role: "", temporary: !!request.temporary,
              createdAt: resolution.resolvedAt, updatedAt: resolution.resolvedAt };
            room.identity.memberships.push(member);
          }
          if (member.forgottenAt || member.kind !== request.kind) throw new Error("Participant identity mismatch.");
          const key = request.aliasKey ?? aliasKey(request.alias);
          if (room.identity.aliases.some(alias => alias.aliasKey === key && !alias.releasedAt && alias.participantId !== member!.participantId))
            throw new Error("Alias already reserved.");
          room.identity.aliases.push({ aliasKey: key, alias: request.alias, participantId: member.participantId, assignedAt: resolution.resolvedAt });
        }
        Object.assign(request, resolution, { status: resolution.outcome === "new" ? "approved_new"
          : resolution.outcome === "reuse" ? "approved_reuse" : resolution.outcome === "timeout" ? "timed_out" : resolution.outcome === "reject" ? "rejected" : "cancelled" });
      });
    },
    async releaseAlias(id: string, participantId: string, at: number, alias?: string) {
      change(id, room => { for (const item of room.identity.aliases)
        if (item.participantId === participantId && !item.releasedAt && (!alias || item.aliasKey === aliasKey(alias))) item.releasedAt = at; });
    },
    async forgetParticipant(id: string, participantId: string, at: number) {
      change(id, room => { const member = room.identity.memberships.find(item => item.participantId === participantId);
        if (member) member.forgottenAt = at;
        database.prepare("DELETE FROM legacy_room_runtime_resume WHERE room_id=? AND participant_id=?").run(id, participantId);
        for (const alias of room.identity.aliases) if (alias.participantId === participantId && !alias.releasedAt) alias.releasedAt = at; });
    },
    async renameAlias(id: string, participantId: string, alias: string, at: number) {
      await persistence.releaseAlias(id, participantId, at);
      change(id, room => { room.identity.aliases.push({ participantId, alias, aliasKey: aliasKey(alias), assignedAt: at }); });
    },
    async setParticipantRole(id: string, participantId: string, role: string) {
      change(id, room => { const member = room.identity.memberships.find(item => item.participantId === participantId); if (member) member.role = role; });
    },
    async closeRoom(id: string) { change(id, room => { room.state = "stored"; }); },
    async dispose() {},
  };
  return persistence;
}

export function prepareLegacyRoomRehost(room: LegacyRoomState, database: DatabaseSync): void {
  room.state = "stored";
  for (const member of room.identity.memberships) if (member.temporary && !member.forgottenAt) {
    member.forgottenAt = Date.now();
    database.prepare("DELETE FROM legacy_room_runtime_resume WHERE room_id=? AND participant_id=?").run(room.roomId, member.participantId);
  }
  for (const request of room.identity.pendingJoins) if (request.status === "pending") request.status = "cancelled";
  for (const alias of room.identity.aliases) if (!alias.releasedAt) alias.releasedAt = Date.now();
}

export interface RecentRoomIdentity {
  id: string;
  url: string;
  room: string;
  roomId?: string;
  host: boolean;
  lastJoined: number;
}

function canonicalRoom(room: string): string {
  return String(room || "").trim().replace(/\s+/g, " ").toLowerCase();
}

export function chatRoomIdentity(url: string, room: string, roomId?: string): string {
  if (roomId) return `room:${roomId}`;
  let host = String(url || "").trim().toLowerCase();
  try { host = new URL(url).hostname.toLowerCase(); } catch { /* preserve legacy host text */ }
  if (host === "localhost" || host === "::1" || host === "[::1]") host = "127.0.0.1";
  return `legacy:${host}||${canonicalRoom(room)}`;
}

export function joinedRoomRecents<T extends RecentRoomIdentity>(rooms: T[]): T[] {
  const seen = new Set<string>();
  return rooms
    .filter(room => !room.host)
    .sort((left, right) => right.lastJoined - left.lastJoined)
    .filter(room => {
      const identity = chatRoomIdentity(room.url, room.room, room.roomId);
      if (seen.has(identity)) return false;
      seen.add(identity);
      room.id = identity;
      return true;
    });
}

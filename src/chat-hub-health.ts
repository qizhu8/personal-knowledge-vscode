import * as http from "http";

export function probeChatRoomActive(wsUrl: string, roomName: string, roomId?: string, timeoutMs = 2000): Promise<boolean> {
  return new Promise(resolve => {
    let httpUrl: string;
    try {
      const url = new URL(wsUrl);
      if (url.protocol === "wss:") { resolve(true); return; }
      url.protocol = "http:";
      url.pathname = "/health";
      url.search = "";
      httpUrl = url.toString();
    } catch { resolve(false); return; }
    const request = http.get(httpUrl, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { if (body.length < 64 * 1024) body += chunk; });
      response.on("end", () => {
        if (response.statusCode !== 200) { resolve(false); return; }
        try {
          const health = JSON.parse(body);
          const activeRooms = Array.isArray(health.activeRooms) ? health.activeRooms : undefined;
          if (activeRooms) {
            const canonicalName = roomName.trim().replace(/\s+/g, " ").toLocaleLowerCase();
            resolve(activeRooms.some((room: any) => roomId
              ? String(room.roomId || "") === roomId
              : String(room.room || "").trim().replace(/\s+/g, " ").toLocaleLowerCase() === canonicalName));
            return;
          }
          resolve(Number(health.rooms) > 0);
        } catch { resolve(false); }
      });
    });
    request.on("error", () => resolve(false));
    request.setTimeout(timeoutMs, () => { request.destroy(); resolve(false); });
  });
}
export type NavigationStatusKind = "online" | "attention" | "offline";

export interface NavigationStatus {
  kind: NavigationStatusKind;
  description: string;
  tooltip: string;
}

export interface ServerNavigationRow {
  status?: string;
  proxyRunning?: boolean;
}

export function summarizeServerNavigation(rows: ServerNavigationRow[]): NavigationStatus {
  const running = rows.filter(row => row.status === "running").length;
  const starting = rows.filter(row => row.status === "starting").length;
  if (starting) {
    const reason = `${starting} starting`;
    return { kind: "attention", description: reason, tooltip: `Servers need attention: ${reason}.` };
  }
  if (running) return { kind: "online", description: `${running} running`, tooltip: `${running} managed server${running === 1 ? " is" : "s are"} running; stable proxy is online.` };
  return { kind: "offline", description: rows.length ? "all stopped" : "none", tooltip: rows.length ? "All managed servers are stopped." : "No managed servers are registered." };
}

export interface ChatNavigationState {
  hubRunning?: boolean;
  rooms?: { status?: string }[];
}

export function summarizeChatNavigation(state: ChatNavigationState): NavigationStatus {
  const rooms = state.rooms || [];
  const connected = rooms.filter(room => room.status === "connected").length;
  const connecting = rooms.filter(room => room.status === "connecting").length;
  if (connecting) return { kind: "attention", description: `${connecting} connecting`, tooltip: `${connecting} Chatroom connection${connecting === 1 ? " is" : "s are"} connecting or reconnecting.` };
  if (connected) return { kind: "online", description: `${connected} connected`, tooltip: `${connected} Chatroom connection${connected === 1 ? " is" : "s are"} active.` };
  if (state.hubRunning) return { kind: "online", description: "Hub running", tooltip: "The local Chat Hub is running; no Room is currently open in this window." };
  return { kind: "offline", description: "offline", tooltip: "Chat Hub and Room connections are offline." };
}
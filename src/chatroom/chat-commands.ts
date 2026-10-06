// Chatroom "magic messages" — slash commands a member can type in the room that
// are intercepted by the hub and answered privately by a background sender
// (the "roombot"). Add new commands to CHAT_COMMANDS; the hub and /help pick
// them up automatically. Command text is NEVER broadcast to the room — only the
// bot's reply is sent back to the requester.
import type { Member } from "./chatroom-protocol";

/** Display name of the background sender that answers slash commands. */
export const BOT_NAME = "roombot";

/** Everything a command needs to build its reply. Provided by the hub. */
export interface CommandContext {
  room:     string;     // canonical room name
  isOwner:  boolean;    // is the requester the room host?
  wsUrl:    string;     // ws://ip:port
  joinUrl:  string;     // ws://ip:port/<room>  (embeds the room)
  members:  Member[];   // full roster (present + departed)
  arg:      string;     // trailing text after the command word (e.g. "/whois bob" -> "bob")
  actions:  CommandActions;   // side-effecting capabilities the hub grants to commands
}

/** Side effects a command may trigger, injected by the hub. */
export interface CommandActions {
  muteAll:   () => number;   // mute every present non-host member; returns how many changed
  unmuteAll: () => number;   // clear all mutes in the room; returns how many were cleared
  rotateSecret: () => Promise<boolean>;  // rotate the room secret; returns true if a secret existed to rotate
  inviteMessage: () => string;
}

export interface ChatCommand {
  name:     string;                          // e.g. "help" (typed as "/help")
  summary:  string;                          // one-line description for /help
  hostOnly?: boolean;                        // only the room host may run it
  run: (ctx: CommandContext) => string | Promise<string>;      // returns the reply text (may be multi-line)
}

function ago(ts?: number): string {
  if (!ts) return "away";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `left ${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `left ${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `left ${h}h ago`;
  return `left ${Math.round(h / 24)}d ago`;
}

function via(m: Member): string {
  return m.kind === "agent" ? "MCP agent" : m.kind === "browser" ? "browser" : "extension";
}

function memberLine(m: Member): string {
  const tag = m.host ? " 👑host" : m.muted ? " 🔇muted" : "";
  const id  = m.sid ? ` #${m.sid}` : "";
  const unv = m.verified === false ? ", unverified" : "";
  return ` • ${m.user}${tag} (${via(m)}${unv})${id}`;
}

export const CHAT_COMMANDS: ChatCommand[] = [
  {
    name: "help",
    summary: "List the commands you can use in this room",
    run: (ctx) => {
      const avail = CHAT_COMMANDS.filter(c => !c.hostOnly || ctx.isOwner);
      const lines = [`🛎️ ${BOT_NAME} — commands you can type here:`];
      for (const c of avail) lines.push(`  /${c.name} — ${c.summary}${c.hostOnly ? "  (host only)" : ""}`);
      return lines.join("\n");
    },
  },
  {
    name: "share_link",
    summary: "Create the one-paste MCP Magic Link invite",
    hostOnly: true,
    run: (ctx) => ctx.actions.inviteMessage(),
  },
  {
    name: "list_audiences",
    summary: "List who is active and who has left this room",
    hostOnly: true,
    run: (ctx) => {
      const present = ctx.members.filter(m => m.present !== false);
      const away    = ctx.members.filter(m => m.present === false);
      const lines = [`👥 Audiences in "${ctx.room}"`, `Active (${present.length}):`];
      lines.push(present.length ? present.map(memberLine).join("\n") : "  (none)");
      if (away.length) {
        lines.push(`Away (${away.length}):`);
        lines.push(away.map(m => `${memberLine(m)} — ${ago(m.lastSeen)}`).join("\n"));
      }
      return lines.join("\n");
    },
  },
  {
    name: "whois",
    summary: "Show details about a member — /whois <name>",
    run: (ctx) => {
      const q = ctx.arg.trim().toLowerCase();
      if (!q) return "Usage: /whois <name>";
      const hits = ctx.members.filter(m => m.user.trim().toLowerCase() === q);
      if (!hits.length) return `No one named "${ctx.arg.trim()}" is here (or was recently).`;
      return hits.map(m => {
        const status = m.present !== false ? "active" : ago(m.lastSeen);
        const bits = [`status: ${status}`, `via: ${via(m)}`, `id: ${m.sid || "—"}${m.verified === false ? " (unverified)" : ""}`];
        if (m.host) bits.push("host 👑");
        if (m.muted) bits.push("muted 🔇");
        return `🔎 ${m.user} — ${bits.join(" · ")}`;
      }).join("\n");
    },
  },
  {
    name: "stop",
    summary: "Stop and disconnect online agents without removing their Room identity — /stop @agent or @all",
    hostOnly: true,
    run: () => "Stopping the named online agent(s).",
  },
  {
    name: "mute_all",
    summary: "Mute everyone except you",
    hostOnly: true,
    run: (ctx) => {
      const n = ctx.actions.muteAll();
      return n ? `🔇 Muted ${n} member(s). Use /unmute_all to reverse it.` : "No one to mute right now.";
    },
  },
  {
    name: "unmute_all",
    summary: "Unmute everyone in the room",
    hostOnly: true,
    run: (ctx) => {
      const n = ctx.actions.unmuteAll();
      return n ? `🔊 Cleared mute on ${n} member(s).` : "No one is muted.";
    },
  },
  {
    name: "rotate_secret",
    summary: "Rotate this room's secret (the old one stops working)",
    hostOnly: true,
    run: async (ctx) => await ctx.actions.rotateSecret()
      ? "🔑 Rotated the room secret. Copy the new one from the notification (or the 🔑 button) and share it with your team. Current members stay; new joiners need the new secret."
      : "This room has no secret to rotate.",
  },
];

/** Parse the leading token of a slash message and return the matching command. */
export function findCommand(text: string): ChatCommand | undefined {
  const name = text.trim().replace(/^\/+/, "").split(/\s+/)[0]?.toLowerCase();
  if (!name) return undefined;
  return CHAT_COMMANDS.find(c => c.name === name);
}

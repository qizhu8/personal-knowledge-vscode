import type { ChatMessage } from "./chatroom";

export function messageAddressesManagedAgent(
  message: Pick<ChatMessage, "text" | "recipients">,
  agentName: string,
): boolean {
  const normalizedName = String(agentName || "").trim().toLocaleLowerCase();
  if (!normalizedName) return false;
  const recipients = Array.isArray(message.recipients)
    ? message.recipients.map(value => String(value || "").trim().toLocaleLowerCase()).filter(Boolean)
    : [];
  if (recipients.length) {
    return recipients.includes(normalizedName) || recipients.includes("all") || recipients.includes("everyone");
  }
  const escaped = agentName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return /@(all|everyone)\b/i.test(message.text)
    || new RegExp(`@(?:"${escaped}"|${escaped})(?=\\s|$|[,.!?;:])`, "i").test(message.text);
}

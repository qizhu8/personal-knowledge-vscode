import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, relative, dirname } from "node:path";

const server = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(server, "legacy");
const hash = text => createHash("sha256").update(text).digest("hex");
const captures = [
  ["src/chatroom/collaboration-model.ts", "src/domain/collaboration-state-model.ts"],
  ["src/chatroom/portal-permissions.ts", "src/domain/collaboration-state-permissions.ts"],
  ["src/chatroom/portal-connections.ts", "src/domain/collaboration-state-connections.ts"],
  ["src/chatroom/portal-routing.ts", "src/domain/collaboration-state-routing.ts"],
  ["src/chatroom/chatroom-hub.ts", "src/domain/collaboration-state-mentions.ts"],
];
const entries = captures.map(([source, destination]) => {
  const original = readFileSync(resolve(repo, source), "utf8");
  const captured = source.endsWith("chatroom-hub.ts")
    ? original.slice(original.indexOf("  private mentionSearchText("), original.indexOf("  private mentionTargets("))
      .replace(/  private (\w+)\(/g, "export function $1(").replace("this.mentionSearchText(", "mentionSearchText(")
    : original.replace('from "./portal-permissions"', 'from "./collaboration-state-permissions.js"');
  const target = resolve(server, destination);
  if (process.argv.includes("--check")) {
    if (readFileSync(target, "utf8") !== captured) throw new Error(`Capture drift: ${destination}`);
  } else writeFileSync(target, captured);
  return { source, destination: relative(server, target), sourceSha256: hash(original), captureSha256: hash(captured) };
});
const evidence = [
  "src/chatroom/chatroom-hub.ts", "src/chatroom/chat-join-approval.ts",
  "src/chatroom/meeting-state.ts", "src/chatroom/chat-meeting-lifecycle.ts",
  "src/chatroom/chatroom-protocol.ts",
].map(source => ({ source, sourceSha256: hash(readFileSync(resolve(repo, source))) }));
const provenance = {
  schema: 1, rootsRelativeTo: "provenance-file-directory", sourceRoot: "../..", captureRoot: "..", captures: entries, evidence,
  subset: [
    "Exact original structured collaboration reducer and Portal permission/routing/view policies.",
    "Local room membership/history CAS aggregate; actor-bound participant identity; original explicit-recipient routing only.",
    "Original meeting start/adjourn phase/status projection only; no Markdown, topics, scheduling or session creation.",
  ],
  restrictions: [
    "No original Knowledge or session data is read. No transports, peers, commands or sessions are invoked.",
    "Portal bindings/leases remain volatile and cannot be restored; persisted room state is not a live connection.",
    "Public list/read/self-leave only. Human room creation/join/mute/close and meeting adapters are not advertised.",
    "Injected authorizeHuman gate must authenticate out of band; no request role, host, owner or actor override.",
    "No browser identity reuse, credential/invitation import, host reassignment, meeting trash or permanent delete.",
    "One logical presence per trusted human actor; transport windows, agent/browser admission and reconnect grace timers are withheld.",
    "Structured recipients only: original case-insensitive alias resolution and quoted/code mention filtering; absent roster identities may remain recipients.",
    "Two-MiB room aggregate, 64 roster/tasks, 5000 history entries, 1000 rooms and 10000 non-evicting receipts per room are new isolation bounds.",
  ],
};
const path = resolve(server, "migration/collaboration-state-provenance.json");
const serialized = JSON.stringify(provenance, null, 2) + "\n";
if (process.argv.includes("--check")) {
  if (readFileSync(path, "utf8") !== serialized) throw new Error("Provenance drift");
} else writeFileSync(path, serialized);
console.log(`Verified ${entries.length} captures and ${evidence.length} source hashes.`);

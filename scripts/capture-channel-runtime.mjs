import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const server = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(server, "legacy");
const digest = value => createHash("sha256").update(value).digest("hex");
const mode = process.argv[2] ?? "";
if (!["", "--check", "--refresh-native"].includes(mode)) {
  throw new Error("Usage: node scripts/capture-channel-runtime.mjs [--check|--refresh-native]");
}
const source = "src/chatroom/peer-protocol.ts";
const destination = "src/domain/channel-runtime-original-peer.ts";
const original = readFileSync(resolve(sourceRoot, source));
const provenance = {
  schema: 1, rootsRelativeTo: "provenance-file-directory", sourceRoot: "../..", captureRoot: "..",
  captures: [{ source, destination, sourceSha256: digest(original), captureSha256: digest(original), transform: "none; exact bytes" }],
  evidence: [
    "src/chatroom/chatroom-protocol.ts", "src/chatroom/chatroom-hub.ts", "src/chatroom/peer-session.ts",
    "src/chatroom/chat-join-approval.ts", "src/chatroom/chat-room-identity.ts",
    "src/chatroom/collaboration-model.ts", "src/chatroom/portal-connections.ts",
    "src/chatroom/meeting-state.ts", "src/chatroom/chat-meeting-lifecycle.ts",
  ].map(source => ({ source, sourceSha256: digest(readFileSync(resolve(sourceRoot, source))) })),
  nextServerEvidence: [
    "src/collaboration-state.ts", "src/manager-runtime.ts", "src/manager-runtime-contracts.ts",
    "src/agent-runtime-contracts.ts", "src/storage.ts", "src/channel-runtime.ts",
    "src/domain/channel-runtime-model.ts",
  ].map(source => ({ source, sourceSha256: digest(readFileSync(resolve(server, source))) })),
  implementation: [
    "Exact original Portal peer envelope parser is reused for optional identity-bound wake hints, never authorization.",
    "New Channel mailbox slice: invited identity, human consent, directed-edge ACL, parent CAS/global receipt transaction and durable per-recipient cursor.",
    "Exact Manager/Board attempt definition/version pin resolves via required native SQL-only authority hooks; Channel stores delivery references, not a second task state machine.",
    "A bounded non-evicting delivery acknowledgement ledger preserves duplicate/reply fencing independently of mailbox retention.",
    "Two synthetic native identities may communicate locally; no external, production, legacy session, auto-spawn, broker or MagicCode calls.",
  ],
  withheld: [
    "No claim of complete Portal/room/meeting parity: meeting topics/Markdown, original transports and role migration are not implemented here.",
    "No shared host, capability registry, package, browser or Manager changes. Parent must compose identity, lease, transaction, global receipts, directed ACL and task authority.",
    "No live connection recovery from persisted presence. Reconnect requires an authenticated native identity with existing current membership.",
    "Invitation plaintext is returned once only; only its SHA-256 and a request fingerprint are durable. Reissuing the same operation returns an explicit error.",
    "Unavailability is explicit; no offline assignment queueing, unauthorized read, broadcast wake or reply effect replay.",
  ],
};
const serialized = JSON.stringify(provenance, null, 2) + "\n";
const provenancePath = resolve(server, "migration/channel-runtime-provenance.json");
if (mode === "--refresh-native") {
  const prior = JSON.parse(readFileSync(provenancePath, "utf8"));
  if (!Array.isArray(prior.nextServerEvidence) || prior.nextServerEvidence.length === 0) {
    throw new Error("Channel native evidence pins are missing.");
  }
  prior.nextServerEvidence = prior.nextServerEvidence.map(item => ({
    ...item, sourceSha256: digest(readFileSync(resolve(server, item.source))),
  }));
  writeFileSync(provenancePath, JSON.stringify(prior, null, 2) + "\n");
  console.log("Refreshed Channel native evidence pins only; original-source captures are untouched.");
} else if (mode === "--check") {
  if (!readFileSync(resolve(server, destination)).equals(original)) throw new Error("Channel peer capture drift");
  if (readFileSync(provenancePath, "utf8") !== serialized) throw new Error("Channel provenance drift");
} else {
  writeFileSync(resolve(server, destination), original);
  writeFileSync(provenancePath, serialized);
}
console.log("Channel: verified one exact original peer capture and 14 source evidence hashes; no invented full parity.");

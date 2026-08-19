#!/usr/bin/env node
const assert = require("assert");
const { createChatMagicLink, parseChatMagicLink } = require("../dist/chat-magic-link");

const url = "ws://127.0.0.1:7345/design";
const current = createChatMagicLink(url, "secret-value", "room-uuid-123");
assert.deepStrictEqual(parseChatMagicLink(current), { url, secret: "secret-value", roomId: "room-uuid-123" });

const legacy = createChatMagicLink(url, "legacy-secret");
assert.deepStrictEqual(parseChatMagicLink(legacy), { url, secret: "legacy-secret", roomId: undefined });

assert.throws(() => parseChatMagicLink(current.slice(0, -1) + (current.endsWith("A") ? "B" : "A")), /checksum/i);
console.log("chat Magic Link test: Room ID, legacy compatibility, and checksum validation OK");
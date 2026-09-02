#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
const start = source.indexOf("  async closeOrLeaveRoom(key: string): Promise<void>");
const end = source.indexOf("\n  async renameActiveRoom", start);
assert(start >= 0 && end > start, "closeOrLeaveRoom implementation must exist");
const implementation = source.slice(start, end);

assert.match(implementation, /room\.roomId === rc\.roomId/,
  "Close Room must prefer the stable Room UUID");
assert.match(implementation, /rc\.selfHost && room\.room === ChatHub\.canonRoom\(rc\.room\)/,
  "a confirmed Host connection must recover from a stale Room UUID by canonical Room name");
assert.match(implementation, /adminCloseRoom\(locallyHosted\.room\)/,
  "Close Room must deactivate the Hub's authoritative Room name");
assert.doesNotMatch(implementation, /!rc\.roomId && room\.room ===/,
  "a stale non-empty Room UUID must not suppress Host recovery");

console.log("Chat Close Room recovery test: stale Room UUID falls back to the confirmed Host's canonical local Room");
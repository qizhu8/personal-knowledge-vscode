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
assert.match(implementation, /!rc\.roomId && rc\.selfHost && ChatHub\.canonRoom\(room\.room\) === ChatHub\.canonRoom\(rc\.room\)/,
  "only a legacy Host connection without a UUID may resolve by canonical Room name");
assert.match(implementation, /adminCloseRoom\(locallyHosted\.roomId\)/,
  "Close Room must deactivate the Hub by immutable Room UUID");

console.log("Chat Close Room recovery test: UUID-first ownership with name fallback only for legacy UUID-less Hosts");
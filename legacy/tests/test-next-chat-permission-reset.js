"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");
const extension = process.env.PKM_TRIAL_EXTENSION_DIST;
if (!extension) throw new Error("Set PKM_TRIAL_EXTENSION_DIST to the isolated extension build.");
const { resetSelectedChatPermissions } = require(path.join(extension, "runtime/next-chat-permission-reset.js"));

test("permission reset drains before deleting the key and never confirms failed deletion", async () => {
  const events = [];
  let live = true, drainFails = false, deleteFails = false, selected = true, accepted = true;
  const state = { owner: {
    assertCurrent() { if (!live) throw new Error("owner revoked"); },
    async revoke() { events.push("drain"); if (drainFails) throw new Error("drain unknown"); live = false; },
  }, profile: { async resetPermissions() { events.push("delete"); if (deleteFails) throw new Error("delete unknown"); } } };
  const options = { state, async confirm() { events.push("confirm"); return accepted; },
    assertSelection() { if (!selected) throw new Error("selection changed"); } };
  accepted = false;
  assert.equal(await resetSelectedChatPermissions(options), false);
  assert.deepEqual(events, ["confirm"]);
  accepted = true; selected = false; events.length = 0;
  await assert.rejects(resetSelectedChatPermissions(options), /selection changed/);
  assert.deepEqual(events, ["confirm"]);
  selected = true; drainFails = true; events.length = 0;
  await assert.rejects(resetSelectedChatPermissions(options), /drain unknown/);
  assert.deepEqual(events, ["confirm", "drain"]);
  drainFails = false; deleteFails = true; events.length = 0;
  await assert.rejects(resetSelectedChatPermissions(options), /delete unknown/);
  assert.deepEqual(events, ["confirm", "drain", "delete"]);
  assert.equal(state.ownerDrained, true);
  deleteFails = false; events.length = 0;
  assert.equal(await resetSelectedChatPermissions(options), true);
  assert.deepEqual(events, ["delete"]);
});

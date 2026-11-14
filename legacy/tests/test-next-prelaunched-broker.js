"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const path = require("node:path");
const dist = process.env.PKM_TEST_DIST || path.resolve("dist");
const { createPrelaunchedNextMcpBroker } = require(path.join(dist, "runtime/next-mcp-prelaunched-broker"));
const closed = child => new Promise(resolve => {
  if (child.exitCode !== null || child.signalCode !== null) return resolve();
  child.once("close", resolve);
});

test("prelaunch refuses missing readiness and retains an unknown outcome", { timeout: 10000 }, async () => {
  let diagnostic = "";
  const broker = createPrelaunchedNextMcpBroker({
    launch: () => ({ command: process.execPath, args: ["-e", "process.stderr.write('startup detail'); process.exit(17)"], env: {} }),
    assertCurrent() {},
    async verifyOwnedDescendantsExited() { throw Error("not reached"); },
    onStderr(bytes) { diagnostic += bytes; },
  });
  await assert.rejects(broker.ready, /before readiness|Invalid Next MCP readiness receipt/);
  assert.equal(broker.status().state, "unknown");
  assert.throws(() => broker.definitionEnvironment(), /closed/);
  await closed(broker.child);
  assert.match(diagnostic, /startup detail/);
  broker.dispose();
});

test("prelaunch refuses changed authority and closes an unadmitted child", { timeout: 10000 }, async () => {
  let valid = true;
  const code = `require("fs").writeSync(3, process.env.PKM_NEXT_OWNER_READY_NONCE + "\\n");
    require("fs").closeSync(3); process.stdin.resume(); process.stdin.on("end", () => process.exit(0));`;
  const broker = createPrelaunchedNextMcpBroker({
    launch: () => ({ command: process.execPath, args: ["-e", code], env: {} }),
    assertCurrent() { if (!valid) throw Error("authority changed"); },
    async verifyOwnedDescendantsExited() { throw Error("not reached"); },
  });
  await broker.ready;
  valid = false;
  assert.throws(() => broker.definitionEnvironment(), /authority changed/);
  valid = true;
  assert.throws(() => broker.definitionEnvironment(), /closed/);
  broker.dispose();
  await closed(broker.child);
  assert.equal(broker.status().state, "unknown");
});

test("prelaunch admits one authenticated bridge and drains only its child", { timeout: 10000 }, async () => {
  const code = `require("fs").writeSync(3, process.env.PKM_NEXT_OWNER_READY_NONCE + "\\n");
    require("fs").closeSync(3); process.stdin.resume(); process.stdin.on("end", () => process.exit(0));`;
  const broker = createPrelaunchedNextMcpBroker({
    launch: () => ({ command: process.execPath, args: ["-e", code], env: {} }),
    assertCurrent() {},
    async verifyOwnedDescendantsExited(child) { assert.equal(child.exitCode, 0); },
  });
  await broker.ready;
  const env = broker.definitionEnvironment();
  const connect = token => new Promise((resolve, reject) => {
    const socket = net.connect(`\0${env.PKM_NEXT_MCP_BROKER}`);
    socket.once("connect", () => socket.write(`${token}\n`));
    socket.once("error", reject);
    resolve(socket);
  });
  const invalid = await connect("0".repeat(64));
  await new Promise(resolve => invalid.once("close", resolve));
  const client = await connect(env.PKM_NEXT_MCP_BROKER_TOKEN);
  assert.equal(await new Promise(resolve => client.once("data", data => resolve(data.toString()))), "OK\n");
  const duplicate = await connect(env.PKM_NEXT_MCP_BROKER_TOKEN);
  await new Promise(resolve => duplicate.once("close", resolve));
  assert.equal((await broker.drainAndClose()).state, "stopped");
  assert.equal(broker.status().state, "stopped");
  assert.throws(() => broker.definitionEnvironment(), /closed/);
  client.destroy();
  broker.dispose();
});

"use strict";
const fs = require("node:fs"), path = require("node:path"), net = require("node:net");
const { randomUUID, createHmac, timingSafeEqual } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { pathToFileURL } = require("node:url");
const { acquireNativeFixtureEffects } = require("./ordinary-environment-native-effects.cjs");

async function startNativeParent(f, actualPriorHostsDrained) {
  const load = name => import(pathToFileURL(path.join(f.next, name + ".js")).href);
  const { adoptLegacyRootInPlaceExperimental, resumeLegacyRootAdoptionExperimental } = await load("legacy-root-adoption");
  const { startAdoptedRootUnifiedHost } = await load("managed-client-host");
  const { createOwnerHostSessions } = await load("owner-host-sessions");
  const { attachOrdinaryEnvironmentsToOwner } = require(path.join(f.build, "runtime/ordinary-environment-owner.js"));
  actualPriorHostsDrained();
  const adoption = await (f.phase === "native" ? adoptLegacyRootInPlaceExperimental : resumeLegacyRootAdoptionExperimental)(f.knowledgeRoot, {});
  const endpoint = "http://127.0.0.1:9/v1";
  const unified = await startAdoptedRootUnifiedHost({ optIn: true, dataPath: f.knowledgeRoot, configPath: f.config,
    expectedWorkspaceId: adoption.workspaceId, policy: { authorizedConfigPath: f.config,
      allowedProviders: ["openai-compatible"], allowedEndpoints: [endpoint], allowedModels: ["fixture"],
      allowedTools: ["knowledge.document.list"], allowInsecureLoopback: true }, resolveSecret: async () => "fixture" }, adoption);
  const owner = unified.ownerResourceContext(), sessions = createOwnerHostSessions(owner);
  const key = require("node:crypto").randomBytes(32).toString("hex");
  const sign = data => createHmac("sha256", key).update(JSON.stringify(data)).digest("hex");
  const statePath = path.join(f.root, "owner-state.json"), ledger = [];
  let adapter, session, connection, readController, readBinding, readExpires = 0, heartbeat;
  const requests = new Map(), used = new Set();
  const state = current => {
    const data = { current, knowledgeRoot: f.knowledgeRoot, profile: f.storage, workspaceId: owner.workspaceId,
      sessionId: sessionId, expiresAtMs: Date.now() + 1000 };
    fs.writeFileSync(statePath, JSON.stringify({ data, mac: sign(data) }));
  };
  const sessionId = randomUUID();
  const assertHost = () => {
    owner.assertCurrent();
    actualPriorHostsDrained();
    if (!connection || connection.destroyed) throw Error("Actual fixture Code connection is absent.");
  };
  const assertRead = binding => {
    assertHost(); session.assertCurrent("environment");
    if (!readBinding || !isDeepStrictEqual(binding, readBinding) || readController.signal.aborted || Date.now() >= readExpires)
      throw Error("Actual native read approval is absent, expired or revoked.");
  };
  const plan = async message => {
    if (!["envList", "envPackages"].includes(message.command)) throw Error("Only ordinary Environment messages are allowed.");
    const rows = await adapter.handleMessage({ command: "envList" });
    const entries = message.command === "envPackages" ? rows.data.filter(row => row.id === message.id) : rows.data;
    if (!entries.length) throw Error("Original environment target is missing.");
    return { workspaceId: owner.workspaceId, actorId: "local:owner", knowledgeRoot: f.knowledgeRoot,
      globalStorageDirectory: f.storage, operation: message.command === "envPackages" ? "packages" : "metadata",
      refresh: message.refresh === true, environments: entries.map(({ id, path, python, manager }) => ({ id, path, python, manager })) };
  };
  const handle = async frame => {
    assertHost();
    if (frame.command === "hello") return { workspaceId: owner.workspaceId, sessionId };
    if (frame.command === "read-approved") {
      const binding = { workspaceId: owner.workspaceId, actorId: "local:owner", knowledgeRoot: f.knowledgeRoot,
        globalStorageDirectory: f.storage, scope: "ordinary-environments:read-cache" };
      if (adapter || !isDeepStrictEqual(frame.payload.binding, binding)
        || !Number.isSafeInteger(frame.payload.expiresAtMs) || frame.payload.expiresAtMs <= Date.now()
        || frame.payload.expiresAtMs > Date.now() + 300_000) throw Error("Native UI read approval does not match this owner/profile.");
      readBinding = binding; readExpires = frame.payload.expiresAtMs; readController = new AbortController();
      adapter = attachOrdinaryEnvironmentsToOwner({ owner, hostSession: session,
        authority: { ...binding, signal: readController.signal, assertCurrent: assertRead }, onCloseError: error => ledger.push({ closeError: String(error) }) });
      ledger.push({ nativeReadApproved: true }); return { accepted: true };
    }
    if (frame.command === "revoke-read") { readController?.abort(); return { revoked: true }; }
    if (frame.command === "revoke-request") { requests.get(frame.payload.requestId)?.abort(); return { revoked: true }; }
    assertRead(readBinding);
    if (frame.command === "message") {
      const message = frame.payload;
      if (message.command === "envList" && message.refresh !== true) return adapter.handleMessage(message);
      if (message.command === "envPackages" && message.refresh !== true) {
        const cached = await adapter.handleMessage(message);
        if (!cached.error) return cached;
      }
      return { needsApproval: true, intent: await plan(message) };
    }
    if (frame.command === "apply-approved") {
      const { message, intent, expiresAtMs } = frame.payload;
      const expected = await plan(message), { requestId, ...binding } = intent;
      if (!isDeepStrictEqual(binding, expected) || typeof requestId !== "string" || used.has(requestId)
        || !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= Date.now() || expiresAtMs > Date.now() + 120_000)
        throw Error("Native UI approval was changed, expired or replayed.");
      used.add(requestId);
      const controller = new AbortController(); requests.set(requestId, controller);
      const scopeSignal = session.signalFor("environment"), revoke = () => controller.abort();
      scopeSignal.addEventListener("abort", revoke, { once: true });
      const effects = acquireNativeFixtureEffects({ fixture: f.root, projectRoot: f.project, profileMountpoint: f.profileVolume,
        programsMountpoint: f.capsules, programs: f.programs, condaExecutable: f.condaExecutable, environment: f.executionEnvironment,
        expectedMountNamespace: f.mountNamespace, expectedPidNamespace: f.pidNamespace,
        originalOwnedProcessesDrained: actualPriorHostsDrained,
        assertOwnerCurrent(actual) { assertRead(readBinding); if (!isDeepStrictEqual(actual, intent)) throw Error("Root intent mismatch."); },
      }, intent, { signal: controller.signal, expiresAtMs });
      const originalRecord = effects.recordExecution;
      effects.recordExecution = (child, trace) => { ledger.push({ requestId, childPid: child.pid, program: trace.program, args: trace.args }); originalRecord(child, trace); };
      const permit = { ...effects, intent, expiresAtMs };
      try {
        const result = await adapter.handleMessage(message, permit);
        ledger.push({ requestId, result }); return result;
      } finally { requests.delete(requestId); controller.abort(); scopeSignal.removeEventListener("abort", revoke); }
    }
    throw Error("Unknown private fixture operation.");
  };
  const server = net.createServer(socket => {
    if (connection) { socket.destroy(); return; }
    connection = socket;
    const controller = new AbortController();
    session = sessions.open({ hostKey: `private-native-code:${sessionId}`, connection: controller.signal,
      assertHostCurrent: assertHost, assertScopeCurrent(scope) { assertHost(); if (scope !== "environment") throw Error("Other scopes are not granted."); },
      onCloseError: error => ledger.push({ closeError: String(error) }) });
    state(true); heartbeat = setInterval(() => {
      try { assertHost(); session.assertCurrent("environment"); state(true); } catch { state(false); }
    }, 200);
    let buffer = "";
    const send = data => { if (!socket.destroyed) socket.write(JSON.stringify({ data, mac: sign(data) }) + "\n"); };
    session.signalFor("environment").addEventListener("abort", () => {
      state(false); send({ command: "revoke" });
    }, { once: true });
    socket.on("data", bytes => {
      buffer += bytes; if (buffer.length > 2_000_000) { socket.destroy(); return; }
      for (;;) {
        const end = buffer.indexOf("\n"); if (end < 0) break;
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let frame;
        try {
          const value = JSON.parse(line), expected = Buffer.from(sign(value.data)), actual = Buffer.from(String(value.mac));
          if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw Error("Unauthenticated fixture frame.");
          frame = value.data;
        } catch { socket.destroy(); break; }
        void handle(frame).then(result => send({ id: frame.id, result }), error => send({ id: frame.id, error: String(error) }));
      }
    });
    socket.on("close", () => {
      clearInterval(heartbeat); state(false); controller.abort(); readController?.abort();
      for (const request of requests.values()) request.abort();
    });
    socket.on("error", () => {});
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { key, endpoint: { host: "127.0.0.1", port: server.address().port }, workspaceId: owner.workspaceId,
    async close() {
      if (connection && !connection.destroyed) connection.end();
      if (session) await session.revoke();
      if (adapter) await adapter.close();
      await unified.managed.close();
      await new Promise(resolve => server.close(resolve));
      fs.writeFileSync(path.join(f.root, `parent-${f.phase}.json`), JSON.stringify({ ledger, workspaceId: owner.workspaceId,
        qualification: "PRESTARTED_REAL_OWNER_REAL_NATIVE_UI_FIXTURE_CONTROL_CHANNEL_NOT_EXCLUSIVE_AUTHORITY" }, null, 2));
    } };
}
module.exports = { startNativeParent };

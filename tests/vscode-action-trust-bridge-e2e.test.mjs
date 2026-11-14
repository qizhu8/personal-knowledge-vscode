import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { originalActionCompilerFixtures as original } from "./action-compiler-original-fixtures.mjs";
import { until } from "./batch07-cli-fixtures.mjs";

const build = resolve(process.env.PKM_ACTION_BUILD ?? resolve(import.meta.dirname, "../dist"));
const load = path => import(pathToFileURL(resolve(build, path)).href);
const [{ createNativeRuntime }, { Storage, initialize }, { startLegacyNoteMcp }, { startMcp },
  { createVscodeActionTrustBridge }, { readActionCompiler }, { originalDigest }] = await Promise.all([
  load("native-runtime.js"), load("storage.js"), load("legacy-note-mcp.js"), load("mcp.js"),
  load("vscode-action-trust-bridge.js"), load("action-compiler.js"),
  load("domain/action-compiler-validation.js"),
]);

const hash = value => createHash("sha256").update(value).digest("hex");

async function createVsCodeAuthority(root) {
  const directory = resolve(root, ".pkm/state/actions");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const candidate of [resolve(root, ".pkm"), resolve(root, ".pkm/state"), directory]) chmodSync(candidate, 0o700);
  const filename = resolve(directory, "host-authority.json");
  const token = randomBytes(32).toString("hex");
  const state = { trusted: true, epoch: randomUUID() };
  let config;
  const writeConfig = port => {
    config = {
      schema: "pkm.action.host-authority/v1", host: "127.0.0.1", port, token,
      trust_epoch: state.epoch, store_path: root,
    };
    writeFileSync(filename, JSON.stringify(config), { mode: 0o600 });
    chmodSync(filename, 0o600);
  };
  const server = createServer(socket => {
    socket.setEncoding("utf8");
    let input = "";
    socket.on("data", chunk => {
      input += chunk;
      if (Buffer.byteLength(input, "utf8") > 8192) return socket.destroy();
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      let response = { ok: false, trusted: false, reason: "INVALID_REQUEST" };
      try {
        const request = JSON.parse(input.slice(0, newline));
        if (request.storePath === root && request.token === token) {
          if (request.operation === "status") {
            response = { ok: state.trusted, trusted: state.trusted, trustEpoch: state.epoch };
          } else if (request.operation === "authorize") {
            const allowed = state.trusted && request.trustEpoch === state.epoch
              && typeof request.actionId === "string" && /^[a-f0-9]{64}$/.test(request.contentHash);
            response = { ok: allowed, trusted: state.trusted, trustEpoch: state.epoch };
          } else if (request.operation === "revoke" && request.trustEpoch === state.epoch) {
            state.trusted = false;
            state.epoch = randomUUID();
            writeConfig(config.port);
            response = { ok: true, trusted: false, trustEpoch: state.epoch };
          }
        }
      } catch {}
      socket.end(`${JSON.stringify(response)}\n`);
    });
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  writeConfig(server.address().port);
  return {
    async close() { await new Promise(resolveClose => server.close(resolveClose)); },
  };
}

test("VS Code trust bridge drives isolated proposal-to-call MCP execution and revocation", { timeout: 30000 }, async t => {
  const root = resolve(import.meta.dirname, `.vscode-action-trust-e2e-${randomUUID()}`);
  await initialize(root);
  const storage = await Storage.open(root);
  const workspaceId = await storage.workspaceId();
  const actor = { id: "mcp:external", canWrite: true };
  const authority = await createVsCodeAuthority(resolve(storage.workspaceRoot()));
  const code = "let s='';for await(const c of process.stdin)s+=c;const v=JSON.parse(s);console.log(JSON.stringify({value:v.value}))";
  const definition = { dependencies: {}, casts: {}, examples: [], ...structuredClone(original.example) };
  definition.implementations[0].program = "fixture";
  definition.implementations[0].args = ["-e", code];
  const compileRevision = value => readActionCompiler({
    operation: "action.definition.compile", args: { source: { kind: "inline", definition: value } },
  });
  const compiled = compileRevision(definition);
  assert.equal(compiled.status, "valid");
  const revisionTwo = { ...structuredClone(definition), version: definition.version + 1 };
  const revisionTwoCompiled = compileRevision(revisionTwo);
  assert.equal(revisionTwoCompiled.status, "valid");
  const allowedRevisionDigests = new Set([compiled.definitionDigest, revisionTwoCompiled.definitionDigest]);
  const approvals = [];
  const definitionBindings = [];
  let effectConsent = true;
  let effectConsentError;
  const bridge = createVscodeActionTrustBridge({
    workspaceRoot: storage.workspaceRoot(), workspaceId, actorId: actor.id,
  });
  const native = await createNativeRuntime({ storage, hostServices: {
    action: {
      automaticTrusted: bridge,
      process: { commands: [{
        id: "fixture", executable: process.execPath, cwd: root, directChildOnly: true,
        arguments: [{ literal: "-e" }, { literal: code }],
        outputContractDigest: originalDigest(definition.output_schema),
        authorizationDigest: hash("VS Code bridge E2E command policy"),
        authorizeDefinition: binding => {
          definitionBindings.push(binding);
          return binding.actorId === actor.id
          && binding.workspaceId === workspaceId && allowedRevisionDigests.has(binding.executableDigest)
          && binding.actionId === definition.action_id && binding.implementation.program === "fixture";
        },
        authorizeData: binding => binding.inputs.value === "public",
        approve: async request => {
          approvals.push(request);
          if (effectConsentError) throw effectConsentError;
          return effectConsent;
        },
        redactOutput: () => ({ value: "redacted-public" }),
      }] },
    },
  } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await startLegacyNoteMcp(storage, serverTransport, {
    core: native.core, actor, actionHost: native.services.hostServices,
  });
  const client = new Client({ name: "vscode-action-trust-bridge-e2e", version: "1.0.0" });
  await client.connect(clientTransport);
  const [capabilityClientTransport, capabilityServerTransport] = InMemoryTransport.createLinkedPair();
  const capabilityServer = await startMcp(native.core, actor, capabilityServerTransport);
  const capabilityClient = new Client({ name: "vscode-action-event-consumer", version: "1.0.0" });
  await capabilityClient.connect(capabilityClientTransport);
  const [otherClientTransport, otherServerTransport] = InMemoryTransport.createLinkedPair();
  const otherServer = await startMcp(native.core, { id: "mcp:other", canWrite: true }, otherServerTransport);
  const otherClient = new Client({ name: "vscode-action-event-isolation", version: "1.0.0" });
  await otherClient.connect(otherClientTransport);
  t.after(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    await capabilityClient.close().catch(() => {});
    await capabilityServer.close().catch(() => {});
    await otherClient.close().catch(() => {});
    await otherServer.close().catch(() => {});
    await native.close();
    await authority.close();
    await storage.close();
    await rmSync(root, { recursive: true, force: true });
  });

  const submit = async actionDefinition => {
    const response = await client.callTool({ name: "legacy_action_write", arguments: {
      tool: "action_register", arguments: { definition: actionDefinition },
    } });
    assert.notEqual(response.isError, true, JSON.stringify(response));
    return response.structuredContent.value;
  };
  const call = (proposal, key, inputs = { value: "public" }) => client.callTool({
    name: "action_call", arguments: {
      action_id: proposal.action_id, proposal_id: proposal.proposal_id,
      content_hash: proposal.content_hash, idempotency_key: key, inputs,
    },
  });
  const status = runId => native.services.hostServices.readAction({
    operation: "action.runtime.get", args: { runId }, actorId: actor.id,
  });

  assert.equal(native.services.hostServices.automaticActionTrustStatus().trustedWorkspace, true);
  const proposal = await submit(definition);
  assert.equal(proposal.state, "automatically_admitted");
  assert.equal(proposal.registered, true);
  assert.equal(proposal.callable, true);
  assert.equal(proposal.content_hash, compiled.definitionDigest,
    "the fixture compiler pin must equal the exact revision admitted from the proposal");
  const invoked = await call(proposal, "bridge-call-1");
  assert.notEqual(invoked.isError, true, JSON.stringify({
    invoked, compiledDigest: compiled.definitionDigest, expectedActorId: actor.id, expectedWorkspaceId: workspaceId,
    expectedActionId: definition.action_id, definitionBindings,
  }));
  const run = await until(() => status(invoked.structuredContent.value.runId), value => value.state === "succeeded");
  assert.equal(run.nodes[0].state, "succeeded");
  assert.equal(Object.hasOwn(run.nodes[0], "outputs"), false);
  const readEventPage = async after => {
    const response = await capabilityClient.callTool({ name: "capability_read", arguments: {
      operation: "action.runtime.events", version: 1, arguments: { runId: run.runId, after, limit: 2 },
    } });
    assert.notEqual(response.isError, true, JSON.stringify(response));
    return response.structuredContent.result;
  };
  const eventPages = [];
  let after = 0, eventPage;
  do {
    eventPage = await readEventPage(after);
    eventPages.push(...eventPage.items);
    after = eventPage.items.at(-1)?.sequence ?? after;
  } while (eventPage.latestSequence > after);
  assert.deepEqual(eventPages.map(item => item.kind), [
    "created", "run-started", "node-started", "node-succeeded", "run-succeeded",
  ]);
  assert.equal(eventPages.every((item, index) => item.sequence === index + 1), true);
  assert.equal(eventPage.gap, false);
  assert.equal(eventPage.latestSequence, eventPages.at(-1).sequence);
  assert.equal(JSON.stringify(eventPages).includes("redacted-public"), false);
  assert.equal(JSON.stringify(eventPages).includes("public"), false);
  const isolated = await otherClient.callTool({ name: "capability_read", arguments: {
    operation: "action.runtime.events", version: 1,
    arguments: { runId: run.runId, after: 0, limit: 100 },
  } });
  assert.equal(isolated.isError, true);
  const result = await client.callTool({ name: "legacy_action_read", arguments: {
    tool: "action_run_get", arguments: { run_id: invoked.structuredContent.value.runId },
  } });
  assert.deepEqual(result.structuredContent.value.output, { value: "redacted-public" },
    "Result reads expose only the adapter-redacted, schema-validated output.");
  assert.equal(Object.hasOwn(result.structuredContent.value, "inputs"), false);
  await assert.rejects(native.services.hostServices.readAutomaticActionResult(
    { id: "mcp:other", canWrite: true }, invoked.structuredContent.value.runId),
    error => error.code === "ACCESS_DENIED");
  assert.equal(approvals.length, 1);
  assert.equal((await call(proposal, "invalid-sensitive-input", { value: "secret" })).isError, true);
  assert.equal(approvals.length, 1, "invalid parameters are denied before effect consent or launch");

  const next = await submit(revisionTwo);
  assert.equal(next.state, "automatically_admitted");
  assert.equal(next.content_hash, revisionTwoCompiled.definitionDigest,
    "the second fixture pin must equal the exact revision admitted from the proposal");
  assert.equal((await call(proposal, "stale-revision")).isError, true);
  const secondInvocation = await call(next, "bridge-call-revision-two");
  assert.notEqual(secondInvocation.isError, true, JSON.stringify(secondInvocation));
  const secondRun = await until(
    () => status(secondInvocation.structuredContent.value.runId),
    value => value.state === "succeeded",
  );
  assert.equal(secondRun.nodes[0].state, "succeeded");
  assert.equal(approvals.length, 2);

  effectConsent = false;
  const denied = await call(next, "effect-consent-denied");
  assert.equal(denied.isError, true);
  assert.match(JSON.stringify(denied), /ACTION_EFFECT_CONSENT_REQUIRED/);
  assert.equal(approvals.length, 3, "effect denial does not authorize or relaunch the process");
  effectConsent = true;
  effectConsentError = new Error("fixture-consent-service-unavailable");
  const unavailable = await call(next, "effect-consent-unavailable");
  assert.equal(unavailable.isError, true);
  assert.match(JSON.stringify(unavailable), /fixture-consent-service-unavailable/);
  effectConsentError = undefined;

  await native.services.hostServices.revokeAutomaticActionTrust();
  assert.equal(native.services.hostServices.automaticActionTrustStatus().trustedWorkspace, false);
  assert.equal((await call(next, "revoked-host-trust")).isError, true);
  const afterRevocation = await submit({ ...structuredClone(definition), version: definition.version + 2 });
  assert.equal(afterRevocation.state, "pending_operator_approval");
});

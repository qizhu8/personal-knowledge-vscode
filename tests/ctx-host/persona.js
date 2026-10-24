const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { createHash } = require("node:crypto");
const vscode = require("vscode");
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function run(extension, fixtureRoot, phase) {
  assert(["initial", "restart"].includes(phase), "Unknown installed Profile acceptance phase");
  const root = path.resolve(fixtureRoot), knowledge = path.join(root, "knowledge");
  const moduleAt = relative => require(path.join(extension.extensionPath, "dist", relative));
  assert.equal(path.resolve(moduleAt("knowledge/filestore").getStorePath()), knowledge,
    "Refuse Profile acceptance outside the isolated fixture Knowledge Root");
  assert.equal(vscode.workspace.isTrusted, true, "Installed Profile acceptance requires the isolated trusted workspace");
  const { PersonaProfileStore } = moduleAt("chat/persona-profiles");
  const { ApiChatStore } = moduleAt("chat/api-chat-store");
  const { ApiChatView } = moduleAt("chat/api-chat-view");
  const directory = path.join(root, "persona"), privateDirectory = path.join(directory, "private-host");
  const manifestFile = path.join(directory, "acceptance.json");
  const namespace = digest(["installed-persona-fixture", root]).slice(0, 16);
  const profiles = new PersonaProfileStore(privateDirectory, knowledge);
  const chats = new ApiChatStore(path.join(knowledge, ".pkm", "state"), namespace);
  const context = {
    globalStorageUri:vscode.Uri.file(privateDirectory),
    secrets:{ get:async () => "local-persona-fixture-only" },
    subscriptions:[],
  };
  const provider = new ApiChatView(context, async () => []);
  provider.store = chats; provider.publish = () => {};
  provider.toolGroups = () => [{ id:"builtin", tools:[] }];
  let server;
  const paths = {
    profiles:require.resolve(path.join(extension.extensionPath, "dist/chat/persona-profiles")),
    view:require.resolve(path.join(extension.extensionPath, "dist/chat/api-chat-view")),
  };
  for (const file of Object.values(paths)) {
    const relative = path.relative(fs.realpathSync(extension.extensionPath), fs.realpathSync(file));
    assert(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "Acceptance must load the supplied extension's modules");
  }
  const verifyHistory = saved => {
    const chat = chats.load(saved.chatId, false);
    const first = chat.messages.find(message => message.id === saved.firstReplyId);
    const second = chat.messages.find(message => message.id === saved.secondReplyId);
    assert(first && second, "Installed Profile history must survive reload");
    assert.equal(first.status, "complete"); assert.equal(second.status, "complete");
    assert.equal(first.profileContext.user.id, saved.userId);
    assert.equal(first.profileContext.user.revision, 1);
    assert.equal(first.profileContext.agent.id, saved.agentId);
    assert.equal(first.profileContext.agent.revision, 1);
    assert.equal(second.profileContext.user.revision, 2);
    assert.equal(second.profileContext.agent, undefined);
    for (const reply of [first, second]) {
      assert.equal(reply.budgetReceipts.length, 1);
      const receipt = reply.budgetReceipts[0];
      assert.equal(receipt.status, "sent");
      assert.equal(receipt.transport.provider, "http");
      assert(receipt.contextPlan.manifest.some(message => message.hash === reply.profileContext.messageHash));
      assert.equal(receipt.contextPlan.estimatedAfter, receipt.consumed.estimatedInputTokens);
    }
    assert.equal(digest([first.profileContext, first.budgetReceipts]), saved.firstEvidenceHash);
    assert.equal(digest([second.profileContext, second.budgetReceipts]), saved.secondEvidenceHash);
    assert.equal(chat.agentProfileId, undefined);
    assert.equal(profiles.user(), undefined);
    assert.throws(() => profiles.get("agent", saved.agentId), /unavailable or deleted/);
    assert.equal(profiles.capture(), undefined);
    provider.chat = chat; provider.chats.set(chat.id, chat);
    return chat;
  };
  try {
    if (phase === "restart") {
      const saved = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
      assert.equal(saved.namespace, namespace);
      assert.notEqual(process.pid, saved.initialPid, "Restart acceptance requires a new extension Host process");
      verifyHistory(saved);
      return { schema:"pkm.profile.installed-acceptance/v1", phase, pid:process.pid, initialPid:saved.initialPid,
        modulePaths:paths, fixtureDirectory:directory, requests:0, historicalSnapshots:2,
        historicalEvidenceRetained:true, restartRetained:true, deletedProfilesNotReused:true,
        firstEvidenceHash:saved.firstEvidenceHash, secondEvidenceHash:saved.secondEvidenceHash };
    }
    assert.equal(fs.existsSync(manifestFile), false, "Refuse to overwrite an earlier installed Profile acceptance run");
    fs.mkdirSync(directory, { recursive:true, mode:0o700 });
    const fields = { name:"Installed fixture user", role:"", focus:"", preferences:"INSTALLED_PERSONA_USER_REVISION_ONE", boundaries:"No extra authority" };
    const user = profiles.save("user", fields);
    const agent = profiles.save("agent", { ...fields, name:"Installed fixture Agent", role:"SDE", preferences:"INSTALLED_PERSONA_ASSIGNED_AGENT" });
    const requests = [], errors = [];
    let editedUser;
    server = http.createServer(async (request, response) => {
      try {
        const chunks = []; let bytes = 0;
        for await (const chunk of request) {
          bytes += chunk.length; assert(bytes <= 128 * 1024, "Installed Profile fixture request exceeds its boundary");
          chunks.push(chunk);
        }
        requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        assert(requests.length <= 2, "No extra inference or replay is permitted");
        if (requests.length === 1) {
          editedUser = profiles.save("user", { ...fields, preferences:"INSTALLED_PERSONA_USER_REVISION_TWO" }, user);
          profiles.delete(agent);
        }
        response.writeHead(200, { "Content-Type":"text/event-stream" });
        response.end(`data: ${JSON.stringify({ choices:[{ delta:{ content:"Installed local-only Profile fixture answer" }, finish_reason:"stop" }] })}\n\ndata: [DONE]\n\n`);
      } catch (error) {
        errors.push(error.message);
        response.writeHead(500); response.end("Installed Profile fixture failed");
      }
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject); server.listen(0, "127.0.0.1", resolve);
    });
    const model = { id:"installed-persona-local", model:"installed-persona-local", label:"Installed Profile fixture",
      status:"active", contextWindow:32768, maxOutputTokens:256, currency:"USD", includeUsage:false, outputTokenParameter:"max_tokens" };
    provider.settings = () => ({ provider:"openai-compatible", selectedProfile:model, profiles:[model],
      endpoint:`http://127.0.0.1:${server.address().port}/v1`, model:model.model,
      contextWindow:8192, maxOutputTokens:256, timeoutMs:5000, maxToolRounds:1, loopReviewAfterMs:60000 });
    const chat = chats.create();
    chat.permissionMode = "read-only"; chat.includeHistory = false; chat.builtinTools = []; chat.vscodeTools = [];
    chat.agentProfileId = agent.id;
    chat.context = [{ id:"installed-persona-pinned", label:"Fixture requirement", content:"INSTALLED_PERSONA_PINNED_TEXT" }];
    provider.chat = chat; provider.chats.set(chat.id, chat);
    provider.acceptanceRetrieval = new Map([[chat.id, async () => []]]);
    await provider.send("Inspect only this installed local Profile fixture");
    const first = chat.messages.at(-1);
    assert.equal(first.status, "complete", first.error);
    const original = digest([first.profileContext, first.budgetReceipts]);
    assert.equal(first.profileContext.user.revision, 1);
    assert.equal(first.profileContext.agent.revision, 1);
    await assert.rejects(provider.send("Deleted assigned Agent must not silently fall back", chat), /unavailable or deleted/);
    assert.equal(requests.length, 1);
    chat.agentProfileId = undefined; chats.save(chat);
    await provider.send("Next attempt uses edited User and no assigned Agent", chat);
    const second = chat.messages.at(-1);
    assert.equal(second.status, "complete", second.error);
    assert.equal(digest([first.profileContext, first.budgetReceipts]), original);
    assert.equal(requests.length, 2); assert.deepEqual(errors, []);
    for (const [index, reply] of [first, second].entries()) {
      const payload = requests[index], receipt = reply.budgetReceipts[0];
      assert.deepEqual(receipt.transport.messageHashes, payload.messages.map(digest));
      assert(payload.messages.some(message => digest(message) === reply.profileContext.messageHash));
      assert(payload.messages.some(message => message.content.includes("INSTALLED_PERSONA_PINNED_TEXT")));
      assert(payload.messages.some(message => message.content.includes(index ? "INSTALLED_PERSONA_USER_REVISION_TWO" : "INSTALLED_PERSONA_USER_REVISION_ONE")));
      assert.equal(payload.messages.some(message => message.content.includes("INSTALLED_PERSONA_ASSIGNED_AGENT")), index === 0);
    }
    profiles.delete(editedUser);
    const saved = { namespace, initialPid:process.pid, chatId:chat.id, firstReplyId:first.id, secondReplyId:second.id,
      userId:user.id, agentId:agent.id, firstEvidenceHash:original, secondEvidenceHash:digest([second.profileContext, second.budgetReceipts]) };
    fs.writeFileSync(manifestFile, JSON.stringify(saved), { mode:0o600 });
    verifyHistory(saved);
    return { schema:"pkm.profile.installed-acceptance/v1", phase, pid:process.pid, modulePaths:paths, fixtureDirectory:directory,
      requests:2, historicalSnapshots:2, actualPreparedAndSent:true, immutableAfterEditAndDelete:true,
      historicalEvidenceRetained:true, deletedProfilesNotReused:true,
      firstEvidenceHash:saved.firstEvidenceHash, secondEvidenceHash:saved.secondEvidenceHash };
  } finally {
    provider.dispose();
    for (const subscription of context.subscriptions) subscription.dispose();
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }
}

module.exports = { run };

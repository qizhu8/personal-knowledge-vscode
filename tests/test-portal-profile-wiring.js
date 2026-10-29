const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/extension.ts"), "utf8");
const ast = ts.createSourceFile("extension.ts", source, ts.ScriptTarget.Latest, true);
let execution;
function visit(node) {
  if (ts.isNewExpression(node) && node.expression.getText(ast) === "PeerSession") {
    const options = node.arguments[0];
    assert.equal(options.properties.find(property => property.name?.getText(ast) === "profileSnapshots").initializer.getText(ast), "true");
    execution = options.properties.find(property => property.name?.getText(ast) === "execute").initializer.getText(ast);
  }
  ts.forEachChild(node, visit);
}
visit(ast);
assert(execution, "The real Portal executor must remain wired");

test("controlled Portal forwards exactly the explicit Profile snapshot through the real extension callback", async () => {
  const calls = [];
  const owner = { id: "controlled-chat" };
  const binding = { peerName: "Controller", peerId: "peer", peerMachine: "controller-host", peerChatId: "controller-chat" };
  const room = { peer: { binding }, client: { isConnected: true }, url: "https://fixture.invalid" };
  const scope = {
    AbortController, onceShare: true, owner, room, peerRoot: "/knowledge",
    getStorePath: () => "/knowledge", vscode: { workspace: { isTrusted: true } },
    setInterval: () => 1, clearInterval() {},
    remoteChatExecutor: async (...args) => { calls.push(args); return { ok: true }; },
  };
  const context = vm.createContext(scope);
  const factory = vm.runInContext(ts.transpileModule(`(function () { return ${execution}; })`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  const host = { chatPortals:new Map(), portalEpochs:new Map(), portalPermissions: new Map(), portalExecutions: new Map(), portalTaskChats: new Map(),
    endpointChatId: id => id, endpoint: () => undefined };
  const execute = factory.call(host);
  const snapshot = { schema: "fixture-explicit-snapshot" };
  assert.deepEqual(await execute("task", new AbortController().signal, "request", snapshot), { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][3], owner.id);
  assert.strictEqual(calls[0][6], snapshot, "The explicitly transmitted snapshot must not be dropped at the extension boundary");
  assert.equal(calls[0][5].participantId, binding.peerId);
  assert.equal(host.portalExecutions.size, 0);
  scope.vscode.workspace.isTrusted = false;
  await assert.rejects(execute("task", new AbortController().signal, "denied", snapshot), /workspace or Knowledge Root changed/);
  assert.equal(calls.length, 1);
});

test("human Portal submission reviews disclosure before sending and cancellation cannot submit", async () => {
  const begin = source.indexOf('} else if (selected === "Send task") {');
  const end = source.indexOf('} else if (selected === "Cancel task")', begin);
  assert(begin >= 0 && end > begin);
  const body = source.slice(begin + '} else if (selected === "Send task") {'.length, end);
  const sent = [], reviews = [];
  const room = {client:{isConnected:true}};
  const owner={id:"chat",room};
  const binding={peerName:"Controlled"};
  const snapshot = { schema: "explicit-review-snapshot" };
  const scope = vm.createContext({
    room, owner, binding, root:"/knowledge",epoch:0,getStorePath:()=>"/knowledge",
    peer: { binding,submit(...args) { sent.push(args); return "request"; } },
    portalProfileReview: async id => { reviews.push(id); return snapshot; },
    vscode: { workspace:{isTrusted:true},window: { setStatusBarMessage() {} } },
  });
  const send = vm.runInContext(`(async function () { ${body} })`, scope);
  const host = { chatPortals: new Map([["chat",owner]]),portalEpochs:new Map(),
    portalPrompt:async()=>({action:"submit",fields:{prompt:"task"}}) };
  await send.call(host);
  assert.deepEqual(reviews, ["chat"]);
  assert.strictEqual(sent[0][2], snapshot);
  scope.portalProfileReview = async () => { throw new Error("Profile disclosure cancelled"); };
  await assert.rejects(send.call(host), /cancelled/);
  assert.equal(sent.length, 1);
  scope.portalProfileReview=async()=>{scope.peer.binding={...binding};return snapshot;};
  await assert.rejects(send.call(host),/Portal changed during task review/);
  assert.equal(sent.length,1,"late Profile approval cannot submit to a changed pairing");
  scope.peer.binding=binding;
  owner.external=true;
  scope.portalProfileReview=async()=>assert.fail("External context must not export a PKM Chat Profile");
  await send.call(host);
  assert.equal(sent.length,2);
  assert.equal(sent[1][2],undefined);
  assert(source.includes("peer.submit(args.prompt, args.requestId)"), "MCP-triggered requests must not silently export the controller's private Profiles");
});

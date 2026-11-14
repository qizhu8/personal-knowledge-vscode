import assert from "node:assert/strict";
import { createServer } from "node:http";
import Module, { createRequire } from "node:module";
import test from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { cp, mkdir, writeFile, readdir, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const bearer = "s".repeat(40);

function fakeVscode() {
  const commands = new Map(), panels = [], messages = [], warnings = [], output = [];
  const global = {}, workspace = {};
  const secrets = new Map(), keys = [];
  const subscriptions = [];
  let input;
  const selections = [], confirmations = [], information = [];
  const api = {
    workspace: { getConfiguration: () => ({ inspect: name => ({ globalValue: global[name], workspaceValue: workspace[name] }) }) },
    commands: { registerCommand(id, handler) {
      assert(!commands.has(id));
      commands.set(id, handler);
      return { dispose() { commands.delete(id); } };
    } },
    ViewColumn: { One: 1 },
    window: {
      showErrorMessage: async message => { messages.push(message); },
      showWarningMessage: async message => { warnings.push(message); return confirmations.shift(); },
      showInformationMessage: async message => { information.push(message); },
      showOpenDialog: async () => selections.shift(),
      showSaveDialog: async () => selections.shift(),
      createOutputChannel: () => ({ appendLine: line => output.push(line), show() {}, dispose() {} }),
      showInputBox: async () => input,
      createWebviewPanel() {
        let listener, onDispose, disposed = false;
        const sent = [];
        const panel = {
          sent,
          webview: {
            html: "",
            onDidReceiveMessage(fn) { listener = fn; return { dispose() { listener = undefined; } }; },
            postMessage: async message => { sent.push(message); return true; },
          },
          onDidDispose(fn) { onDispose = fn; },
          emit(message) { listener?.(message); },
          dispose() { if (!disposed) { disposed = true; onDispose?.(); } },
        };
        panels.push(panel);
        return panel;
      },
    },
  };
  const context = { extensionPath: fileURLToPath(new URL(".", import.meta.url)), subscriptions, secrets: {
    async get(key) { keys.push(key); return secrets.get(key); },
    async store(key, value) { keys.push(key); secrets.set(key, value); },
  } };
  return { api, context, commands, panels, messages, warnings, output, global, workspace, keys, selections, confirmations, information, setInput: value => { input = value; } };
}

function activate(fake) {
  const load = Module._load;
  try {
    Module._load = function (id, ...args) { return id === "vscode" ? fake.api : load.call(this, id, ...args); };
    delete require.cache[require.resolve("./dist/extension.cjs")];
    require("./dist/extension.cjs").activate(fake.context);
  } finally { Module._load = load; }
}

async function server(t, options = {}) {
  const requests = [];
  const http = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const data = JSON.parse(body);
    requests.push({ path: req.url, body: data, authorization: req.headers.authorization });
    let result, error;
    if (req.url === "/v1/server_info") result = {
      name: "pkm-next", serverId: "pkm-next", workspaceId: "workspace-1", actorId: "actor-1",
      workspaceVersion: "pkm.next-workspace/v2", protocolVersion: "v1", catalogRevision: "revision",
      storage: { workspaceSchema: "pkm.next-workspace/v2", authority: "Markdown" },
    };
    else if (req.url === "/v1/capabilities_describe") {
      if (data.operation === "knowledge.document.list")
        result = { operation: data.operation, version: 1, readOnly: true, catalogRevision: "revision" };
      else if (options.beforeWrite && data.operation === "chat.session.create")
        result = { operation: data.operation, version: 1, readOnly: false, catalogRevision: "revision" };
      else error = { code: "NOT_FOUND", effect: "not-committed" };
    } else if (req.url === "/v1/capability_read") {
      if (options.beforeRead) await options.beforeRead();
      result = { items: [{ title: "<img src=x onerror=alert(1)>" }], total: 1, nextOffset: null, workspaceRevision: "revision" };
    } else if (req.url === "/v1/capability_call" && options.beforeWrite) {
      await options.beforeWrite();
      result = { id: data.arguments.id };
    } else error = { code: "NOT_FOUND", effect: "not-committed" };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ schema: "pkm.next-result/v1", requestId: "request", ...(result ? { result } : { error }) }));
  });
  await new Promise(resolve => http.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { http.close(resolve); http.closeAllConnections(); }));
  return { origin: `http://127.0.0.1:${http.address().port}`, requests };
}

async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail("Timed out waiting for webview reply");
}

test("host wires secrets, independently provisioned identity, commands and isolated panels", async t => {
  const fixture = await server(t), fake = fakeVscode();
  Object.assign(fake.global, { origin: fixture.origin, workspaceId: "workspace-1", actorId: "actor-1" });
  Object.assign(fake.workspace, { origin: "http://example.com:9000", actorId: "attacker" });
  activate(fake);
  t.after(() => fake.context.subscriptions.forEach(item => item.dispose()));
  assert(!fake.commands.has("pkm.next.openHumanReview"));
  fake.setInput(bearer);
  await fake.commands.get("pkm.nextHost.setToken")();
  await fake.commands.get("pkm.next.connect")();
  assert.equal(fake.messages.length, 0);
  assert(fake.keys.every(key => key === "pkm.next-host.bearer"));
  assert(fixture.requests.every(req => req.authorization === `Bearer ${bearer}`));
  await fake.commands.get("pkm.nextHost.open")();
  await fake.commands.get("pkm.nextHost.open")();
  const [first, second] = fake.panels;
  assert.match(first.webview.html, /default-src 'none'/);
  assert.match(first.webview.html, /textContent/);
  first.emit({ requestId: "one", action: "knowledgeList", input: {} });
  await waitFor(() => first.sent.length === 1);
  assert.equal(first.sent[0].result.items.length, 1);
  assert.equal(second.sent.length, 0);
  second.emit({ requestId: "two", action: "knowledgeList", input: { endpoint: "http://example.com" } });
  await waitFor(() => second.sent.length === 1);
  assert.equal(second.sent[0].error.code, "INVALID_ARGUMENT");
  first.emit({ requestId: "three", action: "openHumanReview", input: {} });
  await waitFor(() => first.sent.length === 2);
  assert.equal(first.sent[1].error.code, "INVALID_ACTION");
  assert(!JSON.stringify([first.sent, second.sent, fake.messages]).includes(bearer));
  first.dispose();
  first.emit({ requestId: "four", action: "state", input: {} });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(first.sent.length, 2);
  await fake.commands.get("pkm.next.disconnect")();
  second.emit({ requestId: "five", action: "state", input: {} });
  assert.equal(second.sent.length, 1);
  fake.context.subscriptions.forEach(item => item.dispose());
  assert.equal(fake.commands.size, 0);
});

test("host rejects workspace configuration authority, unsafe origins and mismatched attestation", async t => {
  const fixture = await server(t), fake = fakeVscode();
  activate(fake);
  t.after(() => fake.context.subscriptions.forEach(item => item.dispose()));
  fake.setInput(bearer);
  await fake.commands.get("pkm.nextHost.setToken")();
  Object.assign(fake.workspace, { origin: fixture.origin, workspaceId: "workspace-1", actorId: "actor-1" });
  await fake.commands.get("pkm.next.connect")();
  assert.equal(fixture.requests.length, 0);
  Object.assign(fake.global, { origin: "http://example.com:80", workspaceId: "workspace-1", actorId: "actor-1" });
  await fake.commands.get("pkm.next.connect")();
  assert.equal(fixture.requests.length, 0);
  Object.assign(fake.global, { origin: fixture.origin, actorId: "wrong-actor" });
  await fake.commands.get("pkm.next.connect")();
  assert.equal(fixture.requests.length, 1);
  await fake.commands.get("pkm.nextHost.open")();
  assert.equal(fake.panels.length, 0);
  assert(!JSON.stringify(fake.messages).includes(bearer));
});

test("disconnect aborts in-flight panel work and suppresses late replies", async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const fixture = await server(t, { beforeRead: () => gate }), fake = fakeVscode();
  Object.assign(fake.global, { origin: fixture.origin, workspaceId: "workspace-1", actorId: "actor-1" });
  activate(fake);
  t.after(() => fake.context.subscriptions.forEach(item => item.dispose()));
  fake.setInput(bearer);
  await fake.commands.get("pkm.nextHost.setToken")();
  await fake.commands.get("pkm.next.connect")();
  await fake.commands.get("pkm.nextHost.open")();
  const panel = fake.panels[0];
  panel.emit({ requestId: "slow", action: "knowledgeList", input: {} });
  await waitFor(() => fixture.requests.some(req => req.path === "/v1/capability_read"));
  await fake.commands.get("pkm.next.disconnect")();
  release();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(panel.sent, []);
});

test("disconnect reports in-flight write IDs without logging secrets or request bodies", async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const fixture = await server(t, { beforeWrite: () => gate }), fake = fakeVscode();
  Object.assign(fake.global, { origin: fixture.origin, workspaceId: "workspace-1", actorId: "actor-1" });
  activate(fake);
  t.after(() => fake.context.subscriptions.forEach(item => item.dispose()));
  fake.setInput(bearer);
  await fake.commands.get("pkm.nextHost.setToken")();
  await fake.commands.get("pkm.next.connect")();
  await fake.commands.get("pkm.nextHost.open")();
  const operationId = "6a76fc20-96e4-4d01-a964-cc8b6a600f08";
  fake.panels[0].emit({ requestId: "write", action: "chatCreate", input: {
    id: "session", operationId, expectedRevision: 0, title: "private title",
  } });
  await waitFor(() => fixture.requests.some(req => req.path === "/v1/capability_call"));
  await fake.commands.get("pkm.next.disconnect")();
  assert.equal(fake.warnings.length, 1);
  assert.match(fake.output.join("\n"), new RegExp(operationId));
  assert.match(fake.output.join("\n"), /Reconcile server receipts/);
  assert(!JSON.stringify([fake.output, fake.warnings]).includes(bearer));
  assert(!JSON.stringify([fake.output, fake.warnings]).includes("private title"));
  release();
  await fake.commands.get("pkm.next.connect")();
  assert.equal(fixture.requests.filter(req => req.path === "/v1/capability_call").length, 1);
});

async function tree(root) {
  const result = {};
  async function walk(path, prefix = "") {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const key = `${prefix}${entry.name}`;
      result[key] = entry.isDirectory() ? "directory" : createHash("sha256").update(await readFile(join(path, entry.name))).digest("hex");
      if (entry.isDirectory()) await walk(join(path, entry.name), `${key}/`);
    }
  }
  await walk(root);
  return result;
}

test("packaged first-run commands: cancel/deny/blockers write nothing; confirmation binds inspected source, destination and digest", async t => {
  const root = fileURLToPath(new URL(`.first-run-fixture-${randomUUID()}/`, import.meta.url));
  await mkdir(root, { mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  const installed = join(root, "installed");
  await cp(fileURLToPath(new URL("dist/", import.meta.url)), join(installed, "dist"), { recursive: true });
  const manifest = JSON.parse(await readFile(new URL("package.json", import.meta.url), "utf8"));
  for (const suffix of ["importPreview", "importConfirm"]) {
    assert(manifest.activationEvents.includes(`onCommand:pkm.nextHost.${suffix}`));
    assert(manifest.contributes.commands.some(item => item.command === `pkm.nextHost.${suffix}`));
  }
  const source = join(root, "disposable"), destination = join(root, "new-workspace");
  await mkdir(join(source, "notes"), { recursive: true });
  const note = join(source, "notes", "Example.md");
  await writeFile(note, "---\nid: migration-fixture\ntitle: First-run fixture\n---\nFixture bytes.\n");
  const fake = fakeVscode();
  fake.context.extensionPath = installed;
  // Load only the copied extension and copied helper, not next-server/dist.
  const load = Module._load;
  try {
    Module._load = function (id, ...args) { return id === "vscode" ? fake.api : load.call(this, id, ...args); };
    require(join(installed, "dist", "extension.cjs")).activate(fake.context);
  } finally { Module._load = load; }
  t.after(() => fake.context.subscriptions.forEach(item => item.dispose()));
  const invoke = suffix => fake.commands.get(`pkm.nextHost.${suffix}`)();
  const uri = fsPath => ({ scheme: "file", fsPath });
  const select = (target = destination) => fake.selections.push(
    [uri(source)], uri(target), [uri(process.execPath)], [uri("/usr/bin/python3")]);
  const initial = await tree(root);
  await invoke("importPreview"); // Source picker cancellation.
  assert.deepEqual(await tree(root), initial);
  select();
  await invoke("importPreview"); // Disposable-copy acknowledgement denied.
  assert.deepEqual(await tree(root), initial);
  select();
  fake.confirmations.push("Inspect disposable copy");
  await invoke("importPreview");
  assert.equal(fake.messages.length, 0, fake.messages.join("\n"));
  const inspected = JSON.parse(fake.output.find(line => line.startsWith("{")));
  assert.equal(inspected.plan.ready, true, JSON.stringify(inspected));
  assert.equal(inspected.source, source);
  assert.equal(inspected.destination, destination);
  assert.deepEqual(await tree(root), initial);
  await invoke("importConfirm"); // Final confirmation denied.
  await invoke("importConfirm"); // Denial consumes the plan.
  assert.deepEqual(await tree(root), initial);
  assert.match(fake.warnings.at(-1), /No ready inspected plan/);

  await writeFile(join(source, "unsupported.txt"), "preserve unsupported content");
  const blocked = await tree(root);
  select();
  fake.confirmations.push("Inspect disposable copy");
  await invoke("importPreview");
  await invoke("importConfirm");
  assert.match(fake.warnings.at(-1), /No ready inspected plan/);
  assert.deepEqual(await tree(root), blocked);
  await rm(join(source, "unsupported.txt"));

  await mkdir(join(source, "recipes", ".trash"), { recursive: true });
  const nativeBlocked = await tree(root);
  select();
  fake.confirmations.push("Inspect disposable copy");
  await invoke("importPreview");
  const nativeInspection = JSON.parse(fake.output.filter(line => line.startsWith("{")).at(-1));
  assert(nativeInspection.blockers.some(blocker => blocker.code === "recipe-trash-authority-required"));
  await invoke("importConfirm");
  assert.match(fake.warnings.at(-1), /No ready inspected plan/);
  assert.deepEqual(await tree(root), nativeBlocked, "User acknowledgement cannot grant independent native authority");
  await rm(join(source, "recipes"), { recursive: true });

  select(source); // Overlapping/existing destination blocks even a ready source.
  fake.confirmations.push("Inspect disposable copy");
  await invoke("importPreview");
  await invoke("importConfirm");
  assert.match(fake.warnings.at(-1), /No ready inspected plan/);
  assert.deepEqual(await tree(root), initial);

  select();
  fake.confirmations.push("Inspect disposable copy");
  await invoke("importPreview");
  await writeFile(note, "---\nid: migration-fixture\ntitle: Changed\n---\nChanged bytes.\n");
  const changed = await tree(root);
  fake.confirmations.push("Import exact inspected plan");
  await invoke("importConfirm");
  assert.match(fake.messages.at(-1), /SOURCE_CHANGED/);
  assert.deepEqual(await tree(root), changed, "Source drift must fail before staging/publication writes");

  select();
  fake.confirmations.push("Inspect disposable copy");
  await invoke("importPreview");
  const exact = JSON.parse(fake.output.filter(line => line.startsWith("{")).at(-1));
  const sourceBefore = await tree(source);
  // Configuration changes must not retarget the inspected destination.
  fake.global.managedRoot = join(root, "uninspected-root");
  fake.confirmations.push("Import exact inspected plan");
  await invoke("importConfirm");
  assert.equal(fake.messages.length, 1, fake.messages.join("\n")); // Only expected SOURCE_CHANGED above.
  const published = JSON.parse(fake.output.filter(line => line.startsWith("{")).at(-1));
  assert.equal(published.cutover, false);
  assert.equal(published.receipt.destination, exact.destination);
  assert.equal(published.receipt.fingerprint, exact.plan.fingerprint);
  assert.match(fake.warnings.at(-1), new RegExp(exact.plan.planSha256));
  assert.equal(await readFile(join(destination, "notes", "Example.md"), "utf8"), await readFile(note, "utf8"));
  assert.deepEqual(await tree(source), sourceBefore);
  assert(!(await readdir(root)).includes("uninspected-root"));
});

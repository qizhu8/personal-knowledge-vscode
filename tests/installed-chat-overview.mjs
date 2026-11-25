import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

const wait = ms => new Promise(done => setTimeout(done, ms));
const digest = value => createHash("sha256").update(value).digest("hex");
async function json(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}
async function receipt(base, name, value) {
  const file = join(base, name), staging = `${file}.next`;
  await writeFile(staging, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(staging, file);
}
function inside(base, path) {
  const rel = relative(base, path);
  assert(rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !resolve(path).startsWith(`${base}${sep}..${sep}`),
    "Installed overview fixtures must remain inside their private acceptance root");
  assert(resolve(path).startsWith(`${base}${sep}`));
}

/** Optional HTTP branch BEFORE the baseline provider parses/pushes its request. */
export function createOverviewModel({ base, token = "isolated-installed-provider" }) {
  const requests = [], pending = new Set(), failures = [];
  let serial = Promise.resolve();
  const persist = () => {
    const state = { model: "synthetic loopback SSE only", requests:[...requests], pending:[...pending], failures:[...failures] };
    serial = serial.then(() => receipt(base, "overview-model-evidence.json", state));
    return serial;
  };
  const send = (response, delta, reason = "stop") => {
    if (!response.headersSent) response.writeHead(200, { "content-type":"text/event-stream" });
    response.end(`data: ${JSON.stringify({ choices:[{ delta, finish_reason:null }] })}\n\n` +
      `data: ${JSON.stringify({ choices:[{ delta:{}, finish_reason:reason }] })}\n\ndata: [DONE]\n\n`);
  };
  return {
    // The parent reads/parses the HTTP body once, then offers it to this branch.
    async handle(request, response, input) {
      const last = input.messages?.filter(message => message.role === "user").at(-1)?.content;
      if (typeof last !== "string" || !last.startsWith("OVERVIEW_")) return false;
      try {
        assert.equal(request.headers.authorization, `Bearer ${token}`);
        const marker = last.split(":")[0];
        assert(["OVERVIEW_APPROVAL_A", "OVERVIEW_RUNNING_B", "OVERVIEW_FAIL"].includes(marker));
        const results = input.messages.filter(message => message.role === "tool");
        requests.push({ marker, tools:input.tools?.map(tool => tool.function.name), results:results.length });
        if (marker === "OVERVIEW_FAIL") {
          await persist();
          response.writeHead(401, { "content-type":"application/json" });
          response.end('{"error":{"message":"Isolated overview authentication failure"}}');
          return true;
        }
        if (marker === "OVERVIEW_RUNNING_B") {
          pending.add(marker);
          await persist();
          response.writeHead(200, { "content-type":"text/event-stream" });
          response.write(": isolated fixture waits for explicit release\n\n");
          const monitor = setInterval(async () => {
            try {
              if (!await json(join(base, "overview-release-running.json"))) return;
              clearInterval(monitor);
              pending.delete(marker);
              await persist();
              if (!response.destroyed) send(response, { content:"OVERVIEW_B_COMPLETED" });
            } catch (error) {
              clearInterval(monitor); failures.push(String(error)); pending.delete(marker);
              await persist(); response.destroy(error);
            }
          }, 50);
          response.once("close", () => { clearInterval(monitor); pending.delete(marker); void persist(); });
          return true;
        }
        const sequence = [
          ["replace_text", { path:"overview-approval.txt",
            oldText:"OVERVIEW_APPROVAL_PENDING", newText:"OVERVIEW_APPROVAL_RESOLVED" }],
          ["find_vscode_tools", { query:"mcp_pkm_get_note" }],
          ["invoke_vscode_tool", { name:"mcp_pkm_get_note", input:{ slug:"InstalledGatewayNote" } }],
        ];
        assert(results.length <= sequence.length, "Overview fixture must not replay tool steps");
        if (results.length) {
          assert.match(results[0].content, /"applied":\s*true/);
          assert.match(results[0].content, /"saved":\s*false/);
        }
        const step = sequence[results.length];
        if (step) assert(input.tools?.some(tool => tool.function.name === step[0]), `Missing actual installed tool ${step[0]}`);
        else assert.match(results.at(-1).content, /Created by installed PKM Chat through the selected v5 gateway/);
        await persist();
        send(response, step ? { tool_calls:[{ index:0, id:`overview-read-${results.length}`, type:"function",
          function:{ name:step[0], arguments:JSON.stringify(step[1]) } }] } : { content:"OVERVIEW_A_COMPLETED" },
        step ? "tool_calls" : "stop");
      } catch (error) {
        failures.push(String(error)); await persist();
        if (!response.headersSent) response.writeHead(500);
        response.end("Isolated overview fixture failed");
      }
      return true;
    },
    async flush() { await serial; return { requests:[...requests], failures:[...failures], pending:[...pending] }; },
  };
}

/** Capture the real object returned by production registration; never replace its view, state, or execution methods. */
export function observeInstalledChatRegistration(installed, requireInstalled) {
  const module = requireInstalled(join(installed, "dist/chat/api-chat-view.js"));
  const original = module.registerApiChat, providers = [];
  assert.equal(typeof original, "function");
  function observe(...args) {
    const provider = original.apply(this, args);
    providers.push(provider);
    return provider;
  }
  module.registerApiChat = observe;
  return {
    providers,
    restore() { if (module.registerApiChat === observe) module.registerApiChat = original; },
  };
}

async function chatFiles(root) {
  const files = {};
  const visit = async directory => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes:true }); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && /\.(?:json|jsonl)$/.test(entry.name)) {
        const info = await stat(path, { bigint:true });
        files[relative(root, path)] = { sha256:digest(await readFile(path)), size:String(info.size),
          mtimeNs:String(info.mtimeNs), ctimeNs:String(info.ctimeNs) };
      }
    }
  };
  for (const directory of ["api-chats", "api-chat-history", "agent-sessions"]) await visit(join(root, directory));
  return files;
}

/** Run in the real extension-host driver AFTER baseline browser-done and its Session evidence have been captured. */
export async function runInstalledOverviewHost({ base, installed, library, vscode, context, observation, requireInstalled }) {
  base = await realpath(base); library = await realpath(library);
  installed = await realpath(installed);
  inside(base, library); inside(base, installed);
  assert.equal(context.extensionMode, vscode.ExtensionMode.Production);
  assert.equal(await realpath(context.extensionPath), installed);
  inside(base, await realpath(context.globalStorageUri.fsPath));
  const config = vscode.workspace.getConfiguration("personalKnowledge");
  assert.equal(config.get("apiChatProvider"), "openai-compatible");
  const endpoint = new URL(config.get("aiEndpoint"));
  assert.equal(endpoint.protocol, "http:");
  assert.equal(endpoint.hostname, "127.0.0.1", "Only the isolated loopback model may be used");
  const deadline = Date.now() + 180_000;
  let provider;
  while (!(provider = observation.providers.find(item => item.view)) && Date.now() < deadline) await wait(50);
  assert(provider, "Must observe the actual registered installed provider, not construct a substitute");
  observation.restore();
  const actual = vscode.extensions.getExtension("uone.personal-knowledge");
  assert(actual?.isActive);
  assert.equal(await realpath(actual.extensionPath), installed);
  const stateRoot = join(library, ".pkm/state");
  await provider.agentControl("list", {});
  assert.equal(await realpath(provider.store.stateDirectory), await realpath(stateRoot),
    "Fixture creation must not reach a different Knowledge Root");
  const { ApiChatStore } = requireInstalled(join(installed, "dist/chat/api-chat-store.js"));
  const incoming = [];
  const listener = provider.view.webview.onDidReceiveMessage(message => incoming.push({
    type:message?.type, id:message?.id, chatId:message?.chatId,
  }));
  const controls = [];
  let checkpoint;
  try {
    await writeFile(join(library, "overview-approval.txt"), "OVERVIEW_APPROVAL_PENDING\n", { flag:"wx", mode:0o600 });
    const a = await provider.agentControl("create", { title:"Installed overview duplicate title" });
    const b = await provider.agentControl("create", { title:"Installed overview duplicate title" });
    const trash = await provider.agentControl("create", { title:"Installed overview already trashed" });
    provider.store.trashChat(trash.chatId);
    const namespace = provider.store.namespace;
    const foreignNamespace = namespace === "f".repeat(16) ? "e".repeat(16) : "f".repeat(16);
    const foreignStore = new ApiChatStore(stateRoot, foreignNamespace);
    const foreign = foreignStore.create();
    foreign.title = "PRIVATE_OTHER_WORKSPACE_TITLE"; foreign.customTitle = true;
    foreignStore.save(foreign);
    await vscode.commands.executeCommand("personalKnowledge.openApiChat", a.chatUrl);
    provider.refresh();
    await receipt(base, "overview-fixture.json", { a, b, trashId:trash.chatId, foreignId:foreign.id, namespace, foreignNamespace });
    const snapshot = async () => ({
      chatFiles:await chatFiles(stateRoot),
      running:[...provider.running.keys()].sort(),
      approvals:[...provider.approvals.keys()].sort(),
      decisions:[...provider.decisions.keys()].sort(),
      livePermissions:[...provider.chats.values()].map(chat => ({
        id:chat.id, mode:chat.permissionMode, grants:chat.permissionGrants,
        queuedInputIds:chat.queuedInputs?.map(input => input.id),
      })).sort((a, b) => a.id.localeCompare(b.id)),
      settings:digest(await readFile(join(base, "u/User/settings.json"))),
      originalNote:digest(await readFile(join(library, "notes/InstalledGatewayNote.md"))),
      approvalFile:digest(await readFile(join(library, "overview-approval.txt"))),
      model:await json(join(base, "overview-model-evidence.json")),
    });
    let last = 0;
    while (Date.now() < deadline) {
      const command = await json(join(base, "overview-control.json"));
      if (command && command.sequence > last) {
        assert.equal(command.sequence, last + 1);
        last = command.sequence;
        let result;
        if (command.action === "read-only-begin") {
          // Let existing debounced stream persistence settle before measuring the view-only interval.
          let previous, stable = 0;
          for (let attempt = 0; attempt < 30 && stable < 8; attempt++) {
            const current = await snapshot();
            stable = JSON.stringify(previous) === JSON.stringify(current) ? stable + 1 : 0;
            previous = current; await wait(100);
          }
          assert(stable >= 8, "Running fixture did not reach a stable observation checkpoint");
          checkpoint = { value:await snapshot(), offset:incoming.length };
          result = { checkpoint:true };
        } else if (command.action === "read-only-end") {
          assert(checkpoint);
          assert.deepEqual(await snapshot(), checkpoint.value,
            "Viewing the real installed overview must not write Chat/Session files or alter running work, approvals, decisions, or model requests");
          const unexpected = incoming.slice(checkpoint.offset).filter(message =>
            !["hostHealth", "chatVisibility", "chatListRender"].includes(message.type));
          assert.deepEqual(unexpected, [], "Read-only overview emitted an execution, approval, selection, or mutation message");
          result = { readOnly:true, pendingApprovals:checkpoint.value.approvals,
            runningChatIds:checkpoint.value.running, durableFileCount:Object.keys(checkpoint.value.chatFiles).length };
          checkpoint = undefined;
        } else if (command.action === "release-running") {
          await receipt(base, "overview-release-running.json", { release:true });
          result = { released:true };
        } else throw Error(`Unexpected overview fixture action ${command.action}`);
        controls.push({ ...command, result });
        await receipt(base, "overview-control-result.json", { sequence:last, result });
      }
      const done = await json(join(base, "overview-browser-done.json"));
      if (done) {
        assert(!checkpoint);
        assert(controls.some(control => control.result.readOnly));
        assert(done.realInstalledIpc && done.pendingApprovalPreserved && done.draftsPreserved
          && done.namespaceScoped && done.trashExcluded && done.reloadVerified && done.realFailure);
        const listed = provider.store.list(true);
        assert(listed.find(chat => chat.id === b.chatId)?.trashedAt, "Browser must use the actual Trash action");
        assert.equal(listed.find(chat => chat.id === a.chatId)?.status, "failed");
        const model = await json(join(base, "overview-model-evidence.json"));
        assert.deepEqual(model.failures, []);
        assert.equal(model.requests.filter(request => request.marker === "OVERVIEW_RUNNING_B").length, 1);
        assert.equal(model.requests.filter(request => request.marker === "OVERVIEW_APPROVAL_A").length, 4);
        const evidence = { passed:true, extensionMode:"Production", installedExtensionPath:installed,
          observation:"actual production registration, passive real webview IPC; no injected state or substituted API",
          model:"synthetic loopback SSE; explicit approval for an unsaved synthetic text edit, then read-only MCP get_note; no save or knowledge write",
          fixture:{ a:a.chatId, b:b.chatId, namespace, foreignId:foreign.id, foreignNamespace, trashId:trash.chatId },
          controls, browser:done, modelEvidence:model };
        await receipt(base, "overview-host-evidence.json", evidence);
        return evidence;
      }
      await wait(50);
    }
    throw Error("Real installed overview browser did not complete before its fixture deadline");
  } finally { listener.dispose(); }
}

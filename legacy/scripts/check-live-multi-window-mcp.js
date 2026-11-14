#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHash, randomUUID } = require("node:crypto");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const digest = value => createHash("sha256").update(value).digest("hex");

function options(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!["--store", "--python", "--server", "--report"].includes(key) || !argv[index + 1] || values[key]) {
      throw new Error("Usage: check-live-multi-window-mcp.js --store ROOT --python EXECUTABLE --server SERVER.py --report REPORT.json");
    }
    values[key] = path.resolve(argv[index + 1]);
  }
  for (const key of ["--store", "--python", "--server", "--report"]) {
    if (!values[key]) throw new Error(`Missing ${key}. Launch paths must be explicitly chosen; no configuration is changed.`);
  }
  return values;
}

function decode(result) {
  if (result.isError) throw new Error("The live MCP server returned a tool error.");
  const text = result.content?.find(item => item.type === "text")?.text;
  if (!text) throw new Error("The live MCP server returned no JSON tool result.");
  const value = JSON.parse(text);
  if (value.ok === false) throw new Error("The live MCP operation reported failure.");
  return value;
}

async function call(client, name, args = {}) {
  return decode(await client.callTool({ name, arguments: args }, undefined, { timeout: 15000 }));
}

async function receipt(client, request) {
  const deadline = Date.now() + 15000;
  let current = request;
  while (current.status === "queued" || current.status === "running") {
    if (Date.now() >= deadline) throw new Error("The live Host did not finish the read-only probe within 15 seconds.");
    await delay(200);
    current = await call(client, "api_chat_request_get", { host_id: request.host_id, request_id: request.request_id });
  }
  if (current.status !== "succeeded") {
    throw new Error(`Live Host request ended as ${current.status}: ${String(current.error || "outcome unknown").slice(0, 500)}`);
  }
  return current.result;
}

async function hostCatalog(client, store, hostId, operation) {
  // This is the installed Host's supported control protocol, not a mocked host.
  // The generated MCP server has no public tools-catalog wrapper yet.
  const root = path.join(store, ".pkm", "state", "api-chat-control");
  const host = JSON.parse(fs.readFileSync(path.join(root, "hosts", `${hostId}.json`), "utf8"));
  if (!host.operations.includes(operation) || Date.now() - host.updatedAt >= 15000) {
    throw new Error("The selected installed Host is offline or does not support the probe.");
  }
  const commandId = `live-acceptance-${randomUUID()}`;
  const args = operation === "tools" ? { start: false } : {};
  const payload = { operation, arguments: args, commandId };
  const requestId = digest(JSON.stringify([hostId, commandId]));
  const destination = path.join(root, "requests", hostId, `${requestId}.json`);
  const temporary = destination + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify({
    ...payload, schema: "pkm.api-chat.request/v1", hostId, requestId,
    payloadHash: digest(JSON.stringify(payload)), status: "queued",
    createdAt: Date.now(), expiresAt: Date.now() + 30000,
  }), { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, destination);
  return receipt(client, { host_id: hostId, request_id: requestId, status: "queued" });
}

function privateBoundary(store) {
  if (process.platform === "win32") return { verified: false, reason: "Windows DACL acceptance is not available in this Linux probe." };
  let directory = fs.realpathSync(store);
  while (true) {
    const stat = fs.statSync(directory);
    if (stat.uid === process.getuid() && (stat.mode & 0o077) === 0) return { verified: true, boundary: directory };
    const parent = path.dirname(directory);
    if (parent === directory) return { verified: false, reason: "No owner-only ancestor boundary was found; account isolation is not accepted." };
    directory = parent;
  }
}

async function main(argv = process.argv.slice(2)) {
  const settings = options(argv);
  const report = {
    schema: "pkm.live-multi-window-mcp-acceptance/v1", at: new Date().toISOString(),
    machine: os.hostname(), status: "running", probes: [], outstanding: [],
    policy: "Installed server and Hosts only. No model sends, native startup, user Chat modifications, reloads or configuration changes.",
  };
  const clients = [];
  const transports = [];
  const save = () => {
    fs.mkdirSync(path.dirname(settings["--report"]), { recursive: true });
    const temporary = settings["--report"] + ".tmp";
    fs.writeFileSync(temporary, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(temporary, settings["--report"]);
  };
  try {
    const binding = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pkm", "mcp-binding.json"), "utf8"));
    if (fs.realpathSync(binding.knowledgeRoot) !== fs.realpathSync(settings["--store"])) throw new Error("The explicit store does not match this account's binding.");
    report.binding = { serverId: binding.serverId, registrationOwner: binding.registrationOwner, targetId: binding.targetId, accountId: binding.accountId };
    report.isolation = privateBoundary(settings["--store"]);
    if (!report.isolation.verified) report.outstanding.push("Account isolation: owning user must review permissions; no chmod was performed.");
    for (let index = 0; index < 2; index++) {
      const client = new Client({ name: `pkm-live-acceptance-${index}`, version: "1.0.0" });
      const transport = new StdioClientTransport({ command: settings["--python"], args: [settings["--server"]], cwd: path.dirname(settings["--server"]), stderr: "pipe" });
      clients.push(client); transports.push(transport);
      transport.stderr?.on("data", () => {});
      await client.connect(transport, { timeout: 15000 });
      const tools = await client.listTools(undefined, { timeout: 15000 });
      for (const name of ["check_version", "api_chat_capabilities", "api_chat_list", "api_chat_request_get"]) {
        if (!tools.tools.some(tool => tool.name === name)) throw new Error(`Live transport ${index} does not advertise ${name}.`);
      }
      const version = await call(client, "check_version");
      report.probes.push({ name: "stdio-initialize-tools-version", client: index, passed: true, toolCount: tools.tools.length, version });
    }
    const capabilities = await call(clients[0], "api_chat_capabilities");
    if (capabilities.truncated || capabilities.hosts.length < 2) throw new Error("At least two live installed Hosts are required, without a truncated directory.");
    const directories = [];
    for (const [index, host] of capabilities.hosts.entries()) {
      const client = clients[index % clients.length];
      const commandId = `live-list-${randomUUID()}`;
      const submitted = await call(client, "api_chat_list", { host_id: host.host_id, command_id: commandId });
      const replay = await call(clients[(index + 1) % clients.length], "api_chat_list", { host_id: host.host_id, command_id: commandId });
      if (submitted.request_id !== replay.request_id) throw new Error("Same command ID created duplicate receipts across stdio clients.");
      const [listed, catalog] = await Promise.all([receipt(client, submitted), hostCatalog(client, settings["--store"], host.host_id, "tools")]);
      const ids = listed.chats.map(chat => chat.chatUrl).sort();
      directories.push(ids);
      const workspaceRegistration = host.workspace_paths.map(root => ({
        root, projectMcpFilePresent: fs.existsSync(path.join(root, ".vscode", "mcp.json")),
      }));
      const passed = catalog.toolsApiAvailable && catalog.pkmCount > 0;
      report.probes.push({
        name: "installed-host-directory-and-native-catalog", hostId: host.host_id,
        workspaces: workspaceRegistration, build: host.build, passed,
        sharedChatCount: ids.length, directoryHash: digest(JSON.stringify(ids)), truncated: listed.truncated,
        nativeToolsAvailable: catalog.toolsApiAvailable, registeredCount: catalog.registeredCount,
        pkmCount: catalog.pkmCount, pkmToolNames: catalog.pkmTools,
        publicToolsCatalogWrapper: false, nativeStartupRequested: false, idempotentReceipt: true,
      });
      if (!passed) report.outstanding.push(`Native PKM tools are not registered in Host ${host.host_id}; registration alone is not live-tool availability.`);
    }
    const shared = directories[0].filter(id => directories.every(ids => ids.includes(id)));
    report.sharedDirectory = { hosts: directories.length, commonChats: shared.length,
      identical: directories.every(ids => JSON.stringify(ids) === JSON.stringify(directories[0])) };
    if (!shared.length) report.outstanding.push("No common Chat URL was observed; shared identity has not been accepted.");
    report.outstanding.push("Model/tool execution from each actual sending window and paid model calls were not exercised.");
    report.outstanding.push("Actual agent-session PKM tool visibility, native trust/consent, owner-loss recovery and Windows routing require separate acceptance.");
    report.status = report.outstanding.length ? "partial" : "passed";
    save();
    console.log(JSON.stringify({ report: settings["--report"], status: report.status, hosts: directories.length,
      nativeRegisteredHosts: report.probes.filter(probe => probe.name === "installed-host-directory-and-native-catalog" && probe.passed).length,
      sharedDirectory: report.sharedDirectory, accountIsolation: report.isolation.verified, outstanding: report.outstanding }, null, 2));
  } catch (error) {
    report.status = "failed"; report.error = error instanceof Error ? error.message : "Live acceptance failed.";
    save(); throw error;
  } finally {
    for (const client of clients) await client.close();
    for (const transport of transports) await transport.close();
  }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };

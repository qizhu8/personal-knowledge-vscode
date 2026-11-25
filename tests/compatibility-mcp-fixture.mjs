import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { stageCompatibilityMcp } from "../scripts/stage-compatibility-mcp.mjs";

export const compatibilityMcpValue = response => response.structuredContent
  ?? JSON.parse(response.content.filter(part => part.type === "text").map(part => part.text).join(""));

export async function compatibilityMcpFixture(t, { setup } = {}) {
  const legacy = process.env.PKM_COMPATIBILITY_EXTENSION || resolve("../personal-knowledge-vscode");
  const require = createRequire(join(legacy, "package.json"));
  const python = process.env.PKM_TEST_PYTHON || require(join(legacy, "tests/dev-paths.js")).testPython;
  const evidence = resolve(".pkm-test-evidence");
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  const base = await mkdtemp(join(evidence, "pkm-compatible-")), root = join(base, "library"), managed = join(root, "mcp-server");
  const clients = [], cleanups = [];
  t.after(async () => {
    for (const client of clients) await client.close();
    for (const cleanup of cleanups) await cleanup();
    await rm(base, { recursive: true, force: true });
  });
  const runtime = join(base, "python"), home = join(base, "home"), stage = join(base, "v5");
  for (const path of [join(root, "notes"), join(root, "skills"), join(root, "papers"), join(runtime, "bin"), home])
    await mkdir(path, { recursive: true, mode: 0o700 });
  await writeFile(join(base, "package.json"), '{"type":"commonjs"}\n');
  await symlink(python, join(runtime, "bin/python"));
  await writeFile(join(root, "notes/Entry.md"), "---\ntitle: Entry\n---\nOriginal business content.\n");
  if (setup) await setup({ base, root });
  const helper = join(base, "generate.cjs");
  await writeFile(helper, `
const Module=require("module"),path=require("path");
const config={mcpServerPath:${JSON.stringify(managed)},mcpRuntimePath:${JSON.stringify(runtime)},mcpEnabledFeatureDomains:["knowledge","automation","skillRouter"]};
const api={workspace:{isTrusted:true,workspaceFolders:[],getConfiguration:()=>({get:(k,d)=>k in config?config[k]:d})},
env:{appRoot:${JSON.stringify(home)},machineId:"fixture",sessionId:"fixture"},Uri:{file:p=>({fsPath:p,toString:()=>p})}};
const load=Module._load;Module._load=function(id,...a){return id==="vscode"?api:load.call(this,id,...a)};
require(${JSON.stringify(join(legacy, "dist/knowledge/filestore.js"))}).setStorePath(${JSON.stringify(root)});
require(${JSON.stringify(join(legacy, "dist/mcp/mcp.js"))}).generateMcpServer({
extensionPath:${JSON.stringify(legacy)},globalStorageUri:{fsPath:${JSON.stringify(home)}}}).then(()=>{},e=>{console.error(e);process.exitCode=1;});
`);
  execFileSync(process.execPath, [helper], { cwd: base, env: { ...process.env, HOME: home }, stdio: "pipe", timeout: 60000 });
  const frozen = await stageCompatibilityMcp({ extension: legacy, knowledgeRoot: root, managedRoot: managed, python, destination: stage });
  const target = JSON.parse(await readFile(frozen.targetPath));
  async function connect(original = false) {
    const client = new Client({ name: "compatible-facade-fixture", version: "1" });
    const config = JSON.parse(await readFile(target.args[0]));
    const transport = new StdioClientTransport(original
      ? { command: config.python, args: ["-B", config.supervisor.path, config.python, "-B", config.legacy.launcher.path],
        cwd: root, env: { ...process.env, HOME: home, ELECTRON_RUN_AS_NODE: "1", PKM_NODE_EXECUTABLE: config.node.path,
          PKM_CAPABILITY_PROFILE: "compact", PYTHONDONTWRITEBYTECODE: "1" }, stderr: "pipe" }
      : { command: target.command.path, args: [target.entry.path, ...target.args],
        cwd: stage, env: { ...process.env, HOME: home }, stderr: "pipe" });
    let diagnostic = "";
    transport.stderr?.on("data", bytes => { diagnostic = (diagnostic + bytes).slice(-6000); });
    clients.push(client);
    try { await client.connect(transport); }
    catch (error) { throw new Error(`${error.message}\n${diagnostic}`, { cause: error }); }
    return { client, transport };
  }
  async function close(client) {
    let reply = await client.callTool({ name: "mcp_lifecycle_quiesce", arguments: {} });
    for (let i = 0; compatibilityMcpValue(reply).phase !== "drained" && i < 200; i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      reply = await client.callTool({ name: "mcp_lifecycle_status", arguments: {} });
    }
    assert.equal(compatibilityMcpValue(reply).phase, "drained", JSON.stringify(reply));
    await client.close();
  }
  return { base, root, managed, stage, target, frozen, connect, close,
    retainCleanup(cleanup) {
      assert.equal(typeof cleanup, "function");
      cleanups.push(cleanup);
    }, regenerate() {
    execFileSync(process.execPath, [helper], { cwd: base, env: { ...process.env, HOME: home }, stdio: "pipe", timeout: 60000 });
  } };
}

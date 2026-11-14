"use strict";
const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const { randomUUID } = require("node:crypto");
const { test } = require("node:test");
const { localSdkTransport } = require("./next-trial-electron/sdk-local-transport.cjs");

test("private SDK imports the actual Code ASAR package and discovers through local JSON-RPC", { timeout: 30000 }, async t => {
  const project = path.resolve(__dirname, "..");
  const fixture = path.join(project, ".migration-test-work", `sdk-asar-offline-${randomUUID()}`);
  const codeRoot = process.env.PKM_TEST_CODE_ROOT || path.join(os.homedir(), ".cache/pkm-vscode-test/vscode-linux-x64-1.143.0");
  const electron = path.join(codeRoot, "code"), appRoot = path.join(codeRoot, "resources/app");
  const sdkModule = path.join(process.env.PKM_TEST_EXTENSION_DIST || path.join(project, ".migration-test-work/chat-permission-validation/extension"), "chat/api-chat-copilot-sdk.js");
  const rpcModule = path.join(process.env.PKM_REAL_SDK_MODULES || path.join(project, ".migration-test-work/root-upgrade-validation/sdk-real-fixture/node_modules"), "vscode-jsonrpc/node");
  if (!fs.existsSync(electron) || !fs.existsSync(sdkModule) || !fs.existsSync(`${rpcModule}.js`)) {
    t.skip("Requires private Code, isolated extension build, and the local JSON-RPC fixture dependencies.");
    return;
  }
  const rpc = require(rpcModule);
  fs.mkdirSync(fixture, { recursive: true, mode: 0o700 });
  const transport = await localSdkTransport({ rpc, program: process.execPath, args: [], cwd: fixture, mode: "foreground" });
  t.after(async () => { await transport.close(); fs.rmSync(fixture, { recursive: true, force: true }); });
  const source = `
    const assert=require('node:assert/strict'), path=require('node:path'), Module=require('node:module');
    const old=Module._load; Module._load=function(name,...args){return name==='vscode'?{}:old.call(this,name,...args)};
    const adapter=require(process.argv[1]), appRoot=process.argv[2], url=process.argv[3], base=process.argv[4], proxy=process.argv[5];
    const located=adapter.locateCopilotSdkRuntime(appRoot);
    assert.match(located.sdkDir,/node_modules\\.asar\\//);
    assert.match(located.cliPath,/node_modules\\.asar\\.unpacked\\//);
    const sdk=require(located.sdkDir), original=sdk.RuntimeConnection.forStdio;
    sdk.RuntimeConnection.forStdio=() => original({path:process.execPath,args:[proxy,url]});
    const host={env:{appRoot},authentication:{async getSession(){return {accessToken:'fixture-only-token'}}}};
    (async()=>{const deps=adapter.createPrivateCopilotSdk(host,base);try{
      const {client}=await deps.client();
      const models=await adapter.discoverCopilotSdkModels(host,undefined,deps,true,false);
      assert.equal(models[0].id,'local-sdk-fixture');
      const session=await client.createSession({
        model:models[0].id,gitHubToken:'fixture-only-token',streaming:true,
        tools:[sdk.defineTool('run_process',{description:'Fixture only',parameters:{type:'object'},
          handler:async()=>JSON.stringify({error:'not executed'})})],
        availableTools:['run_process'],enableConfigDiscovery:false,enableSkills:false,
        enableSessionStore:false,enableHostGitOperations:false
      });
      const nextEvent=(predicate)=>new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(Error('SDK fixture event timeout')),5000);
        const unsubscribe=session.on(event=>{if(predicate(event)){clearTimeout(timer);unsubscribe();resolve(event)}});
      });
      try {
        const tool=nextEvent(event=>event.type==='assistant.message' && event.data?.toolRequests?.length);
        await session.send({prompt:'fixture request'});
        const requested=await tool;
        assert.equal(requested.data.toolRequests[0].name,'run_process');
        const reply=nextEvent(event=>event.type==='assistant.message' && event.data?.content==='SDK_FIXTURE_SUCCESS');
        await session.send({prompt:JSON.stringify({role:'tool',content:'fixture result'})});
        await reply;
      } finally {await session.disconnect();await client.deleteSession(session.sessionId)}
      console.log(JSON.stringify({version:require(path.join(located.sdkDir,'package.json')).version,model:models[0].id,tool:'run_process'}));
    } finally {await deps.dispose(); sdk.RuntimeConnection.forStdio=original}})().catch(e=>{console.error(e);process.exitCode=1});
  `;
  const { stdout } = await promisify(execFile)(electron, ["-e", source, sdkModule, appRoot, transport.url, fixture, path.join(__dirname, "next-trial-electron/sdk-stdio-proxy.cjs")], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NODE_PATH: path.join(appRoot, "node_modules.asar") },
    timeout: 20000,
  });
  const result = JSON.parse(stdout.trim());
  assert.match(result.version, /^1\./);
  assert.equal(result.model, "local-sdk-fixture");
  assert.equal(result.tool, "run_process");
  assert.equal(transport.state.connections, 1);
  assert.equal(transport.state.creates.length, 1);
  assert.equal(transport.state.sends.length, 2);
});

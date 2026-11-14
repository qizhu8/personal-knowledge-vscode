"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { pathToFileURL } = require("node:url");

async function until(read, predicate, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

exports.run = async ({ root, node, extensionPath, legacy, vscode }) => {
  assert.equal(vscode.workspace.isTrusted, true, "The real VS Code workspace must be trusted.");
  const workspace = path.join(root, "editor", "action-workspace");
  assert.ok(vscode.workspace.getWorkspaceFolder(vscode.Uri.file(workspace)));
  const cli = path.join(extensionPath, "next-runtime/server/dist/cli.js");
  assert.ok(fs.statSync(cli).isFile(), "Installed extension must contain its production CLI.");
  execFileSync(node, [cli, "init", "--data", workspace], { timeout: 15000, env: process.env, stdio: "pipe" });
  fs.mkdirSync(path.join(workspace, "scripts"), { mode: 0o700 });
  const originalDialog = vscode.window.showOpenDialog;
  const originalSaveDialog = vscode.window.showSaveDialog;
  const originalWarning = vscode.window.showWarningMessage;
  let allowed = true, consentCount = 0, selectionCount = 0;
  const artifactSource = path.join(root, "action-selected.bin");
  const artifactDestination = path.join(root, "action-export.bin");
  const artifactBytes = Buffer.from([0, 3, 10, 255, 17]);
  const artifactDigest = createHash("sha256").update(artifactBytes).digest("hex");
  let artifactId, childHash;
  const artifactConsents = [];
  let checkBuildConsent;
  let client, serverChild, serverExit;
  vscode.window.showOpenDialog = async options => {
    selectionCount++;
    if (options.openLabel === "Select Action artifact") return [vscode.Uri.file(artifactSource)];
    return [vscode.Uri.file(workspace)];
  };
  vscode.window.showSaveDialog = async options => {
    assert.equal(options.saveLabel, "Select Action artifact export destination");
    return vscode.Uri.file(artifactDestination);
  };
  vscode.window.showWarningMessage = async (message, options) => {
    if (message === "Enable Actions for this isolated next workspace?") {
      assert.equal(options.modal, true);
      assert.match(options.detail, /programs with bounded private-source builds \(including pkm\.action\.result\/v1\)/);
      assert.match(options.detail, /pure JavaScript pipelines using core\.constant and core\.math-expression/);
      assert.match(options.detail, /without.*allowlist|not.*require a per-program allowlist/i);
      assert.ok(options.detail.includes(workspace));
      return "Enable trusted Actions";
    }
    if (message === "Import this file as an Action artifact?") {
      assert.equal(options.modal, true);
      assert.ok(options.detail.includes(artifactSource));
      assert.ok(options.detail.includes(artifactDigest));
      assert.match(options.detail, /Actor: mcp:external/);
      return allowed ? "Approve artifact import" : undefined;
    }
    if (message === "Export this managed Action artifact?") {
      assert.equal(options.modal, true);
      assert.ok(options.detail.includes(artifactDestination));
      assert.ok(options.detail.includes(artifactDigest));
      return allowed ? "Approve artifact export" : undefined;
    }
    if (message.startsWith("Allow Action invocation:")) {
      consentCount++;
      assert.equal(options.modal, true);
      if (message.includes("example.installed.build")) {
        assert.ok(checkBuildConsent, "Unexpected build consent.");
        checkBuildConsent(options.detail);
      } else if (message.includes("example.installed.pure"))
        assert.match(options.detail, /Pure pipeline: core\.constant, core\.math-expression \(3 steps\)/);
      else if (message.includes("example.installed.artifact") || message.includes("core.artifact.copy")) {
        artifactConsents.push(message);
        assert.ok(options.detail.includes(artifactId));
        assert.ok(options.detail.includes(artifactDigest));
        if (message.includes("example.installed.artifact"))
          assert.ok(options.detail.includes(`core.artifact.copy (${childHash})`));
      }
      else assert.ok(options.detail.includes(node));
      assert.match(options.detail, /Input digest: [a-f0-9]{64}/);
      assert.match(options.detail, /Input and validated output may be persisted/);
      return allowed ? "Allow this invocation" : undefined;
    }
    throw new Error(`Unexpected Action warning: ${message}`);
  };
  try {
    await vscode.commands.executeCommand("personalKnowledge.actions.attachNativeWorkspace");
    assert.equal(selectionCount, 1);
    assert.equal(fs.realpathSync(require(path.join(extensionPath, "dist/knowledge/filestore.js")).getStorePath()),
      fs.realpathSync(legacy), "Action opt-in must not replace the old root.");
    const config = JSON.parse(fs.readFileSync(path.join(workspace, ".pkm-action-authority/host-authority.json"), "utf8"));
    assert.equal(config.store_path, workspace);
    assert.equal(config.schema, "pkm.action.host-authority/v1");
    assert.ok(config.port > 0);

    const sdk = path.join(extensionPath, "next-runtime/server/node_modules/@modelcontextprotocol/sdk/dist/esm");
    const { Client } = await import(pathToFileURL(path.join(sdk, "client/index.js")).href);
    const { StdioClientTransport } = await import(pathToFileURL(path.join(sdk, "client/stdio.js")).href);
    const transport = new StdioClientTransport({
      command: node, args: [cli, "mcp", "--data", workspace, "--experimental-legacy-mcp", "--experimental-trusted-actions"],
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-8192); });
    client = new Client({ name: "installed-action-test", version: "1.0.0" });
    try { await client.connect(transport); } catch (error) { throw new Error(`Installed Action MCP failed: ${stderr}`, { cause: error }); }
    serverChild = transport._process;
    assert.ok(serverChild?.pid, "The installed CLI must be a real MCP child process.");
    serverExit = new Promise(resolve => serverChild.once("exit", (code, signal) => resolve({ code, signal })));
    const tools = await client.listTools();
    assert.ok(tools.tools.some(tool => tool.name === "action_call"));
    const status = await client.callTool({ name: "action_trust_status", arguments: {} });
    assert.equal(status.structuredContent.value.trustedWorkspace, true);
    assert.equal(status.structuredContent.value.actorId, "mcp:external");

    const proof = path.join(workspace, "scripts/action-proof.json");
    const code = "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{let x=JSON.parse(s);require('node:fs').writeFileSync('scripts/action-proof.json',JSON.stringify(x));console.log(JSON.stringify({value:x.value+'-result'}))})";
    const schema = { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false };
    const definition = {
      schema: "pkm.action.definition/v1", action_id: "example.installed.action", version: 1,
      description: "Synthetic installed Action.", input_schema: schema, output_schema: schema, effects: ["local-write"],
      implementations: [{ id: "native", kind: "program", platforms: ["Linux"], program: node, args: ["-e", code] }],
      dependencies: {}, casts: {}, examples: [],
    };
    const submit = value => client.callTool({ name: "legacy_action_write", arguments: {
      tool: "action_register", arguments: { definition: value },
    } });
    const submitted = await submit(definition);
    assert.notEqual(submitted.isError, true, JSON.stringify(submitted));
    const proposal = submitted.structuredContent.value;
    assert.equal(proposal.state, "automatically_admitted");
    assert.equal(proposal.registered, true);
    assert.equal(proposal.callable, true);
    const call = (action, key, inputs = { value: "installed" }) => client.callTool({ name: "action_call", arguments: {
      action_id: action.action_id, content_hash: action.content_hash, idempotency_key: key, inputs,
    } });
    const invoked = await call(proposal, "allowed");
    assert.notEqual(invoked.isError, true, JSON.stringify(invoked));
    const runId = invoked.structuredContent.value.runId;
    const readRun = async id => {
      const response = await client.callTool({ name: "legacy_action_read", arguments: {
        tool: "action_run_get", arguments: { run_id: id },
      } });
      assert.notEqual(response.isError, true, JSON.stringify(response));
      return response.structuredContent.value;
    };
    const result = await until(() => readRun(runId), run => run.state === "succeeded", "installed Action success");
    assert.deepEqual(result.output, { value: "installed-result" }, "The installed MCP endpoint returns the validated program result, not the input.");
    for (const field of ["inputs", "stdout", "stderr", "env", "environment"])
      assert.equal(Object.hasOwn(result, field), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(proof, "utf8")), { value: "installed" });
    assert.equal(consentCount, 1);
    assert.equal((await call(proposal, "bad-input", { value: 7 })).isError, true);
    assert.equal(consentCount, 1, "Invalid inputs must not ask for consent.");
    allowed = false;
    const denied = await call(proposal, "denied", { value: "must-not-run" });
    assert.equal(denied.isError, true);
    assert.match(JSON.stringify(denied), /ACTION_EFFECT_CONSENT_REQUIRED/);
    assert.equal(consentCount, 2);
    assert.deepEqual(JSON.parse(fs.readFileSync(proof, "utf8")), { value: "installed" });

    const inspect = sql => JSON.parse(execFileSync(node, ["-e",
      "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1],{readOnly:true});console.log(JSON.stringify(d.prepare(process.argv[2]).all()));d.close()",
      path.join(workspace, "core.sqlite"), sql], { encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" } }));
    assert.equal(Number(inspect("SELECT count(*) n FROM native_action_automatic_calls")[0].n), 1);
    assert.equal(Number(inspect("SELECT count(*) n FROM action_runtime_runs")[0].n), 1);
    assert.equal(Number(inspect("SELECT count(*) n FROM runtime_process_jobs")[0].n), 1);
    const unsupported = structuredClone(definition);
    unsupported.action_id = "example.installed.protocol";
    unsupported.implementations[0].build = { program: node, args: [], source_files: ["source"], outputs: ["output"] };
    const unsupportedResult = await submit(unsupported);
    assert.equal(unsupportedResult.isError, true);
    assert.match(JSON.stringify(unsupportedResult), /private .pkm-action-sources directory/i);
    const numeric = { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false };
    const pipelineResult = await submit({
      schema: "pkm.action.definition/v1", action_id: "example.installed.pipeline", version: 1,
      description: "Unsupported synthetic pipeline.", input_schema: { type: "object", properties: {}, additionalProperties: false },
      output_schema: numeric, effects: ["pure"],
      implementations: [{ kind: "pipeline", platforms: ["Linux"],
        steps: [{ id: "constant", component: "core.constant", inputs: { value: 1 }, output_schema: numeric }],
        output: { value: { $step: "constant.value" } } }],
    });
    assert.equal(pipelineResult.isError, true);
    assert.match(JSON.stringify(pipelineResult), /explicit JavaScript core.constant, core.math-expression, core.cast and core.lookup/i);
    assert.equal(Number(inspect("SELECT count(*) n FROM native_action_automatic_calls")[0].n), 1);
    assert.equal(Number(inspect("SELECT count(*) n FROM action_runtime_runs")[0].n), 1);
    assert.equal(Number(inspect("SELECT count(*) n FROM runtime_process_jobs")[0].n), 1);

    const sourceDir = path.join(workspace, ".pkm-action-sources");
    const buildDir = path.join(workspace, ".pkm-action-builds");
    fs.mkdirSync(sourceDir, { mode: 0o700 });
    const source = path.join(sourceDir, "installed.c");
    const sourceText = '#include <stdio.h>\nint main(void) { puts("{\\"value\\":\\"compiled-installed\\"}"); return 0; }\n';
    fs.writeFileSync(source, sourceText, { mode: 0o600 });
    const compiler = (process.env.PATH || "").split(path.delimiter).filter(path.isAbsolute)
      .map(directory => path.join(directory, "gcc"))
      .find(candidate => {
        try { fs.accessSync(candidate, fs.constants.X_OK); return fs.statSync(candidate).isFile(); }
        catch { return false; }
      });
    assert.ok(compiler, "The installed Action build test requires an existing GCC; no compiler is installed by PKM.");
    const gcc = fs.realpathSync(compiler);
    const sha256 = value => createHash("sha256").update(value).digest("hex");
    const buildDefinition = structuredClone(definition);
    buildDefinition.action_id = "example.installed.build";
    buildDefinition.description = "Compile a newly authored synthetic Action.";
    buildDefinition.implementations[0] = {
      id: "native", kind: "program", platforms: ["Linux"], program: "${build_dir}/installed", args: [],
      build: { program: gcc, args: [source, "-o", "${build_dir}/installed"],
        source_files: [source], outputs: ["installed"], timeout_seconds: 30 },
    };
    const counters = () => [
      "native_action_automatic_calls", "action_runtime_runs", "action_runtime_receipts", "runtime_process_jobs",
    ].map(table => Number(inspect(`SELECT count(*) n FROM ${table}`)[0].n));
    const beforeBuild = counters();
    const builtProposalResult = await submit(buildDefinition);
    assert.notEqual(builtProposalResult.isError, true, JSON.stringify(builtProposalResult));
    const builtProposal = builtProposalResult.structuredContent.value;
    assert.equal(builtProposal.callable, true);
    assert.deepEqual(counters(), beforeBuild, "Registration must not publish a run or process job.");
    assert.equal(fs.existsSync(buildDir), false, "Registration must not perform a build.");
    let beforeConsent = beforeBuild;
    let buildConsentCount = 0;
    checkBuildConsent = detail => {
      buildConsentCount++;
      const start = detail.indexOf("\n{\n"), end = detail.indexOf("\nRun program:", start);
      assert.ok(start >= 0 && end > start, "The consent dialog must display the full build plan before the run plan.");
      const plan = JSON.parse(detail.slice(start + 1, end));
      assert.equal(plan.compiler, gcc);
      assert.equal(plan.compilerSha256, sha256(fs.readFileSync(gcc)));
      assert.deepEqual(plan.args, buildDefinition.implementations[0].build.args);
      assert.deepEqual(plan.sources, [{ path: source, sha256: sha256(fs.readFileSync(source)) }]);
      assert.deepEqual(plan.outputs, ["installed"]);
      assert.equal(plan.timeoutSeconds, 30);
      assert.equal(plan.runtime, "${build_dir}/installed");
      assert.match(detail, /Run program: \$\{build_dir\}\/installed\nRun arguments: \[\]/);
      assert.match(detail, /Declared effects: local-write/);
      assert.deepEqual(counters(), beforeConsent, "Consent must precede every build/run receipt and job.");
      if (buildConsentCount <= 2) assert.equal(fs.existsSync(buildDir), false, "No build effect may precede consent.");
    };
    allowed = false;
    const buildDenied = await call(builtProposal, "build-denied");
    assert.equal(buildDenied.isError, true);
    assert.match(JSON.stringify(buildDenied), /ACTION_EFFECT_CONSENT_REQUIRED/);
    assert.deepEqual(counters(), beforeBuild);
    assert.equal(fs.existsSync(buildDir), false, "Denied consent must not create build outputs.");
    allowed = true;
    const buildCall = await call(builtProposal, "build-success");
    assert.notEqual(buildCall.isError, true, JSON.stringify(buildCall));
    const buildRun = await until(() => readRun(buildCall.structuredContent.value.runId),
      value => ["succeeded", "failed", "cancelled", "unknown"].includes(value.state), "installed compiled Action", 45000);
    assert.equal(buildRun.state, "succeeded", JSON.stringify(buildRun));
    assert.deepEqual(buildRun.output, { value: "compiled-installed" });
    assert.equal(counters()[3], beforeBuild[3] + 2, "Build and run must be separate durable jobs.");
    assert.equal(buildConsentCount, 2);
    const oldBuilds = fs.readdirSync(buildDir);
    assert.equal(oldBuilds.length, 1);
    assert.ok(fs.statSync(path.join(buildDir, oldBuilds[0], "installed")).isFile());

    fs.writeFileSync(source, "int main( { invalid source\n");
    beforeConsent = counters();
    const badBuildCall = await call(builtProposal, "build-failure");
    assert.notEqual(badBuildCall.isError, true, JSON.stringify(badBuildCall));
    const badBuild = await until(() => readRun(badBuildCall.structuredContent.value.runId),
      value => ["succeeded", "failed", "cancelled", "unknown"].includes(value.state), "installed compiler failure", 45000);
    assert.equal(badBuild.state, "failed", JSON.stringify(badBuild));
    assert.equal(badBuild.nodes[0].reason, "ACTION_BUILD_FAILED");
    assert.equal(Object.hasOwn(badBuild, "output"), false);
    assert.equal(counters()[3], beforeConsent[3] + 1, "Failed compilation must not launch the old executable.");
    const newBuilds = fs.readdirSync(buildDir);
    assert.equal(newBuilds.length, 2, "Each invocation must use a fresh build directory.");
    assert.ok(fs.statSync(path.join(buildDir, oldBuilds[0], "installed")).isFile(),
      "The old executable exists but cannot be reused after compiler failure.");
    assert.equal(buildConsentCount, 3);

    const pure = {
      schema: "pkm.action.definition/v1", action_id: "example.installed.pure", version: 1,
      description: "Synthetic pure calculation.", input_schema: { type: "object", properties: {}, additionalProperties: false },
      output_schema: numeric, effects: ["pure"],
      implementations: [{ kind: "pipeline", platforms: ["Linux"], steps: [
        { id: "left", component: "core.constant", implementation: "javascript", inputs: { value: 2 }, output_schema: numeric },
        { id: "right", component: "core.constant", implementation: "javascript", inputs: { value: 3 }, output_schema: numeric },
        { id: "math", component: "core.math-expression", implementation: "javascript", output_schema: numeric,
          inputs: { expression: "{0} * {1} + 4", input_0: { $step: "left.value" }, input_1: { $step: "right.value" } } },
      ], output: { value: { $step: "math.value" } } }],
    };
    const pureSubmitted = await submit(pure);
    assert.notEqual(pureSubmitted.isError, true, JSON.stringify(pureSubmitted));
    assert.equal(pureSubmitted.structuredContent.value.callable, true);
    const pureCall = await call(pureSubmitted.structuredContent.value, "pure-success", {});
    assert.notEqual(pureCall.isError, true, JSON.stringify(pureCall));
    const pureRun = await until(() => readRun(pureCall.structuredContent.value.runId),
      value => ["succeeded", "failed", "cancelled", "unknown"].includes(value.state), "installed pure pipeline");
    assert.equal(pureRun.state, "succeeded", JSON.stringify(pureRun));
    assert.deepEqual(pureRun.output, { value: 10 });
    assert.equal(Object.hasOwn(pureRun, "inputs"), false);
    console.log("Trial Electron: installed GCC build consent/denial/failure and pure pipeline owned outputs verified");

    fs.writeFileSync(artifactSource, artifactBytes, { flag: "wx", mode: 0o600 });
    const importArtifact = () => client.callTool({ name: "action_artifact_pick_import", arguments: {} });
    allowed = false;
    assert.equal((await importArtifact()).isError, true, "Denied file selection must not admit an artifact.");
    allowed = true;
    const imported = await importArtifact();
    assert.notEqual(imported.isError, true, JSON.stringify(imported));
    artifactId = imported.structuredContent.value.artifact_id;
    assert.match(artifactId, /^artifact_[a-f0-9]{32}$/);
    const { builtinActionDefinitions } = await import(pathToFileURL(
      path.join(extensionPath, "next-runtime/server/dist/domain/action-compiler-validation.js")).href);
    const canonicalCopy = builtinActionDefinitions().get("core.artifact.copy");
    childHash = canonicalCopy.content_hash;
    const copyDefinition = Object.fromEntries(Object.entries(canonicalCopy).filter(([key]) =>
      !["knowledgeId", "source_id", "implementation_hash", "content_hash"].includes(key)));
    const copyRegistration = await submit(copyDefinition);
    assert.notEqual(copyRegistration.isError, true, JSON.stringify(copyRegistration));
    assert.equal(copyRegistration.structuredContent.value.content_hash, childHash);
    const script = "import json,sys\nfrom action_modules import invoke_from_environment\nvalue=json.load(sys.stdin)\nprint(json.dumps(invoke_from_environment('core.artifact.copy',value,'installed-copy')))\n";
    const artifactProgram = {
      schema: "pkm.action.definition/v1", action_id: "example.installed.artifact", version: 1,
      description: "Copy the selected artifact via the pinned nested Action.",
      input_schema: copyDefinition.input_schema, output_schema: copyDefinition.output_schema,
      effects: ["local-read", "local-write"], dependencies: { "core.artifact.copy": childHash },
      implementations: [{ kind: "program", program: "python3", args: ["-c", script], platforms: ["Linux"] }],
    };
    const artifactRegistration = await submit(artifactProgram);
    assert.notEqual(artifactRegistration.isError, true, JSON.stringify(artifactRegistration));
    const artifactCall = await call(artifactRegistration.structuredContent.value, "installed-artifact",
      { source: { artifact_id: artifactId } });
    assert.notEqual(artifactCall.isError, true, JSON.stringify(artifactCall));
    const artifactRun = await until(() => readRun(artifactCall.structuredContent.value.runId),
      value => ["succeeded", "failed", "cancelled", "unknown"].includes(value.state), "installed artifact program");
    assert.equal(artifactRun.state, "succeeded", JSON.stringify(artifactRun));
    const ownedId = artifactRun.output.artifact_id;
    assert.match(ownedId, /^artifact_[a-f0-9]{32}$/);
    assert.notEqual(ownedId, artifactId);
    assert.deepEqual(artifactConsents, ["Allow Action invocation: example.installed.artifact?",
      "Allow Action invocation: core.artifact.copy?"]);
    assert.equal((await client.callTool({ name: "action_artifact_pick_export", arguments: { artifact_id: artifactId } })).isError, true);
    const exported = await client.callTool({ name: "action_artifact_pick_export", arguments: { artifact_id: ownedId } });
    assert.notEqual(exported.isError, true, JSON.stringify(exported));
    assert.deepEqual(fs.readFileSync(artifactDestination), artifactBytes);
    console.log("Trial Electron: installed picker admission → separately approved program and pinned copy → owned export verified");

    allowed = true;
    const slow = structuredClone(definition);
    slow.version = 2;
    slow.implementations[0].args = ["-e", "setTimeout(()=>console.log(JSON.stringify({value:'late'})),30000)"];
    const slowSubmitted = await submit(slow);
    assert.notEqual(slowSubmitted.isError, true, JSON.stringify(slowSubmitted));
    const slowProposal = slowSubmitted.structuredContent.value;
    assert.equal(slowProposal.callable, true);
    assert.notEqual((await call(slowProposal, "active")).isError, true);
    const job = await until(() => inspect("SELECT record_json FROM runtime_process_jobs WHERE state='RUNNING'"),
      rows => rows.some(row => Number.isInteger(JSON.parse(row.record_json).pid)), "active installed Action child");
    const pid = JSON.parse(job.find(row => Number.isInteger(JSON.parse(row.record_json).pid)).record_json).pid;
    const revoked = await client.callTool({ name: "action_trust_revoke", arguments: {} });
    assert.notEqual(revoked.isError, true, JSON.stringify(revoked));
    assert.equal(revoked.structuredContent.value.trustedWorkspace, false);
    assert.equal((await call(slowProposal, "after-revocation")).isError, true);
    assert.equal(Object.hasOwn(await readRun(runId), "output"), false, "Revocation fences result reads.");
    assert.equal((await client.callTool({ name: "action_artifact_pick_export", arguments: { artifact_id: ownedId } })).isError, true,
      "Revocation fences owned artifact export.");
    await until(() => {
      try { process.kill(pid, 0); return false; } catch (error) { return error.code === "ESRCH"; }
    }, stopped => stopped, "revoked Action child exit");
    await client.close();
    client = undefined;
    assert.deepEqual(await serverExit, { code: 0, signal: null }, "Installed Action CLI must drain and exit cleanly.");
    assert.equal(inspect("SELECT closed FROM runtime_process_owner")[0].closed, 1);
    console.log("Trial Electron: installed VS Code authority → bundled MCP CLI → proposal/call/validated-owned-output/consent/revoke/drain verified");
  } finally {
    if (client) await client.close();
    if (serverChild && serverExit) await serverExit;
    vscode.window.showOpenDialog = originalDialog;
    vscode.window.showSaveDialog = originalSaveDialog;
    vscode.window.showWarningMessage = originalWarning;
  }
};

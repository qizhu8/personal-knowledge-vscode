import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const prepared = new WeakMap(), components = new WeakMap();
const releaseSha256 = "1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27";
const hash = value => createHash("sha256").update(value).digest("hex");
const load = (installed, name) => import(pathToFileURL(join(installed, "next-runtime/server/dist", `${name}.js`)).href);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function fail(code) { throw Object.assign(new Error(code), { code }); }
function stateFor(value) {
  const state = prepared.get(value);
  if (!state) fail("INSTALLED_ACTION_ACTUAL_COLD_FIXTURE_REQUIRED");
  return state;
}
async function waitJson(path, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    try {
      const value = JSON.parse(await readFile(path, "utf8"));
      if (value.failed) throw new Error(`Installed Action UI failed: ${value.error}`);
      return value;
    } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    await delay(50);
  }
  throw new Error(`Installed Action evidence timed out: ${path}`);
}
async function enrolled(root, installed) {
  const stat = await lstat(root);
  if (!isAbsolute(root) || resolve(root) !== root || await realpath(root) !== root
    || !/^\.installed-host-[a-f0-9-]{36}$/.test(basename(root)) || !stat.isDirectory() || stat.isSymbolicLink()
    || stat.uid !== process.getuid() || stat.mode & 0o077) fail("INSTALLED_ACTION_PRIVATE_DRIVER_REQUIRED");
  const first = JSON.parse(await readFile(join(root, "native-identity-first.json"), "utf8"));
  const proof = JSON.parse(await readFile(join(root, "native-identity-passed.json"), "utf8"));
  const member = typeof first.result?.path === "string" ? relative(root, first.result.path) : "";
  if (!member || member === ".." || member.startsWith(`..${sep}`) || isAbsolute(member)
    || await realpath(first.result.path) !== first.result.path) fail("INSTALLED_ACTION_ENROLLED_PROFILE_REQUIRED");
  const identity = await load(installed, "original-mcp-native-identity");
  identity.verifyOriginalMcpNativeIdentity(JSON.parse(first.publicRecord), first.result.sha256, first.result.profileSha256);
  assert.equal(await readFile(first.result.path, "utf8"), first.publicRecord);
  assert.equal(proof.passed, true); assert.equal(proof.realInstalledExtension, true);
  assert.equal(proof.identitySha256, first.result.sha256);
  return first;
}
async function originalArchive(path) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) fail("INSTALLED_ACTION_PINNED_ORIGINAL_WRITER_REQUIRED");
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 268435456
    || await realpath(path) !== path || hash(await readFile(path)) !== releaseSha256)
    fail("INSTALLED_ACTION_ORIGINAL_WRITER_CHANGED");
}

/**
 * Whole editor must already be stopped. Register genuine original source before
 * either component B0 or base custody; no native receipt or old effect grant is invented.
 */
export async function prepareInstalledNativeActionFixture(input) {
  return prepareInstalledNativeAction(input, "pipeline");
}
export async function prepareInstalledNativeActionProgramFixture(input) {
  return prepareInstalledNativeAction(input, "program");
}
const originalProgramCode = `let text='';for await(const chunk of process.stdin)text+=chunk;
const input=JSON.parse(text);
if(input.value.startsWith("wait-"))await new Promise(resolve=>setTimeout(resolve,30000));
console.log(JSON.stringify({value:input.value+"-original-program",environmentKeys:Object.keys(process.env).sort()}));`;
async function prepareInstalledNativeAction({ root, installed, componentFixture, legacyVsix }, mode) {
  const recovery = await load(installed, "original-mcp-component-recovery");
  await recovery.assertOriginalMcpColdComponentFixture(componentFixture);
  if (prepared.has(componentFixture)) fail("INSTALLED_ACTION_ALREADY_PREPARED");
  if (await lstat(join(componentFixture.root, ".pkm-next-original-mcp.json")).catch(error => {
    if (error.code === "ENOENT") return null; throw error;
  })) fail("INSTALLED_ACTION_PREPARE_BEFORE_CUSTODY_REQUIRED");
  await originalArchive(legacyVsix);
  const first = await enrolled(root, installed);
  if (mode === "program" && await lstat(join(root, "native-action-program-ui-ready.json")).catch(error => {
    if (error.code === "ENOENT") return null; throw error;
  })) fail("INSTALLED_ACTION_PROGRAM_FRESH_DRIVER_REQUIRED");
  const { ACTION_SOURCE_IDENTITY } = await load(installed, "domain/action-source-identity");
  if (ACTION_SOURCE_IDENTITY.identity !== "compiler-capture-v1")
    fail("INSTALLED_ACTION_EXACT_RELEASE_IDENTITY_REQUIRED");
  const actionId = mode === "program" ? "fixture.installed.native-program" : "fixture.installed.native-pure";
  if (await lstat(join(componentFixture.root, `actions/${actionId}.json`)).catch(error => {
    if (error.code === "ENOENT") return null; throw error;
  })) fail("INSTALLED_ACTION_SOURCE_ALREADY_EXISTS");
  const parent = resolve(fileURLToPath(new URL("../../tests/", import.meta.url)), `.installed-action-writer-${randomUUID()}`);
  await mkdir(parent, { mode: 0o700 });
  let written;
  try {
    // Reuse the independently pinned original-writer oracle and its process/network-denying audit hook.
    // Registration writes real source/admission files only; no old worker is invoked.
    const writer = pathToFileURL(fileURLToPath(new URL("../../tests/legacy-action-original-fixture.mjs", import.meta.url))).href;
    const node = await realpath(process.execPath);
    const authored = mode === "program" ? {
      schema: "pkm.action.definition/v1", action_id: actionId, version: 1,
      description: "Disposable pinned original local Node program. No shell, model, network, credentials or descendants.",
      input_schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
      output_schema: { type: "object", properties: { value: { type: "string" },
        environmentKeys: { type: "array", items: { type: "string" }, maxItems: 0 } },
      required: ["value", "environmentKeys"], additionalProperties: false },
      effects: ["pure"], dependencies: {},
      implementations: [{ id: "native", kind: "program", platforms: ["Linux"], program: node, args: ["-e", originalProgramCode] }],
      examples: [{ inputs: { value: "installed" }, output: { value: "installed-original-program", environmentKeys: [] } }],
    } : {
      schema: "pkm.action.definition/v1", action_id: actionId, version: 1,
      description: "Disposable installed native Action business effect; no process or model.",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
      output_schema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false },
      effects: ["pure"], dependencies: {},
      implementations: [{ id: "native", kind: "pipeline", platforms: ["Linux"],
        steps: [{ id: "number", component: "core.constant", implementation: "javascript", inputs: { value: 41 } }],
        output: { value: { $step: "number.value" } } }],
      examples: [{ inputs: {}, output: { value: 41 } }],
    };
    const script = `
import assert from "node:assert/strict";
import { originalActionFixture } from ${JSON.stringify(writer)};
const [parent,root,pins,definition] = process.argv.slice(1);
const result=originalActionFixture(parent).json(\`
import hashlib,json,sys
from pathlib import Path
resources=Path(sys.argv[1])
pins=json.loads(sys.argv[3])
actual={name:hashlib.sha256((resources.parent/name).read_bytes()).hexdigest() for name in pins}
assert actual==pins,"Exact original writer/source identity is required"
sys.path.insert(0,str(resources))
from action_modules import ModuleRuntime
runtime=ModuleRuntime(sys.argv[2])
definition=runtime.register(json.loads(sys.argv[4]))
print(json.dumps({"definition":definition,"writerSourceHashes":actual}))
\`,[root,pins,definition]);
assert.equal(result.definition.action_id,JSON.parse(definition).action_id);
console.log(JSON.stringify(result));
`;
    written = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script, parent,
      componentFixture.root, JSON.stringify(ACTION_SOURCE_IDENTITY.sourceHashes), JSON.stringify(authored)], {
      encoding: "utf8", timeout: 45000, maxBuffer: 1048576, cwd: parent,
      env: { ...process.env, PKM_LEGACY_VSIX: legacyVsix, PKM_ACTION_SOURCE_IDENTITY: ACTION_SOURCE_IDENTITY.identity,
        TMPDIR: parent, PYTHONDONTWRITEBYTECODE: "1" },
    }));
    await originalArchive(legacyVsix);
  } finally { await rm(parent, { recursive: true, force: true }); }
  const { readActionCompiler } = await load(installed, "action-compiler");
  const { portableActionDefinition } = await load(installed, "domain/action-compiler-validation");
  const definitionPath = `actions/${written.definition.action_id}.json`;
  const bytes = await readFile(join(componentFixture.root, definitionPath));
  const member = `definitions/${written.definition.action_id}.json`;
  const { originalDigest } = await load(installed, "domain/action-compiler-validation");
  const unsigned = { schema: "pkm.action.module-set/v1", module_set_id: "fixture.installed.original-registry",
    version: 1, name: "Original registry identity check", actions: [written.definition.action_id],
    files: { [member]: hash(bytes) }, resources: {}, provenance: { authority: "none; compiler check only" } };
  const compiled = readActionCompiler({ operation: "action.definition.compile", args: { source: {
    kind: "moduleSet", enabled: true, manifest: { ...unsigned, package_hash: originalDigest(unsigned) },
    files: { [member]: bytes.toString("utf8") },
  } } });
  if (mode === "program" && compiled.status !== "valid")
    throw Object.assign(new Error(`INSTALLED_ACTION_PROGRAM_COMPILER_BLOCKED: ${JSON.stringify(compiled)}`),
      { code: "INSTALLED_ACTION_PROGRAM_COMPILER_BLOCKED" });
  assert.equal(compiled.status, "valid", JSON.stringify(compiled));
  assert.equal(compiled.definitionDigest, written.definition.content_hash,
    "Original identities must compile without modifying source, hashes, or the candidate compiler identity.");
  assert.deepEqual(portableActionDefinition(compiled.definition), portableActionDefinition(written.definition));
  let program;
  if (mode === "program") {
    const executable = await realpath(process.execPath);
    const contextPath = "action-sources/installed-native-program", assetPath = `${contextPath}/capsule.txt`;
    await mkdir(join(componentFixture.root, contextPath), { recursive: true, mode: 0o700 });
    const asset = Buffer.from("Exact independently backed installed local-program execution context.\n");
    await writeFile(join(componentFixture.root, assetPath), asset, { mode: 0o600, flag: "wx" });
    const executableSha256 = hash(await readFile(executable));
    program = { contextPath, assetPath, asset, executable, executableSha256 };
  }
  const value = Object.freeze({ kind: mode === "program" ? "pkm.installed-native-action-program-fixture/v1" : "pkm.installed-native-action-fixture/v1",
    root: componentFixture.root,
    profileSha256: first.result.profileSha256, identitySha256: first.result.sha256,
    sourceIdentity: ACTION_SOURCE_IDENTITY.identity, originalWriterSha256: releaseSha256,
    definitionPath, definitionSha256: hash(bytes), actionId: written.definition.action_id,
    contentHash: written.definition.content_hash, implementationSha256: originalDigest(written.definition.implementations[0]),
    ...(program ? { executableSha256: program.executableSha256, contextPath: program.contextPath } : {}) });
  const state = { value, componentFixture, driverRoot: root, installed, first, bytes, definition: written.definition,
    writerSourceHashes: written.writerSourceHashes, phase: "prepared", closing: undefined, lifetime: new AbortController(),
    mode, program };
  prepared.set(componentFixture, state); prepared.set(value, state);
  return value;
}

/** Call under the same actual cold writer fence after base custody and before editor restart/openRoot. */
export async function captureInstalledNativeActionCustody({ sourceFixture, custody, writerFence }) {
  const state = stateFor(sourceFixture);
  if (state.phase !== "prepared") fail("INSTALLED_ACTION_CUSTODY_ORDER_REQUIRED");
  const recovery = await load(state.installed, "original-mcp-component-recovery");
  await recovery.assertOriginalMcpColdComponentFixture(state.componentFixture);
  if (custody.root !== sourceFixture.root || custody.profileSha256 !== sourceFixture.profileSha256)
    fail("INSTALLED_ACTION_SEALED_PROFILE_MISMATCH");
  const domain = await load(state.installed, "original-mcp-action-domain");
  const result = await domain.captureOriginalMcpActionCustody(custody, {
    backup: join(state.componentFixture.directory, "action-custody"),
    selection: { definitions: [{ path: sourceFixture.definitionPath, sha256: sourceFixture.definitionSha256 }],
      moduleSets: [], assets: state.program ? [{ path: state.program.assetPath, sha256: hash(state.program.asset) }] : [],
      toolchains: state.program ? [{ path: state.program.executable, sha256: state.program.executableSha256, role: "runtime" }] : [],
      selections: [{ actionId: sourceFixture.actionId, implementationId: "native", sourcePath: sourceFixture.definitionPath }],
      runIds: [], stateFiles: [] },
  }, { writerFence });
  assert.equal(result.profileSha256, sourceFixture.profileSha256);
  assert.equal(result.sourceIdentity, sourceFixture.sourceIdentity);
  assert.equal(result.toolchains.length, state.program ? 1 : 0);
  if (state.program) assert.equal(result.toolchains[0].sha256, state.program.executableSha256);
  state.custody = result; state.baseCustody = custody; state.phase = "captured";
  return result;
}

/**
 * Fixed Action-specific alternative to the existing disposable cold bootstrap.
 * Parent selects it before restarting the editor; no shared Core/activation change
 * or caller-owned native policy, transport, identity callback, or engine is accepted.
 */
export async function bootstrapInstalledNativeActionComponent({ sourceFixture, operatorId, limits, attachment,
  python, env, port, payloadBuildId, timeoutMs = 120000 }) {
  const state = stateFor(sourceFixture), installed = state.installed, fixture = state.componentFixture;
  if (state.phase !== "prepared") fail("INSTALLED_ACTION_PREPARE_BEFORE_CUSTODY_REQUIRED");
  if (attachment?.identitySha256 !== sourceFixture.identitySha256
    || attachment?.identity?.profileSha256 !== sourceFixture.profileSha256
    || attachment?.payloadBuildId !== payloadBuildId)
    fail("INSTALLED_ACTION_ENROLLED_ATTACHMENT_REQUIRED");
  const rootApi = await load(installed, "original-mcp-root");
  const recovery = await load(installed, "original-mcp-component-recovery");
  const attachmentApi = await load(installed, "original-mcp-native-attachment");
  const requests = await load(installed, "original-mcp-native-request");
  const hosts = await load(installed, "original-mcp-native-host");
  const sourcePoliciesApi = await load(installed, "original-mcp-native-source-policy");
  await recovery.assertOriginalMcpColdComponentFixture(fixture);
  const fence = await rootApi.acquireOriginalMcpRootFence(fixture.root);
  let opened, server, host, backend, sourcePolicies, completion, closing;
  let closed = false, shutdownConfirmed = false;
  const pending = new Set(), actor = Object.freeze({ id: "mcp:external", canWrite: true });
  try {
    const b0 = await recovery.captureOriginalMcpComponentB0(fixture, limits, fence);
    const custody = await rootApi.captureOriginalMcpCustody({
      root: fixture.root, backup: join(fixture.directory, "custody"), operatorId,
      profileSha256: sourceFixture.profileSha256, limits,
    }, { writerFence: fence });
    await captureInstalledNativeActionCustody({ sourceFixture, custody, writerFence: fence });
    opened = await rootApi.openOriginalMcpRoot(custody, { writerFence: fence, prepareNative: async storage => {
      if (!server) fail("INSTALLED_ACTION_PRIVATE_ATTACHMENT_REQUIRED");
      const session = await server.waitForSession({ timeoutMs: 300000 });
      await requests.waitForOriginalMcpNativeSupport(session, { timeoutMs: 120000 });
      host = await hosts.createOriginalMcpNativeHost(storage, requests.createOriginalMcpNativeRequestPolicy(session));
      sourcePolicies = sourcePoliciesApi.createOriginalMcpNativeSourcePolicies(storage, host, session);
      const action = await composeInstalledNativeActionFixture({ sourceFixture, storage, host, session,
        python, env, port, payloadBuildId, timeoutMs });
      return { ...action, authorizeTool: host.options.authorizeTool };
    } });
    const source = await load(installed, "native-public-original-mcp-contracts");
    const contracts = source.originalPublicMcpContracts();
    server = await attachmentApi.startOriginalMcpNativeAttachmentServer({
      directory: attachment.directory, identity: attachment.identity, identitySha256: attachment.identitySha256,
      maxPacketBytes: 65536, binding: { root: fixture.root, workspaceId: opened.workspaceId,
        planSha256: custody.planSha256, profileSha256: sourceFixture.profileSha256,
        catalogSha256: contracts.provenance.metadataSha256, payloadBuildId,
        hostEntrySha256: attachment.hostEntrySha256 },
    });
    const actual = opened, tools = ["get_note", "get_skill", "add_note", "update_note", "add_skill", "update_skill"];
    const component = Object.freeze({
      kind: "pkm.installed-native-action-cold-component/v1", fixture, b0, custody,
      root: actual.root, workspaceId: actual.workspaceId, planSha256: actual.planSha256, journalSha256: actual.journalSha256,
      owner: actual.owner, storage: actual.storage, businessReady: false, fullCutoverQualified: false,
      attachmentDescriptorPath: server.descriptorPath, attachmentDescriptorSha256: server.descriptorSha256,
      complete() {
        if (closed) fail("INSTALLED_ACTION_COMPONENT_CLOSED");
        return completion ??= (async () => {
          const full = await actual.owner.ensureFull();
          if (closed || !host || full.storage !== actual.storage) fail("INSTALLED_ACTION_SAME_OWNER_COMPOSITION_REQUIRED");
          host.assertCurrent();
          const { createLegacyNoteBackend } = await load(installed, "legacy-note-mcp");
          const { createOriginalMcpPublicDispatcher } = await load(installed, "original-mcp-public");
          backend = await createOriginalMcpPublicDispatcher(actual.owner, actor, host,
            createLegacyNoteBackend(actual.storage, { core: full.runtime.core, actor }));
          return host;
        })();
      },
      sourcePolicies() {
        if (closed || !backend || !host || !sourcePolicies) fail("INSTALLED_ACTION_SOURCE_POLICIES_UNAVAILABLE");
        host.assertCurrent(); sourcePolicies.assertCurrent(); return sourcePolicies;
      },
      async invoke(tool, args, signal) {
        if (closed || !backend || !host) fail("INSTALLED_ACTION_COMPONENT_CLOSED");
        if (!tools.includes(tool)) fail("INSTALLED_ACTION_PUBLIC_TOOL_OUTSIDE_COMPONENT");
        host.assertCurrent();
        const request = backend.invoke({ tool, arguments: args }, signal);
        pending.add(request);
        try { return await request; } finally { pending.delete(request); }
      },
      close() {
        closed = true;
        return closing ??= (async () => {
          const failures = [];
          for (const work of [() => closeInstalledNativeActionFixture(sourceFixture), () => server.close(),
            () => Promise.allSettled([...pending, ...(completion ? [completion] : [])]), () => actual.owner.close()])
            try { await work(); } catch (error) { failures.push(error); }
          if (failures.length) throw new AggregateError(failures, "Installed Action component shutdown incomplete; preserve all evidence.");
          shutdownConfirmed = true;
        })().catch(error => { closing = undefined; throw error; });
      },
    });
    components.set(component, { state, closed: () => shutdownConfirmed });
    return component;
  } catch (error) {
    const failures = [error];
    for (const work of [() => closeInstalledNativeActionFixture(sourceFixture), () => server?.close(),
      () => opened ? opened.owner.close() : fence.release()])
      try { await work(); } catch (cleanup) { failures.push(cleanup); }
    if (failures.length > 1) throw new AggregateError(failures, "Installed Action cold bootstrap/cleanup failed.");
    throw error;
  }
}

/** Unchanged real cold guards verify whole-editor exit again; serialized wrappers confer nothing. */
export async function preserveInstalledNativeActionB1(component) {
  const actual = components.get(component);
  if (!actual?.closed() || !actual.state.evidence || !actual.state.closed)
    fail("INSTALLED_ACTION_CONFIRMED_EFFECTS_AND_CLOSE_REQUIRED");
  const recovery = await load(actual.state.installed, "original-mcp-component-recovery");
  return recovery.preserveOriginalMcpComponentB1(actual.state.componentFixture);
}

const actionUi = String.raw`
import hashlib,json,sys,time
from pathlib import Path
from playwright.sync_api import sync_playwright
f=json.loads(sys.argv[1]);root=Path(f["root"]);deadline_seconds=f["timeoutMs"]/1000
def wait_stage(name):
    until=time.monotonic()+deadline_seconds
    while time.monotonic()<until:
        try:
            progress=json.loads((root/"progress.json").read_text())
            if progress.get("stage")=="failed":raise RuntimeError(str(progress))
            if progress.get("stage")==name:return
        except (FileNotFoundError,json.JSONDecodeError):pass
        time.sleep(.05)
    raise RuntimeError("Action UI stage timed out: "+name)
try:
    with sync_playwright() as p:
        browser=p.chromium.connect_over_cdp("http://127.0.0.1:"+str(f["port"]))
        page=next(page for context in browser.contexts for page in context.pages if "workbench" in page.url)
        (root/"native-action-business-ui-ready.json").write_text('{"ready":true,"actualRenderer":true}')
        dialogs=[]
        def consent(title,button,exact):
            dialog=page.locator(".monaco-dialog-box")
            dialog.get_by_role("button",name=button,exact=True).wait_for(state="visible",timeout=f["timeoutMs"])
            text=dialog.inner_text()
            assert title in text,"Wrong native Action dialog: "+text[:500]
            for identity in exact:assert identity in text,"Native Action dialog omitted exact identity: "+identity
            dialogs.append({"title":title,"choice":button,"textSha256":hashlib.sha256(text.encode()).hexdigest(),
                            "exactIdentityVisible":True})
            dialog.get_by_role("button",name=button,exact=True).click()
        wait_stage("native-business-action-enable")
        page.keyboard.press("Control+Shift+P")
        widget=page.locator(".quick-input-widget")
        widget.wait_for(state="visible",timeout=f["timeoutMs"])
        widget.locator("input").first.fill(">pkm-v5 (Experimental): Enable Separate Native Action Approvals")
        command=widget.locator(".monaco-list-row").filter(has_text="Enable Separate Native Action Approvals").first
        command.wait_for(state="visible",timeout=f["timeoutMs"]);command.click()
        consent("Enable separate native Action approvals","Approve this exact Action request",[f["sourceRoot"],f["profileSha256"]])
        page.locator(".statusbar-item").filter(has_text="PKM Action approvals").wait_for(state="visible",timeout=f["timeoutMs"])
        (root/"native-action-business-enabled.json").write_text('{"enabled":true,"actualNativeUi":true}')
        for stage,button in [("native-business-action-source-deny","Deny"),
                             ("native-business-action-source-admit","Approve this exact Action request")]:
            wait_stage(stage)
            consent("Admit this exact original Action source/state capsule",button,
                    [f["sourceRoot"],f["profileSha256"],f["capsuleSha256"],f["actionId"],f["contentHash"],'"noExecution": true'])
        for stage,button in [("native-business-action-call-deny","Deny"),
                             ("native-business-action-call-admit","Approve this exact Action request")]:
            wait_stage(stage)
            consent("action_call","Approve this request",[f["sourceRoot"],f["actionId"],f["contentHash"]])
            consent("Execute this exact admitted native Action invocation",button,
                    [f["sourceRoot"],f["profileSha256"],f["capsuleSha256"],f["actionId"],f["contentHash"],
                     '"automaticReplay": false','"inputs": {}'])
        wait_stage("native-business-action-call-reuse")
        consent("action_call","Approve this request",[f["sourceRoot"],f["actionId"],f["contentHash"]])
        wait_stage("native-business-action-revoke")
        item=page.locator(".statusbar-item").filter(has_text="PKM Action approvals")
        assert item.count()==1,"Exactly one native Action approval status indicator is required"
        item.hover()
        hover=page.locator(".monaco-hover").filter(has_text="Revoke native Action approvals")
        hover.wait_for(state="visible",timeout=f["timeoutMs"])
        tooltip=hover.inner_text()
        assert f["sourceRoot"] in tooltip and f["profileSha256"] in tooltip
        item.click();item.wait_for(state="hidden",timeout=f["timeoutMs"])
        (root/"native-action-business-revoked.json").write_text('{"revoked":true,"actualNativeUi":true}')
        wait_stage("native-business-action-revoked-call")
        consent("action_call","Approve this request",[f["sourceRoot"],f["actionId"],f["contentHash"]])
        wait_stage("native-business-action-complete")
        (root/"native-action-business-ui-passed.json").write_text(json.dumps({"passed":True,"actualNativeUi":True,
            "dialogs":dialogs,"exactRootProfileTooltipVisible":True,"statusBarClicked":True}))
except Exception as error:
    (root/"native-action-business-ui-passed.json").write_text(json.dumps({"failed":True,"error":str(error)}))
    raise
`;
export const installedNativeActionUiScript = actionUi;
const programUi = String.raw`
import hashlib,json,sys,time
from pathlib import Path
from playwright.sync_api import sync_playwright
f=json.loads(sys.argv[1]);root=Path(f["root"]);prefix=f["prefix"]
def evidence(name,value):
    (root/(prefix+"-"+name+".json")).write_text(json.dumps(value))
def wait_stage(name):
    deadline=time.monotonic()+f["timeoutMs"]/1000
    while time.monotonic()<deadline:
        try:
            progress=json.loads((root/"progress.json").read_text())
            if progress.get("stage")=="failed":raise RuntimeError(str(progress))
            if progress.get("stage")==name:return progress
        except (FileNotFoundError,json.JSONDecodeError):pass
        time.sleep(.05)
    raise RuntimeError("Program UI stage timed out: "+name)
try:
    with sync_playwright() as p:
        browser=p.chromium.connect_over_cdp("http://127.0.0.1:"+str(f["port"]))
        page=next(page for context in browser.contexts for page in context.pages if "workbench" in page.url)
        evidence("ui-ready",{"ready":True,"actualRenderer":True})
        dialogs=[]
        def consent(title,button,exact):
            dialog=page.locator(".monaco-dialog-box")
            dialog.get_by_role("button",name=button,exact=True).wait_for(state="visible",timeout=f["timeoutMs"])
            text=dialog.inner_text()
            assert title in text,"Wrong native local-program dialog: "+text[:500]
            for identity in exact:assert identity in text,"Native program dialog omitted exact identity: "+identity
            dialogs.append({"title":title,"choice":button,"textSha256":hashlib.sha256(text.encode()).hexdigest(),
                            "exactIdentityVisible":True})
            dialog.get_by_role("button",name=button,exact=True).click()
        common=[f["sourceRoot"],f["profileSha256"],f["capsuleSha256"],f["actionId"],f["contentHash"]]
        def public_call(button="Approve this request"):
            consent("action_call",button,[f["sourceRoot"],f["actionId"],f["contentHash"]])
        def program(button):
            consent("Run this exact pinned local Action program",button,common+
                    [f["executable"],f["executableSha256"],f["cwd"],"exact-local-direct-child/v1",
                     '"inheritedEnvironment": false','"credentials": false','"network": false','"automaticReplay": false'])
        wait_stage("native-business-program-enable")
        page.keyboard.press("Control+Shift+P")
        widget=page.locator(".quick-input-widget")
        widget.wait_for(state="visible",timeout=f["timeoutMs"])
        widget.locator("input").first.fill(">pkm-v5 (Experimental): Enable Separate Native Action Approvals")
        command=widget.locator(".monaco-list-row").filter(has_text="Enable Separate Native Action Approvals").first
        command.wait_for(state="visible",timeout=f["timeoutMs"]);command.click()
        consent("Enable separate native Action approvals","Approve this exact Action request",[f["sourceRoot"],f["profileSha256"]])
        page.locator(".statusbar-item").filter(has_text="PKM Action approvals").wait_for(state="visible",timeout=f["timeoutMs"])
        evidence("enabled",{"enabled":True,"actualNativeUi":True})
        for stage,button in [("native-business-program-source-deny","Deny"),
                             ("native-business-program-source-admit","Approve this exact Action request")]:
            wait_stage(stage)
            consent("Admit this exact original Action source/state capsule",button,common+['"noExecution": true'])
        wait_stage("native-business-program-public-deny");public_call("Deny")
        wait_stage("native-business-program-consent-deny");public_call();program("Deny")
        wait_stage("native-business-program-run");public_call();program("Run this exact local program")
        wait_stage("native-business-program-reuse");public_call()
        wait_stage("native-business-program-cancel-run");public_call();program("Run this exact local program")
        cancel=wait_stage("native-business-program-cancel")
        consent("action_run_cancel","Approve this request",[f["sourceRoot"],cancel["runId"]])
        wait_stage("native-business-program-cancel-reuse");public_call()
        wait_stage("native-business-program-revoke-run");public_call();program("Run this exact local program")
        wait_stage("native-business-program-revoke")
        item=page.locator(".statusbar-item").filter(has_text="PKM Action approvals")
        assert item.count()==1,"Exactly one native Action approval indicator is required"
        item.hover()
        hover=page.locator(".monaco-hover").filter(has_text="Revoke native Action approvals")
        hover.wait_for(state="visible",timeout=f["timeoutMs"])
        tooltip=hover.inner_text()
        assert f["sourceRoot"] in tooltip and f["profileSha256"] in tooltip
        item.click();item.wait_for(state="hidden",timeout=f["timeoutMs"])
        evidence("revoked",{"revoked":True,"actualNativeUi":True})
        wait_stage("native-business-program-revoked-call");public_call()
        wait_stage("native-business-program-complete")
        evidence("ui-passed",{"passed":True,"actualNativeUi":True,"dialogs":dialogs,
            "exactToolchainContextVisible":True,"separateProgramDecision":True,"statusBarClicked":True})
except Exception as error:
    evidence("ui-passed",{"failed":True,"error":str(error)})
    raise
`;
export const installedNativeActionProgramUiScript = programUi;
async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const stopped = new Promise(resolve => child.once("exit", resolve));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try { await stopped; } finally { clearTimeout(timer); }
}

/**
 * Parent prepareNative(actualStorage), after actual signed host admission and before
 * that owner's Action engine exists. No session/host/storage callbacks are accepted.
 */
export async function composeInstalledNativeActionFixture({ sourceFixture, storage, host, session,
  python, env, port, payloadBuildId, timeoutMs = 120000 }) {
  const state = stateFor(sourceFixture);
  if (state.phase !== "captured") fail("INSTALLED_ACTION_COLD_CUSTODY_REQUIRED");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 1 || timeoutMs > 120000) fail("INSTALLED_ACTION_DRIVER_LIMITS_REQUIRED");
  const installed = state.installed, first = await enrolled(state.driverRoot, installed);
  const attachment = await load(installed, "original-mcp-native-attachment");
  attachment.assertAuthenticatedOriginalMcpNativeSession(session);
  const nativeHost = await load(installed, "original-mcp-native-host");
  nativeHost.assertOriginalMcpNativeHost(host, storage);
  assert.equal(storage.workspaceRoot(), sourceFixture.root);
  assert.equal(session.identitySha256, first.result.sha256);
  assert.equal(session.binding.root, sourceFixture.root);
  assert.equal(session.binding.planSha256, state.baseCustody.planSha256);
  assert.equal(session.binding.profileSha256, sourceFixture.profileSha256);
  assert.equal(session.binding.payloadBuildId, payloadBuildId);
  assert.equal(session.binding.hostEntrySha256, hash(await readFile(join(installed, "dist/extension.cjs"))));
  assert.equal(session.activationId, host.receipt.epoch);
  assert.equal(host.receipt.profileSha256, state.baseCustody.profileSha256);
  if (state.program) {
    const requests = await load(installed, "original-mcp-native-request");
    const supported = await requests.waitForOriginalMcpNativeSupport(session, { timeoutMs, signal: state.lifetime.signal });
    assert(supported.includes("action.program.approve"), "The actual installed producer must advertise separate program consent.");
  }
  const domain = await load(installed, "original-mcp-action-domain");
  const authorityApi = await load(installed, "original-mcp-native-action-authority");
  await domain.declareOriginalMcpActionNativeFootprint(storage, state.custody);
  const authority = await authorityApi.startOriginalMcpNativeActionAuthority(storage, host, session, state.custody);
  state.authority = authority; state.storage = storage; state.host = host; state.session = session;
  state.uiPrefix = state.program ? "native-action-program" : "native-action-business";
  const settings = { root: state.driverRoot, port, timeoutMs, sourceRoot: sourceFixture.root,
    profileSha256: sourceFixture.profileSha256, capsuleSha256: state.custody.capsuleSha256,
    actionId: sourceFixture.actionId, contentHash: sourceFixture.contentHash,
    ...(state.program ? { prefix: state.uiPrefix, executable: state.program.executable,
      executableSha256: state.program.executableSha256, cwd: join(sourceFixture.root, state.program.contextPath) } : {}) };
  const ui = spawn(python, ["-B", "-c", state.program ? programUi : actionUi, JSON.stringify(settings)], { env, stdio: "inherit" });
  state.ui = ui; state.timeoutMs = timeoutMs; state.payloadBuildId = payloadBuildId;
  state.uiDone = new Promise((resolve, reject) => {
    ui.once("error", reject);
    ui.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`Installed Action UI exited ${code}/${signal}`)));
  });
  void state.uiDone.catch(error => { state.uiError = error; });
  try {
    await waitJson(join(state.driverRoot, `${state.uiPrefix}-ui-ready.json`), timeoutMs, state.lifetime.signal);
    await writeFile(join(state.driverRoot, "progress.json"),
      JSON.stringify({ stage: state.program ? "native-business-program-enable" : "native-business-action-enable" }), { mode: 0o600 });
    await waitJson(join(state.driverRoot, `${state.uiPrefix}-enabled.json`), timeoutMs, state.lifetime.signal);
    const policy = await domain.createOriginalMcpActionNativePolicy(storage, host, state.custody, { nativeAuthority: authority,
      ...(state.program ? { localPrograms: [{ actionId: sourceFixture.actionId, cwd: state.program.contextPath }] } : {}) });
    if (state.program) {
      if (policy.options.hostServices.action.process?.commands.length !== 1)
        fail("INSTALLED_ACTION_PROGRAM_COMPOSITION_REQUIRED");
      assert.equal(policy.options.hostServices.action.process.commands[0].program, state.definition.implementations[0].program);
    }
    state.policy = policy; state.phase = "composed";
    return policy.options;
  } catch (error) {
    await stopChild(ui); await authority.close(); throw error;
  }
}

/** After the real owner/host completes. Use before another domain closes the signed session. */
export async function verifyInstalledNativeAction({ sourceFixture, component }) {
  const state = stateFor(sourceFixture);
  if (state.program) fail("INSTALLED_ACTION_PROGRAM_VERIFIER_REQUIRED");
  if (state.phase !== "composed" || component.fixture !== state.componentFixture
    || component.root !== sourceFixture.root || component.storage !== state.storage)
    fail("INSTALLED_ACTION_SAME_OWNER_COMPOSITION_REQUIRED");
  assert.equal(await component.complete(), state.host);
  const { assertRootOwner } = await load(state.installed, "root-owner");
  assertRootOwner(component.owner);
  const full = await component.owner.ensureFull(), lease = { ...component.owner.workspaceLease() };
  assert.equal(full.storage, state.storage);
  const domain = await load(state.installed, "original-mcp-action-domain");
  const action = await load(state.installed, "original-mcp-action-runtime");
  const adapter = await action.createOriginalMcpActionRuntime(component.owner, { id: "mcp:external", canWrite: true }, state.host);
  state.adapter = adapter;
  const call = async (tool, args = {}) => (await adapter.invoke(tool, args)).structuredContent;
  const progress = stage => writeFile(join(state.driverRoot, "progress.json"), JSON.stringify({ stage }), { mode: 0o600 });
  const counts = () => {
    const db = state.storage.connectNative();
    try { return { runs: db.prepare("SELECT count(*) n FROM action_runtime_runs").get().n,
      processes: db.prepare("SELECT count(*) n FROM runtime_process_jobs").get().n }; }
    finally { db.close(); }
  };
  const unchanged = async () => assert.deepEqual(await readFile(join(component.root, sourceFixture.definitionPath)), state.bytes);
  await assert.rejects(call("action_get", { action_id: sourceFixture.actionId }), /ORIGINAL_ACTION_SOURCE_ADMISSION_REQUIRED/);
  await progress("native-business-action-source-deny");
  await assert.rejects(domain.admitOriginalMcpActionDomain(component.owner, { id: "mcp:external", canWrite: true },
    state.host, state.policy), /ACTION_SOURCE_ADMISSION_RPC_REQUIRED/);
  assert.equal(domain.originalMcpActionSourceIsAdmitted(state.storage, sourceFixture.actionId), false);
  await unchanged();
  await progress("native-business-action-source-admit");
  const admitted = await domain.admitOriginalMcpActionDomain(component.owner, { id: "mcp:external", canWrite: true }, state.host, state.policy);
  assert.equal(admitted.capsuleSha256, state.custody.capsuleSha256);
  assert.equal(admitted.automaticReplay, false);
  const args = { action_id: sourceFixture.actionId, content_hash: sourceFixture.contentHash, inputs: {}, idempotency_key: "installed-pure-action" };
  await progress("native-business-action-call-deny");
  await assert.rejects(call("action_call", args), /ACTION_EFFECT_CONSENT_REQUIRED/);
  assert.deepEqual(counts(), { runs: 0, processes: 0 });
  await progress("native-business-action-call-admit");
  const created = await call("action_call", args);
  let completed;
  for (let attempt = 0; attempt < 400; attempt++) {
    completed = await call("action_run_get", { run_id: created.run_id });
    if (completed.state === "succeeded") break;
    if (state.uiError) throw state.uiError;
    await delay(25);
  }
  assert.equal(completed.state, "succeeded");
  assert.deepEqual(completed.output, { value: 41 });
  assert.equal(created.launch_reused, false);
  await progress("native-business-action-call-reuse");
  const reused = await call("action_call", args);
  assert.equal(reused.run_id, created.run_id); assert.equal(reused.launch_reused, true);
  assert.deepEqual(counts(), { runs: 1, processes: 0 });
  await progress("native-business-action-revoke");
  await waitJson(join(state.driverRoot, "native-action-business-revoked.json"), state.timeoutMs, state.lifetime.signal);
  const { createVscodeActionTrustBridge } = await load(state.installed, "vscode-action-trust-bridge");
  const probe = createVscodeActionTrustBridge({ workspaceRoot: component.root, workspaceId: component.workspaceId,
    actorId: "mcp:external", nativeEndpoint: true });
  try { assert.equal((await probe.refresh()).trustedWorkspace, false); } finally { await probe.close(); }
  await progress("native-business-action-revoked-call");
  await assert.rejects(call("action_call", { ...args, idempotency_key: "must-not-run-after-native-revoke" }), /ACTION_NATIVE_TRUST_REQUIRED/);
  assert.deepEqual(counts(), { runs: 1, processes: 0 });
  state.host.assertCurrent();
  assert.equal(state.host.signal.aborted, false, "Action revocation is independent of model/public/native session grants.");
  assert.equal((await component.owner.ensureFull()).runtime.core, full.runtime.core);
  assert.deepEqual(component.owner.workspaceLease(), lease); await unchanged();
  await progress("native-business-action-complete");
  const ui = await waitJson(join(state.driverRoot, "native-action-business-ui-passed.json"), state.timeoutMs, state.lifetime.signal);
  await state.uiDone;
  assert.equal(ui.actualNativeUi, true);
  const receipt = domain.verifyOriginalMcpActionDomain(state.storage);
  const evidence = { passed: true, scope: "new disposable installed Action business fixture only; not full native-engine qualification",
    profileSha256: sourceFixture.profileSha256, identitySha256: sourceFixture.identitySha256,
    custodyPlanSha256: state.baseCustody.planSha256, actionCapsuleSha256: state.custody.capsuleSha256,
    sourceIdentity: sourceFixture.sourceIdentity, originalWriterSha256: releaseSha256,
    definitionSha256: sourceFixture.definitionSha256, nativeHostReceiptSha256: state.host.receipt.receiptSha256,
    actionDomainReceiptSha256: receipt.receiptSha256, nativeEpoch: state.host.receipt.epoch,
    installedPayloadBuildId: state.payloadBuildId, actionId: sourceFixture.actionId, contentHash: sourceFixture.contentHash,
    runId: created.run_id, output: completed.output, sameRootOwnerAndCachedCore: true,
    actualNativeUi: ui, sourceDenialNoAdmission: true, separateInvocationDenialNoRun: true,
    actualPurePipelineEffect: true, idempotentRunReused: true, statusBarRevocationDeniedNewEffect: true,
    independentSignedSessionPreserved: true, externalProcessJobs: 0, originalSourceBytesUnchanged: true,
    noExternalToolchainRequired: true, modelChannelRequired: false, checkpointExecutionQualified: false,
    b1RootClosureQualified: false, fullCutoverQualified: false, actualProfileOrKeyringQualified: false };
  state.evidence = evidence; state.phase = "verified";
  await writeFile(join(state.driverRoot, "native-action-business-passed.json"), JSON.stringify(evidence), { mode: 0o600, flag: "wx" });
  return evidence;
}

/** Same real cold component; program selection comes only from branded pre-B0 preparation. */
export async function verifyInstalledNativeActionProgram({ sourceFixture, component }) {
  const state = stateFor(sourceFixture);
  if (!state.program || state.phase !== "composed" || component.fixture !== state.componentFixture
    || component.root !== sourceFixture.root || component.storage !== state.storage)
    fail("INSTALLED_ACTION_PROGRAM_SAME_OWNER_REQUIRED");
  assert.equal(await component.complete(), state.host);
  const { assertRootOwner } = await load(state.installed, "root-owner");
  const { originalDigest } = await load(state.installed, "domain/action-compiler-validation");
  assertRootOwner(component.owner);
  const full = await component.owner.ensureFull(), lease = { ...component.owner.workspaceLease() };
  assert.equal(full.storage, state.storage);
  const domain = await load(state.installed, "original-mcp-action-domain");
  const action = await load(state.installed, "original-mcp-action-runtime");
  const actor = Object.freeze({ id: "mcp:external", canWrite: true });
  const adapter = await action.createOriginalMcpActionRuntime(component.owner, actor, state.host);
  state.adapter = adapter;
  const call = async (tool, args = {}) => (await adapter.invoke(tool, args)).structuredContent;
  const progress = (stage, detail = {}) => writeFile(join(state.driverRoot, "progress.json"),
    JSON.stringify({ stage, ...detail }), { mode: 0o600 });
  const jobs = () => {
    const db = state.storage.connectNative();
    try { return db.prepare("SELECT record_json FROM runtime_process_jobs").all().map(row => JSON.parse(row.record_json)); }
    finally { db.close(); }
  };
  const snapshots = () => {
    const db = state.storage.connectNative();
    try { return db.prepare("SELECT snapshot FROM action_runtime_runs WHERE actor_id=?").all(actor.id).map(row => JSON.parse(row.snapshot)); }
    finally { db.close(); }
  };
  const until = async check => {
    const deadline = Date.now() + state.timeoutMs;
    while (Date.now() < deadline) {
      state.lifetime.signal.throwIfAborted(); component.owner.assertWorkspaceLease();
      if (state.uiError) throw state.uiError;
      const value = await check();
      if (value) return value;
      await delay(25);
    }
    throw new Error("Installed original local-program effect did not reach its canonical receipt.");
  };
  const unchanged = async () => {
    assert.deepEqual(await readFile(join(component.root, sourceFixture.definitionPath)), state.bytes);
    assert.deepEqual(await readFile(join(component.root, state.program.assetPath)), state.program.asset);
  };
  const args = (value, key = value) => ({ action_id: sourceFixture.actionId, content_hash: sourceFixture.contentHash,
    inputs: { value }, idempotency_key: key });
  const records = [];
  const launch = async (stage, value, key = value) => {
    const before = new Set(jobs().map(job => job.jobId));
    await progress(stage);
    const run = await call("action_call", args(value, key));
    const job = await until(() => {
      const added = jobs().filter(job => !before.has(job.jobId));
      assert(added.length <= 1, "Exactly one canonical ProcessJob may be created by an exact program Run.");
      return added[0];
    });
    assert.equal(run.launch_reused, false); assert.equal(job.actorId, actor.id);
    const db = state.storage.connectNative();
    try {
      const invocation = JSON.parse(db.prepare("SELECT payload FROM original_mcp_action_invocations WHERE run_id=?").get(run.run_id).payload);
      assert.equal(invocation.request.inputs.value, value);
      assert.equal(invocation.localProgram.request.runId, run.run_id);
      assert.equal(invocation.localProgram.request.inputSha256, originalDigest({ value }));
      assert.equal(invocation.localProgram.request.executable.sha256, state.program.executableSha256);
      assert.equal(invocation.localProgram.request.cwd.path, join(sourceFixture.root, state.program.contextPath));
      assert.deepEqual(invocation.localProgram.request.arguments, ["-e", originalProgramCode]);
      assert.equal(invocation.localProgram.decision.requestSha256, originalDigest(invocation.localProgram.request));
      assert.equal(invocation.localProgram.decision.runId, run.run_id);
      assert.equal(invocation.localProgram.decision.profileSha256, sourceFixture.profileSha256);
      assert.equal(invocation.localProgram.decision.epoch, state.host.receipt.epoch);
    } finally { db.close(); }
    const record = { runId: run.run_id, jobId: job.jobId, value, key };
    records.push(record); return record;
  };
  const finished = async (record, expectedRunState, expectedJobState, expectedEffect) => {
    const run = await until(() => snapshots().find(run => run.runId === record.runId && run.state === expectedRunState));
    const job = await until(() => jobs().find(job => job.jobId === record.jobId && job.state === expectedJobState));
    assert.equal(job.actorId, actor.id); assert.equal(job.effect, expectedEffect);
    assert.equal(job.stdout, ""); assert.equal(job.stderr, "");
    Object.assign(record, { state: run.state, processState: job.state, processEffect: job.effect });
    return run;
  };
  await unchanged();
  assert.deepEqual(jobs(), []); assert.deepEqual(snapshots(), []);
  await assert.rejects(call("action_get", { action_id: sourceFixture.actionId }), /ORIGINAL_ACTION_SOURCE_ADMISSION_REQUIRED/);
  await progress("native-business-program-source-deny");
  await assert.rejects(domain.admitOriginalMcpActionDomain(component.owner, actor, state.host, state.policy),
    /ACTION_SOURCE_ADMISSION_RPC_REQUIRED/);
  assert.equal(domain.originalMcpActionSourceIsAdmitted(state.storage, sourceFixture.actionId), false);
  await unchanged();
  await progress("native-business-program-source-admit");
  const admitted = await domain.admitOriginalMcpActionDomain(component.owner, actor, state.host, state.policy);
  assert.equal(admitted.capsuleSha256, state.custody.capsuleSha256);
  await progress("native-business-program-public-deny");
  await assert.rejects(call("action_call", args("installed", "installed-program-success")), { code: "ACCESS_DENIED" });
  assert.deepEqual(jobs(), []); assert.deepEqual(snapshots(), []);
  await progress("native-business-program-consent-deny");
  await assert.rejects(call("action_call", args("installed", "installed-program-success")), /ACTION_LOCAL_PROGRAM_CONSENT_REQUIRED/);
  assert.deepEqual(jobs(), []); assert.deepEqual(snapshots(), []);
  const completed = await launch("native-business-program-run", "installed", "installed-program-success");
  await finished(completed, "succeeded", "SUCCEEDED", "completed");
  const output = await call("action_run_get", { run_id: completed.runId });
  assert.deepEqual(output.output, { value: "installed-original-program", environmentKeys: [] });
  await progress("native-business-program-reuse");
  const reused = await call("action_call", args("installed", "installed-program-success"));
  assert.equal(reused.run_id, completed.runId); assert.equal(reused.launch_reused, true);
  assert.equal(jobs().length, 1); assert.equal(snapshots().length, 1);
  const cancelled = await launch("native-business-program-cancel-run", "wait-cancel");
  await until(() => jobs().some(job => job.jobId === cancelled.jobId && job.state === "RUNNING" && job.pid !== null));
  await progress("native-business-program-cancel", { runId: cancelled.runId });
  const cancellation = await call("action_run_cancel", { run_id: cancelled.runId });
  assert.equal(cancellation.remote_rollback, false);
  await finished(cancelled, "unknown", "CANCELLED", "unknown");
  await progress("native-business-program-cancel-reuse");
  const uncertain = await call("action_call", args("wait-cancel"));
  assert.equal(uncertain.run_id, cancelled.runId); assert.equal(uncertain.launch_reused, true);
  assert.equal(uncertain.state, "outcome_unknown");
  assert.equal(jobs().length, 2); assert.equal(snapshots().length, 2);
  const revoked = await launch("native-business-program-revoke-run", "wait-revoke");
  await until(() => jobs().some(job => job.jobId === revoked.jobId && job.state === "RUNNING" && job.pid !== null));
  await progress("native-business-program-revoke");
  await waitJson(join(state.driverRoot, `${state.uiPrefix}-revoked.json`), state.timeoutMs, state.lifetime.signal);
  await finished(revoked, "unknown", "CANCELLED", "unknown");
  await progress("native-business-program-revoked-call");
  await assert.rejects(call("action_call", args("after-revoke")), /ACTION_NATIVE_TRUST_REQUIRED|SOURCE_ADMISSION_REQUIRED/);
  assert.equal(jobs().length, 3); assert.equal(snapshots().length, 3);
  assert.equal(state.host.signal.aborted, false, "Action program revocation must not close unrelated source/model/public grants.");
  assert.deepEqual(component.owner.workspaceLease(), lease);
  assert.equal((await component.owner.ensureFull()).runtime.core, full.runtime.core);
  await unchanged();
  const receipt = domain.verifyOriginalMcpActionDomain(state.storage);
  await progress("native-business-program-complete");
  const ui = await waitJson(join(state.driverRoot, `${state.uiPrefix}-ui-passed.json`), state.timeoutMs, state.lifetime.signal);
  await state.uiDone;
  assert.equal(ui.actualNativeUi, true); assert.equal(ui.exactToolchainContextVisible, true);
  const evidence = { passed: true, scope: "new disposable installed original local-program Action fixture; not full native-engine qualification",
    mode: "program", profileSha256: sourceFixture.profileSha256, identitySha256: sourceFixture.identitySha256,
    custodyPlanSha256: state.baseCustody.planSha256, actionCapsuleSha256: state.custody.capsuleSha256,
    sourceIdentity: sourceFixture.sourceIdentity, originalWriterSha256: releaseSha256,
    definitionSha256: sourceFixture.definitionSha256, executableSha256: state.program.executableSha256,
    nativeHostReceiptSha256: state.host.receipt.receiptSha256, actionDomainReceiptSha256: receipt.receiptSha256,
    nativeEpoch: state.host.receipt.epoch, installedPayloadBuildId: state.payloadBuildId,
    actionId: sourceFixture.actionId, contentHash: sourceFixture.contentHash, runId: completed.runId, output: output.output,
    actualNativeUi: ui, records, canonicalProcessJobs: jobs().length, exactlyOneJobPerExactRun: true,
    sourceDenialNoAdmission: true, publicInvocationDenialNoRun: true, separateProgramDenialNoRun: true,
    actualOriginalProgramOutput: true, childEnvironmentEmpty: true, exactTypedToolchainInputDecisions: true,
    idempotentRunAndUncertaintyReused: true, canonicalOwnedCancellationUnknown: true,
    nativeRevocationCancelledOwnedChild: true, noProcessReplay: true, noPidAdoption: true,
    sameRootOwnerAndCachedCore: true, independentSignedSessionPreserved: true, originalSourceBytesUnchanged: true,
    osSandboxQualified: false, modelChannelRequired: false, b1RootClosureQualified: false,
    fullCutoverQualified: false, actualProfileOrKeyringQualified: false };
  state.evidence = evidence; state.phase = "verified";
  await writeFile(join(state.driverRoot, `${state.uiPrefix}-passed.json`), JSON.stringify(evidence), { mode: 0o600, flag: "wx" });
  return evidence;
}

/** Before component.close(); actual complete editor exit remains mandatory before B1. */
export async function closeInstalledNativeActionFixture(sourceFixture) {
  const state = stateFor(sourceFixture);
  if (state.closing) return state.closing;
  state.lifetime.abort();
  state.closing = (async () => {
    const failures = [];
    for (const work of [() => state.adapter?.close(), () => state.policy?.close(), () => state.authority?.close(),
      () => stopChild(state.ui)]) try { await work(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "Installed Action cleanup incomplete; preserve all evidence.");
    if (state.authority) await assert.rejects(lstat(join(sourceFixture.root, ".pkm-action-authority")), { code: "ENOENT" });
    state.closed = true;
  })().catch(error => { state.closing = undefined; throw error; });
  return state.closing;
}

/** Parent calls only after actual editor exit, closed owner, genuine B1 and fresh B0 restoration. */
export async function verifyInstalledNativeActionRestored(sourceFixture, { restoredRoot, archive }) {
  const state = stateFor(sourceFixture);
  if (!state.closed || !state.evidence) fail("INSTALLED_ACTION_CONFIRMED_EFFECTS_AND_CLOSE_REQUIRED");
  assert.deepEqual(await readFile(join(restoredRoot, sourceFixture.definitionPath)), state.bytes);
  assert.deepEqual(await readFile(join(archive, sourceFixture.definitionPath)), state.bytes);
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(archive, "core.sqlite"), { readOnly: true });
  try {
    if (state.program) {
      const { originalDigest } = await load(state.installed, "domain/action-compiler-validation");
      assert.equal(db.prepare("SELECT count(*) n FROM runtime_process_jobs").get().n, state.evidence.records.length);
      assert.equal(db.prepare("SELECT count(*) n FROM action_runtime_runs").get().n, state.evidence.records.length);
      assert.equal(db.prepare("SELECT closed FROM runtime_process_owner WHERE singleton=1").get().closed, 1);
      for (const record of state.evidence.records) {
        const snapshot = JSON.parse(db.prepare("SELECT snapshot FROM action_runtime_runs WHERE actor_id='mcp:external' AND run_id=?")
          .get(record.runId).snapshot);
        assert.equal(snapshot.state, record.state); assert.equal(snapshot.definitionDigest, sourceFixture.contentHash);
        if (record.state === "succeeded") assert.deepEqual(snapshot.nodes[0].outputs, state.evidence.output);
        const job = JSON.parse(db.prepare("SELECT record_json FROM runtime_process_jobs WHERE job_id=?").get(record.jobId).record_json);
        assert.equal(job.actorId, "mcp:external"); assert.equal(job.state, record.processState);
        assert.equal(job.effect, record.processEffect); assert.equal(job.stdout, ""); assert.equal(job.stderr, "");
        assert(job.finishedAt !== null);
        const invocation = JSON.parse(db.prepare("SELECT payload FROM original_mcp_action_invocations WHERE run_id=?").get(record.runId).payload);
        assert.equal(invocation.sourceReceiptSha256, state.evidence.actionDomainReceiptSha256);
        assert.equal(invocation.request.inputs.value, record.value);
        assert.equal(invocation.localProgram.request.runId, record.runId);
        assert.equal(invocation.localProgram.request.executable.sha256, state.program.executableSha256);
        assert.equal(invocation.localProgram.decision.requestSha256, originalDigest(invocation.localProgram.request));
        assert.equal(invocation.localProgram.decision.epoch, state.evidence.nativeEpoch);
      }
    } else {
      const row = db.prepare("SELECT snapshot FROM action_runtime_runs WHERE actor_id='mcp:external' AND run_id=?").get(state.evidence.runId);
      assert(row);
      const snapshot = JSON.parse(row.snapshot);
      assert.equal(snapshot.state, "succeeded"); assert.equal(snapshot.definitionDigest, sourceFixture.contentHash);
      assert.deepEqual(snapshot.nodes[0].outputs, { value: 41 });
      const call = db.prepare("SELECT payload FROM original_mcp_action_invocations WHERE run_id=?").get(state.evidence.runId);
      assert(call); assert.equal(JSON.parse(call.payload).sourceReceiptSha256, state.evidence.actionDomainReceiptSha256);
    }
  } finally { db.close(); }
  if (state.program) {
    assert.deepEqual(await readFile(join(restoredRoot, state.program.assetPath)), state.program.asset);
    assert.deepEqual(await readFile(join(archive, state.program.assetPath)), state.program.asset);
    const proof = state.custody.toolchains[0], saved = state.custody.files.find(file => file.path === proof.capsulePath);
    assert(saved);
    assert.equal(hash(await readFile(join(state.custody.backup, "blobs", saved.blob))), state.program.executableSha256);
    await assert.rejects(lstat(join(restoredRoot, "core.sqlite")), { code: "ENOENT" });
  }
  await assert.rejects(lstat(join(restoredRoot, ".pkm-action-authority")), { code: "ENOENT" });
  return { originalActionB0BytesRestored: true, canonicalB1EffectAndInvocationReceiptPreserved: true,
    ...(state.program ? { canonicalB1ProcessJobsAndUncertaintyPreserved: true, originalContextAssetRestored: true,
      independentlyBackedToolchainBytesRetained: true, nativeProcessAuthorityNotRestored: true } : {}),
    fullCutoverQualified: false };
}
export async function verifyInstalledNativeActionProgramRestored(sourceFixture, input) {
  const state = stateFor(sourceFixture);
  if (!state.program) fail("INSTALLED_ACTION_PROGRAM_FIXTURE_REQUIRED");
  return verifyInstalledNativeActionRestored(sourceFixture, input);
}

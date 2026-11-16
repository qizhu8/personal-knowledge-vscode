"use strict";
const assert = require("node:assert/strict");
const { writeFile, readFile, readdir, stat, realpath, lstat } = require("node:fs/promises");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { createHash } = require("node:crypto");
const vscode = require("vscode");

async function snapshotTree(root, maxFileBytes = 2_097_152n) {
  const entries = {};
  const visit = async (path, name) => {
    assert(Object.keys(entries).length < 200, "Native fixture snapshot exceeded its bound");
    const info = await lstat(path, { bigint: true });
    assert(!info.isSymbolicLink(), "Native fixture snapshots must not follow symlinks");
    entries[name] = {
      kind: info.isDirectory() ? "directory" : "file", dev: String(info.dev), ino: String(info.ino),
      mode: String(info.mode), size: String(info.size), mtimeNs: String(info.mtimeNs), ctimeNs: String(info.ctimeNs),
    };
    if (info.isDirectory()) {
      for (const child of (await readdir(path)).sort()) await visit(join(path, child), name ? `${name}/${child}` : child);
    } else {
      assert(info.isFile() && info.size < maxFileBytes, "Only bounded regular native fixture files can be snapshotted");
      entries[name].sha256 = createHash("sha256").update(await readFile(path)).digest("hex");
    }
  };
  await visit(root, "");
  return entries;
}

function validateInitialBootstrap(before, after) {
  const areas = ["notes", "skills", "papers"];
  const directories = new Set(areas.flatMap(area => [area, `${area}/.trash`]));
  const sqlite = new Set(["core.sqlite", "core.sqlite-wal", "core.sqlite-shm"]);
  const changes = [];
  for (const name of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const previous = before[name], current = after[name];
    if (JSON.stringify(previous) === JSON.stringify(current)) continue;
    changes.push({ path: name, before: previous ?? null, after: current ?? null });
    if (sqlite.has(name)) {
      assert(!current || current.kind === "file", "Operational SQLite state must remain regular files");
      if (name === "core.sqlite" && previous) {
        assert(current, "Bootstrap removed the published SQLite database");
        for (const key of ["kind", "dev", "ino", "mode"]) assert.equal(current[key], previous[key]);
      }
    } else if (!previous) {
      assert(directories.has(name) && current?.kind === "directory",
        `Bootstrap created an unapproved path: ${name}`);
    } else if ((name === "" || areas.includes(name)) && previous.kind === "directory") {
      assert(current, `Bootstrap removed a protected directory: ${name}`);
      const stable = entry => Object.fromEntries(Object.entries(entry)
        .filter(([key]) => !["mtimeNs", "ctimeNs", "size"].includes(key)));
      assert.deepEqual(stable(current), stable(previous), `Bootstrap replaced a protected parent: ${name}`);
    } else assert.deepEqual(current, previous, `Bootstrap changed protected content: ${name}`);
  }
  for (const area of areas) {
    const trash = `${area}/.trash`;
    assert(after[trash]?.kind === "directory", `Native bootstrap did not provision ${trash}`);
    assert(!Object.keys(after).some(name => name.startsWith(`${trash}/`)),
      "The known bootstrap may create only EMPTY Trash directories");
  }
  return changes;
}

function knowledgeSnapshot(tree) {
  const protectedEntries = Object.fromEntries(Object.entries(tree)
    .filter(([name]) => ["notes", "skills", "papers"].some(area => name === area || name.startsWith(`${area}/`))));
  assert(Object.keys(protectedEntries).some(name => /\.md$/i.test(name)),
    "The served and protected fixture must contain real published Markdown");
  return protectedEntries;
}

async function waitForJson(path, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return JSON.parse(await readFile(path, "utf8")); }
    catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Native UI evidence was not produced: ${path}`);
}

function validatePreviewSource(output, expected) {
  const marker = output.lastIndexOf("FIRST-RUN IMPORT PREVIEW");
  assert(marker >= 0, "Real native preview output is missing");
  const start = output.indexOf("{", marker);
  assert(start >= 0);
  const inspection = JSON.parse(output.slice(start).trim());
  assert.equal(inspection.source, expected.source);
  assert.equal(inspection.plan.sourceRoot, expected.source);
  assert.equal(inspection.destination, expected.destination);
  assert.equal(inspection.plan.fingerprint, expected.fingerprint);
  assert.equal(inspection.plan.ready, true);
  return inspection;
}

async function previewWithSourceEvidence(fixture, phase, extension) {
  const request = join(fixture.root, `source-picker-${phase}-request.json`);
  const response = join(fixture.root, `source-picker-${phase}-response.json`);
  let done = false;
  const probe = (async () => {
    const deadline = Date.now() + 45000;
    while (!done && Date.now() < deadline) {
      let selected;
      try { selected = JSON.parse(await readFile(request, "utf8")); }
      catch (error) {
        if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      }
      if (selected) {
        assert.equal(selected.source, fixture.source);
        const uri = vscode.Uri.file(fixture.source);
        const info = await vscode.workspace.fs.stat(uri);
        const entries = await vscode.workspace.fs.readDirectory(uri);
        assert.equal(info.type, vscode.FileType.Directory);
        assert(entries.some(([name, type]) => name === "notes" && type === vscode.FileType.Directory));
        const noteUri = vscode.Uri.file(fixture.note);
        const bytes = await vscode.workspace.fs.readFile(noteUri);
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        assert.equal(sha256, fixture.sourceBeforeImport["notes/Example.md"].sha256);
        const workspace = vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath);
        assert.deepEqual(workspace, [join(fixture.root, "editor")]);
        const { planLegacyImport } = await import(pathToFileURL(join(fixture.installed,
          "next-runtime/server/dist/legacy-import.js")).href);
        const plan = await planLegacyImport(fixture.source);
        assert.equal(plan.sourceRoot, fixture.source);
        assert.equal(plan.ready, true);
        const proof = {
          nonce: selected.nonce, capturedAt: new Date().toISOString(), source: fixture.source,
          sourceUri: uri.toString(), stat: info, entries, noteSha256: sha256,
          expectedFingerprint: plan.fingerprint, workspace, extensionId: extension.id,
          extensionPath: extension.extensionPath, extensionHostPid: process.pid, vscodeVersion: vscode.version,
        };
        fixture.nativeSourcePickerProofs ??= {};
        fixture.nativeSourcePickerProofs[phase] = proof;
        await writeFile(response, JSON.stringify(proof));
        return proof;
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error("Native source picker did not complete the required bounded FileService probe");
  })().catch(async error => {
    await writeFile(response, JSON.stringify({ failed: true, error: String(error), stack: error.stack }));
    throw error;
  });
  let native;
  try {
    [, native] = await Promise.all([
      vscode.commands.executeCommand("pkm.nextHost.importPreview").finally(() => { done = true; }), probe,
    ]);
  } finally { done = true; }
  await waitForJson(join(fixture.root, `preview-source-${phase}-copied.json`));
  const output = await vscode.env.clipboard.readText();
  await writeFile(join(fixture.root, `preview-source-${phase}-native-output.json`),
    JSON.stringify({ actualNativeClipboardOutput: output, expected: native }));
  const inspection = validatePreviewSource(output, {
    source: fixture.source, destination: fixture.destination, fingerprint: native.expectedFingerprint,
  });
  fixture.previewSourceProofs ??= {};
  fixture.previewSourceProofs[phase] = { inspection, actualNativeClipboardOutput: output };
  await writeFile(join(fixture.root, `preview-source-${phase}-verified.json`), JSON.stringify({
    passed: true, source: inspection.source, selectedSourceUri: native.sourceUri, fingerprint: inspection.plan.fingerprint,
  }));
}

async function ownedMcpChildren(selected) {
  const found = [];
  let visited = 0;
  const inspect = async pid => {
    assert(++visited <= 32, "Owned extension-host process tree exceeded its bound");
    let children;
    try { children = (await readFile(`/proc/${pid}/task/${pid}/children`, "utf8")).trim().split(/\s+/).filter(Boolean); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const child of children) {
      try {
        const args = (await readFile(`/proc/${child}/cmdline`, "utf8")).split("\0").filter(Boolean);
        const state = await readFile(`/proc/${child}/stat`, "utf8");
        const started = state.slice(state.lastIndexOf(")") + 2).split(" ")[19];
        const generation = join(selected.managedRoot, "generations", selected.generation) + "/";
        if (args.includes(join(selected.managedRoot, "launch.py")) || args.some(arg => arg.startsWith(generation)))
          found.push({ pid: Number(child), args, started });
        await inspect(child);
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  };
  await inspect(process.pid);
  assert(found.some(child => child.args.includes(join(selected.managedRoot, "launch.py"))),
    "The native server must be an actual owned child using this exact verified launcher");
  return found;
}

async function waitForOwnedExit(children) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const remaining = [];
    for (const child of children) {
      try {
        const state = await readFile(`/proc/${child.pid}/stat`, "utf8");
        if (state.slice(state.lastIndexOf(")") + 2).split(" ")[19] === child.started) remaining.push(child.pid);
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    if (!remaining.length) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("Explicit native Stop did not terminate all recorded owned MCP children");
}

async function verifySideBySide(fixture, extension, progress) {
  const selected = fixture.sideBySide;
  assert.equal(extension.id.toLowerCase(), "pkm-nonproduction.pkm-v5");
  assert.equal(extension.packageJSON.displayName, "pkm-v5");
  assert.deepEqual(extension.packageJSON.contributes.mcpServerDefinitionProviders,
    [{ id: "pkm-v5", label: "pkm-v5" }]);
  assert.equal(typeof vscode.lm?.registerMcpServerDefinitionProvider, "function",
    "This genuine native host must support stable MCP provider registration");
  assert.equal(typeof vscode.McpStdioServerDefinition, "function");
  const configuration = vscode.workspace.getConfiguration("pkm.nextHost");
  assert.equal(configuration.inspect("managedRoot").globalValue, undefined);
  await progress({ stage: "native-mcp-empty-discovery" });
  const emptyUi = await waitForJson(join(fixture.root, "native-mcp-empty-ui.json"), 30000);
  assert.equal(emptyUi.passed, true);
  const runtime = join(fixture.installed, "next-runtime/server");
  assert.equal(await realpath(selected.data), await realpath(fixture.destination));
  const outcomePath = join(fixture.data, ".imported.pkm-legacy-import.outcome.json");
  const outcomeBytes = await readFile(outcomePath, "utf8");
  const outcome = JSON.parse(outcomeBytes);
  const importer = await import(pathToFileURL(join(runtime, "dist/legacy-import.js")).href);
  const recovery = await importer.recoverLegacyImportOutcome(selected.data);
  assert.equal(recovery.status, "published");
  assert.deepEqual(recovery.receipt, outcome.receipt);
  const receipt = recovery.receipt;
  assert.equal(receipt.destination, selected.data);
  assert.equal(receipt.documentCount, 1);
  const document = receipt.documents.find(entry => entry.path === "notes/Example.md");
  assert(document);
  const documentBytes = await readFile(join(selected.data, document.path));
  assert.deepEqual(documentBytes, await readFile(fixture.note));
  assert.equal(createHash("sha256").update(documentBytes).digest("hex"), document.sha256);
  const rootBeforeBootstrap = await snapshotTree(selected.data, 16_777_216n);
  const importedKnowledge = knowledgeSnapshot(rootBeforeBootstrap);
  const importEvidence = {
    outcomePath, outcomeBytes, receipt, document, publishedRoot: selected.data,
    protectedMarkdownCount: Object.keys(importedKnowledge).filter(name => /\.md$/i.test(name)).length,
    sourceBeforeImport: fixture.sourceBeforeImport,
  };
  await writeFile(join(fixture.root, "side-by-side-import-evidence.json"), JSON.stringify(importEvidence));
  const { Storage } = await import(pathToFileURL(join(runtime, "dist/storage.js")).href);
  const { Core } = await import(pathToFileURL(join(runtime, "dist/core.js")).href);
  const storage = await Storage.open(selected.data);
  try {
    selected.coreInfo = (await new Core(storage).dispatch("server_info", {}, { id: "mcp:external", canWrite: false })).result;
    assert.equal(selected.coreInfo.name, "pkm-v5");
    assert.equal(selected.coreInfo.serverId, "pkm-v5");
  } finally { await storage.close(); }
  const provisioner = await import(pathToFileURL(selected.provisioner).href);
  const generation = await provisioner.stageIsolatedManagedGeneration({
    managedRoot: selected.managedRoot, data: selected.data, repositoryRoot: runtime,
    python: fixture.python, node: fixture.node, allowWrites: false,
  });
  await provisioner.publishIsolatedManagedGeneration(selected.managedRoot, generation.generation);
  selected.generation = generation.generation;
  selected.runtimeBuild = generation.runtimeBuild;
  await configuration.update("managedRoot", selected.managedRoot, vscode.ConfigurationTarget.Global);
  assert.equal(configuration.inspect("managedRoot").globalValue, selected.managedRoot);
  const sdk = suffix => import(pathToFileURL(join(runtime,
    `node_modules/@modelcontextprotocol/sdk/dist/esm/${suffix}.js`)).href);
  const [{ Client }, { StdioClientTransport }] = await Promise.all([sdk("client/index"), sdk("client/stdio")]);
  const { isolatedManagedLaunch, verifyIsolatedManagedGeneration } =
    await import(pathToFileURL(selected.launchVerifier).href);
  const manifest = await verifyIsolatedManagedGeneration(selected.managedRoot, selected.generation);
  assert.equal(manifest.runtimeBuild, selected.runtimeBuild);
  const launch = await isolatedManagedLaunch(selected.managedRoot);
  assert.equal(launch.command, manifest.interpreters.python.path);
  assert.deepEqual(launch.args, ["-I", "-S", join(selected.managedRoot, "launch.py")]);
  const generationRoot = join(selected.managedRoot, "generations", selected.generation);
  const launchConfiguration = JSON.parse(await readFile(join(generationRoot, "launch.json"), "utf8"));
  assert.equal(launchConfiguration.data, selected.data);
  assert.equal(launchConfiguration.allowWrites, false);
  const publication = async () => ({
    latest: await readFile(join(selected.managedRoot, "latest-generation.json"), "utf8"),
    active: await readFile(join(selected.managedRoot, "active-generation.json"), "utf8"),
    importOutcome: { bytes: await readFile(outcomePath, "utf8"), stat: await snapshotTree(outcomePath) },
    workspaceMarker: await snapshotTree(join(selected.data, ".pkm-next-workspace")),
    source: await snapshotTree(fixture.source),
  });
  const publicationBeforeBootstrap = await publication();
  assert.deepEqual(publicationBeforeBootstrap.source, fixture.sourceBeforeImport);
  const transport = new StdioClientTransport({ ...launch, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", bytes => { stderr = (stderr + bytes.toString()).slice(-8192); });
  const client = new Client({ name: "pkm-v5-owned-installation-check", version: "0.1.0" });
  let serverInfo, metadata, inventory, toolNames = [];
  try {
    await client.connect(transport, { timeout: 60000 });
    serverInfo = client.getServerVersion();
    assert.equal(serverInfo.name, "pkm-v5", "The actual verified stdio server must initialize with the new public name");
    let cursor;
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      toolNames.push(...page.tools.map(tool => tool.name));
      cursor = page.nextCursor;
      assert(toolNames.length <= 400, "Unexpected unbounded MCP tool inventory");
    } while (cursor);
    for (const name of ["check_version", "capabilities_inventory"]) assert(toolNames.includes(name));
    const readMetadata = async name => {
      const result = await client.callTool({ name, arguments: {} }, undefined, { timeout: 60000 });
      assert(!result.isError, `${name} returned a protocol/tool error`);
      assert(JSON.stringify(result).length < 262144, "Metadata response exceeded its bound");
      return result;
    };
    metadata = await readMetadata("check_version");
    inventory = await readMetadata("capabilities_inventory");
  } catch (error) {
    error.message += `\nOwned verified MCP stderr: ${stderr}`;
    throw error;
  } finally { await client.close(); }
  const rootAfterBootstrap = await snapshotTree(selected.data, 16_777_216n);
  const bootstrap = {
    authorization: "Explicit initial native lifecycle bootstrap; actor read-only is NOT filesystem-readonly",
    policy: {
      emptyDirectories: ["notes/.trash", "skills/.trash", "papers/.trash"],
      associatedAreaDirectories: ["notes", "skills", "papers"],
      parentMetadata: ["mtimeNs", "ctimeNs", "size"],
      operationalFiles: ["core.sqlite", "core.sqlite-wal", "core.sqlite-shm"],
      allOtherEntries: "exactly unchanged, including Markdown bytes, inode and mtime",
    },
    before: rootBeforeBootstrap, after: rootAfterBootstrap,
    publicationBefore: publicationBeforeBootstrap, publicationAfter: await publication(),
  };
  await writeFile(join(fixture.root, "side-by-side-bootstrap.json"), JSON.stringify(bootstrap));
  bootstrap.validatedChanges = validateInitialBootstrap(rootBeforeBootstrap, rootAfterBootstrap);
  assert.deepEqual(bootstrap.publicationAfter, bootstrap.publicationBefore);
  await writeFile(join(fixture.root, "side-by-side-bootstrap.json"), JSON.stringify(bootstrap));
  const before = { knowledge: knowledgeSnapshot(rootAfterBootstrap), publication: await publication() };
  await writeFile(join(fixture.root, "side-by-side-strict-before.json"), JSON.stringify(before));
  const reader = new Client({ name: "pkm-v5-published-document-reader", version: "0.1.0" });
  let documentRead;
  try {
    await reader.connect(new StdioClientTransport({ ...launch, stderr: "pipe" }), { timeout: 60000 });
    assert.equal(reader.getServerVersion().name, "pkm-v5");
    const readerVersion = await reader.callTool({ name: "check_version", arguments: {} });
    assert(!readerVersion.isError, JSON.stringify(readerVersion));
    const readerPid = readerVersion.structuredContent.runtime.pid;
    assert(Number.isSafeInteger(readerPid) && readerPid > 0);
    const contract = await reader.callTool({ name: "capabilities_describe",
      arguments: { operation: "mcp.tool.get_note" } });
    assert(!contract.isError, JSON.stringify(contract));
    const contractValue = contract.structuredContent ?? JSON.parse(contract.content[0].text);
    assert.equal(contractValue.readOnly, true);
    const result = await reader.callTool({ name: "capability_read", arguments: {
      operation: "mcp.tool.get_note", version: 1, arguments: { id: document.documentId },
    } }, undefined, { timeout: 60000 });
    assert(!result.isError, JSON.stringify(result));
    const value = result.structuredContent ?? JSON.parse(result.content[0].text);
    assert.equal(value.title, "Installed host");
    assert.equal(value.content, "Disposable fixture only.\n");
    documentRead = { contract, result, readerPid, documentId: document.documentId, path: document.path, sha256: document.sha256 };
    await writeFile(join(fixture.root, "side-by-side-document-read.json"), JSON.stringify(documentRead));
  } finally { await reader.close(); }
  await assert.rejects(lstat(`/proc/${documentRead.readerPid}`), { code: "ENOENT" });
  documentRead.readerPidExitedBeforeNativeStart = true;
  await writeFile(join(fixture.root, "side-by-side-document-read.json"), JSON.stringify(documentRead));
  await writeFile(join(fixture.root, "side-by-side-protocol.json"), JSON.stringify({
    serverInfo, toolNames, metadata, inventory, launch: { command: launch.command, args: launch.args, cwd: launch.cwd },
  }));
  const directPid = metadata.structuredContent.runtime.pid;
  assert(Number.isSafeInteger(directPid) && directPid > 0);
  await assert.rejects(lstat(`/proc/${directPid}`), { code: "ENOENT" },
    "The direct verified protocol client must terminate before native Start");
  // The direct protocol client is closed before the workbench can start its separate owned server.
  await progress({ stage: "native-mcp-discovery" });
  assert.equal((await waitForJson(join(fixture.root, "native-mcp-running.json"), 90000)).ready, true);
  const nativeChildren = await ownedMcpChildren(selected);
  await writeFile(join(fixture.root, "native-mcp-processes-recorded.json"), JSON.stringify({ passed: true, nativeChildren }));
  const nativeUi = await waitForJson(join(fixture.root, "native-mcp-ui-verified.json"), 90000);
  assert.equal(nativeUi.passed, true);
  assert.equal(nativeUi.discoveredLabel, "pkm-v5");
  assert.equal(nativeUi.started, true);
  assert.equal(nativeUi.stopped, true);
  assert.equal(nativeUi.explicitStopAction, true);
  assert.equal(nativeUi.editorAliveAtStop, true);
  assert.equal(nativeUi.discoveredTools, toolNames.length,
    "The genuine native provider and the separately verified stdio generation must advertise the same tool count");
  await waitForOwnedExit(nativeChildren);
  assert(extension.isActive, "Native Stop must complete before extension-host shutdown");
  assert.equal((await vscode.commands.executeCommand("pkm.nextHost.migrationState")).status, "disconnected");
  const after = {
    knowledge: knowledgeSnapshot(await snapshotTree(selected.data, 16_777_216n)), publication: await publication(),
  };
  await writeFile(join(fixture.root, "side-by-side-strict-after.json"), JSON.stringify(after));
  assert.deepEqual(after, before, "Read-only identity checks changed Markdown or generation publication pointers");
  await verifyIsolatedManagedGeneration(selected.managedRoot, selected.generation);
  await writeFile(join(fixture.root, "side-by-side-passed.json"), JSON.stringify({
    passed: true, scope: "named side-by-side installation in a separate owned synthetic profile; not a cutover",
    extensionId: extension.id, coreInfo: selected.coreInfo, serverInfo, toolNames, metadata, inventory, emptyUi, nativeUi,
    importEvidence, bootstrap, documentRead, servedData: selected.data,
    initiallyUnconfiguredNativeDiscovery: true, globalRootConfiguredWithoutReload: true,
    generation: selected.generation, runtimeBuild: selected.runtimeBuild,
    installedPayloadBuildId: selected.installedPayloadBuildId, managedRoot: selected.managedRoot,
    launch: { command: launch.command, args: launch.args, cwd: launch.cwd }, allowWrites: false,
    directProtocolClientClosedBeforeNativeStart: true, before, after,
    directProtocolPid: directPid, directProtocolPidExitedBeforeNativeStart: true,
    nativeChildren, nativeChildrenExitedAfterExplicitStop: true,
    extensionHostPid: process.pid, extensionHostAliveAfterExplicitStop: true,
    oldPkmCohosted: false, productionProfileTouched: false, productionCutover: false,
  }));
  await progress({ stage: "native-mcp-complete" });
  assert.equal((await waitForJson(join(fixture.root, "ui-passed.json"))).passed, true);
}

async function run() {
  const fixture = JSON.parse(process.env.PKM_HOST_INSTALLED_FIXTURE);
  const progress = async value => writeFile(join(fixture.root, "progress.json"), JSON.stringify(value));
  const extension = vscode.extensions.getExtension("pkm-nonproduction.pkm-v5");
  assert(extension, "Host VSIX must be installed");
  assert.equal(await realpath(extension.extensionPath), fixture.installed);
  assert(!vscode.extensions.getExtension("uone.personal-knowledge"), "Production extension must not be loaded");
  assert(!extension.extensionPath.includes("test-driver"));
  const sourceBytes = await readFile(fixture.note, "utf8");
  const sourceStat = await stat(fixture.note);
  fixture.sourceBeforeImport = await snapshotTree(fixture.source);
  const invoke = suffix => vscode.commands.executeCommand(`pkm.nextHost.${suffix}`);
  for (const name of ["importPreview", "importConfirm"])
    assert(extension.packageJSON.contributes.commands.some(item => item.command === `pkm.nextHost.${name}`));
  await extension.activate();
  assert.equal(extension.isActive, true);
  assert.equal(typeof extension.exports.assertActiveMigrationContext, "function",
    "Coordinator commands must run only after activation exports are available");
  if (!fixture.coordinator) {
    const disabled = await invoke("productionState");
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.status, "disabled");
  }
  await vscode.commands.executeCommand("pkm.next.disconnect");
  assert.equal((await invoke("migrationState")).status, "disconnected");
  await invoke("migrationDisconnect");
  assert.equal((await invoke("migrationState")).status, "disconnected");

  await progress({ stage: "cancel-source" });
  await invoke("importPreview");
  assert.deepEqual((await readdir(fixture.data)).sort(), ["source"]);
  await progress({ stage: "preview-deny" });
  await previewWithSourceEvidence(fixture, "preview-deny", extension);
  assert.deepEqual((await readdir(fixture.data)).sort(), ["source"]);
  await progress({ stage: "deny-confirm" });
  await invoke("importConfirm");
  assert.deepEqual((await readdir(fixture.data)).sort(), ["source"]);
  await progress({ stage: "preview-accept" });
  await previewWithSourceEvidence(fixture, "preview-accept", extension);
  assert.deepEqual((await readdir(fixture.data)).sort(), ["source"]);
  await progress({ stage: "accept-confirm" });
  await invoke("importConfirm");
  assert.equal(await readFile(join(fixture.destination, "notes", "Example.md"), "utf8"), sourceBytes);
  assert.equal(await readFile(fixture.note, "utf8"), sourceBytes);
  assert.equal((await stat(fixture.note)).mtimeMs, sourceStat.mtimeMs);
  assert.equal(extension.isActive, true);
  await writeFile(join(fixture.root, "activation.json"), JSON.stringify({
    id: extension.id, version: extension.packageJSON.version, path: extension.extensionPath,
    active: extension.isActive, realInstalledExtension: true, disconnectedLifecycle: true,
    coordinatorDisabledByDefault: !fixture.coordinator,
    nativeSourcePickerProofs: fixture.nativeSourcePickerProofs, previewSourceProofs: fixture.previewSourceProofs,
    checks: ["source-picker-cancel", "preview-read-only", "confirmation-deny-no-write",
      "exact-plan-confirmation", "publication", "source-bytes-and-mtime-unchanged", "disconnected-lifecycle"],
  }));
  // The actual output is read from the workbench by the outside Playwright driver.
  await progress({ stage: "published" });
  let copied;
  for (let attempt = 0; attempt < 150; attempt++) {
    try { copied = JSON.parse(await readFile(join(fixture.root, "ui-copied.json"), "utf8")); break; }
    catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(copied, "Real UI must select and copy Output");
  const output = await vscode.env.clipboard.readText();
  assert(output.includes("FIRST-RUN IMPORT PREVIEW"));
  assert(output.includes("pkm.legacy-import-receipt/v1"));
  assert(output.includes('"cutover": false'));
  assert(output.includes(JSON.stringify(fixture.source)));
  assert(output.includes(JSON.stringify(fixture.destination)));
  const digests = [...output.matchAll(/"planSha256":\s*"([a-f0-9]{64})"/g)];
  assert.equal(digests.at(-1)?.[1], copied.planSha256);
  const fingerprints = [...output.matchAll(/"fingerprint":\s*"([a-f0-9]{64})"/g)];
  assert(fingerprints.length >= 3);
  assert.equal(fingerprints.at(-1)[1], fingerprints.at(-2)[1]);
  await writeFile(join(fixture.root, "output-verified.json"), '{"passed":true}');
  let verified = false;
  for (let attempt = 0; attempt < 300; attempt++) {
    try { if (JSON.parse(await readFile(join(fixture.root, "ui-import-passed.json"), "utf8")).passed) { verified = true; break; } }
    catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(verified, "UI driver did not verify receipt");
  if (fixture.sideBySide) await verifySideBySide(fixture, extension, progress);
  if (!fixture.coordinator) return;
  const selected = fixture.coordinator;
  const before = await stat(selected.note, { bigint: true });
  const bytes = await readFile(selected.note);
  const initial = await invoke("productionState");
  assert.equal(initial.enabled, true);
  const nativeHost = await import(pathToFileURL(join(fixture.installed,
    "next-runtime/server/dist/active-vscode-migration-host.js")).href);
  let callerProofInvoked = false;
  const selfAsserted = { assertActiveMigrationContext() { callerProofInvoked = true; } };
  const forged = {
    extensionPath: extension.extensionPath, extension,
    globalStorageUri: vscode.Uri.file(initial.profile), subscriptions: [],
    exports: selfAsserted,
    vscode: { extensions: { getExtension: () => ({ ...extension, exports: selfAsserted }) } },
  };
  const rootBeforeForgery = await readdir(selected.root);
  assert.throws(() => nativeHost.activateActiveVscodeMigrationHost(forged),
    /The migration context is not this live extension activation/);
  assert.equal(callerProofInvoked, false, "Caller-owned native API/proof objects must be ignored");
  assert.deepEqual(await readdir(selected.root), rootBeforeForgery);
  assert.deepEqual(await readFile(selected.note), bytes);
  await progress({ stage: "coordinator-preview" });
  const preview = await invoke("productionPreview");
  assert.equal(await realpath(initial.profile), initial.profile, "Actual VS Code globalStorage profile must be canonical");
  assert.equal(preview.status, "previewed");
  assert.equal(preview.root, selected.root);
  assert.match(preview.buildId, /^[a-f0-9]{64}$/);
  assert.match(preview.planSha256, /^[a-f0-9]{64}$/);
  await writeFile(join(fixture.root, "coordinator-preview.json"), JSON.stringify(preview));
  if (selected.mode === "preflight-safety") {
    assert.equal(preview.writerBoundary, "cold-host-unproven");
    const beforeTransition = { root: await snapshotTree(selected.root), profile: await snapshotTree(initial.profile) };
    for (const name of ["active-v5-migration-intent.json", "active-v5-migration.json", "active-v5-owner.json"])
      assert(!beforeTransition.profile[name], `Fresh native fixture unexpectedly contains ${name}`);
    await progress({ stage: "coordinator-preflight-ready" });
    assert.equal((await waitForJson(join(fixture.root, "preflight-dialog-monitor-ready.json"))).ready, true);
    let outcome;
    try { await invoke("productionTransition"); }
    catch (error) {
      outcome = { code: error.code, message: error.message };
    }
    assert(outcome, "The unsupported transition must reject, not resolve successfully");
    assert.equal(outcome.code, "LEGACY_WRITER_INVENTORY_UNAVAILABLE");
    assert.equal(outcome.message,
      "The active host cold-host boundary is unproven. Native inventory cannot exclude previously loaded/uninstalled legacy code. "
      + "This host's planning drain and empty child registry do not justify a same-PID writer exemption; installed takeover remains blocked.");
    const afterTransition = { root: await snapshotTree(selected.root), profile: await snapshotTree(initial.profile) };
    assert.deepEqual(afterTransition, beforeTransition, "Preflight rejection changed Root or host profile/intent state");
    const secondPreview = await invoke("productionPreview");
    assert.equal(secondPreview.status, "previewed", "A preflight rejection must leave real planning admission open");
    assert.equal(secondPreview.planSha256, preview.planSha256);
    assert.deepEqual({ root: await snapshotTree(selected.root), profile: await snapshotTree(initial.profile) }, beforeTransition);
    const disconnected = await invoke("productionDisconnect");
    assert.equal(disconnected.status, "disconnected");
    assert.deepEqual({ root: await snapshotTree(selected.root), profile: await snapshotTree(initial.profile) }, beforeTransition);
    await writeFile(join(fixture.root, "coordinator-preflight-outcome.json"), JSON.stringify({
      outcome, beforeTransition, afterTransition, secondPreview, disconnected,
    }));
    await progress({ stage: "coordinator-preflight-observed" });
    const dialogs = await waitForJson(join(fixture.root, "preflight-ui-verified.json"));
    assert.equal(dialogs.passed, true);
    assert.deepEqual(dialogs.visibleDialogs, []);
    await writeFile(join(fixture.root, "coordinator-preflight-passed.json"), JSON.stringify({
      passed: true, scope: "real-installed preflight safety/negative-path only",
      root: selected.root, profile: initial.profile, buildId: preview.buildId,
      outcome, beforeTransition, afterTransition, dialogs, secondPreview, disconnected,
      checks: ["actual-activation-exports-present", "forged-context-rejected-through-real-native-exports",
        "caller-native-api-and-proof-ignored", "real-preview-available", "exact-cold-host-unproven-rejection",
        "no-native-consent-dialog-observed", "root-and-profile-intent-unchanged", "second-preview-admission-still-open",
        "coordinator-disconnect-completed"],
      legacyResourceDrainVerified: false, adoptionVerified: false, managedReadVerified: false,
      rollbackVerified: false, liveTakeoverVerified: false, productionCutover: false,
    }));
    await progress({ stage: "coordinator-preflight-complete" });
    assert.equal((await waitForJson(join(fixture.root, "ui-passed.json"))).passed, true);
    return;
  }
  await progress({ stage: "coordinator-transition" });
  const connected = await invoke("productionTransition");
  assert.equal(connected.status, "connected");
  const record = await vscode.commands.executeCommand("pkm.nextHost.productionRead",
    { operation: "get", input: { id: selected.documentId } });
  assert.equal(record.result.id, selected.documentId);
  assert.match(record.result.content, /Disposable same-root fixture/);
  await invoke("productionDisconnect");
  assert.equal((await invoke("productionState")).status, "disconnected");
  await progress({ stage: "coordinator-rollback" });
  const rollback = await invoke("productionRollback");
  assert.equal((await invoke("productionState")).status, "rolled-back");
  assert.equal(rollback.schema, "pkm.legacy-root-postcommit-rollback-result/v1");
  assert((await stat(rollback.archive)).isDirectory());
  assert((await stat(join(rollback.archive, ".pkm-next-workspace"))).isFile());
  const after = await stat(selected.note, { bigint: true });
  assert.equal(after.ino, before.ino);
  assert.equal(after.dev, before.dev);
  assert.deepEqual(await readFile(selected.note), bytes);
  await assert.rejects(lstat(join(selected.root, ".pkm-next-workspace")), { code: "ENOENT" });
  const evidence = {
    passed: true, scope: "isolated native opt-in same-root coordinator; not production cutover",
    root: selected.root, profile: initial.profile, buildId: preview.buildId, planSha256: preview.planSha256,
    rollbackArchive: rollback.archive,
    checks: ["forged-context-rejected-by-real-activation", "caller-native-api-and-proof-ignored",
      "real-snapshot-status-consent", "separate-exact-migration-consent", "managed-document-read",
      "drain", "fresh-rollback-consent", "rolled-back", "note-inode-and-bytes-unchanged", "workspace-marker-removed"],
  };
  await writeFile(join(fixture.root, "coordinator-passed.json"), JSON.stringify(evidence));
  await progress({ stage: "coordinator-complete" });
  for (let attempt = 0; attempt < 150; attempt++) {
    try { if (JSON.parse(await readFile(join(fixture.root, "ui-passed.json"), "utf8")).passed) return; }
    catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("UI driver did not finish same-root coordinator verification");
}

exports.run = async () => {
  let timer;
  try {
    await Promise.race([run(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Installed-host dialog acceptance timed out")),
        (() => { const fixture = JSON.parse(process.env.PKM_HOST_INSTALLED_FIXTURE);
          return fixture.coordinator || fixture.sideBySide ? 210000 : 75000; })());
    })]);
  }
  catch (error) {
    const fixture = JSON.parse(process.env.PKM_HOST_INSTALLED_FIXTURE);
    await writeFile(join(fixture.root, "progress.json"), JSON.stringify({ stage: "failed", error: String(error) }));
    throw error;
  }
  finally { clearTimeout(timer); }
};

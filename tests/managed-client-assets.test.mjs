import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const project = resolve(import.meta.dirname, "../legacy");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
async function snapshot(root) {
  const files = {};
  async function walk(directory, prefix = "") {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(directory, entry.name), path);
      else files[path] = hash(await readFile(join(directory, entry.name)));
    }
  }
  await walk(root);
  return files;
}

test("production payload bytes and build ID are independent of root versus host caller CWD", { timeout: 120000 }, async t => {
  const root = resolve(import.meta.dirname, `.payload-cwd-${randomUUID()}`);
  await mkdir(root, { mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = resolve(import.meta.dirname, "..");
  const staging = require.resolve("../scripts/stage-runtime.cjs");
  const version = JSON.parse(await readFile(join(repository, "package.json"), "utf8")).version;
  const outputs = ["root", "host"].map(name => join(root, name));
  for (const [index, cwd] of [repository, join(repository, "clients/vscode-host")].entries()) {
    execFileSync(process.execPath, ["-e", `
      require(${JSON.stringify(staging)}).stage(${JSON.stringify(outputs[index])},
        { production: true, extensionVersion: ${JSON.stringify(version)} });
    `], { cwd, encoding: "utf8", timeout: 55000 });
  }
  const manifests = await Promise.all(outputs.map(output => readFile(join(output, "manifest.json"), "utf8")));
  const inventories = await Promise.all(outputs.map(snapshot));
  const changed = [...new Set(inventories.flatMap(files => Object.keys(files)))]
    .filter(name => inventories[0][name] !== inventories[1][name]);
  assert.deepEqual(changed, [], "Every staged byte must be independent of caller CWD.");
  assert.equal(manifests[1], manifests[0], "The payload manifest and build ID must also match byte-for-byte.");
  const manifest = JSON.parse(manifests[0]);
  delete inventories[0]["manifest.json"];
  assert.deepEqual(inventories[0], manifest.files);
  assert.equal(manifest.buildId, hash(JSON.stringify(manifest.files)));
});

test("v5 payload is reproducible and retained runtime dependencies work after relocation without checkout resolution", { timeout: 240000 }, async t => {
  const root = resolve(import.meta.dirname, `.payload-closure-${randomUUID()}`);
  await mkdir(root, { mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = join(root, "first"), extension = join(root, "relocated #100% ?");
  for (const directory of [first, extension]) await mkdir(directory, { mode: 0o700 });
  const relocated = join(extension, "next-runtime");
  const { stage, retainedRuntimeFiles } = require("../scripts/stage-runtime.cjs");
  const version = JSON.parse(await readFile(resolve(import.meta.dirname, "../package.json"), "utf8")).version;
  stage(join(first, "next-runtime"), { production: true, extensionVersion: version });
  stage(relocated, { production: true, extensionVersion: version });
  const manifest = JSON.parse(await readFile(join(first, "next-runtime/manifest.json"), "utf8"));
  assert.deepEqual(JSON.parse(await readFile(join(relocated, "manifest.json"), "utf8")), manifest);
  assert.equal(manifest.buildId, hash(JSON.stringify(manifest.files)));
  const actual = await snapshot(relocated);
  delete actual["manifest.json"];
  assert.deepEqual(actual, manifest.files);
  assert(!Object.keys(actual).some(name => /^server\/(?:src|tests|legacy\/src|node_modules\/(?:typescript|esbuild))\//.test(name)),
    "No checkout implementation or build dependencies are staged.");
  const retainedFiles = retainedRuntimeFiles();
  assert.deepEqual(Object.keys(actual).filter(name => name.startsWith("server/legacy/dist/"))
    .map(name => name.slice("server/legacy/dist/".length)).sort(), retainedFiles);
  for (const name of retainedFiles)
    assert.equal(actual[`server/legacy/dist/${name}`], hash(await readFile(join(project, "dist", name))),
      `Retained ${name} must be the unchanged compiled module, not an independently bundled brand.`);
  await rm(first, { recursive: true });
  const runtime = join(relocated, "server"), scratch = join(root, "locks");
  const nativeRoot = join(root, "native-root"), profile = join(root, "native-profile");
  for (const directory of [scratch, nativeRoot, profile, join(extension, "dist")])
    await mkdir(directory, { mode: 0o700 });
  await mkdir(join(nativeRoot, ".pkm"), { mode: 0o700 });
  await writeFile(join(nativeRoot, ".pkm/content-privacy.json"), "{}", { mode: 0o600 });
  await writeFile(join(extension, "package.json"), JSON.stringify({ version }));
  await writeFile(join(extension, "dist/extension.cjs"), "// Isolated native-host identity fixture.\n");
  const script = `
    import assert from "node:assert/strict";
    import Module, { registerHooks, createRequire } from "node:module";
    import { fileURLToPath, pathToFileURL } from "node:url";
    import { join, sep } from "node:path";
    const runtime = ${JSON.stringify(runtime)};
    registerHooks({ resolve(specifier, context, next) {
      const result = next(specifier, context);
      if (result.url.startsWith("file:"))
        assert(fileURLToPath(result.url).startsWith(runtime + sep), "Checkout dependency: " + result.url);
      return result;
    } });
    const load = name => import(pathToFileURL(join(runtime, "dist", name)).href);
    const { pureComponentAvailable } = await load("action-pure-components.js");
    assert.equal(pureComponentAvailable(), true, "Pinned CommonJS component engine must remain usable.");
    const { legacyMarkdownAssets } = await load("legacy-sync-markdown-assets.js");
    const assets = legacyMarkdownAssets();
    assert.equal(assets.rewriteMarkdownAssetReferences("![image](old.assets/a.png)",
      reference => reference.replace("old.assets", "new.assets")), "![image](new.assets/a.png)");
    assert.equal(assets.isMarkdownAssetDirectory("old.assets"), true);
    const require = createRequire(pathToFileURL(join(runtime, "dist/cli.js")));
    const lock = require("../legacy/dist/runtime/cross-process-lock.js");
    assert.equal(await lock.withCrossProcessLock(${JSON.stringify(join(scratch, "target.lock"))},
      "staged payload test", 1000, async () => "locked"), "locked");
    const retained = require("./legacy-chatroom-retained.cjs");
    for (const name of ["ChatHub", "ChatJoinApprovalManager", "MeetingStateStore", "WebSocketServer"])
      assert.equal(typeof retained[name], "function", name);
    for (const name of ["zod", "@modelcontextprotocol/sdk/server/mcp.js", "yaml", "casbin", "ipaddr.js", "image-size"])
      assert(require.resolve(name).startsWith(join(runtime, "node_modules") + sep), name);
    await load("managed-client-child.js");
    const extensionPath = ${JSON.stringify(extension)}, nativeRoot = ${JSON.stringify(nativeRoot)};
    const profile = ${JSON.stringify(profile)};
    const installed = { id: "fixture.active-payload", extensionPath, isActive: true,
      packageJSON: { publisher: "fixture", name: "active-payload", main: "./dist/extension.cjs" } };
    const disposable = () => ({ dispose() {} });
    const vscode = {
      extensions: { all: [installed], onDidChange: disposable,
        getExtension: id => id === installed.id ? installed : undefined },
      workspace: { isTrusted: true, onDidChangeWorkspaceFolders: disposable, onDidChangeConfiguration: disposable,
        getConfiguration: () => ({ inspect: () => ({ globalValue: { enabled: true, root: nativeRoot } }) }) },
      window: { showWarningMessage: async (_message, _options, label) => label },
    };
    const originalLoad = Module._load;
    Module._load = function(specifier, ...args) {
      if (specifier === "vscode") return vscode;
      return Reflect.apply(originalLoad, this, [specifier, ...args]);
    };
    const context = { extensionPath, extension: installed, globalStorageUri: { fsPath: profile },
      subscriptions: [], secrets: { onDidChange: disposable } };
    installed.exports = Object.freeze({
      assertActiveMigrationContext(candidate) {
        assert.equal(candidate, context, "The fixture entrypoint rejects an alien activation context.");
      },
    });
    const retainedRequire = createRequire(pathToFileURL(join(runtime, "legacy/dist/runtime/next-payload-verifier.js")));
    const { verifyNextPayload } = retainedRequire("./next-payload-verifier.js");
    assert.equal(verifyNextPayload(extensionPath).buildId, ${JSON.stringify(manifest.buildId)});
    const { HostWriterAdmission } = retainedRequire("./host-writer-admission.js");
    const registryApi = retainedRequire("./managed-host-child-registry.js");
    const hostAdmission = new HostWriterAdmission(nativeRoot, () => nativeRoot);
    const registry = registryApi.createManagedHostChildRegistry(nativeRoot, hostAdmission);
    require("../legacy/dist/runtime/managed-host-child-registry.js")
      .assertManagedHostChildRegistry(registry, nativeRoot, hostAdmission);
    let childClosed = false;
    registry.register(async () => { childClosed = true; });
    await registry.close();
    assert.equal(childClosed, true);
    await hostAdmission.drain();
    const bridge = await load("active-vscode-migration-host.js");
    const coreCaller = await import(pathToFileURL(join(runtime, "dist/active-vscode-migration-host.js")).href);
    assert.throws(() => bridge.activateActiveVscodeMigrationHost({ ...context }), /alien activation context/);
    const host = bridge.activateActiveVscodeMigrationHost(context);
    try {
      assert.equal(await host.inspect(async () => "inspected"), "inspected");
      assert.throws(() => coreCaller.assertActiveVscodeMigrationHost(host), /drain/);
      await host.drain();
      coreCaller.assertActiveVscodeMigrationHost(host);
      assert.throws(() => coreCaller.assertActiveVscodeMigrationHost({ ...host }), /authentic/);
      const authority = await host.requestSnapshotAuthority();
      assert(authority, "Native snapshot approval must survive the packaged filestore/WeakMap boundaries.");
      retainedRequire("./legacy-snapshot-vscode-authority.js").assertLegacySnapshotVscodeAuthority(authority, context, host);
      coreCaller.assertActiveVscodeSnapshotAdmission(host, authority);
      const intent = { action: "adopt", sourceRoot: nativeRoot, planSha256: "a".repeat(64) };
      const grant = await host.requestMigrationApproval(intent);
      assert(grant);
      coreCaller.assertActiveVscodeMigrationGrant(host, grant, nativeRoot, intent);
      assert.throws(() => coreCaller.assertActiveVscodeMigrationGrant(host, { ...grant }, nativeRoot), /approval/);
    } finally { host.dispose(); }
    console.log("Relocated managed payload closure verified.");
  `;
  assert.match(execFileSync(process.execPath, ["--input-type=module", "-e", script],
    { cwd: relocated, encoding: "utf8", timeout: 30000 }), /Relocated managed payload closure verified/);
  const python = execFileSync("python3", ["-I", "-B", "-c", "import os,sys; print(os.path.realpath(sys.executable))"],
    { encoding: "utf8" }).trim();
  assert.match(execFileSync(process.execPath, [join(relocated, "check.cjs"), python],
    { cwd: relocated, encoding: "utf8", timeout: 30000 }), /payload and interpreter prerequisites verified/);
});

test("production client reads preserved legacy resources across Notes/Skills/Papers before and after controlled restart", { timeout: 240000 }, async t => {
  const root = join(project, "../tests", `.managed-assets-${randomUUID()}`);
  const extension = join(root, "extension"), source = join(root, "source");
  const parent = join(root, "parent"), legacy = join(root, "legacy");
  const clients = [];
  t.after(async () => {
    for (const client of clients) { try { await client.close(); } catch { /* Unknown sessions remain failed, never replayed. */ } }
    if (clients.every(client => client.isStopped())) await rm(root, { recursive: true, force: true });
  });
  for (const path of [root, extension, source, parent, legacy]) await mkdir(path, { mode: 0o700 });
  await writeFile(join(legacy, "fixture-sentinel.txt"), "Untouched synthetic legacy root.");
  await cp(join(project, "package.json"), join(extension, "package.json"));
  execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", project,
    "--outDir", join(extension, "dist"), "--sourceMap", "false"], { stdio: "pipe", timeout: 120000 });
  require("../scripts/stage-runtime.cjs").stage(join(extension, "next-runtime"), { production: true });
  const { NextManagedClient } = require(join(extension, "dist/runtime/next-managed-client.js"));
  const image = Buffer.alloc(140003);
  for (let index = 0; index < image.length; index++) image[index] = index % 251;
  const sharedName = "0123456789abcdef.bin", ignoredName = "fedcba9876543210.bin";
  const shared = Buffer.from([255, 0, 3, 10, 128]), diagram = Buffer.from("graph LR\nLegacy-->Preserved\n");
  const documents = [];
  for (const area of ["notes", "skills", "papers"]) {
    const sharedLinks = `![shared](_assets/${sharedName})\n\`![code](_assets/${ignoredName})\`\n![missing](_assets/0000000000000000.bin)\n`
      + (area === "skills" ? "![nested](_assets/diagrams/skill%20image.bin)\n" : "");
    const content = `![image](Design.assets/plot%20one.png)\n${sharedLinks}![outside](../../scripts/private.bin)\n`;
    const id = `knowledge_${hash(area).slice(0, 24)}`;
    const raw = `---\nschema: pkm.knowledge/v1\nknowledgeId: ${id}\nrevision: 2\naliases: []\ntitle: ${area} original\ncustomMetadata: keep-me\n---\n${content}`;
    await mkdir(join(source, area, "Team/Design.assets"), { recursive: true, mode: 0o700 });
    await writeFile(join(source, area, "Team/Design.md"), raw);
    await writeFile(join(source, area, "Team/Design.assets/plot one.png"), image);
    await writeFile(join(source, area, "Team/Design.assets/diagram.mmd"), diagram);
    await writeFile(join(source, area, "Team/Design.assets/empty.bin"), Buffer.alloc(0));
    await mkdir(join(source, area, "Team/_assets"), { mode: 0o700 });
    await writeFile(join(source, area, `Team/_assets/${sharedName}`), shared);
    await writeFile(join(source, area, `Team/_assets/${ignoredName}`), "not referenced outside code");
    if (area === "skills") {
      await mkdir(join(source, area, "Team/_assets/diagrams"), { mode: 0o700 });
      await writeFile(join(source, area, "Team/_assets/diagrams/skill image.bin"), image);
      await writeFile(join(source, area, "Team/_assets/unreferenced.bin"), "Preserve even when not discoverable as a referenced resource.");
    }
    documents.push({ id, area, raw, expectedCount: area === "skills" ? 5 : 4 });
  }
  const sourceBefore = await snapshot(source), legacyBefore = await snapshot(legacy);
  const client = new NextManagedClient(); clients.push(client);
  const python = execFileSync("python3", ["-I", "-B", "-c", "import os,sys; print(os.path.realpath(sys.executable))"], { encoding: "utf8" }).trim();
  const plan = await client.planImport(extension, parent, process.execPath, legacy, source, python);
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  assert.equal((await client.confirmImport(plan.planSha256)).outcome.status, "published");
  assert.equal((await client.importStatus()).outcome.status, "published");
  await client.attachImport();
  const targetBefore = await snapshot(plan.target);
  await assert.rejects(client.invoke("update", {}), /read-only/);

  async function readResources(active) {
    for (const document of documents) {
      const record = (await active.invoke("get", { id: document.id })).result;
      assert.equal(record.area, document.area);
      const first = (await active.invoke("asset-list", { id: document.id, limit: 1 })).result;
      assert.equal(first.total, document.expectedCount);
      assert.equal(first.area, document.area);
      assert.equal(first.documentSha256, record.sha256);
      assert.equal(first.nextOffset, 1);
      assert(first.diagnostics.some(item => item.code === "outside-area"));
      assert(first.diagnostics.some(item => item.code === "missing-resource"));
      const later = (await active.invoke("asset-list", { id: document.id, offset: 1, limit: 100, revision: first.revision })).result;
      const items = [...first.items, ...later.items];
      assert.equal(later.nextOffset, null);
      assert(items.some(item => item.path.endsWith("diagram.mmd")), "Unreferenced owned diagrams remain discoverable.");
      assert(!items.some(item => item.path.endsWith(ignoredName)), "Fenced/inline-code references do not grant resource membership.");
      const imageEntry = items.find(item => item.path.endsWith("plot one.png"));
      const empty = items.find(item => item.path.endsWith("empty.bin"));
      const emptyChunk = (await active.invoke("asset-get", { id: document.id, path: empty.path,
        expectedDocumentSha256: record.sha256, expectedDigest: empty.digest })).result;
      assert.equal(emptyChunk.data, "");
      assert.equal(emptyChunk.size, 0);
      assert.equal(emptyChunk.nextOffset, null);
      assert.equal(imageEntry.digest, `sha256:${hash(image)}`);
      const pins = { id: document.id, path: imageEntry.path, expectedDocumentSha256: record.sha256, expectedDigest: imageEntry.digest };
      const chunks = [];
      let offset = 0;
      do {
        const response = await active.invoke("asset-get", { ...pins, offset });
        assert(!response.error, JSON.stringify(response.error));
        const chunk = response.result, bytes = Buffer.from(chunk.data, "base64");
        assert.equal(chunk.offset, offset);
        assert.equal(chunk.documentSha256, record.sha256);
        assert.equal(chunk.digest, imageEntry.digest);
        assert.equal(chunk.area, document.area);
        assert.equal(chunk.size, image.length);
        assert(bytes.length <= 65536);
        chunks.push(bytes);
        offset = chunk.nextOffset;
      } while (offset !== null);
      assert.deepEqual(Buffer.concat(chunks), image);
      assert.equal((await active.invoke("asset-list", { id: document.id, revision: "0".repeat(64) })).error.code, "CONFLICT");
      assert.equal((await active.invoke("asset-get", { ...pins, expectedDocumentSha256: "0".repeat(64) })).error.code, "CONFLICT");
      assert.equal((await active.invoke("asset-get", { ...pins, expectedDigest: `sha256:${"0".repeat(64)}` })).error.code, "CONFLICT");
      assert.equal((await active.invoke("asset-get", { ...pins, length: 65537 })).error.code, "INVALID_ARGUMENT");
      assert.equal((await active.invoke("asset-get", { ...pins, path: "../../private.bin" })).error.code, "INVALID_ARGUMENT");
      assert.equal((await active.invoke("asset-get", { ...pins, path: "Team/Design.assets/pkm-todo-board.json" })).error.code, "ACCESS_DENIED");
      assert.equal((await active.invoke("asset-get", { ...pins, path: `Team/_assets/${ignoredName}` })).error.code, "NOT_FOUND");
      {
        const entry = items.find(item => item.path.endsWith(sharedName));
        assert.deepEqual(Buffer.from((await active.invoke("asset-get", { id: document.id, path: entry.path,
          expectedDocumentSha256: record.sha256, expectedDigest: entry.digest })).result.data, "base64"), shared);
      }
      if (document.area === "skills") {
        const entry = items.find(item => item.path.endsWith("diagrams/skill image.bin"));
        const chunk = (await active.invoke("asset-get", { id: document.id, path: entry.path,
          expectedDocumentSha256: record.sha256, expectedDigest: entry.digest })).result;
        assert.deepEqual(Buffer.from(chunk.data, "base64"), image.subarray(0, 65536));
        assert.equal(chunk.nextOffset, 65536);
      }
      assert.equal(await readFile(join(plan.target, document.area, "Team/Design.md"), "utf8"), document.raw);
    }
  }
  await readResources(client);
  assert.deepEqual(await snapshot(plan.target), targetBefore, "Readonly resource discovery/chunks must not write database, assets or Markdown.");
  const prepared = await client.prepareImportWrite();
  const credential = await client.enableImportWrite(prepared.authorizationDigest, prepared.target);
  await readResources(client);
  await client.close();
  const restarted = new NextManagedClient(); clients.push(restarted);
  await restarted.resumeImport(extension, credential, process.execPath, legacy);
  await readResources(restarted);
  await restarted.close();
  assert.deepEqual(await snapshot(source), sourceBefore);
  assert.deepEqual(await snapshot(legacy), legacyBefore);
  for (const [path, digest] of Object.entries(sourceBefore)) assert.equal(hash(await readFile(join(plan.target, path))), digest);
  const changedParent = join(root, "changed-parent");
  await mkdir(changedParent, { mode: 0o700 });
  const changed = new NextManagedClient(); clients.push(changed);
  const changedPlan = await changed.planImport(extension, changedParent, process.execPath, legacy, source, python);
  await changed.confirmImport(changedPlan.planSha256);
  await changed.attachImport();
  const resourceList = (await changed.invoke("asset-list", { id: documents[0].id })).result;
  const resource = resourceList.items.find(item => item.path.endsWith("plot one.png"));
  const targetAsset = join(changedPlan.target, "notes", resource.path);
  await writeFile(targetAsset, "unexpected external writer");
  const pins = { id: documents[0].id, path: resource.path,
    expectedDocumentSha256: resourceList.documentSha256, expectedDigest: resource.digest };
  await assert.rejects(changed.invoke("asset-get", pins), /outcome unknown/);
  await writeFile(targetAsset, image);
  await assert.rejects(changed.invoke("asset-get", pins), /previously failed/);
  await changed.close();
  assert.deepEqual(await snapshot(source), sourceBefore);
  assert.deepEqual(await snapshot(legacy), legacyBefore);
});

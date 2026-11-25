import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import * as childProcess from "node:child_process";
import { execFileSync } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import * as fsPromises from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { after, mock, test } from "node:test";
import * as recovery from "../experimental/cold-state-recovery.mjs";
import * as actualRoot from "../dist/original-mcp-root.js";
import * as actualFence from "../dist/linux-root-writer-fence.js";
import * as actualGate from "../dist/linux-legacy-writer-quiescence.js";
import * as actualProfile from "../dist/original-mcp-profile-binding.js";
import * as actualNoReplace from "../dist/rename-no-replace.js";
import * as actualGit from "../dist/original-mcp-git-protection.js";
import * as actualRootMode from "../dist/original-mcp-root-mode.js";
import * as actualIdentity from "../dist/original-mcp-native-identity.js";
import { originalMcpBrokerAvailability } from "../dist/original-mcp-broker.js";
import {
  planOriginalMcpCutover, assertOriginalMcpFullParity, originalMcpCutoverCatalogSha256,
  originalMcpCutoverCatalogRevision, originalMcpCutoverPublicTools, originalMcpNativeAttachmentContract,
} from "../experimental/original-mcp-cutover.mjs";

assert(process.env.PKM_TEST_WORKSPACE, "Use the Linux framework; never run against an ordinary profile.");
const work = process.env.PKM_TEST_WORKSPACE;
// Real pathname sockets have a kernel length limit. A fresh, short, private
// fixture HOME remains under recovery storage, not a symlink or gate exemption.
const home = join(homedir(), ".local/state/pkm-v5-recovery", `t-${randomBytes(4).toString("hex")}`);
await mkdir(home, { mode: 0o700 });
const homeIdentity = await lstat(home, { bigint: true });
after(async () => {
  const current = await lstat(home, { bigint: true });
  assert.equal(current.ino, homeIdentity.ino); assert.equal(current.dev, homeIdentity.dev);
  assert.equal(current.uid, homeIdentity.uid); assert(!current.isSymbolicLink());
  await rm(home, { recursive: true });
});
process.env.HOME = home;
process.umask(0o077);
const base = join(home, ".local/state/pkm-v5-recovery");
await mkdir(base, { recursive: true, mode: 0o700 });
const hex = bytes => createHash("sha256").update(bytes).digest("hex");
const encode = value => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item) + "\n";
const hash = value => hex(encode(value));
const paths = ["experimental/original-mcp-cutover.mjs", "experimental/cold-state-recovery.mjs",
  ...["original-mcp-root", "original-mcp-broker", "original-mcp-broker-descriptor", "original-mcp-profile-binding",
    "original-mcp-relay-cli", "original-mcp-public", "original-mcp-native-host", "linux-root-writer-fence",
    "linux-legacy-writer-quiescence", "rename-no-replace", "original-mcp-git-protection", "original-mcp-root-mode",
    "original-mcp-native-attachment", "original-mcp-native-identity"].map(name => `dist/${name}.js`)];
async function privateJson(path, value) { await writeFile(path, encode(value), { mode: 0o600 }); return { path, sha256: hex(await readFile(path)) }; }
async function pin(path) { return { path, sha256: hex(await readFile(path)) }; }
function report(oracle, ready = true) {
  return { schema: "pkm.original-mcp-implementation-readiness/v1", acceptedScope: "preserve-existing-mcp/v1",
    catalogSha256: originalMcpCutoverCatalogSha256, catalogRevision: originalMcpCutoverCatalogRevision,
    requiredOperationIds: oracle.operationIds, implementedOperationIds: ready ? oracle.operationIds : oracle.operationIds.slice(1),
    missingImplementations: ready ? [] : [{ operationId: oracle.operationIds[0], code: "MISSING_NATIVE_ADAPTER" }],
    authorityRequirements: [{ id: "model-provider" }, { id: "tool-approval" }], ready };
}

async function fixture(t, { compactRelay = false } = {}) {
  t.after(() => mock.restoreAll());
  const cleanup = [];
  const directory = join(work, `cutover-fixture-${randomUUID()}`);
  const originalRoot = join(directory, "original"), userData = join(directory, "native-user"), extensions = join(directory, "extensions");
  const storage = join(userData, "globalStorage/pkm-nonproduction.pkm-v5");
  const release = join(directory, "release");
  for (const path of [join(originalRoot, "notes"), join(originalRoot, "skills"), join(originalRoot, "papers"),
    join(originalRoot, ".pkm/state/actions"), storage, extensions, release])
    await mkdir(path, { recursive: true, mode: 0o700 });
  execFileSync("/usr/bin/git", ["init", "--quiet", originalRoot],
    { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  await writeFile(join(originalRoot, ".gitignore"), "# synthetic existing ignore policy\n", { mode: 0o600 });
  await chmod(originalRoot, 0o775);
  await chmod(join(originalRoot, "notes"), 0o775);
  await writeFile(join(originalRoot, "notes/Entry.md"), "---\ntitle: Entry\n---\nSynthetic original content.\n", { mode: 0o600 });
  await privateJson(join(originalRoot, ".pkm/content-privacy.json"), { schema: 1, private: {} });
  await privateJson(join(originalRoot, ".pkm/state/actions/settings.json"), { fixture: "inert" });
  const installed = join(extensions, "uone.personal-knowledge-4.0.22");
  await mkdir(join(installed, "dist"), { recursive: true, mode: 0o700 });
  await privateJson(join(installed, "package.json"), { publisher: "uone", name: "personal-knowledge", version: "4.0.22", main: "./dist/extension.js" });
  await writeFile(join(installed, "dist/extension.js"), "export const syntheticOldExtension=true;\n", { mode: 0o600 });
  const nativePackage = join(extensions, "pkm-nonproduction.pkm-v5-0.1.0/package.json");
  await mkdir(join(nativePackage, ".."), { recursive: true, mode: 0o700 });
  await privateJson(nativePackage, { publisher: "pkm-nonproduction", name: "pkm-v5", version: "0.1.0" });
  const nativeHostEntry = join(nativePackage, "../dist/extension.cjs");
  await mkdir(join(nativeHostEntry, ".."), { recursive: true, mode: 0o700 });
  await writeFile(nativeHostEntry, "module.exports.fixtureNativeProducer=true;\n", { mode: 0o600 });
  const payloadManifest = join(nativePackage, "../next-runtime/manifest.json");
  await mkdir(join(payloadManifest, ".."), { recursive: true, mode: 0o700 });
  const payloadBuildId = hex("fixture-native-payload");
  await privateJson(payloadManifest, { buildId: payloadBuildId, fixtureOnly: true });
  const vsix = join(directory, "old.vsix");
  execFileSync("python3", ["-I", "-B", "-c",
    "import zipfile,sys,pathlib\nroot=pathlib.Path(sys.argv[1])\nwith zipfile.ZipFile(sys.argv[2],'w') as z:\n for p in ['package.json','dist/extension.js']: z.write(root/p,'extension/'+p)",
    installed, vsix]);
  await chmod(vsix, 0o600);
  const cli = join(directory, "code-server");
  await writeFile(cli, "#!/bin/sh\nexit 99\n", { mode: 0o700 }); // Executed only through explicit unit-test command spies.
  const node = await pin(await realpath(process.execPath));
  const operationIds = Array.from({ length: 151 }, (_v, index) => `mcp.tool.fixture_${index}`);
  const aliasNames = [...["note", "skill", "paper"].flatMap(module => ["read", "write", "modify", "list", "search"].map(action => `${module}_${action}`)),
    "project_read", "project_list", "project_search"];
  const aliasSchema = { type: "object", properties: {}, additionalProperties: false };
  const directAliases = aliasNames.map((name, index) => ({ name, operation: operationIds[index], version: 1,
    readOnly: !/_(?:write|modify)$/.test(name), inputSchemaSha256: hash(aliasSchema) }));
  const oracle = { schema: "pkm.original-mcp-cutover-oracle/v1", catalogSha256: originalMcpCutoverCatalogSha256,
    catalogRevision: originalMcpCutoverCatalogRevision, operationIds, toolSurface: "hybrid", directAliases,
    describes: operationIds.map(operation => ({ operation, sha256: hash({ operation, fixture: true }) })),
    discovery: Array.from({ length: 23 }, (_v, index) => ({ tool: "capabilities_list",
      arguments: { path: `fixture-${index}`, limit: 3, offset: 0 }, sha256: hash({ fixture: index, operations: [] }) })) };
  const relay = `
import readline from 'node:readline';
const tools=${JSON.stringify([...originalMcpCutoverPublicTools, ...(compactRelay ? [] : aliasNames)])};
const schema=${JSON.stringify(aliasSchema)};
for await (const line of readline.createInterface({input:process.stdin})) {
 const q=JSON.parse(line); if(q.id===undefined)continue; let result={};
 if(q.method==='tools/list')result={tools:tools.map(name=>({name,inputSchema:schema}))};
 if(q.method==='tools/call'){
  const a=q.params.arguments;
  const v=q.params.name==='capabilities_describe'?{operation:a.operation,fixture:true}:
   a.path==='todo'||a.path==='memory'?{operations:[{id:a.path+'.fixture'}]}:
    {fixture:Number(a.path.slice(8)),operations:[]};
  result={structuredContent:v,content:[]};
 }
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');
}`;
  for (const path of paths) {
    await mkdir(join(release, path, ".."), { recursive: true, mode: 0o700 });
    if (path === "experimental/original-mcp-cutover.mjs" || path === "dist/original-mcp-profile-binding.js")
      await copyFile(resolve(path), join(release, path));
    else await writeFile(join(release, path), path === "dist/original-mcp-relay-cli.js" ? relay
      : ["dist/original-mcp-git-protection.js", "dist/original-mcp-root-mode.js", "dist/original-mcp-native-identity.js"].includes(path)
        ? `export * from ${JSON.stringify(pathToFileURL(resolve(path)).href)};\n`
        : "export {};\n", { mode: 0o600 });
    await chmod(join(release, path), 0o600);
  }
  const manifest = { schema: "pkm.original-mcp-cutover-release/v1", files: await Promise.all(paths.map(async path =>
    ({ path, sha256: hex(await readFile(join(release, path))) }))), node, buildSha256: hex("fixture release"),
    catalogSha256: originalMcpCutoverCatalogSha256, catalogRevision: originalMcpCutoverCatalogRevision,
    toolSurface: "hybrid", aliasSurfaceSha256: hash(directAliases),
    extension: { id: "pkm-nonproduction.pkm-v5", version: "0.1.0" } };
  const manifestPin = await privateJson(join(release, "release-manifest.json"), manifest);
  const nativeCli = await pin(cli);
  const qualification = await privateJson(join(directory, "qualification.json"), {
    schema: "pkm.original-mcp-cutover-release-qualification/v1", releaseSha256: manifestPin.sha256,
    catalogSha256: originalMcpCutoverCatalogSha256, acceptedScope: "preserve-existing-mcp/v1",
    actualNativeRuntime: true, describesPassed: 151, discoveryCasesPassed: 23, nativeCliCasesPassed: 9,
    canonicalDomains: ["todo", "memory"], canonicalRuntimeCasesPassed: 2, nativeCliSha256: nativeCli.sha256,
    toolSurface: "hybrid", aliasSurfaceSha256: hash(directAliases), directAliasCasesPassed: directAliases.length,
    nativeAttachmentContractSha256: hash(originalMcpNativeAttachmentContract),
    nativeCredentialPolicy: "native-reenroll-separate-id", nativeDeploymentCasesPassed: 1,
  }); // Fixture-only report. Full execution tests mock fixed production modules, never production authority.
  const recoveryPin = await privateJson(join(directory, "recovery-request.json"), {
    schema: "pkm.cold-state-request/v1", originalRoot,
    externalDirectories: [{ id: "native-user", path: userData }, { id: "extensions", path: extensions }],
    configurationFiles: [], opaqueLinks: "refuse",
  });
  const unitFile = await privateJson(join(directory, "unused-unit.json"), {});
  await rm(unitFile.path);
  await writeFile(unitFile.path, `[Service]\nExecStart=${cli} --start-server --user-data-dir ${userData} --extensions-dir ${extensions} --disable-extension uone.personal-knowledge\n`, { mode: 0o600 });
  const identity = actualIdentity.originalMcpNativeIdentity(
    generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    actualProfile.originalMcpProfileBinding(storage).sha256);
  const publicEnrollment = await privateJson(join(storage, "original-mcp-native-identity.json"), identity);
  const request = { schema: "pkm.original-mcp-cutover-request/v1", acceptedScope: "preserve-existing-mcp/v1",
    operatorId: "fixture-operator", originalRoot, recovery: recoveryPin, rootMode: { approvedMode: 0o700 },
    nativeDeployment: { publicEnrollment, identitySha256: identity.sha256, package: await pin(nativePackage),
      payloadBuildId, hostEntry: await pin(nativeHostEntry), payloadManifest: await pin(payloadManifest),
      protocolSha256: hash(originalMcpNativeAttachmentContract), credentialPolicy: "native-reenroll-separate-id" },
    profile: { storageDirectory: storage, sha256: actualProfile.originalMcpProfileBinding(storage).sha256,
      userDataDirectory: userData, extensionsDirectory: extensions },
    legacy: { installedDirectory: installed, package: await pin(join(installed, "package.json")),
      main: await pin(join(installed, "dist/extension.js")), vsix: await pin(vsix) },
    nativeCli, release: { directory: release, manifest: manifestPin, qualification, oracle: await privateJson(join(directory, "oracle.json"), oracle) },
    maintenance: { systemctl: await pin(await realpath("/usr/bin/systemctl")), unit: "synthetic-pkm-profile.service",
      unitFile: await pin(unitFile.path), hostExecutable: nativeCli },
    custodyLimits: { maxEntries: 10000, maxDepth: 32, maxBytes: 67108864, maxFileBytes: 16777216 } };
  const stageDirectory = join(base, `cutover-${randomUUID()}`);
  const planned = await planOriginalMcpCutover(request, stageDirectory);
  const plan = JSON.parse(await readFile(planned.path, "utf8"));
  t.after(async () => {
    const errors = [];
    for (const close of cleanup.reverse()) try { await close(); } catch (error) { errors.push(error); }
    try { await rm(directory, { recursive: true }); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Owned cutover fixture cleanup failed.");
  });
  return { directory, originalRoot, request, oracle, manifest, planned, plan, stageDirectory, cleanup };
}

async function transactionMocks(t, f, mode = {}) {
  const events = [], deployments = new WeakSet(), bootstraps = new WeakSet(), attachments = new WeakSet();
  let fence, owner, opened, bootstrap, brokerInfo, nativeAttached = false;
  let resolveAttachment;
  const attachmentGate = new Promise(resolve_ => { resolveAttachment = resolve_; });
  let resolveClosed, rejectClosed;
  const brokerClosed = new Promise((resolve_, reject) => { resolveClosed = resolve_; rejectClosed = reject; });
  const releaseFault = (resource, error) => {
    if (!error) return resource;
    const release = resource.release.bind(resource);
    let injected = false;
    mock.method(resource, "release", async () => {
      await release();
      if (!injected) { injected = true; throw error; }
    });
    return resource;
  };
  const staged = (entry, namedExports) => mock.module(pathToFileURL(join(f.stageDirectory, "runtime", entry)).href, { namedExports });
  staged("dist/original-mcp-public.js", { async verifyOriginalMcpImplementationReadiness() {
    events.push("readiness"); return report(f.oracle, mode.ready !== false);
  } });
  staged("dist/original-mcp-profile-binding.js", actualProfile);
  staged("dist/linux-legacy-writer-quiescence.js", actualGate);
  staged("dist/linux-root-writer-fence.js", {
    ...actualFence,
    async acquireLinuxRootWriterFence(root) {
      events.push("fence"); fence = releaseFault(await actualFence.acquireLinuxRootWriterFence(root), mode.fenceReleaseError); return fence;
    },
  });
  staged("dist/original-mcp-root-mode.js", {
    ...actualRootMode,
    async applyOriginalMcpRootMode(plan, options) {
      assert(events.includes("b0-restored")); assert(!events.includes("git-protection"));
      assert.equal(options.writerFence, fence); events.push("root-mode");
      return actualRootMode.applyOriginalMcpRootMode(plan, options);
    },
  });
  staged("dist/rename-no-replace.js", actualNoReplace);
  staged("dist/original-mcp-git-protection.js", {
    ...actualGit,
    async applyOriginalMcpGitProtection(plan, options) {
      assert(events.includes("b0-restored")); assert(!events.includes("prepare"));
      assert(events.includes("root-mode"));
      assert.equal(options.writerFence, fence); events.push("git-protection");
      return actualGit.applyOriginalMcpGitProtection(plan, options);
    },
  });
  const attachmentAPI = {
    originalMcpNativeAttachmentContract,
    async verifyOriginalMcpOfflineDeployment(input) {
      events.push("offline-deployment");
      const value = { async close() { events.push("authority-close"); if (mode.authorityCloseError) throw mode.authorityCloseError; },
        facts: { schema: "pkm.original-mcp-offline-deployment/v1", root: f.originalRoot,
          profileSha256: f.request.profile.sha256, operatorId: f.request.operatorId,
          releaseSha256: f.request.release.manifest.sha256, packageSha256: f.request.nativeDeployment.package.sha256,
          publicEnrollmentSha256: f.request.nativeDeployment.publicEnrollment.sha256,
          identitySha256: f.request.nativeDeployment.identitySha256, payloadBuildId: f.request.nativeDeployment.payloadBuildId,
          hostEntrySha256: f.request.nativeDeployment.hostEntry.sha256,
          payloadManifestSha256: f.request.nativeDeployment.payloadManifest.sha256,
          protocolSha256: f.request.nativeDeployment.protocolSha256, credentialPolicy: "native-reenroll-separate-id",
          modelAuthority: false, humanAuthority: false, businessReady: false },
        managedRootFiles: f.plan.sourceRootWritePlan.filter(entry => entry.operation === "create-only").map(entry => entry.path) };
      if (mode.extraStartupWrite) value.managedRootFiles.push(join(f.originalRoot, ".pkm-next-retrieval-models/model.bin"));
      if (mode.offlineClaimsAuthority) value.facts.modelAuthority = true;
      assert.equal(input.contract.offlineQualification, "deployment-facts-only");
      deployments.add(value); events.push("deployment"); return value;
    },
    isTrustedOriginalMcpOfflineDeployment(value) { return deployments.has(value); },
    async bootstrapOriginalMcpNativeAttachment(options) {
      events.push("bootstrap"); assert.equal(options.writerFence, fence); options.gitProtection.assertCurrent();
      assert(deployments.has(options.deployment));
      if (mode.brokerStartError) throw mode.brokerStartError;
      opened = await actualRoot.openOriginalMcpRoot(options.plan, { writerFence: options.writerFence,
        gitProtection: options.gitProtection, prepareNative: async () => {
          events.push("prepare-native-factory"); assert(nativeAttached, "No native factory/recovery before attachment.");
          return {};
        } });
      owner = opened.owner; events.push("owner");
      const attachmentDescriptorPath = join(options.directory, "native-attachment.json");
      await writeFile(attachmentDescriptorPath, encode({
        schema: originalMcpNativeAttachmentContract.descriptorSchema, brokerId: randomUUID(),
        identitySha256: mode.badControlDescriptor ? "0".repeat(64) : f.request.nativeDeployment.identitySha256,
        binding: { root: f.originalRoot, workspaceId: opened.workspaceId, planSha256: opened.planSha256,
          catalogSha256: originalMcpCutoverCatalogSha256, profileSha256: f.request.profile.sha256,
          payloadBuildId: f.request.nativeDeployment.payloadBuildId, hostEntrySha256: f.request.nativeDeployment.hostEntry.sha256 },
        socketPath: join(options.directory, "n"),
      }), { mode: 0o600 });
      bootstrap = { ...opened, attachmentDescriptorPath, attachmentDescriptorSha256: hex(await readFile(attachmentDescriptorPath)),
        businessReady: false, storageRecovered: false,
        ...(mode.observeBrokerClosure ? { closed: brokerClosed } : {}),
        async close() { events.push("bootstrap-close"); await owner.close(); resolveClosed({ reason: "maintenance" }); } };
      bootstraps.add(bootstrap);
      assert(!events.includes("prepare-native-factory"));
      return bootstrap;
    },
    isTrustedOriginalMcpNativeBootstrap(value) { return bootstraps.has(value); },
    async verifyOriginalMcpNativeAttachmentDescriptor(path, pin) {
      return { ...JSON.parse(await readFile(path, "utf8")), descriptorPath: path, descriptorSha256: pin };
    },
    async waitForOriginalMcpNativeAttachment(value) {
      assert.equal(value, bootstrap); events.push("wait-native-attachment");
      if (mode.deferAttachment) await attachmentGate;
      const result = { async close() { events.push("native-attachment-close"); } };
      if (!mode.badAttachment) attachments.add(result);
      return result;
    },
    isTrustedOriginalMcpNativeAttachment(value) { return attachments.has(value); },
    async admitOriginalMcpNativeAttachment(value, attachment) {
      assert.equal(value, bootstrap); assert(attachments.has(attachment)); nativeAttached = true;
      events.push("native-attachment");
      return { schema: "pkm.original-mcp-native-admission/v1", profileSha256: f.request.profile.sha256,
        workspaceId: opened.workspaceId, planSha256: opened.planSha256,
        publicEnrollmentSha256: f.request.nativeDeployment.publicEnrollment.sha256, recoveryCompleted: true,
        identitySha256: f.request.nativeDeployment.identitySha256, payloadBuildId: f.request.nativeDeployment.payloadBuildId,
        hostEntrySha256: f.request.nativeDeployment.hostEntry.sha256,
        credentialPolicy: "native-reenroll-separate-id", oldCredentialsTouched: false, epoch: "fixture-native-epoch",
        canonicalDomains: ["todo", "memory"], enabledOperationIds: f.oracle.operationIds };
    },
    async publishOriginalMcpNativeBusiness(options) { return brokerExports.startOriginalMcpBroker(options); },
    async verifyOriginalMcpNativeActivation() {
      throw Object.assign(new Error("Fixture is not a native activation proof."), { code: "NATIVE_ACTIVATION_QUALIFICATION_REQUIRED" });
    },
  };
  staged("dist/original-mcp-native-attachment.js", mode.noAuthority ? {} : attachmentAPI);
  // Old model-policy callbacks are deliberately not an attachment producer.
  staged("dist/original-mcp-native-host.js", {});
  staged("experimental/cold-state-recovery.mjs", {
    ...recovery,
    async captureColdStateRecovery(request, path, options) {
      events.push("b0-capture"); assert.equal(options.writerFence, fence);
      if (mode.b1CaptureError && path.includes("-b1-")) throw mode.b1CaptureError;
      if (mode.badBackup) throw Object.assign(new Error("Fixture bad backup"), { code: "CORRUPT_BYTES" });
      return recovery.captureColdStateRecovery(request, path, options);
    },
    async restoreColdStateRecovery(...args) {
      const restored = await recovery.restoreColdStateRecovery(...args);
      events.push("b0-restored");
      if (mode.sourceChanged) await writeFile(join(f.originalRoot, ".pkm/state/actions/settings.json"), '{"changed":true}', { mode: 0o600 });
      return restored;
    },
  });
  staged("dist/original-mcp-root.js", {
    ...actualRoot,
    async acquireOriginalMcpRootFence(root) {
      events.push("fence"); fence = releaseFault(await actualRoot.acquireOriginalMcpRootFence(root), mode.b1ReleaseError); return fence;
    },
    async captureOriginalMcpCustody(request, options) { events.push("custody"); assert.equal(options.writerFence, fence); return actualRoot.captureOriginalMcpCustody(request, options); },
    async prepareOriginalMcpRoot(plan, options) {
      assert(events.includes("b0-restored")); assert(!events.includes("native-uninstall"));
      assert(events.includes("git-protection"));
      assert.equal(options.writerFence, fence); events.push("prepare");
      return actualRoot.prepareOriginalMcpRoot(plan, options);
    },
  });
  const brokerExports = {
    originalMcpBrokerAuthorizationSchema: { safeParse() { return { success: !mode.reduced }; } },
    originalMcpBrokerAvailability() { return mode.reduced ? originalMcpBrokerAvailability(true)
      : { enabledOperationIds: f.oracle.operationIds, disabledOperationIds: [], limitations: [] }; },
    async startOriginalMcpBroker(options) {
      events.push("broker"); assert.equal(options.bootstrap, bootstrap);
      assert.equal(options.toolSurface, "hybrid");
      options.gitProtection.assertCurrent();
      assert(attachments.has(options.attachment));
      assert(events.includes("prepare-native-factory"));
      const descriptorPath = join(f.plan.brokerDirectory, "descriptor.json");
      const body = encode({ fixture: true });
      await writeFile(descriptorPath, body, { mode: 0o600 });
      brokerInfo = { schema: "pkm.original-mcp-broker-verification/v1", root: f.originalRoot,
        rootDevice: f.plan.originalRootIdentity.dev, rootInode: f.plan.originalRootIdentity.ino,
        operatorId: f.request.operatorId, writable: true, descriptorPath, descriptorSha256: hex(body),
        scope: mode.brokerReducedAfterOpen ? "knowledge-content-only/v1" : "preserve-existing-mcp/v1",
        enabledOperationIds: f.oracle.operationIds, disabledOperationIds: [],
        nodePath: f.manifest.node.path, nodeSha256: f.manifest.node.sha256, runtimeBuildSha256: f.manifest.buildSha256,
        relayPath: join(f.stageDirectory, "runtime/dist/original-mcp-relay-cli.js"),
        relaySha256: f.manifest.files.find(entry => entry.path === "dist/original-mcp-relay-cli.js").sha256,
        workspaceId: opened.workspaceId, brokerPid: process.pid, profileSha256: f.request.profile.sha256 };
      return { descriptorPath, descriptorSha256: hex(body), owner, storage: opened.storage,
        async stop() {
          events.push("stop");
          if (mode.brokerStopError) throw mode.brokerStopError;
        } };
    },
  };
  staged("dist/original-mcp-broker.js", brokerExports);
  staged("dist/original-mcp-broker-descriptor.js", { async verifyOriginalMcpBrokerDescriptor() { events.push("authenticated-probe-fixture"); return brokerInfo; } });
  const { default: _default, ...nativeExports } = childProcess;
  const spy = (file, args, options, callback) => {
    if (file === f.request.maintenance.systemctl.path) {
      events.push("maintenance");
      callback(null, { stdout: `Id=${f.request.maintenance.unit}\nActiveState=${mode.hot ? "active" : "inactive"}\nSubState=dead\nUnitFileState=masked\nFragmentPath=/dev/null\nControlGroup=\nDropInPaths=\n`, stderr: "" });
    } else if (file === f.request.nativeCli.path) {
      assert(!args.includes("--uninstall-extension"), "Independent re-enrollment must leave old installation/credentials untouched.");
      callback(null, { stdout: "uone.personal-knowledge@4.0.22\npkm-nonproduction.pkm-v5@0.1.0\n", stderr: "" });
    } else return childProcess.execFile(file, args, options,
      (error, stdout, stderr) => callback(error, { stdout, stderr }));
  };
  // promisify(execFile) normally has a custom stdout/stderr result contract.
  const { promisify } = await import("node:util");
  spy[promisify.custom] = (file, args, options) => new Promise((resolve_, reject) => {
    spy(file, args, options, (error, value) => error ? reject(error) : resolve_(value));
  });
  mock.module("node:child_process", { namedExports: { ...nativeExports, execFile: spy,
    spawn(...args) {
      const child = childProcess.spawn(...args);
      if (mode.relayStdinCloseError && args[1]?.[0] === join(f.stageDirectory, "runtime/dist/original-mcp-relay-cli.js")) {
        const end = child.stdin.end.bind(child.stdin);
        child.stdin.end = (...values) => {
          const callback = values.at(-1);
          if (typeof callback === "function") return end(...values.slice(0, -1), () => callback(mode.relayStdinCloseError));
          end(...values); throw mode.relayStdinCloseError;
        };
      }
      return child;
    },
  } });
  if (mode.failureJournalError || mode.closeJournalError || mode.planReadCloseError) {
    const { default: defaultFs, ...nativeFs } = fsPromises;
    mock.module("node:fs/promises", { defaultExport: defaultFs, namedExports: {
      ...nativeFs,
      async open(path, ...args) {
        if (mode.failureJournalError && typeof path === "string" && path.endsWith("-failed-retained.json"))
          throw mode.failureJournalError;
        if (mode.closeJournalError && typeof path === "string" && /-broker-(?:closed|close-failed)\.json$/.test(path))
          throw mode.closeJournalError;
        const handle = await fsPromises.open(path, ...args);
        if (mode.planReadCloseError && path === f.planned.path)
          return new Proxy(handle, { get(target, property) {
            if (property === "close") return async () => { await target.close(); throw mode.planReadCloseError; };
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          } });
        return handle;
      },
    } });
  }
  const stagedCoordinator = await import(pathToFileURL(join(f.stageDirectory, "runtime/experimental/original-mcp-cutover.mjs")).href);
  const coordinator = { ...stagedCoordinator, async executeOriginalMcpCutover(...args) {
    const pending = await stagedCoordinator.executeOriginalMcpCutover(...args);
    return pending.complete();
  } };
  const oldCwd = process.cwd(); process.chdir(f.stageDirectory);
  f.cleanup.push(async () => {
    try { await owner?.close(); await fence?.release(); } finally { process.chdir(oldCwd); }
  });
  return { coordinator, stagedCoordinator, events, getFence: () => fence, rejectBrokerClosure: error => rejectClosed(error),
    attachNative: () => resolveAttachment() };
}

test("knowledge-only availability is never full parity merely because metadata has 151 names", () => {
  assert.throws(() => assertOriginalMcpFullParity({ ready: true, scope: "knowledge-content-only/v1",
    ...originalMcpBrokerAvailability(true) }, { operationIds: [] }), { code: "FULL_PARITY_UNAVAILABLE" });
});

for (const [label, mode, code] of [
  ["missing concrete handlers", { ready: false }, "FULL_PARITY_UNAVAILABLE"],
  ["reduced broker", { reduced: true }, "FULL_PARITY_UNAVAILABLE"],
  ["missing private attachment protocol", { noAuthority: true }, "NATIVE_ATTACHMENT_PROTOCOL_UNAVAILABLE"],
  ["unapproved native startup file", { extraStartupWrite: true }, "WRITE_PLAN_UNQUALIFIED"],
  ["uncontrolled native restart", { hot: true }, "MAINTENANCE_CONTROL_UNAVAILABLE"],
  ["bad B0", { badBackup: true }, "CORRUPT_BYTES"],
  ["changed source after B0", { sourceChanged: true }, "SOURCE_CHANGED"],
]) test(`fixed preflight/order gate: ${label} refuses before original/profile writes (unit native-command spies)`, async t => {
  const f = await fixture(t), unit = await transactionMocks(t, f, mode);
  await assert.rejects(unit.coordinator.executeOriginalMcpCutover(f.planned.path, f.planned.sha256), { code });
  assert(!unit.events.includes("prepare")); assert(!unit.events.includes("native-uninstall"));
  assert.equal((await lstat(f.originalRoot)).mode & 0o777, 0o775);
  await assert.rejects(lstat(join(f.originalRoot, ".pkm-next-workspace")), { code: "ENOENT" });
  await assert.rejects(lstat(f.plan.enrollmentPath), { code: "ENOENT" });
});

test("real B0/custody/fence/owner order precedes mocked native effects; future full broker unit fixture is not production qualification", async t => {
  const f = await fixture(t), unit = await transactionMocks(t, f);
  const result = await unit.coordinator.executeOriginalMcpCutover(f.planned.path, f.planned.sha256);
  t.after(() => result.close());
  const index = event => unit.events.indexOf(event);
  assert(index("fence") < index("b0-capture"));
  assert(index("b0-restored") < index("custody"));
  assert(index("b0-restored") < index("git-protection"));
  assert(index("b0-restored") < index("root-mode"));
  assert(index("root-mode") < index("git-protection"));
  assert(index("git-protection") < index("custody"));
  assert(index("custody") < index("prepare"));
  assert(index("owner") < index("native-attachment"));
  assert(index("native-attachment") < index("prepare-native-factory"));
  assert(index("prepare-native-factory") < index("broker"));
  assert(index("broker") < index("authenticated-probe-fixture"));
  assert(!unit.events.includes("native-uninstall"));
  assert.equal(result.activated, false);
  const enrollment = JSON.parse(await readFile(result.enrollmentPath, "utf8"));
  assert.deepEqual(Object.keys(enrollment).sort(), ["descriptorPath", "descriptorSha256", "profileSha256", "schema"]);
  unit.getFence().assertHeld();
  assert.equal((await lstat(f.originalRoot)).mode & 0o777, 0o700);
  assert.equal((await lstat(join(f.originalRoot, "notes/Entry.md"))).mode & 0o777, 0o600);
  assert.equal((await lstat(join(f.originalRoot, "notes"))).mode & 0o777, 0o775);
  const modeReceipt = JSON.parse(await readFile(join(f.stageDirectory, "execution/root-mode/root-mode.before.json"), "utf8"));
  assert.equal(modeReceipt.plan.fromMode, 0o775);
  assert.equal(modeReceipt.automaticPermissionLoosening, false);
  assert.equal(execFileSync("/usr/bin/git", ["-C", f.originalRoot, "check-ignore", "--no-index",
    "core.sqlite", ".pkm-next-workspace"], { encoding: "utf8" }).trim(),
  "core.sqlite\n.pkm-next-workspace");
  assert.equal(await readFile(join(f.stageDirectory, "execution/git-protection/gitignore.before"), "utf8"),
    "# synthetic existing ignore policy\n");
  assert((await readFile(join(f.originalRoot, ".gitignore"), "utf8")).startsWith("# synthetic existing ignore policy\n"));
  await assert.rejects(unit.coordinator.verifyOriginalMcpCutover(f.planned.path, f.planned.sha256,
    result.descriptorPath, result.descriptorSha256, "0".repeat(64)), { code: "WRONG_PIN" });
  await assert.rejects(unit.coordinator.verifyOriginalMcpCutover(f.planned.path, f.planned.sha256,
    result.descriptorPath, result.descriptorSha256, result.executionReceiptSha256), { code: "NATIVE_ACTIVATION_QUALIFICATION_REQUIRED" });
  await result.close();
  assert(unit.events.includes("authority-close"));
  const nativeMemory = join(f.originalRoot, ".pkm-next-memory");
  await mkdir(nativeMemory, { mode: 0o700 });
  await writeFile(join(nativeMemory, "test-state"), "new native state", { mode: 0o600 });
  let restoredB1;
  await assert.rejects(unit.coordinator.rollbackOriginalMcpCutover(f.planned.path, f.planned.sha256), error => {
    assert.equal(error.code, "ROLLBACK_RETIREMENT_UNQUALIFIED");
    assert.equal(error.b1.retirementQualified, false);
    assert.equal(error.b1.originalFilesReverted, false);
    restoredB1 = error.b1.restored;
    return true;
  });
  assert.equal(await readFile(join(restoredB1, "payload/pkm-next-memory/test-state"), "utf8"), "new native state");
  assert.equal(await readFile(join(nativeMemory, "test-state"), "utf8"), "new native state");
  assert.equal((await lstat(join(f.originalRoot, "core.sqlite"))).isFile(), true);
  const next = await actualRoot.acquireOriginalMcpRootFence(f.originalRoot);
  await next.release();
  assert.equal((await lstat(f.originalRoot)).mode & 0o777, 0o700, "Rollback refusal must never loosen the backed root mode.");
});

test("an actual writable original handle is refused, not exempted by unit mocks or an operator scope choice", async t => {
  const f = await fixture(t), unit = await transactionMocks(t, f);
  const child = childProcess.spawn(process.execPath, ["--input-type=module", "-e",
    "import{openSync,closeSync}from'node:fs';const f=openSync(process.argv[1],'r+');process.stdout.write('ready');process.stdin.resume();process.stdin.on('end',()=>{closeSync(f);process.exit(0)})",
    join(f.originalRoot, ".pkm/content-privacy.json")], { stdio: ["pipe", "pipe", "pipe"] });
  await new Promise(resolve_ => child.stdout.once("data", resolve_));
  try {
    await assert.rejects(unit.coordinator.executeOriginalMcpCutover(f.planned.path, f.planned.sha256),
      { code: "LEGACY_WRITERS_ACTIVE" });
    assert.equal(child.exitCode, null);
    assert(!unit.events.includes("prepare")); assert(!unit.events.includes("native-uninstall"));
  } finally { const closed = new Promise(resolve_ => child.once("close", resolve_)); child.stdin.end(); await closed; }
});

test("a reduced post-open descriptor retains prepared state/B0 but performs no native profile edit or automatic revert", async t => {
  const f = await fixture(t), unit = await transactionMocks(t, f, { brokerReducedAfterOpen: true });
  await assert.rejects(unit.coordinator.executeOriginalMcpCutover(f.planned.path, f.planned.sha256), { code: "BROKER_NOT_FULL_PARITY" });
  assert(unit.events.includes("owner")); assert(unit.events.includes("stop"));
  assert(!unit.events.includes("native-uninstall"));
  assert.equal((await lstat(join(f.originalRoot, ".pkm-next-workspace"))).isFile(), true);
  assert.equal((await lstat(join(f.plan.b0, "capture.complete.json"))).isFile(), true);
  assert.equal((await lstat(join(f.plan.b0Restored, "restore.complete.json"))).isFile(), true);
  await assert.rejects(lstat(f.plan.enrollmentPath), { code: "ENOENT" });
  const names = await readdir(join(f.stageDirectory, "execution"));
  const failure = JSON.parse(await readFile(join(f.stageDirectory, "execution", names.find(name => name.endsWith("-failed-retained.json"))), "utf8"));
  assert.equal(failure.evidence.automaticRevertAttempted, false);
  assert.equal(failure.evidence.b1RequiredBeforeAnyRevert, true);
});

test("compact-only registration cannot activate a new hybrid profile despite full151 fixture readiness", async t => {
  const f = await fixture(t, { compactRelay: true }), unit = await transactionMocks(t, f);
  await assert.rejects(unit.coordinator.executeOriginalMcpCutover(f.planned.path, f.planned.sha256),
    { code: "BROKER_PUBLIC_TOOLS_MISMATCH" });
  assert(unit.events.includes("owner")); assert(unit.events.includes("stop"));
  assert(!unit.events.includes("native-uninstall"));
  await assert.rejects(lstat(f.plan.enrollmentPath), { code: "ENOENT" });
});
test("bad backup/release/qualification/rollback-material input pins cannot stage an approved execution", async t => {
  const f = await fixture(t);
  await assert.rejects(planOriginalMcpCutover({ ...f.request, rootMode: { approvedMode: 0o775 } },
    join(base, `cutover-${randomUUID()}`)), { code: "ROOT_MODE_APPROVAL_REQUIRED" });
  for (const field of ["recovery", "manifest", "qualification", "vsix"]) {
    const request = structuredClone(f.request);
    const selected = field === "recovery" ? request.recovery
      : field === "vsix" ? request.legacy.vsix : request.release[field];
    selected.sha256 = "0".repeat(64);
    const target = join(base, `cutover-${randomUUID()}`);
    await assert.rejects(planOriginalMcpCutover(request, target), { code: "WRONG_PIN" });
    await assert.rejects(lstat(target), { code: "ENOENT" });
  }
});

test("wrong pins, staged release changes and interrupted transaction directories never replay", async t => {
  const f = await fixture(t), unit = await transactionMocks(t, f);
  await assert.rejects(unit.coordinator.executeOriginalMcpCutover(f.planned.path, "0".repeat(64)), { code: "WRONG_PIN" });
  await mkdir(join(f.stageDirectory, "execution"), { mode: 0o700 });
  await privateJson(join(f.stageDirectory, "execution/001-planned.json"), { interrupted: true });
  await assert.rejects(unit.coordinator.executeOriginalMcpCutover(f.planned.path, f.planned.sha256), { code: "INTERRUPTED_TRANSACTION" });
  await writeFile(join(f.stageDirectory, "runtime/dist/original-mcp-root.js"), "changed staged release", { mode: 0o600 });
  await assert.rejects(unit.coordinator.executeOriginalMcpCutover(f.planned.path, f.planned.sha256), { code: "WRONG_PIN" });
  assert(!unit.events.includes("prepare")); assert(!unit.events.includes("native-uninstall"));
});

function cleanupFailure(code) {
  return Object.assign(new Error("synthetic-secret-native-cleanup-detail"), { code });
}
async function assertRedactedCleanupReport(error) {
  assert(error instanceof AggregateError);
  assert.equal(error.code, "ORIGINAL_MCP_CLEANUP_FAILED");
  assert.equal(error.cleanupReportDurable, true);
  const raw = await readFile(error.cleanupReportPath, "utf8");
  assert(!raw.includes("synthetic-secret-native-cleanup-detail"));
  const report = JSON.parse(raw);
  assert.equal(report.cleanupConfirmed, false);
  assert.equal(report.originalStateRetained, true);
  return report;
}

for (const validation of [false, true])
  test(`authority cleanup preserves ${validation ? "admission rejection" : "setup interruption"} as well as native cleanup failure`, async t => {
    const f = await fixture(t), authorityCloseError = cleanupFailure("AUTHORITY_CLOSE_FAILED");
    const unit = await transactionMocks(t, f, { authorityCloseError, extraStartupWrite: validation });
    if (!validation) await mkdir(join(f.stageDirectory, "execution"), { mode: 0o700 });
    await assert.rejects(unit.coordinator.executeOriginalMcpCutover(f.planned.path, f.planned.sha256), asyncError => {
      assert.equal(asyncError.primaryError.code, validation ? "WRITE_PLAN_UNQUALIFIED" : "INTERRUPTED_TRANSACTION");
      assert(asyncError.errors.includes(authorityCloseError));
      assert.equal(asyncError.cleanupErrors[0].operation, "native-deployment-close");
      return true;
    });
    const reportName = (await readdir(f.stageDirectory)).find(name => name.startsWith("cleanup-failure-"));
    const raw = await readFile(join(f.stageDirectory, reportName), "utf8");
    assert(!raw.includes("synthetic-secret-native-cleanup-detail"));
    assert.equal(JSON.parse(raw).cleanupFailures[0].code, "AUTHORITY_CLOSE_FAILED");
    assert(!unit.events.includes("prepare")); assert(!unit.events.includes("native-uninstall"));
  });

test("failed execution attempts all cleanup and reports fence, authority and failure-journal errors without masking B0 failure", async t => {
  const f = await fixture(t);
  const fenceReleaseError = cleanupFailure("FENCE_RELEASE_FAILED"), authorityCloseError = cleanupFailure("AUTHORITY_CLOSE_FAILED");
  const failureJournalError = cleanupFailure("FAILURE_JOURNAL_FAILED");
  const unit = await transactionMocks(t, f, { badBackup: true, fenceReleaseError, authorityCloseError, failureJournalError });
  let observed;
  await assert.rejects(unit.coordinator.executeOriginalMcpCutover(f.planned.path, f.planned.sha256), error => {
    observed = error;
    assert.equal(error.primaryError.code, "CORRUPT_BYTES");
    for (const original of [fenceReleaseError, authorityCloseError, failureJournalError]) assert(error.errors.includes(original));
    assert.deepEqual(error.cleanupErrors.map(item => item.operation),
      ["writer-fence-release", "native-deployment-close", "failure-journal"]);
    return true;
  });
  await assertRedactedCleanupReport(observed);
  assert(unit.events.includes("authority-close"));
  assert(!unit.events.includes("prepare")); assert(!unit.events.includes("native-uninstall"));
});

test("a control-read error and its handle-close error are both retained", async t => {
  const f = await fixture(t), planReadCloseError = cleanupFailure("FILE_CLOSE_FAILED");
  const unit = await transactionMocks(t, f, { planReadCloseError });
  await assert.rejects(unit.coordinator.executeOriginalMcpCutover(f.planned.path, "0".repeat(64)), error => {
    assert(error instanceof AggregateError);
    assert.equal(error.primaryError.code, "WRONG_PIN");
    assert(error.errors.includes(planReadCloseError));
    assert.equal(error.cleanupErrors[0].operation, "control-read-handle-close");
    assert(!JSON.stringify(error.cleanupFailures).includes("synthetic-secret-native-cleanup-detail"));
    return true;
  });
  assert(!unit.events.includes("fence")); assert(!unit.events.includes("prepare"));
});

test("manual shutdown never writes broker-closed success when stop, authority or shutdown journal cleanup fails", async t => {
  const f = await fixture(t), brokerStopError = cleanupFailure("BROKER_STOP_FAILED");
  const authorityCloseError = cleanupFailure("AUTHORITY_CLOSE_FAILED"), closeJournalError = cleanupFailure("SHUTDOWN_JOURNAL_FAILED");
  const unit = await transactionMocks(t, f, { brokerStopError, authorityCloseError, closeJournalError });
  const result = await unit.coordinator.executeOriginalMcpCutover(f.planned.path, f.planned.sha256);
  let observed;
  await assert.rejects(result.close(), error => {
    observed = error;
    for (const original of [brokerStopError, authorityCloseError, closeJournalError]) assert(error.errors.includes(original));
    assert.deepEqual(error.cleanupErrors.map(item => item.operation), ["broker-stop", "native-deployment-close", "shutdown-journal"]);
    return true;
  });
  await assertRedactedCleanupReport(observed);
  assert(unit.events.includes("stop")); assert(unit.events.includes("authority-close"));
  assert(!(await readdir(result.executionDirectory)).some(name => name.endsWith("-broker-closed.json")));
});

test("B1 capture and fence-release failures stay visible together, without reverting original state", async t => {
  const f = await fixture(t), b1CaptureError = cleanupFailure("B1_CAPTURE_FAILED"), b1ReleaseError = cleanupFailure("B1_RELEASE_FAILED");
  const unit = await transactionMocks(t, f, { b1CaptureError, b1ReleaseError });
  const result = await unit.coordinator.executeOriginalMcpCutover(f.planned.path, f.planned.sha256);
  await result.close();
  let observed;
  await assert.rejects(unit.coordinator.preserveOriginalMcpCutoverB1(f.planned.path, f.planned.sha256), error => {
    observed = error;
    assert.equal(error.primaryError, b1CaptureError);
    assert(error.errors.includes(b1ReleaseError));
    return true;
  });
  await assertRedactedCleanupReport(observed);
  assert.equal((await lstat(join(f.originalRoot, "core.sqlite"))).isFile(), true);
  assert.equal((await lstat(f.originalRoot)).mode & 0o777, 0o700);
});

test("background broker rejection remains awaitable and emits only a redacted cleanup notification", async t => {
  const f = await fixture(t), authorityCloseError = cleanupFailure("AUTHORITY_CLOSE_FAILED");
  const primary = cleanupFailure("BROKER_RUNTIME_FAILED");
  const unit = await transactionMocks(t, f, { authorityCloseError, observeBrokerClosure: true });
  const notifications = [];
  mock.method(process.stderr, "write", chunk => { notifications.push(String(chunk)); return true; });
  const result = await unit.coordinator.executeOriginalMcpCutover(f.planned.path, f.planned.sha256);
  unit.rejectBrokerClosure(primary);
  let observed;
  await assert.rejects(result.closed, error => {
    observed = error;
    assert.equal(error.primaryError, primary);
    assert(error.errors.includes(authorityCloseError));
    return true;
  });
  await assertRedactedCleanupReport(observed);
  assert(notifications.some(text => text.includes("BROKER_RUNTIME_FAILED") && text.includes("AUTHORITY_CLOSE_FAILED")));
  assert(!notifications.join("").includes("synthetic-secret-native-cleanup-detail"));
  assert(!(await readdir(result.executionDirectory)).some(name => name.endsWith("-broker-closed.json")));
});

test("uncertain broker handoff failure retains the actual fence instead of releasing an unconfirmed owner", async t => {
  const f = await fixture(t), brokerStartError = cleanupFailure("BROKER_START_FAILED");
  const unit = await transactionMocks(t, f, { brokerStartError });
  let observed;
  await assert.rejects(unit.coordinator.executeOriginalMcpCutover(f.planned.path, f.planned.sha256), error => {
    observed = error;
    assert.equal(error.primaryError, brokerStartError);
    assert(error.cleanupFailures.some(item => item.code === "OWNER_SHUTDOWN_UNCONFIRMED"));
    return true;
  });
  await assertRedactedCleanupReport(observed);
  unit.getFence().assertHeld();
  assert(!unit.events.includes("native-uninstall"));
});

test("relay cleanup cannot mask a failed surface probe or skip waiting for the owned child", async t => {
  const f = await fixture(t, { compactRelay: true }), relayStdinCloseError = cleanupFailure("RELAY_CLOSE_FAILED");
  const unit = await transactionMocks(t, f, { relayStdinCloseError });
  let observed;
  await assert.rejects(unit.coordinator.executeOriginalMcpCutover(f.planned.path, f.planned.sha256), error => {
    observed = error;
    assert.equal(error.primaryError.code, "BROKER_PUBLIC_TOOLS_MISMATCH");
    assert(error.errors.includes(relayStdinCloseError));
    assert.equal(error.cleanupErrors[0].operation, "relay-stdin-close");
    return true;
  });
  const names = await readdir(observed.executionDirectory);
  const failure = JSON.parse(await readFile(join(observed.executionDirectory, names.find(name => name.endsWith("-failed-retained.json"))), "utf8"));
  assert.equal(failure.evidence.cleanupConfirmed, false);
  assert(!JSON.stringify(failure).includes("synthetic-secret-native-cleanup-detail"));
  assert(unit.events.includes("stop")); assert(unit.events.includes("authority-close"));
  assert(!unit.events.includes("native-uninstall"));
});

test("offline deployment verification has no model/human authority and does not require the editor's live LM context", async t => {
  const f = await fixture(t), unit = await transactionMocks(t, f, { ready: false });
  const facts = await unit.stagedCoordinator.validateOriginalMcpNativeStaging(f.planned.path, f.planned.sha256);
  assert.equal(facts.modelAuthority, false); assert.equal(facts.humanAuthority, false);
  assert.equal(facts.businessReady, false); assert.equal(facts.mutationPerformed, false);
  assert.equal(facts.identitySha256, f.request.nativeDeployment.identitySha256);
  await assert.rejects(unit.stagedCoordinator.executeOriginalMcpCutover(f.planned.path, f.planned.sha256), { code: "FULL_PARITY_UNAVAILABLE" });
  assert(!unit.events.includes("fence")); assert(!unit.events.includes("owner"));
  assert.equal((await lstat(f.originalRoot)).mode & 0o777, 0o775);
});

test("an offline deployment record claiming live model permission is rejected before the cold fence", async t => {
  const f = await fixture(t), unit = await transactionMocks(t, f, { offlineClaimsAuthority: true });
  await assert.rejects(unit.stagedCoordinator.executeOriginalMcpCutover(f.planned.path, f.planned.sha256),
    { code: "OFFLINE_DEPLOYMENT_IS_NOT_AUTHORITY" });
  assert(!unit.events.includes("fence")); assert(!unit.events.includes("owner"));
});

test("cold same-owner bootstrap exposes only attachment control, defers recovery and publishes no business enrollment before attachment", async t => {
  const f = await fixture(t), unit = await transactionMocks(t, f, { deferAttachment: true });
  const pending = await unit.stagedCoordinator.executeOriginalMcpCutover(f.planned.path, f.planned.sha256);
  assert.equal(pending.status, "awaiting-native-attachment"); assert.equal(pending.businessReady, false);
  assert.equal(pending.storageRecovered, false); assert.equal(pending.descriptorPath, undefined);
  assert(!unit.events.includes("prepare-native-factory")); assert(!unit.events.includes("broker"));
  await assert.rejects(lstat(f.plan.enrollmentPath), { code: "ENOENT" });
  const completion = pending.complete();
  await new Promise(resolve_ => setTimeout(resolve_, 10));
  assert(!unit.events.includes("prepare-native-factory")); assert(!unit.events.includes("broker"));
  unit.getFence().assertHeld();
  unit.attachNative();
  const result = await completion;
  assert(unit.events.indexOf("native-attachment") < unit.events.indexOf("prepare-native-factory"));
  assert(unit.events.indexOf("prepare-native-factory") < unit.events.indexOf("broker"));
  assert.equal((await lstat(result.enrollmentPath)).isFile(), true);
  assert.equal((await lstat(f.request.legacy.package.path)).isFile(), true);
  assert.equal(hex(await readFile(f.request.legacy.main.path)), f.request.legacy.main.sha256);
  assert(!unit.events.includes("native-uninstall"));
  await result.close();
});

test("an untrusted native attachment cannot trigger recovery, a business publisher or enrollment", async t => {
  const f = await fixture(t), unit = await transactionMocks(t, f, { badAttachment: true });
  const pending = await unit.stagedCoordinator.executeOriginalMcpCutover(f.planned.path, f.planned.sha256);
  await assert.rejects(pending.complete(), { code: "NATIVE_ATTACHMENT_UNAUTHENTICATED" });
  assert(!unit.events.includes("prepare-native-factory")); assert(!unit.events.includes("broker"));
  await assert.rejects(lstat(f.plan.enrollmentPath), { code: "ENOENT" });
});

test("a private control descriptor must bind the independently pinned identity and cannot masquerade as business readiness", async t => {
  const f = await fixture(t), unit = await transactionMocks(t, f, { badControlDescriptor: true });
  await assert.rejects(unit.stagedCoordinator.executeOriginalMcpCutover(f.planned.path, f.planned.sha256),
    { code: "NATIVE_CONTROL_DESCRIPTOR_UNQUALIFIED" });
  assert(!unit.events.includes("prepare-native-factory")); assert(!unit.events.includes("broker"));
  await assert.rejects(lstat(f.plan.enrollmentPath), { code: "ENOENT" });
});

test("closing a pending bootstrap cancels the attachment barrier without recovery or a lingering wait timer", async t => {
  const f = await fixture(t), unit = await transactionMocks(t, f, { deferAttachment: true });
  const pending = await unit.stagedCoordinator.executeOriginalMcpCutover(f.planned.path, f.planned.sha256);
  const completion = pending.complete();
  const cancelled = assert.rejects(completion, { code: "NATIVE_BOOTSTRAP_CLOSED" });
  await pending.close();
  await cancelled;
  assert(!unit.events.includes("prepare-native-factory")); assert(!unit.events.includes("broker"));
  await assert.rejects(lstat(f.plan.enrollmentPath), { code: "ENOENT" });
});

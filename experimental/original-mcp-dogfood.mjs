import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { cp, lstat, mkdir, open, readdir, readFile, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";

const hash = value => createHash("sha256").update(value).digest("hex");
const encoded = value => JSON.stringify(value) + "\n";
const sha = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const within = (base, value) => value === base || value.startsWith(base + sep);
const scope = "native-dogfood/v1";
const ownPath = fileURLToPath(import.meta.url);
function fail(code) { throw Object.assign(new Error(code), { code }); }
function exact(value, names) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join() !== [...names].sort().join()) fail("DOGFOOD_REQUEST_INVALID");
}
async function privateDirectory(path) {
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path) fail("DOGFOOD_PATH_INVALID");
  const stat = await lstat(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== BigInt(process.getuid())
    || stat.mode & 0o7077n) fail("DOGFOOD_PRIVATE_DIRECTORY_REQUIRED");
}
async function durable(path, value) {
  const bytes = Buffer.from(encoded(value)), fd = await open(path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await fd.writeFile(bytes); await fd.sync(); } finally { await fd.close(); }
  const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
  return hash(bytes);
}
async function json(path, pin) {
  const stat = await lstat(path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.uid !== BigInt(process.getuid())
    || stat.mode & 0o7077n || stat.size > 2_097_152n) fail("DOGFOOD_CONTROL_INVALID");
  const bytes = await readFile(path);
  if (pin !== undefined && (!sha(pin) || hash(bytes) !== pin)) fail("DOGFOOD_PIN_CHANGED");
  return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
}
async function inventory(root, prefix = "") {
  const files = {};
  for (const name of (await readdir(join(root, prefix))).sort()) {
    const relative = prefix ? `${prefix}/${name}` : name, path = join(root, relative), stat = await lstat(path);
    if (stat.isSymbolicLink()) fail("DOGFOOD_RELEASE_LINK");
    if (stat.isDirectory()) Object.assign(files, await inventory(root, relative));
    else if (stat.isFile()) files[relative] = hash(await readFile(path));
    else fail("DOGFOOD_RELEASE_SPECIAL_FILE");
  }
  return files;
}
function modulePath(plan, name) { return join(plan.directory, "runtime/server/dist", name + ".js"); }
function load(plan, name) { return import(pathToFileURL(modulePath(plan, name)).href); }

/** Preparation only; no source/profile write or legacy termination occurs. */
export async function planOriginalMcpDogfood(request, directory) {
  exact(request, ["schema", "acceptedScope", "root", "operatorId", "nativeExtension", "runtimeExtension", "runtimeManifestSha256", "nativeStorage",
    "nativeIdentitySha256", "recoveryRequest", "recoveryRequestSha256", "custodyLimits"]);
  if (request.schema !== "pkm.original-mcp-dogfood-request/v1" || request.acceptedScope !== scope
    || typeof request.operatorId !== "string" || !request.operatorId || request.operatorId.length > 128
    || !sha(request.nativeIdentitySha256) || !sha(request.recoveryRequestSha256)
    || !sha(request.runtimeManifestSha256)) fail("DOGFOOD_REQUEST_INVALID");
  for (const name of ["root", "nativeExtension", "runtimeExtension", "nativeStorage", "recoveryRequest"])
    if (!isAbsolute(request[name]) || realpathSync(request[name]) !== request[name]) fail("DOGFOOD_PATH_INVALID");
  const base = join(homedir(), ".local/state/pkm-v5-recovery");
  await privateDirectory(base);
  if (dirname(directory) !== base || resolve(directory) !== directory || within(request.root, directory)
    || within(directory, request.root)) fail("DOGFOOD_STAGE_OUTSIDE_ROOT_REQUIRED");
  const require = createRequire(join(request.nativeExtension, "package.json"));
  const payload = require(join(request.nativeExtension,
    "next-runtime/server/legacy/dist/runtime/next-payload-verifier.js")).verifyNextPayload(request.nativeExtension);
  const runtime = require(join(request.runtimeExtension,
    "next-runtime/server/legacy/dist/runtime/next-payload-verifier.js")).verifyNextPayload(request.runtimeExtension);
  if (hash(await readFile(join(runtime.root, "manifest.json"))) !== request.runtimeManifestSha256)
    fail("DOGFOOD_RELEASE_CHANGED");
  const storage = await import(pathToFileURL(join(payload.root, "server/dist/original-mcp-profile-binding.js")).href);
  const identityModule = await import(pathToFileURL(join(payload.root, "server/dist/original-mcp-native-identity.js")).href);
  const limitsModule = await import(pathToFileURL(join(payload.root, "server/dist/original-mcp-root-custody.js")).href);
  limitsModule.originalMcpLimits.parse(request.custodyLimits);
  const profile = storage.originalMcpProfileBinding(request.nativeStorage);
  const identityPath = join(request.nativeStorage, "original-mcp-native-identity.json");
  const identity = identityModule.verifyOriginalMcpNativeIdentity(await json(identityPath), request.nativeIdentitySha256, profile.sha256);
  const recoveryRequest = await json(request.recoveryRequest, request.recoveryRequestSha256);
  if (recoveryRequest.originalRoot !== request.root || recoveryRequest.includeNativeRuntimeDirectories !== undefined)
    fail("DOGFOOD_RECOVERY_SCOPE_INVALID");
  if (!recoveryRequest.externalDirectories?.some(entry => within(entry.path, request.nativeStorage)))
    fail("DOGFOOD_NATIVE_PROFILE_BACKUP_REQUIRED");
  const releaseManifest = JSON.parse(await readFile(join(runtime.root, "manifest.json"), "utf8"));
  if (!["original-mcp-native-bootstrap.js", "original-mcp-hot-switch-target.js", "original-mcp-broker.js", "original-mcp-retirement.js"]
    .every(name => Object.hasOwn(releaseManifest.files, `server/dist/${name}`)))
    fail("DOGFOOD_RELEASE_INCOMPLETE");
  await mkdir(directory, { mode: 0o700 });
  await cp(runtime.root, join(directory, "runtime"), { recursive: true, errorOnExist: true, force: false });
  await mkdir(join(directory, "experimental"), { mode: 0o700 });
  await cp(ownPath, join(directory, "experimental/original-mcp-dogfood.mjs"), { force: false, errorOnExist: true });
  await mkdir(join(directory, "runtime/server/experimental"), { mode: 0o700, recursive: true });
  await cp(join(dirname(ownPath), "cold-state-recovery.mjs"),
    join(directory, "runtime/server/experimental/cold-state-recovery.mjs"), { force: false, errorOnExist: true });
  const files = await inventory(directory);
  const plan = {
    schema: "pkm.original-mcp-dogfood-plan/v1", id: randomUUID(), acceptedScope: scope, directory, request, profile,
    identity, payloadBuildId: payload.buildId, runtimeBuildId: runtime.buildId,
    hostEntrySha256: hash(await readFile(join(request.nativeExtension, "dist/extension.cjs"))),
    payloadManifestSha256: hash(await readFile(join(request.nativeExtension, "next-runtime/manifest.json"))),
    node: { path: realpathSync(process.execPath), sha256: hash(await readFile(realpathSync(process.execPath))) },
    files, recoveryRequest,
    productionCutover: false,
  };
  const path = join(directory, "plan.json"), pin = await durable(path, plan);
  await verifyOriginalMcpDogfoodPlan(path, pin);
  return { path, sha256: pin, originalRootChanged: false, profileChanged: false, readyForCutover: false };
}
export async function verifyOriginalMcpDogfoodPlan(path, pin) {
  const plan = await json(path, pin);
  if (plan.schema !== "pkm.original-mcp-dogfood-plan/v1" || plan.acceptedScope !== scope
    || join(plan.directory, "plan.json") !== path) fail("DOGFOOD_PLAN_INVALID");
  await privateDirectory(plan.directory);
  for (const [file, digest] of Object.entries(plan.files)) {
    if (!sha(digest) || isAbsolute(file) || relative(plan.directory, join(plan.directory, file)).startsWith(".."))
      fail("DOGFOOD_PLAN_INVALID");
    if (hash(await readFile(join(plan.directory, file))) !== digest) fail("DOGFOOD_RELEASE_CHANGED");
  }
  const runtimeFiles = await inventory(join(plan.directory, "runtime"));
  const expectedFiles = Object.fromEntries(Object.entries(plan.files).filter(([name]) => name.startsWith("runtime/"))
    .map(([name, digest]) => [name.slice("runtime/".length), digest]));
  if (JSON.stringify(runtimeFiles) !== JSON.stringify(expectedFiles)) fail("DOGFOOD_RELEASE_CHANGED");
  if (realpathSync(process.execPath) !== plan.node.path || hash(await readFile(plan.node.path)) !== plan.node.sha256)
    fail("DOGFOOD_NODE_CHANGED");
  if (hash(await readFile(join(plan.request.nativeExtension, "dist/extension.cjs"))) !== plan.hostEntrySha256
    || hash(await readFile(join(plan.request.nativeExtension, "next-runtime/manifest.json"))) !== plan.payloadManifestSha256)
    fail("DOGFOOD_NATIVE_INSTALL_CHANGED");
  return plan;
}

/** Must be launched outside the library from an independent terminal. */
export async function startOriginalMcpDogfood(path, pin) {
  const plan = await verifyOriginalMcpDogfoodPlan(path, pin);
  if (within(plan.request.root, realpathSync(process.cwd()))) fail("DOGFOOD_CONTROLLER_OUTSIDE_ROOT_REQUIRED");
  const root = await load(plan, "original-mcp-root");
  const fences = await load(plan, "linux-root-writer-fence");
  const quiescence = await load(plan, "linux-legacy-writer-quiescence");
  const native = await load(plan, "original-mcp-native-bootstrap");
  const brokers = await load(plan, "original-mcp-broker");
  const targets = await load(plan, "original-mcp-hot-switch-target");
  const retirement = await load(plan, "original-mcp-retirement");
  if (!["captureOriginalMcpRetirementB1", "prepareOriginalMcpRetirement", "retireOriginalMcpRoot"]
    .every(name => typeof retirement[name] === "function")) fail("DOGFOOD_RETIREMENT_UNAVAILABLE");
  const recovery = await import(pathToFileURL(join(plan.directory, "runtime/server/experimental/cold-state-recovery.mjs")).href);
  const execution = join(plan.directory, `execution-${randomUUID()}`);
  const writerFence = await fences.acquireLinuxRootWriterFence(plan.request.root);
  let bootstrap, broker, closing, completion;
  const close = () => closing ??= (async () => {
    if (broker) await broker.stop();
    if (bootstrap) await bootstrap.close();
    else await writerFence.release();
  })();
  try {
    // No durable source or profile writes precede the real inventory gate.
    await quiescence.assertLinuxLegacyWritersQuiescent(plan.request.root);
    await mkdir(execution, { mode: 0o700 });
    const backupRequest = structuredClone(plan.recoveryRequest);
    if (!backupRequest.configurationFiles.some(item => item.path === join(plan.request.root, ".gitignore")))
      backupRequest.configurationFiles.push({ id: "original-root-gitignore", path: join(plan.request.root, ".gitignore") });
    const b0Path = join(dirname(plan.directory), `c-${randomBytes(5).toString("hex")}`), restoredPath = `${b0Path}-r`;
    await durable(join(execution, "recovery-targets.json"), { b0: b0Path, restored: restoredPath });
    const b0 = await recovery.captureColdStateRecovery(backupRequest, b0Path, { writerFence });
    if (!b0.summary.targetClosureComplete) fail("DOGFOOD_B0_INCOMPLETE");
    await recovery.verifyColdStateRecovery(b0.path, b0.manifestSha256);
    const restored = await recovery.restoreColdStateRecovery(b0.path, b0.manifestSha256, restoredPath);
    if (JSON.stringify(restored.summary) !== JSON.stringify(b0.summary)) fail("DOGFOOD_B0_RESTORE_INVALID");
    await durable(join(execution, "b0-qualified.json"), { b0, restored });
    const modes = await load(plan, "original-mcp-root-mode");
    await modes.applyOriginalMcpRootMode(modes.planOriginalMcpRootMode(plan.request.root),
      { writerFence, backupDirectory: join(execution, "root-mode"), approvedMode: 0o700 });
    const git = await load(plan, "original-mcp-git-protection");
    const protection = await git.applyOriginalMcpGitProtection(git.planOriginalMcpGitProtection(plan.request.root),
      { writerFence, backupDirectory: join(execution, "git-protection") });
    const custody = await root.captureOriginalMcpCustody({
      root: plan.request.root, backup: join(execution, "custody"), operatorId: plan.request.operatorId,
      profileSha256: plan.profile.sha256, limits: plan.request.custodyLimits,
    }, { writerFence });
    await durable(join(execution, "custody.json"), custody);
    const ipc = join(dirname(plan.directory), `d-${randomBytes(5).toString("hex")}`);
    await mkdir(ipc, { mode: 0o700 });
    await durable(join(execution, "native-endpoint.json"), { directory: ipc });
    bootstrap = await native.bootstrapOriginalMcpNativeRuntime({ plan: custody, writerFence, gitProtection: protection,
      attachment: { directory: ipc, identity: plan.identity, identitySha256: plan.identity.sha256,
        payloadBuildId: plan.payloadBuildId, hostEntrySha256: plan.hostEntrySha256 } });
    const prepared = Object.fromEntries(["root", "workspaceId", "planSha256", "journalSha256"].map(key => [key, bootstrap[key]]));
    const executionRecord = { schema: "pkm.original-mcp-dogfood-execution/v1", planPath: path, planSha256: pin,
      execution, custody, prepared, b0: { path: b0.path, manifestSha256: b0.manifestSha256 } };
    const executionPath = join(execution, "execution.json"), executionSha256 = await durable(executionPath, executionRecord);
    const pointer = { schema: "pkm.original-mcp-native-bootstrap/v1", descriptorPath: bootstrap.attachmentDescriptorPath,
      descriptorSha256: bootstrap.attachmentDescriptorSha256, profileSha256: plan.profile.sha256 };
    const pointerPath = join(plan.request.nativeStorage, "original-mcp-native-bootstrap.json");
    await durable(pointerPath, pointer);
    await durable(join(execution, "native-bootstrap.json"), pointer);
    return {
      status: "awaiting-native-consent", execution, executionPath, executionSha256, pointerPath, businessReady: false, close,
      complete() {
        return completion ??= (async () => {
        const nativeHost = await bootstrap.complete();
        const business = join(dirname(plan.directory), `b-${randomBytes(5).toString("hex")}`);
        await mkdir(business, { mode: 0o700 });
        await durable(join(execution, "business-endpoint.json"), { directory: business });
        const relay = modulePath(plan, "original-mcp-relay-cli");
        const runtime = { node: plan.node, relay: { path: relay, sha256: hash(await readFile(relay)) }, buildSha256: plan.runtimeBuildId };
        const manifest = { schema: "pkm.mcp.lifecycle/v1", managedRoot: execution, generation: plan.id, version: "0.1.0",
          runtimeBuild: plan.runtimeBuildId, components: { knowledge: "0.1.0", chat: "0.1.0", recipes: "0.1.0", agent_sessions: "0.1.0" },
          enabledFeatureDomains: [] };
        await durable(join(execution, "active-generation.json"), { schema: manifest.schema, generation: plan.id });
        broker = await brokers.startOriginalMcpNativeBroker({
          plan: custody, writerFence, directory: business, runtime, manifest, gitProtection: protection,
          owner: bootstrap.owner, storage: bootstrap.storage, nativeHost,
          authorization: { schema: "pkm.original-mcp-broker-authorization/v1", operatorId: plan.request.operatorId,
            profileSha256: plan.profile.sha256, planSha256: custody.planSha256, acceptedScope: scope, writable: true },
        });
        const target = await targets.writeOriginalMcpHotSwitchTarget({
          descriptorPath: broker.descriptorPath, descriptorSha256: broker.descriptorSha256,
          profileSha256: plan.profile.sha256, knowledgeRoot: plan.request.root, targetPath: join(execution, "hot-switch-target.json"),
        });
        await durable(join(execution, "business-ready.json"), { target, scope, connectionVerified: false });
        return { status: "awaiting-client-hot-switch", target, connectionVerified: false,
          shutdownRequires: "PKM-Pause-MCP-Runtime-for-Maintenance-before-stopping-this-owner", close, closed: broker.closed };
        })();
      },
    };
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Dogfood failure and cleanup incomplete; retain all state."); }
    throw error;
  }
}

/**
 * Explicit write-preserving return to the old engine. The actual broker/owner
 * must already have exited; no process is killed and no knowledge bytes revert.
 */
export async function retireOriginalMcpDogfood(path, pin, executionPath, executionPin) {
  const plan = await verifyOriginalMcpDogfoodPlan(path, pin), execution = await json(executionPath, executionPin);
  if (execution.schema !== "pkm.original-mcp-dogfood-execution/v1" || execution.planPath !== path
    || execution.planSha256 !== pin || dirname(execution.execution) !== plan.directory
    || join(execution.execution, "execution.json") !== executionPath
    || execution.custody.root !== plan.request.root || execution.custody.profileSha256 !== plan.profile.sha256)
    fail("DOGFOOD_EXECUTION_CHANGED");
  if (within(plan.request.root, realpathSync(process.cwd()))) fail("DOGFOOD_CONTROLLER_OUTSIDE_ROOT_REQUIRED");
  const root = await load(plan, "original-mcp-root");
  const git = await load(plan, "original-mcp-git-protection");
  const retirement = await load(plan, "original-mcp-retirement");
  const recovery = await import(pathToFileURL(join(plan.directory, "runtime/server/experimental/cold-state-recovery.mjs")).href);
  await recovery.verifyColdStateRecovery(execution.b0.path, execution.b0.manifestSha256);
  const writerFence = await root.acquireOriginalMcpRootFence(plan.request.root);
  try {
    const desired = git.planOriginalMcpGitProtection(plan.request.root);
    if (desired.writeRequired) fail("DOGFOOD_GIT_PROTECTION_CHANGED");
    const options = { writerFence, gitProtection: { assertCurrent() {
      const current = git.planOriginalMcpGitProtection(plan.request.root);
      if (current.writeRequired || current.desiredSha256 !== desired.desiredSha256) fail("DOGFOOD_GIT_PROTECTION_CHANGED");
    } } };
    const ticketPath = join(execution.execution, "retirement-ticket.json");
    let ticket;
    try { ticket = await json(ticketPath); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      const intent = join(plan.request.root,
        `.pkm-next-original-mcp-retired-${execution.prepared.workspaceId}`, "intent.json");
      try { ticket = await json(intent); }
      catch (intentError) {
        if (intentError.code !== "ENOENT") throw intentError;
        const backup = join(execution.execution, "retirement-b1");
        let b1;
        try { b1 = await json(join(backup, "complete.json")); }
        catch (b1Error) {
          if (b1Error.code !== "ENOENT") throw b1Error;
          b1 = await retirement.captureOriginalMcpRetirementB1(execution.custody, execution.prepared, { scope, backup }, options);
        }
        ticket = await retirement.prepareOriginalMcpRetirement(execution.custody, execution.prepared, { scope, b1 }, options);
      }
      await durable(ticketPath, ticket);
    }
    const result = await retirement.retireOriginalMcpRoot(execution.custody, execution.prepared, ticket, options);
    const pointerPath = join(plan.request.nativeStorage, "original-mcp-native-bootstrap.json");
    const pointer = await json(join(execution.execution, "native-bootstrap.json"));
    let current;
    try { current = await json(pointerPath); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (current) {
      if (JSON.stringify(pointer) !== JSON.stringify(current)) fail("DOGFOOD_PROFILE_POINTER_CHANGED");
      await unlink(pointerPath);
      const profile = await open(plan.request.nativeStorage, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await profile.sync(); } finally { await profile.close(); }
    }
    return { ...result, publicUpdatesRetainedInPlace: true, configurationRestored: false,
      legacyConnectionVerified: false, nextAction: "explicit-v4-Switch-MCP-Runtime-Back-to-Managed" };
  } finally { await writerFence.release(); }
}

if (process.argv[1] && resolve(process.argv[1]) === ownPath) {
  const [command, first, second, third, fourth] = process.argv.slice(2);
  try {
    if (command === "plan") console.log(JSON.stringify(await planOriginalMcpDogfood(await json(resolve(first)), resolve(second))));
    else if (command === "start") {
      const active = await startOriginalMcpDogfood(resolve(first), second);
      const shutdown = () => { void active.close().catch(error => { console.error(error); process.exitCode = 1; }); };
      process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
      console.log(JSON.stringify({ ...active, complete: undefined, close: undefined }));
      try {
        const ready = await active.complete();
        console.log(JSON.stringify({ ...ready, close: undefined, closed: undefined }));
        await ready.closed;
      } finally { await active.close(); }
    } else if (command === "retire") console.log(JSON.stringify(await retireOriginalMcpDogfood(
      resolve(first), second, resolve(third), fourth)));
    else fail("USAGE: plan PRIVATE_REQUEST NEW_PRIVATE_STAGE | start PLAN PIN | retire PLAN PIN EXECUTION PIN");
  } catch (error) { console.error(error); process.exitCode = 1; }
}

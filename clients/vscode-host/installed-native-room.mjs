import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import Module, { createRequire } from "node:module";
import { constants, existsSync, lstatSync, openSync, closeSync, fstatSync, readFileSync, realpathSync } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url), preparations = new WeakMap(), intents = new WeakMap();
const archiveSha256 = "1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27";
const extensionId = "pkm-nonproduction.pkm-v5";
const hash = value => createHash("sha256").update(value).digest("hex");
const load = (installed, name) => import(pathToFileURL(join(installed, "next-runtime/server/dist", `${name}.js`)).href);
const digest = /^[a-f0-9]{64}$/, uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const intentName = "native-room-credential-intent.json", credentialName = "native-room-created-credentials.json";
const observationName = "native-room-credential-observation.json";
const credentialTitle = "Create new synthetic private Room fixture credentials?";
const credentialChoice = "Create new synthetic Room credentials";
const credentialMember = "dist/chatroom/chat-room-credentials.js";
export const installedNativeRoomRequestedCredentialProtocol = "pkm.installed-native-room-requested-credential/v1";
const originalMembers = Object.freeze(["package.json", "dist/chat-persistence.js", "dist/chat-persistence-worker.js",
  "dist/chatroom/chat-persistence.js", "dist/chatroom/chat-persistence-worker.js", "dist/chatroom/meeting-state.js",
  credentialMember, "dist/runtime/cross-process-lock.js", "dist/sql-wasm.js", "dist/sql-wasm.wasm",
  "resources/chat_server.py.template", "resources/mcp_call_guard.py"]);
function fail(code) { throw Object.assign(new Error(code), { code }); }
function inside(root, path) {
  const member = relative(root, path);
  return member !== "" && member !== ".." && !member.startsWith(`..${sep}`) && !isAbsolute(member);
}
function pin(stat) { return [stat.dev, stat.ino, stat.uid, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs].join(":"); }
function bytesSync(path, maximum = 1048576, privateFile = false) {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximum
    || realpathSync(path) !== path || privateFile && (before.uid !== process.getuid() || before.mode & 0o077))
    fail("INSTALLED_ROOM_UNSAFE_OR_CHANGED_FILE");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (pin(fstatSync(fd)) !== pin(before)) fail("INSTALLED_ROOM_FILE_CHANGED");
    const bytes = readFileSync(fd);
    if (pin(fstatSync(fd)) !== pin(before) || pin(lstatSync(path)) !== pin(before)) fail("INSTALLED_ROOM_FILE_CHANGED");
    return bytes;
  } finally { closeSync(fd); }
}
function privateDriver(root, installed) {
  if (process.platform !== "linux" || !isAbsolute(root) || resolve(root) !== root
    || !/^\.installed-host-[a-f0-9-]{36}$/.test(basename(root))) fail("INSTALLED_ROOM_PRIVATE_DRIVER_REQUIRED");
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077
    || realpathSync(root) !== root) fail("INSTALLED_ROOM_PRIVATE_DRIVER_REQUIRED");
  if (typeof installed !== "string" || dirname(installed) !== join(root, "x")
    || !/^pkm-nonproduction\.pkm-v5-[0-9]/.test(basename(installed))
    || realpathSync(installed) !== installed) fail("INSTALLED_ROOM_CLI_INSTALL_REQUIRED");
  const manifest = JSON.parse(bytesSync(join(installed, "package.json")).toString("utf8"));
  if (`${manifest.publisher}.${manifest.name}` !== extensionId || manifest.main !== "./dist/extension.cjs")
    fail("INSTALLED_ROOM_CLI_INSTALL_REQUIRED");
  return { entry: join(installed, "dist/extension.cjs"), entrySha256: hash(bytesSync(join(installed, "dist/extension.cjs"), 67108864)),
    rootIdentity: `${stat.dev}:${stat.ino}:${stat.uid}:${stat.mode}` };
}
function pinnedArchive(path) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path)
    fail("INSTALLED_ROOM_PINNED_ORIGINAL_REQUIRED");
  const bytes = bytesSync(path, 268435456);
  if (hash(bytes) !== archiveSha256) fail("INSTALLED_ROOM_ORIGINAL_PACKAGE_CHANGED");
  return bytes;
}
function originalCredentialSource(archive) {
  return execFileSync("python3", ["-I", "-B", "-c",
    "import io,sys,zipfile;z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()));sys.stdout.buffer.write(z.read('extension/dist/chatroom/chat-room-credentials.js'))"],
  { input: archive, timeout: 10000, maxBuffer: 1048576 });
}
async function absent(path, code) {
  try { await lstat(path); fail(code); } catch (error) { if (error.code !== "ENOENT") throw error; }
}
async function publish(path, value) {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
}
function limits(port, timeoutMs) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 1 || timeoutMs > 120000) fail("INSTALLED_ROOM_BOUNDED_DRIVER_REQUIRED");
}
async function waitJson(path, timeoutMs, check = () => {}) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    check();
    try {
      const value = JSON.parse(bytesSync(path, 1048576, true).toString("utf8"));
      if (value.failed) fail(value.code || "INSTALLED_ROOM_UI_FAILED");
      return value;
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await delay(25);
  }
  fail("INSTALLED_ROOM_EVIDENCE_TIMEOUT");
}
function credentialEvidence(intent, value) {
  const allowed = ["schema", "fixtureNonce", "roomId", "hostCredentialHash", "joinSecretHash", "profileDirectory",
    "extensionId", "extensionHostPid", "installedEntrySha256", "originalPackageSha256", "credentialProducerSha256",
    "actualProductionActivationObserved", "newSyntheticCredentialsOnly"];
  if (!value || Object.keys(value).some(key => !allowed.includes(key))
    || value.schema !== "pkm.installed-native-room-created-credentials/v1"
    || value.fixtureNonce !== intent.fixtureNonce || value.roomId !== intent.roomId
    || !digest.test(value.hostCredentialHash) || !digest.test(value.joinSecretHash)
    || value.installedEntrySha256 !== intent.installedEntrySha256
    || value.originalPackageSha256 !== archiveSha256 || value.credentialProducerSha256 !== intent.credentialProducerSha256
    || value.extensionId !== extensionId || value.actualProductionActivationObserved !== true
    || value.newSyntheticCredentialsOnly !== true || !Number.isSafeInteger(value.extensionHostPid) || value.extensionHostPid < 1
    || typeof value.profileDirectory !== "string" || !inside(join(intent.driverRoot, "u"), value.profileDirectory))
    fail("INSTALLED_ROOM_ACTUAL_CREDENTIAL_EVIDENCE_REQUIRED");
  return value;
}
function publicHashes(value) {
  return Object.freeze({ roomId: value.roomId, hostCredentialHash: value.hostCredentialHash, joinSecretHash: value.joinSecretHash });
}
function readCredentialEvidence(root, intent) {
  const hashes = JSON.parse(bytesSync(join(root, credentialName), 16384, true).toString("utf8"));
  if (!hashes || Object.keys(hashes).sort().join(",") !== "hostCredentialHash,joinSecretHash,roomId")
    fail("INSTALLED_ROOM_HASH_ONLY_CREDENTIAL_EVIDENCE_REQUIRED");
  const observation = JSON.parse(bytesSync(join(root, observationName), 16384, true).toString("utf8"));
  if (!observation || typeof observation !== "object" || Array.isArray(observation)
    || ["roomId", "hostCredentialHash", "joinSecretHash"].some(key => key in observation))
    fail("INSTALLED_ROOM_HASH_ONLY_CREDENTIAL_EVIDENCE_REQUIRED");
  return credentialEvidence(intent, { ...observation, ...hashes });
}

/** Coordinator only, before launching the first editor. This creates an intent, never keys or proof. */
export async function prepareInstalledNativeRoomCredentials({ root, installed, legacyVsix, requestedJoinSecretSha256 }) {
  if (requestedJoinSecretSha256 !== undefined
    && (typeof requestedJoinSecretSha256 !== "string" || !digest.test(requestedJoinSecretSha256)))
    fail("INSTALLED_ROOM_REQUESTED_JOIN_HASH_REQUIRED");
  const driver = privateDriver(root, installed);
  const source = originalCredentialSource(pinnedArchive(legacyVsix));
  const value = Object.freeze({ schema: "pkm.installed-native-room-credential-intent/v1", driverRoot: root, installed,
    rootIdentity: driver.rootIdentity, installedEntrySha256: driver.entrySha256, fixtureNonce: randomUUID(), roomId: randomUUID(),
    originalPackageSha256: archiveSha256, credentialProducerSha256: hash(source),
    ...(requestedJoinSecretSha256 !== undefined ? { requestedJoinSecretSha256 } : {}),
    title: credentialTitle, choice: credentialChoice });
  await absent(join(root, credentialName), "INSTALLED_ROOM_CREDENTIALS_ALREADY_EXIST");
  await absent(join(root, observationName), "INSTALLED_ROOM_CREDENTIAL_CREATION_INCOMPLETE");
  await publish(join(root, intentName), value);
  intents.set(value, { root, installed, legacyVsix });
  return value;
}

/**
 * Extension-host driver only; call synchronously before its first await/target activation.
 * The actual production activate return value and platform APIs are never replaced.
 * No context, SecretStorage object or credential bytes escape this closure.
 */
export function observeInstalledNativeRoomActivation({ root, installed, legacyVsix, requestedJoinSecret, timeoutMs = 120000 }) {
  const driver = privateDriver(root, installed);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) fail("INSTALLED_ROOM_BOUNDED_DRIVER_REQUIRED");
  const intent = JSON.parse(bytesSync(join(root, intentName), 16384, true).toString("utf8"));
  if (intent.schema !== "pkm.installed-native-room-credential-intent/v1" || intent.driverRoot !== root
    || intent.installed !== installed || intent.rootIdentity !== driver.rootIdentity
    || intent.installedEntrySha256 !== driver.entrySha256 || !uuid.test(intent.roomId) || !uuid.test(intent.fixtureNonce))
    fail("INSTALLED_ROOM_CREDENTIAL_INTENT_CHANGED");
  if (intent.requestedJoinSecretSha256 !== undefined) {
    if (typeof intent.requestedJoinSecretSha256 !== "string" || !digest.test(intent.requestedJoinSecretSha256))
      fail("INSTALLED_ROOM_CREDENTIAL_INTENT_CHANGED");
    if (typeof requestedJoinSecret !== "string" || hash(requestedJoinSecret) !== intent.requestedJoinSecretSha256)
      fail("INSTALLED_ROOM_REQUESTED_JOIN_INPUT_MISMATCH");
  } else if (requestedJoinSecret !== undefined) fail("INSTALLED_ROOM_UNREQUESTED_JOIN_INPUT");
  const fixture = JSON.parse(process.env.PKM_HOST_INSTALLED_FIXTURE || "null");
  if (!fixture?.nativeRoom || fixture.root !== root || fixture.installed !== installed || fixture.legacyVsix !== legacyVsix)
    fail("INSTALLED_ROOM_EXPLICIT_FIXTURE_DRIVER_REQUIRED");
  const previous = existsSync(join(root, credentialName)) ? readCredentialEvidence(root, intent) : undefined;
  if (!previous && existsSync(join(root, observationName))) fail("INSTALLED_ROOM_CREDENTIAL_CREATION_INCOMPLETE");
  const originalSource = originalCredentialSource(pinnedArchive(legacyVsix));
  if (hash(originalSource) !== intent.credentialProducerSha256) fail("INSTALLED_ROOM_ORIGINAL_PACKAGE_CHANGED");
  let vscode;
  try { vscode = createRequire(join(installed, "package.json"))("vscode"); }
  catch { fail("INSTALLED_ROOM_REAL_EXTENSION_HOST_REQUIRED"); }
  if (typeof vscode?.extensions?.getExtension !== "function" || !vscode.ExtensionMode || !vscode.workspace)
    fail("INSTALLED_ROOM_REAL_EXTENSION_HOST_REQUIRED");
  const extension = vscode.extensions.getExtension(extensionId);
  if (!extension || extension.isActive || extension.extensionPath !== installed
    || vscode.extensions.getExtension("uone.personal-knowledge")) fail("INSTALLED_ROOM_EARLY_ACTIVATION_OBSERVER_REQUIRED");
  const entryRequire = createRequire(join(installed, "package.json"));
  let entry, originalExports;
  try { entry = entryRequire.resolve(driver.entry); originalExports = entryRequire(entry); }
  catch { fail("INSTALLED_ROOM_ACTIVATION_LOADER_UNOBSERVABLE"); }
  if (entry !== driver.entry) fail("INSTALLED_ROOM_ACTIVATION_LOADER_UNOBSERVABLE");
  const cached = entryRequire.cache[entry];
  if (!cached || cached.exports !== originalExports || typeof originalExports.activate !== "function")
    fail("INSTALLED_ROOM_ACTIVATION_LOADER_UNOBSERVABLE");
  const descriptor = Object.getOwnPropertyDescriptor(originalExports, "activate");
  if (descriptor && "value" in descriptor && !descriptor.configurable && !descriptor.writable)
    fail("INSTALLED_ROOM_ACTIVATION_LOADER_UNOBSERVABLE");
  let resolveReady, rejectReady, restored = false, tapped = false, terminal = false;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  void ready.catch(() => {});
  const failure = code => {
    if (terminal) return;
    terminal = true;
    void publish(join(root, "native-room-credential-failed.json"), { failed: true, code }).catch(() => {});
    rejectReady(Object.assign(new Error(code), { code }));
  };
  const restore = () => {
    if (restored) return;
    restored = true;
    if (entryRequire.cache[entry] !== cached || cached.exports !== proxy) {
      failure("INSTALLED_ROOM_ACTIVATION_CACHE_CHANGED"); return;
    }
    cached.exports = originalExports;
  };
  const timer = setTimeout(() => { restore(); failure("INSTALLED_ROOM_ACTIVATION_NOT_OBSERVED"); }, timeoutMs);
  timer.unref();
  async function create(context, returned) {
    const actualExports = await returned, end = Date.now() + timeoutMs;
    while (!extension.isActive && Date.now() < end) await delay(25);
    if (terminal || !extension.isActive || extension.exports !== actualExports
      || typeof actualExports?.assertActiveMigrationContext !== "function"
      || context?.extensionMode !== vscode.ExtensionMode.Production || context.extension?.id !== extensionId
      || context.extensionPath !== installed || !vscode.workspace.isTrusted
      || JSON.stringify(vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath)) !== JSON.stringify([join(root, "editor")]))
      fail("INSTALLED_ROOM_ACTUAL_PRODUCTION_CONTEXT_REQUIRED");
    actualExports.assertActiveMigrationContext(context);
    const profileDirectory = context.globalStorageUri?.fsPath;
    if (typeof profileDirectory !== "string" || !inside(join(root, "u"), profileDirectory)
      || resolve(profileDirectory) !== profileDirectory) fail("INSTALLED_ROOM_PRIVATE_PROFILE_REQUIRED");
    let ancestor = profileDirectory;
    while (!existsSync(ancestor)) ancestor = dirname(ancestor);
    if (realpathSync(ancestor) !== ancestor || !inside(root, ancestor)) fail("INSTALLED_ROOM_PRIVATE_PROFILE_REQUIRED");
    if (privateDriver(root, installed).entrySha256 !== driver.entrySha256) fail("INSTALLED_ROOM_INSTALLED_ENTRY_CHANGED");
    if (previous) {
      if (previous.profileDirectory !== profileDirectory) fail("INSTALLED_ROOM_SAME_ACTUAL_PROFILE_REQUIRED");
      terminal = true; clearTimeout(timer); resolveReady(publicHashes(previous)); return;
    }
    await publish(join(root, "native-room-credential-modal.json"), {
      stage: "native-room-credential-create", fixtureNonce: intent.fixtureNonce, roomId: intent.roomId,
    });
    const answer = await vscode.window.showWarningMessage(credentialTitle, { modal: true, detail: JSON.stringify({
      schema: "pkm.installed-native-room-credential-confirm/v1", fixtureNonce: intent.fixtureNonce, roomId: intent.roomId,
      extensionId, extensionMode: "Production", profileDirectory, installedEntrySha256: driver.entrySha256,
      originalPackageSha256: archiveSha256, credentialProducerSha256: intent.credentialProducerSha256,
      newSyntheticCredentialsOnly: true, noOldKeyringMigration: true, noNetwork: true, noRehost: true,
      ...(intent.requestedJoinSecretSha256 !== undefined ? {
        requestedJoinSecretSha256: intent.requestedJoinSecretSha256,
        joinSecretOrigin: "caller-generated-synthetic-requested-input",
      } : {}),
      permission: "Fixture-only creation of NEW synthetic Room credentials in this actual installed Production ExtensionContext.secrets. No old credentials, ownership or joined identity is imported; only hashes leave this activation.",
    }, null, 2) }, credentialChoice, "Deny");
    if (terminal || answer !== credentialChoice) fail("INSTALLED_ROOM_CREDENTIAL_CREATION_DENIED");
    actualExports.assertActiveMigrationContext(context);
    if (!extension.isActive || extension.exports !== actualExports || !vscode.workspace.isTrusted)
      fail("INSTALLED_ROOM_ACTUAL_PRODUCTION_CONTEXT_REQUIRED");
    const compiled = new Module(join(root, "original-room-credential-producer-memory.cjs"));
    compiled.filename = join(root, "original-room-credential-producer-memory.cjs");
    compiled.paths = Module._nodeModulePaths(root);
    compiled._compile(originalSource.toString("utf8"), compiled.filename);
    const store = new compiled.exports.ChatRoomCredentialStore(context.secrets);
    const created = await store.create(intent.roomId, requestedJoinSecret);
    const hashes = { hostCredentialHash: created.hostCredentialHash, joinSecretHash: created.joinSecretHash };
    if (!digest.test(hashes.hostCredentialHash) || !digest.test(hashes.joinSecretHash)
      || hash(created.hostCredential) !== hashes.hostCredentialHash || hash(created.joinSecret) !== hashes.joinSecretHash)
      fail("INSTALLED_ROOM_ORIGINAL_CREDENTIAL_PRODUCER_FAILED");
    if (intent.requestedJoinSecretSha256 !== undefined && hashes.joinSecretHash !== intent.requestedJoinSecretSha256)
      fail("INSTALLED_ROOM_ORIGINAL_CREDENTIAL_PRODUCER_FAILED");
    let observed = false;
    while (!observed && Date.now() < end) {
      const loaded = await store.load(intent.roomId);
      observed = !!loaded && loaded.hostCredentialHash === hashes.hostCredentialHash
        && loaded.joinSecretHash === hashes.joinSecretHash && await store.verifyHost(intent.roomId, hashes.hostCredentialHash);
      if (!observed) await delay(25);
    }
    if (!observed || terminal) fail("INSTALLED_ROOM_NATIVE_CREDENTIAL_STORE_UNOBSERVABLE");
    actualExports.assertActiveMigrationContext(context);
    const evidence = credentialEvidence(intent, {
      schema: "pkm.installed-native-room-created-credentials/v1", fixtureNonce: intent.fixtureNonce, roomId: intent.roomId,
      ...hashes, profileDirectory, extensionId, extensionHostPid: process.pid,
      installedEntrySha256: driver.entrySha256, originalPackageSha256: archiveSha256,
      credentialProducerSha256: intent.credentialProducerSha256, actualProductionActivationObserved: true,
      newSyntheticCredentialsOnly: true,
    });
    const { roomId: _roomId, hostCredentialHash: _host, joinSecretHash: _join, ...observation } = evidence;
    await publish(join(root, observationName), observation);
    await publish(join(root, credentialName), publicHashes(evidence));
    terminal = true; clearTimeout(timer); resolveReady(publicHashes(evidence));
  }
  const originalActivate = originalExports.activate;
  const activate = new Proxy(originalActivate, { apply(target, receiver, args) {
    if (tapped) return Reflect.apply(target, receiver === proxy ? originalExports : receiver, args);
    tapped = true; restore();
    let result;
    try { result = Reflect.apply(target, receiver === proxy ? originalExports : receiver, args); }
    catch (error) { clearTimeout(timer); failure("INSTALLED_ROOM_PRODUCTION_ACTIVATION_FAILED"); throw error; }
    void create(args[0], result).catch(error => {
      clearTimeout(timer); failure(typeof error?.code === "string" && error.code.startsWith("INSTALLED_ROOM_")
        ? error.code : "INSTALLED_ROOM_ACTUAL_PRODUCTION_CONTEXT_REQUIRED");
    });
    return result;
  } });
  const proxy = new Proxy(originalExports, { get(target, key, receiver) {
    return key === "activate" ? activate : Reflect.get(target, key, receiver);
  } });
  cached.exports = proxy;
  return Object.freeze({ kind: "pkm.installed-room-activation-observer/v1", ready, alreadyCreated: !!previous,
    dispose() { clearTimeout(timer); restore(); if (!terminal) failure("INSTALLED_ROOM_ACTIVATION_OBSERVER_DISPOSED"); } });
}

/** Pinned original writer/oracle inputs only; this function creates no keys and proves no installed activation. */
export async function prepareInstalledNativeRoomOriginalWriters({ directory, legacyVsix, python }) {
  const archive = pinnedArchive(legacyVsix);
  if (typeof python !== "string" || !isAbsolute(python)) fail("INSTALLED_ROOM_EXPLICIT_PYTHON_REQUIRED");
  if (!isAbsolute(directory) || resolve(directory) !== directory) fail("INSTALLED_ROOM_PRIVATE_WRITER_REQUIRED");
  await mkdir(directory, { mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077
    || await realpath(directory) !== directory) fail("INSTALLED_ROOM_PRIVATE_WRITER_REQUIRED");
  execFileSync(python, ["-I", "-B", "-c", `
import io,json,stat,sys,zipfile
from pathlib import Path,PurePosixPath
root=Path(sys.argv[1]);total=0
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as archive:
 names=archive.namelist()
 metadata=json.loads(archive.read("extension/package.json"))
 assert (metadata["publisher"].lower(),metadata["name"],metadata["version"])==("uone","personal-knowledge","4.0.22")
 for member in json.loads(sys.argv[2]):
  path=PurePosixPath(member);name="extension/"+member
  assert not path.is_absolute() and ".." not in path.parts and "\\\\" not in member and ":" not in member
  assert names.count(name)==1
  info=archive.getinfo(name);total+=info.file_size
  assert not info.is_dir() and not stat.S_ISLNK(info.external_attr>>16) and info.file_size<=8388608 and total<=33554432
  target=root.joinpath(*path.parts);target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
  with target.open("xb") as output:output.write(archive.read(info))
`, directory, JSON.stringify(originalMembers)], { input: archive, timeout: 30000, maxBuffer: 1048576 });
  const files = Object.fromEntries(await Promise.all(originalMembers.map(async member => [member, hash(await readFile(join(directory, member)))])));
  const named = { name: "Historic Agent 雪 'not rejoined'" }, calls = [{}, named];
  const expected = JSON.parse(execFileSync(python, ["-I", "-B", "-c", `
import asyncio,json,os,runpy,sys
def audit(event,args):
 if event=="open":
  mode,flags=args[1:3]
  if isinstance(mode,str) and any(x in mode for x in "wax+") or isinstance(flags,int) and flags&(os.O_WRONLY|os.O_RDWR|os.O_CREAT|os.O_TRUNC|os.O_APPEND):
   raise PermissionError("Room status oracle is read only")
 if event.startswith("socket.") and not(event=="socket.__new__" and args[1]==1):raise PermissionError("No Room network")
 if event.startswith(("subprocess.","os.exec","os.spawn")) or event in {"os.system","os.fork","os.forkpty","os.mkdir","os.remove","os.rmdir","os.rename"}:
  raise PermissionError("No Room writer or worker")
sys.addaudithook(audit);sys.path.insert(0,sys.argv[1])
module=runpy.run_path(os.path.join(sys.argv[1],"chat_server.py.template"),run_name="installed_room_original_oracle")
assert module["_connections"]=={}
method=module["chat_status"];method=getattr(method,"fn",method)
print(json.dumps([asyncio.run(method(**args)) for args in json.load(sys.stdin)]))
`, join(directory, "resources")], { input: JSON.stringify(calls), encoding: "utf8", timeout: 30000,
    maxBuffer: 1048576, env: { PATH: process.env.PATH || "", PYTHONDONTWRITEBYTECODE: "1" } }));
  assert.deepEqual(JSON.parse(expected[0]), { ok: true, active_aliases: [], connections: [] });
  assert.equal(JSON.parse(expected[1]).ok, false);
  for (const member of originalMembers) assert.equal(hash(await readFile(join(directory, member))), files[member]);
  return Object.freeze({ directory, originalPackageSha256: archiveSha256, files: Object.freeze(files),
    statusCalls: Object.freeze(calls.map(Object.freeze)), statusExpected: Object.freeze(expected), installedProof: false });
}

/** Whole first editor closed, before B0/custody. Only hashes from the real activation's explicit creation are accepted. */
export async function prepareInstalledNativeRoomFixture({ root, installed, componentFixture, legacyVsix, credentialIntent, python }) {
  const selected = intents.get(credentialIntent);
  if (!selected || selected.root !== root || selected.installed !== installed || selected.legacyVsix !== legacyVsix)
    fail("INSTALLED_ROOM_ACTUAL_CREDENTIAL_INTENT_REQUIRED");
  privateDriver(root, installed);
  await (await load(installed, "original-mcp-component-recovery")).assertOriginalMcpColdComponentFixture(componentFixture);
  if (preparations.has(componentFixture)) fail("INSTALLED_ROOM_ALREADY_PREPARED");
  for (const path of [join(componentFixture.directory, "b0"), join(componentFixture.directory, "custody"),
    join(componentFixture.root, ".pkm-next-original-mcp.json"), join(componentFixture.root, "core.sqlite"),
    join(componentFixture.root, "chatrooms")])
    await absent(path, "INSTALLED_ROOM_PRESEAL_ORIGINAL_PREPARATION_REQUIRED");
  const receiptBytes = bytesSync(join(root, credentialName), 16384, true);
  const receipt = readCredentialEvidence(root, credentialIntent);
  const observationSha256 = hash(bytesSync(join(root, observationName), 16384, true));
  const ui = JSON.parse(bytesSync(join(root, "native-room-credential-ui-passed.json"), 16384, true).toString("utf8"));
  if (ui.passed !== true || ui.actualNativeUi !== true || ui.fixtureNonce !== credentialIntent.fixtureNonce
    || ui.roomId !== receipt.roomId || ui.choice !== credentialChoice) fail("INSTALLED_ROOM_ACTUAL_CREDENTIAL_UI_REQUIRED");
  if (existsSync(`/proc/${receipt.extensionHostPid}`)) fail("INSTALLED_ROOM_FIRST_EXTENSION_HOST_MUST_EXIT");
  await (await load(installed, "linux-legacy-writer-quiescence")).assertLinuxLegacyWritersQuiescent(componentFixture.root);
  const first = JSON.parse(bytesSync(join(root, "native-identity-first.json"), 16384).toString("utf8"));
  if (dirname(first.result?.path || "") !== receipt.profileDirectory) fail("INSTALLED_ROOM_SAME_ACTUAL_PROFILE_REQUIRED");
  const privacy = JSON.parse(await readFile(join(componentFixture.root, ".pkm/content-privacy.json"), "utf8"));
  if (privacy.schema !== 1 || !privacy.private?.notes?.includes("Chatroom Meetings"))
    fail("INSTALLED_ROOM_PRIVATE_MEETING_POLICY_REQUIRED");
  const writer = await prepareInstalledNativeRoomOriginalWriters({
    directory: join(componentFixture.directory, "original-room-writer"), legacyVsix, python,
  });
  if (writer.files[credentialMember] !== credentialIntent.credentialProducerSha256)
    fail("INSTALLED_ROOM_ORIGINAL_PACKAGE_CHANGED");
  const fixturePath = new URL("../../legacy/tests/next-trial-electron/chatroom-live-fixture.cjs", import.meta.url);
  const fixtureBytes = readFileSync(fixturePath), original = require(fixturePath.pathname);
  const mask = process.umask(0o077);
  let meeting;
  try {
    await original.create({ extension: writer.directory, root: componentFixture.root,
      roomId: receipt.roomId, credentials: { hostCredentialHash: receipt.hostCredentialHash, joinSecretHash: receipt.joinSecretHash },
      hostParticipantId: "historic-human", roomName: "Installed synthetic original private Room",
      descriptorName: "installed-original-room-writer.json" });
    const Store = require(join(writer.directory, "dist/chatroom/meeting-state.js")).MeetingStateStore;
    const store = new Store(join(componentFixture.root, "chatrooms"), join(componentFixture.root, "notes"));
    meeting = await store.startMeeting({ roomId: receipt.roomId, roomName: "Installed synthetic original private Room",
      title: "Installed private synthetic Meeting", problemStatement: "Retain exact private source and current native custody",
      owner: "Historic Human", lead: "Historic Human", recorder: "Historic Human", participants: ["Historic Human", "Historic Agent"],
      host: "Historic Human", triggerMessageId: "history-human", requestId: "installed-room-meeting-start", expectedRevision: 0 });
    await store.adjournMeeting({ roomId: receipt.roomId, meetingId: meeting.id, actor: "Historic Human",
      requestId: "installed-room-meeting-adjourn", expectedRevision: meeting.revision });
  } finally { process.umask(mask); }
  assert.deepEqual(readFileSync(fixturePath), fixtureBytes);
  for (const [member, sha256] of Object.entries(writer.files))
    assert.equal(hash(await readFile(join(writer.directory, member))), sha256);
  const notePath = `notes/${meeting.markdownPath}`, marker = "INSTALLED_PRIVATE_ROOM_MANUAL_NOTE";
  await writeFile(join(componentFixture.root, notePath), Buffer.concat([
    await readFile(join(componentFixture.root, notePath)), Buffer.from(`\n${marker}: private manual annotation — retain exact bytes.\n`),
  ]), { mode: 0o600 });
  const files = [];
  for (const path of [`chatrooms/${receipt.roomId}/chatroom.db`,
    `chatrooms/${receipt.roomId}/meetings/canonical.json`, notePath, ".pkm/content-privacy.json"])
    files.push({ path, bytes: await readFile(join(componentFixture.root, path)) });
  const journal = `chatrooms/${receipt.roomId}/chatroom.journal`;
  if (existsSync(join(componentFixture.root, journal))) files.push({ path: journal, bytes: await readFile(join(componentFixture.root, journal)) });
  const inspect = await load(installed, "legacy-chatroom-continuation"), archive = inspect.inspectLegacyChatroomArchive(componentFixture.root, receipt.roomId);
  const participants = inspect.inspectLegacyChatroomParticipants(componentFixture.root, receipt.roomId);
  assert.equal(archive.messages.length, 3); assert.equal(participants.memberships.length, 2);
  assert.equal(hash(bytesSync(join(root, credentialName), 16384, true)), hash(receiptBytes));
  const value = Object.freeze({ kind: "pkm.installed-native-room-fixture/v1", root: componentFixture.root, roomId: receipt.roomId,
    meetingId: meeting.id, notePath, manualMarker: marker, hostCredentialHash: receipt.hostCredentialHash,
    joinSecretHash: receipt.joinSecretHash, profileDirectory: receipt.profileDirectory,
    originalPackageSha256: archiveSha256, credentialReceiptSha256: hash(receiptBytes),
    credentialObservationSha256: observationSha256,
    files: Object.freeze(files.map(file => Object.freeze({ path: file.path, sha256: hash(file.bytes) }))) });
  const state = { value, componentFixture, installed, driverRoot: root, intent: credentialIntent, receipt, files, writer, phase: "prepared" };
  preparations.set(value, state); preparations.set(componentFixture, state);
  return value;
}

export const installedNativeRoomUiProgram = String.raw`
import hashlib,json,os,re,sys,time
from pathlib import Path
from playwright.sync_api import sync_playwright
os.umask(0o077)
f=json.loads(sys.argv[1]);root=Path(f["root"]);seconds=f["timeoutMs"]/1000;until=time.monotonic()+min(seconds*5,480)
def check(condition,message):
 if not condition:raise AssertionError(message)
def read(name):return json.loads((root/name).read_text())
def publish(name,value):
 with (root/name).open("x") as output:json.dump(value,output)
def wait_file(name):
 stop=min(until,time.monotonic()+seconds)
 while time.monotonic()<stop:
  try:return read(name)
  except (FileNotFoundError,json.JSONDecodeError):pass
  time.sleep(.025)
 raise RuntimeError("Room evidence timed out: "+name)
def stage(name):
 stop=min(until,time.monotonic()+seconds)
 while time.monotonic()<stop:
  try:
   current=read("progress.json").get("stage");check(current!="failed","Parent installed workflow failed")
   if current==name:return
  except (FileNotFoundError,json.JSONDecodeError):pass
  time.sleep(.025)
 raise RuntimeError("Room stage timed out: "+name)
def details(page,title):
 dialog=page.locator(".monaco-dialog-box:visible");dialog.wait_for(state="visible")
 check(dialog.count()==1,"Exactly one actual native modal is required")
 heading=dialog.get_by_text(title,exact=True);check(heading.count()==1 and heading.is_visible(),"Wrong exact native Room title")
 text=dialog.inner_text().replace("\u00a0"," ");start=text.find("{");check(start>=0,"Native modal omitted exact JSON")
 body,_=json.JSONDecoder().raw_decode(text[start:]);return dialog,body,text
proof={"schema":"pkm.installed-native-room-ui-evidence/v1","dialogs":[]}
output="native-room-credential-ui-passed.json" if f["mode"]=="credentials" else "native-room-ui-passed.json"
try:
 check(re.fullmatch(r"\.installed-host-[a-f0-9-]{36}",root.name),"Not a disposable installed driver")
 with sync_playwright() as p:
  browser=None
  while browser is None and time.monotonic()<until:
   try:browser=p.chromium.connect_over_cdp("http://127.0.0.1:"+str(f["port"]),timeout=1500)
   except Exception:time.sleep(.05)
  check(browser is not None,"No actual installed renderer CDP endpoint")
  pages=[]
  while len(pages)!=1 and time.monotonic()<until:
   pages=[page for context in browser.contexts for page in context.pages if "workbench" in page.url]
   if len(pages)!=1:time.sleep(.05)
  check(len(pages)==1,"Exactly one installed workbench renderer is required")
  page=pages[0];page.set_default_timeout(f["timeoutMs"]);page.wait_for_load_state("networkidle")
  if f["mode"]=="credentials":
   c=read("native-room-credential-intent.json");wait_file("native-room-credential-modal.json")
   dialog,body,text=details(page,c["title"])
   check(body["schema"]=="pkm.installed-native-room-credential-confirm/v1","Wrong creation subtype")
   for key in ["fixtureNonce","roomId","installedEntrySha256","originalPackageSha256","credentialProducerSha256"]:check(body[key]==c[key],"Wrong credential creation binding: "+key)
   check(body["extensionId"]=="pkm-nonproduction.pkm-v5" and body["extensionMode"]=="Production","Not actual Production activation")
   check(str(body["profileDirectory"]).startswith(str(root/"u")+"/"),"Profile is not disposable")
   for key in ["newSyntheticCredentialsOnly","noOldKeyringMigration","noNetwork","noRehost"]:check(body[key] is True,"Missing fixture restriction: "+key)
   check("Only hashes" in text or "only hashes" in text,"Hash-only boundary omitted")
   dialog.get_by_role("button",name=c["choice"],exact=True).click()
   wait_file("native-room-created-credentials.json")
   publish(output,{"passed":True,"actualNativeUi":True,"fixtureNonce":c["fixtureNonce"],"roomId":c["roomId"],
    "choice":c["choice"],"productionContextVisible":True,"newSyntheticKeysOnlyVisible":True,
    "textSha256":hashlib.sha256(text.encode()).hexdigest()})
  else:
   c=read("native-room-ui-contract.json");check(c["schema"]=="pkm.installed-native-room-ui/v1","Wrong Room UI contract")
   publish("native-room-ui-ready.json",{"ready":True,"actualRenderer":True})
   approved_host="";source_decision="";host_challenges=set()
   for step in c["steps"]:
    stage(step["stage"])
    for action in step["dialogs"]:
     dialog,body,text=details(page,action["title"])
     check(body["source"]==c["source"],"Room modal changed exact private source")
     check(body["session"]["binding"]==c["sessionBinding"],"Room modal changed signed root/profile/build binding")
     check(body["session"]["activationId"]==c["nativeEpoch"],"Room modal changed epoch")
     if action["kind"] in ("source","host"):check(body["noExecution"] is True,"Custody is not execution permission")
     if action["kind"]=="source":
      check("No public Note projection" in text and "participant history only" in text,"Private source boundary omitted")
     elif action["kind"]=="host":
      check(body["sourceDecisionId"] and re.fullmatch(r"[a-f0-9-]{36}",body["sourceDecisionId"]),"Host omitted source decision")
      if source_decision:check(body["sourceDecisionId"]==source_decision,"Changed source decision")
      source_decision=body["sourceDecisionId"]
      check(body["challenge"] not in host_challenges,"Host challenge was reused");host_challenges.add(body["challenge"])
      approved_host=body["challenge"] if action["choice"]=="Verify current Room Host" else ""
      check("Secrets remain in native SecretStorage" in text,"Native-only Host secret boundary omitted")
     else:
      check(body["sourceDecisionId"]==source_decision and body["hostChallenge"]==approved_host,"Status did not consume current Host proof")
      check(body["operation"]=="mcp.tool.chat_status" and body["arguments"]==step["arguments"],"Wrong exact public Room request")
      args=json.dumps(step["arguments"],ensure_ascii=False,sort_keys=True,separators=(",",":")).encode()
      check(body["argumentsSha256"]==hashlib.sha256(args).hexdigest(),"Changed argument digest")
      for key in ["noNetwork","noRehost","noParticipantChange"]:check(body[key] is True,"Missing status-only boundary")
      check("No client is joined or restored" in text and "Host/join secrets stay native" in text,"Status must not fake online or export keys")
     proof["dialogs"].append({"stage":step["stage"],"kind":action["kind"],"choice":action["choice"],"textSha256":hashlib.sha256(text.encode()).hexdigest()})
     dialog.get_by_role("button",name=action["choice"],exact=True).click()
   stage("native-room-revoke")
   item=page.locator(".statusbar-item").filter(has_text="PKM private Room")
   check(item.count()==1,"Exactly one actual private Room status indicator is required")
   item.hover();hover=page.locator(".monaco-hover").filter(has_text="Private source only; click to revoke the signed session.")
   hover.wait_for(state="visible");tooltip=hover.inner_text()
   check(c["source"]["root"] in tooltip and c["source"]["roomName"] in tooltip,"Wrong exact Room status tooltip")
   item.click();proof.update({"passed":True,"actualNativeUi":True,"sourceStatusBarClicked":True,
    "exactSourceHostAndArgumentBindingsVisible":True,"noJoinedIdentityInvented":True})
   publish(output,proof)
  browser.close()
except Exception as error:
 try:publish(output,{"failed":True,"error":str(error)})
 except FileExistsError:pass
 raise
`;

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const done = new Promise(resolve => child.once("exit", resolve));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try { await done; } finally { clearTimeout(timer); }
}
function startUi({ root, python, env, port, timeoutMs = 120000, mode }) {
  limits(port, timeoutMs);
  if (typeof python !== "string" || !isAbsolute(python)) fail("INSTALLED_ROOM_EXPLICIT_PYTHON_REQUIRED");
  const child = spawn(python, ["-I", "-B", "-c", installedNativeRoomUiProgram,
    JSON.stringify({ root, port, timeoutMs, mode })], { env, stdio: "inherit" });
  let error;
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`Installed Room UI failed ${code}/${signal}`)));
  });
  void done.catch(failure => { error = failure; });
  return Object.freeze({ done, get error() { return error; }, stop: () => stopChild(child) });
}
export function startInstalledNativeRoomCredentialUi(options) {
  privateDriver(options.root, options.installed);
  return startUi({ ...options, mode: "credentials" });
}
async function unchanged(state, root = state.value.root) {
  for (const file of state.files) assert.deepEqual(await readFile(join(root, file.path)), file.bytes);
}
function stateFor(source) {
  const state = preparations.get(source);
  if (!state) fail("INSTALLED_ROOM_ACTUAL_PREPARATION_REQUIRED");
  return state;
}

/** Run last: the actual Room status-bar revocation closes the complete signed session. */
export async function verifyInstalledNativeRoom({ root, installed, component, sourceFixture,
  python, env, port, payloadBuildId, timeoutMs = 120000 }) {
  const state = stateFor(sourceFixture);
  if (state.phase !== "prepared" || state.installed !== installed || state.driverRoot !== root
    || component.fixture !== state.componentFixture || component.root !== sourceFixture.root)
    fail("INSTALLED_ROOM_SAME_ACTUAL_COMPONENT_REQUIRED");
  if (typeof component.selectRoom !== "function" || typeof component.invoke !== "function")
    fail("INSTALLED_ROOM_ACTUAL_SELECTION_AND_PUBLIC_ROUTE_REQUIRED");
  privateDriver(root, installed); limits(port, timeoutMs);
  await (await load(installed, "original-mcp-component-recovery")).assertOriginalMcpColdComponentFixture(component.fixture);
  const first = JSON.parse(bytesSync(join(root, "native-identity-first.json"), 16384).toString("utf8"));
  const identityProof = JSON.parse(bytesSync(join(root, "native-identity-passed.json"), 16384).toString("utf8"));
  if (dirname(first.result?.path || "") !== sourceFixture.profileDirectory
    || identityProof.passed !== true || identityProof.realInstalledExtension !== true
    || identityProof.identitySha256 !== first.result.sha256) fail("INSTALLED_ROOM_SAME_ACTUAL_PROFILE_REQUIRED");
  assert.equal(bytesSync(first.result.path, 16384, true).toString("utf8"), first.publicRecord);
  (await load(installed, "original-mcp-native-identity")).verifyOriginalMcpNativeIdentity(
    JSON.parse(first.publicRecord), first.result.sha256, first.result.profileSha256);
  assert.equal(hash(bytesSync(join(root, credentialName), 16384, true)), sourceFixture.credentialReceiptSha256);
  assert.equal(hash(bytesSync(join(root, observationName), 16384, true)), sourceFixture.credentialObservationSha256);
  const host = await component.complete(), full = await component.owner.ensureFull(), lease = { ...component.owner.workspaceLease() };
  (await load(installed, "root-owner")).assertRootOwner(component.owner);
  (await load(installed, "original-mcp-native-host")).assertOriginalMcpNativeHost(host, component.storage);
  assert.equal(full.storage, component.storage);
  assert.equal(host.options.providerTransport.supports("openai-compatible"), false);
  assert.equal(host.options.providerTransport.supports("azure-openai"), false);
  const descriptorBytes = await readFile(component.attachmentDescriptorPath), descriptor = JSON.parse(descriptorBytes);
  assert.equal(hash(descriptorBytes), component.attachmentDescriptorSha256);
  assert.equal(descriptor.identitySha256, first.result.sha256);
  assert.equal(descriptor.binding.root, component.root); assert.equal(descriptor.binding.workspaceId, component.workspaceId);
  assert.equal(descriptor.binding.planSha256, component.custody.planSha256);
  assert.equal(descriptor.binding.profileSha256, first.result.profileSha256);
  assert.equal(component.custody.profileSha256, first.result.profileSha256);
  assert.equal(descriptor.binding.payloadBuildId, payloadBuildId);
  assert.equal(descriptor.binding.hostEntrySha256, hash(await readFile(join(installed, "dist/extension.cjs"))));
  assert.equal(host.receipt.authorityId, `native-rpc:${descriptor.brokerId}`);
  assert(uuid.test(host.receipt.epoch)); assert.equal(host.receipt.profileSha256, first.result.profileSha256);
  const source = await (await load(installed, "original-mcp-room-source")).inspectOriginalMcpRoomSource(
    component.storage, host, sourceFixture.roomId);
  assert.equal(source.hostCredentialHash, sourceFixture.hostCredentialHash);
  assert.equal(source.joinSecretHash, sourceFixture.joinSecretHash);
  assert.equal(source.hostParticipantId, "historic-human"); assert.equal(source.participants, 2);
  assert.equal(source.messages, 3); assert.equal(source.meetings, 1); assert.equal(source.privateNotes, 1);
  const sourceDialog = choice => ({ kind: "source", title: "Admit this exact original private Room source?", choice });
  const hostDialog = choice => ({ kind: "host", title: "Verify current native-profile Room Host custody?", choice });
  const statusDialog = choice => ({ kind: "status", title: "Read this exact original Room client status?", choice });
  const steps = [
    { stage: "native-room-source-deny", dialogs: [sourceDialog("Deny")] },
    { stage: "native-room-source-admit", dialogs: [sourceDialog("Admit this private Room source only")] },
    { stage: "native-room-host-deny", arguments: {}, dialogs: [hostDialog("Deny")] },
    { stage: "native-room-status-deny", arguments: {}, dialogs: [hostDialog("Verify current Room Host"), statusDialog("Deny")] },
    ...state.writer.statusCalls.map((args, index) => ({ stage: `native-room-status-${index ? "named" : "empty"}`, arguments: args,
      dialogs: [hostDialog("Verify current Room Host"), statusDialog("Read this exact Room client status")] })),
  ];
  await publish(join(root, "native-room-ui-contract.json"), { schema: "pkm.installed-native-room-ui/v1",
    source, sessionBinding: descriptor.binding, nativeEpoch: host.receipt.epoch, steps });
  const ui = startUi({ root, python, env, port, timeoutMs, mode: "status" }), cancellation = new AbortController();
  void ui.done.catch(error => cancellation.abort(error));
  const progress = stage => writeFile(join(root, "progress.json"), JSON.stringify({ stage }), { mode: 0o600 });
  const checkUi = () => { if (ui.error) throw ui.error; };
  const invoke = async args => {
    checkUi();
    const result = await component.invoke("chat_status", args, cancellation.signal);
    assert(!result.isError, JSON.stringify(result));
    const value = result.structuredContent ?? JSON.parse(result.content?.[0]?.text);
    assert.deepEqual(Object.keys(value), ["result"]);
    assert.equal(typeof value.result, "string");
    assert.deepEqual(JSON.parse(result.content[0].text), value);
    return value;
  };
  state.phase = "verifying"; state.b0Sha256 = component.b0?.sha256;
  if (!digest.test(state.b0Sha256)) fail("INSTALLED_ROOM_ACTUAL_B0_REQUIRED");
  try {
    await waitJson(join(root, "native-room-ui-ready.json"), timeoutMs, checkUi);
    await assert.rejects(invoke({}), /SOURCE_SELECTION_REQUIRED/);
    await progress("native-room-source-deny");
    await assert.rejects(component.selectRoom(sourceFixture.roomId), /SOURCE_DENIED/); await unchanged(state);
    await assert.rejects(invoke({}), /SOURCE_SELECTION_REQUIRED/);
    await progress("native-room-source-admit");
    const selected = await component.selectRoom(sourceFixture.roomId); await unchanged(state);
    await progress("native-room-host-deny");
    await assert.rejects(invoke({}), /HOST_DENIED/); await unchanged(state);
    await progress("native-room-status-deny");
    await assert.rejects(invoke({}), /STATUS_DENIED/); await unchanged(state);
    const actual = [];
    for (const [index, args] of state.writer.statusCalls.entries()) {
      await progress(`native-room-status-${index ? "named" : "empty"}`);
      const value = await invoke(args);
      assert.equal(value.result, state.writer.statusExpected[index], "Original chat_status inner JSON string must match byte-for-byte.");
      assert(!JSON.stringify(value).includes(sourceFixture.manualMarker));
      actual.push(value); await unchanged(state);
    }
    assert.equal((await component.owner.ensureFull()).runtime.core, full.runtime.core);
    assert.deepEqual(component.owner.workspaceLease(), lease);
    await progress("native-room-revoke");
    const uiEvidence = await waitJson(join(root, "native-room-ui-passed.json"), timeoutMs, checkUi);
    await ui.done;
    assert.equal(uiEvidence.actualNativeUi, true); assert.equal(uiEvidence.sourceStatusBarClicked, true);
    assert.equal(uiEvidence.dialogs.length, 9);
    const end = Date.now() + timeoutMs;
    while (!host.signal.aborted && Date.now() < end) { checkUi(); await delay(25); }
    assert.equal(host.signal.aborted, true, "Actual native Room UI revocation must revoke the real signed host.");
    await assert.rejects(invoke({}));
    await assert.rejects(selected.dispatch("mcp.tool.chat_status", {}));
    await unchanged(state);
    const db = component.storage.connectNative();
    try {
      const row = db.prepare("SELECT payload FROM original_mcp_native_host_admissions WHERE receipt_sha256=?").get(host.receipt.receiptSha256);
      assert(row); state.nativeHostReceipt = JSON.parse(row.payload);
      assert.deepEqual(state.nativeHostReceipt, host.receipt);
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='legacy_room_runtime_rooms'").get())
        assert.equal(db.prepare("SELECT count(*) AS n FROM legacy_room_runtime_rooms WHERE room_id=?").get(sourceFixture.roomId).n, 0);
    } finally { db.close(); }
    const evidence = { passed: true, scope: "new synthetic installed Room credentials and no-joined-client status only",
      actualInstalledUi: uiEvidence, sameRootOwnerStorageAndCore: true, sameNativeProfile: true,
      originalPackageSha256: archiveSha256, credentialReceiptSha256: sourceFixture.credentialReceiptSha256,
      profileSha256: first.result.profileSha256, payloadBuildId, nativeEpoch: host.receipt.epoch,
      custodyPlanSha256: component.custody.planSha256, sourceSha256: source.sourceSha256,
      sourceDenyNoSelection: true, hostDenyNoStatus: true, statusDenyNoResult: true,
      originalEmptyAndNamedStatusParity: true, actualSignedSessionRevokedByRoomUi: true,
      cachedPublicPortFailsClosed: true, privateRoomAndManualMeetingNoteUnchanged: true,
      newSyntheticKeysOnly: true, keyringCopiedOrRestored: false, networkRehostOrJoinedClientQualified: false,
      fullTenQualified: false, fullCutoverQualified: false, b1AndB0Qualified: false, actual };
    state.evidence = evidence; state.phase = "verified";
    await publish(join(root, "native-room-passed.json"), evidence);
    return evidence;
  } finally {
    if (state.phase !== "verified") state.phase = "failed";
    cancellation.abort(); await ui.stop();
  }
}

/** Called only after parent-confirmed complete editor shutdown and genuine component B1/retire/B0 recovery. */
export async function verifyInstalledNativeRoomRestored(sourceFixture, { retirement, restored }) {
  const state = stateFor(sourceFixture);
  if (state.phase !== "verified" || !state.evidence || !state.nativeHostReceipt)
    fail("INSTALLED_ROOM_VERIFIED_EFFECTS_AND_PARENT_RECOVERY_REQUIRED");
  if (retirement?.kind !== "pkm.original-mcp-component-retirement/v1" || retirement.root !== sourceFixture.root
    || retirement.receiptPath !== join(state.componentFixture.directory, "retirement-complete.json")
    || restored?.root !== join(state.componentFixture.directory, "restored-b0")
    || restored.receiptPath !== join(state.componentFixture.directory, "b0-restored.json")
    || restored.originalRootOverwritten !== false || restored.newRootIdentity !== true)
    fail("INSTALLED_ROOM_PARENT_RECOVERY_RECEIPTS_REQUIRED");
  if (typeof retirement.archive !== "string" || !/^\.pkm-next-component-retired-[a-f0-9-]{36}$/.test(basename(retirement.archive))
    || relative(sourceFixture.root, retirement.archive) !== basename(retirement.archive))
    fail("INSTALLED_ROOM_DISJOINT_RESTORATION_REQUIRED");
  const retiredBytes = await readFile(retirement.receiptPath), restoredBytes = await readFile(restored.receiptPath);
  assert.equal(hash(retiredBytes), retirement.receiptSha256); assert.equal(hash(restoredBytes), restored.receiptSha256);
  const prior = JSON.parse(retiredBytes), after = JSON.parse(restoredBytes);
  assert.equal(prior.schema, "pkm.original-mcp-component-retirement/v1");
  assert.equal(prior.archive, retirement.archive); assert.equal(prior.originalPathRetired, true); assert.equal(prior.enginesStopped, true);
  assert.equal(prior.b0Sha256, state.b0Sha256);
  assert.equal(after.schema, "pkm.original-mcp-component-b0-restored/v1");
  assert.equal(after.originalRoot, sourceFixture.root); assert.equal(after.root, restored.root);
  assert.equal(after.retirementSha256, retirement.receiptSha256);
  assert.equal(after.b0Sha256, state.b0Sha256); assert.equal(after.b1Sha256, prior.b1Sha256);
  assert.equal(after.nativeIdentityOrProfileRestored, false); assert.equal(after.originalRootOverwritten, false);
  for (const root of [retirement.archive, restored.root]) {
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(root) !== root) fail("INSTALLED_ROOM_CANONICAL_RECOVERY_REQUIRED");
    await unchanged(state, root);
  }
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(retirement.archive, "core.sqlite"), { readOnly: true });
  try {
    assert.equal(db.prepare("PRAGMA quick_check").get().quick_check, "ok");
    assert.deepEqual(JSON.parse(db.prepare("SELECT payload FROM original_mcp_native_host_admissions WHERE receipt_sha256=?")
      .get(state.nativeHostReceipt.receiptSha256).payload), state.nativeHostReceipt);
  } finally { db.close(); }
  await absent(join(restored.root, "core.sqlite"), "INSTALLED_ROOM_B0_MUST_NOT_INHERIT_NATIVE_STATE");
  await absent(join(restored.root, ".pkm-next-original-mcp.json"), "INSTALLED_ROOM_B0_MUST_NOT_INHERIT_NATIVE_GRANTS");
  return { originalRoomAndPrivateManualNoteB0Restored: true, originalRoomAndPrivateManualNoteB1Preserved: true,
    actualNativeHostAdmissionB1Preserved: true, freshB0HasNoNativeStateOrGrant: true,
    keyringCopiedOrRestored: false, fullTenQualified: false, fullCutoverQualified: false };
}

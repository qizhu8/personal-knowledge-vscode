#!/usr/bin/env node
"use strict";
const fs = require("node:fs"), path = require("node:path"), net = require("node:net");
const { spawn, spawnSync, fork, execFileSync } = require("node:child_process");
const { createHash, createHmac, createDecipheriv, randomBytes, randomUUID, scryptSync } = require("node:crypto");
const { runInNewContext } = require("node:vm");
const assert = require("node:assert/strict"), ts = require("typescript");

const project = path.resolve(__dirname, ".."), work = path.join(project, ".migration-test-work");
const code = process.env.PKM_VSCODE_EXECUTABLE || "/home/yuwang8/.cache/pkm-vscode-test/vscode-linux-x64-1.143.0/code";
const xvfb = process.env.PKM_TRIAL_XVFB || "/home/yuwang8/.cache/pkm-vscode-test/tools/xvfb/usr/bin/Xvfb";
const uiMode = process.env.PKM_PRIVATE_SUBSCRIPTION_UI_JOURNEY === "1";
const remote = uiMode && process.env.PKM_PRIVATE_SUBSCRIPTION_REMOTE === "1";
const membershipMode = remote && process.env.PKM_PRIVATE_SUBSCRIPTION_MEMBERSHIP === "1";
const setupOnly = remote && process.env.PKM_PRIVATE_SUBSCRIPTION_REMOTE_SETUP_ONLY === "1";
const multi = uiMode && (remote || process.env.PKM_PRIVATE_SUBSCRIPTION_MULTI === "1");
const physicalIdentity = uiMode || process.env.PKM_PRIVATE_SUBSCRIPTION_REAL_IDENTITY === "1";
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
process.umask(0o077);

if (process.argv[2] !== "--inside") {
  const fixture = path.join(work, `pkm-protected-state-fixture-${randomUUID()}`);
  const short = path.join(project, `.ps${randomBytes(3).toString("hex")}`);
  for (const dir of [fixture, path.join(fixture, "run"), path.join(fixture, "h"), path.join(fixture, "t")])
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.symlinkSync(fixture, short, "dir");
  const config = path.join(fixture, "dbus.conf");
  fs.writeFileSync(config, `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-BUS Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig><type>session</type><listen>unix:dir=${short}/run</listen><auth>EXTERNAL</auth>
<policy context="default"><allow send_destination="*"/><allow eavesdrop="true"/><allow own="*"/><allow user="*"/></policy>
</busconfig>`, { mode: 0o600 });
  try {
    const env = { PATH: process.env.PATH || "", HOME: path.join(fixture, "h"),
      PKM_VSCODE_EXECUTABLE: code, PKM_TRIAL_XVFB: xvfb,
      PKM_PRIVATE_SUBSCRIPTION_REAL_IDENTITY: physicalIdentity ? "1" : "0",
      PKM_PRIVATE_SUBSCRIPTION_UI_JOURNEY: uiMode ? "1" : "0",
      PKM_PRIVATE_SUBSCRIPTION_MULTI: multi ? "1" : "0",
      PKM_PRIVATE_SUBSCRIPTION_REMOTE: remote ? "1" : "0",
      PKM_PRIVATE_SUBSCRIPTION_MEMBERSHIP: membershipMode ? "1" : "0",
      PKM_PRIVATE_SUBSCRIPTION_REMOTE_SETUP_ONLY: setupOnly ? "1" : "0",
      XDG_RUNTIME_DIR: path.join(short, "run"), TMPDIR: path.join(fixture, "t") };
    const run = spawnSync("unshare", ["--user", "--map-root-user", "--mount", "--net", "--pid", "--fork", "--mount-proc",
      "dbus-run-session", `--config-file=${config}`, "--", process.execPath, __filename, "--inside", fixture, short],
    { cwd: fixture, env, stdio: "inherit", timeout: 600_000 });
    if (run.error) throw run.error;
    process.exitCode = run.status ?? 1;
  } finally {
    fs.rmSync(short, { force: true });
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
} else {
  void main(process.argv[3], process.argv[4]).catch(error => {
    console.error("Private Subscription host test failed:", error && error.message || "unknown");
    process.exitCode = 1;
  });
}

async function legacyFixture(fixture) {
  const profile = path.join(fixture, "profile"), statePath = path.join(profile, "subscriptions.json"), memory = new Map();
  const virtualFs = { ...fs,
    existsSync(file) { return memory.has(String(file)) || fs.existsSync(file); },
    readFileSync(file, options) {
      if (!memory.has(String(file))) return fs.readFileSync(file, options);
      const value = Buffer.from(memory.get(String(file)));
      return typeof options === "string" ? value.toString(options) : options?.encoding ? value.toString(options.encoding) : value;
    },
    writeFileSync(file, value, options) {
      if (String(file).startsWith(`${statePath}.`)) { memory.set(String(file), Buffer.from(value)); return; }
      return fs.writeFileSync(file, value, options);
    },
    renameSync(from, to) {
      if (String(to) === statePath && memory.has(String(from))) {
        memory.get(statePath)?.fill(0);
        memory.set(statePath, memory.get(String(from))); memory.delete(String(from)); return;
      }
      return fs.renameSync(from, to);
    },
  };
  const mocks = {
    fs: physicalIdentity ? fs : virtualFs,
    os: { ...require("node:os"), hostname: () => "127.0.0.1" },
    "./subscription-mqtt-client": {},
    "../sync/sync-server": { emptySyncSelection: () => ({}),
      buildSyncBundle: () => ({ notes: [{ slug: "Fixture", content: "# Synthetic old share\n" }] }),
      attachMarkdownAssetsToSyncBundle: value => value },
    "./subscription-ip-policy": { normalizeIpBlockRules: values => values },
    "../servers/servers": {}, "../knowledge/content-privacy": { isContentItemPrivate: () => false },
    "../chatroom/chat-room-lock": {}, "../runtime/cross-process-lock": {
      withCrossProcessLock: (_file, _name, _timeout, action) => action(),
    },
    "../runtime/user-service-ports": { stableUserPort: () => 23000 }, "../knowledge/markdown-assets": {},
  };
  const text = fs.readFileSync(path.join(project, "src/subscriptions/subscriptions.ts"), "utf8");
  const output = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} };
  runInNewContext(output, { module, exports: module.exports, require: name => mocks[name] ?? require(name),
    Buffer, process, URL, setTimeout, clearTimeout, setInterval, clearInterval, console, __dirname: project });
  const secret = randomBytes(32).toString("base64url"), secrets = new Map();
  const Manager = module.exports.SharedMarketManager;
  const manager = new Manager(profile, path.join(fixture, "unused-gateway.js"), "Synthetic publisher", {}, {
    async get(key) { return secrets.get(key); },
    async store(key, value) { secrets.set(key, value); },
    async delete(key) { secrets.delete(key); },
  }, { user: "fixture", host: "fixture" });
  let share = await manager.upsertShare({ name: "Synthetic share", protection: "secret-protected", secret,
    contentTypes: ["notes"], selected: { notes: ["Fixture"] }, controlPort: 23001 });
  share = await manager.upsertShare({ shareId: share.shareId, name: "Synthetic share v2",
    protection: "secret-protected", contentTypes: ["notes"], selected: { notes: ["Fixture"] }, controlPort: 23001 });
  assert.equal(share.revision, 2);
  if (secrets.get(`personalKnowledge.shareBroker.${share.shareId}.secret`) !== secret)
    throw new Error("Legacy publisher fixture secret unavailable.");
  const state = physicalIdentity ? fs.readFileSync(statePath) : memory.get(statePath);
  assert(state && JSON.parse(state).privateKey);
  if (!physicalIdentity) fs.writeFileSync(statePath, "virtual-old-state", { mode: 0o600 });
  return { secret: Buffer.from(secret), state: Buffer.from(state), shareId: share.shareId, statePath, share,
    parseShareMagicLink: module.exports.parseShareMagicLink, verifyShareSummary: module.exports.verifyShareSummary };
}

async function legacyUiFixture(fixture, ext) {
  const profile = path.join(fixture, "profile"), statePath = path.join(profile, "subscriptions.json");
  const setRoot = root => {
    require(path.join(ext, "dist/knowledge/filestore.js")).setStorePath(root);
    require(path.join(ext, "dist/knowledge/storage.js")).setStorePath(root);
  };
  setRoot(path.join(fixture, "original"));
  const legacy = require(path.join(ext, "dist/subscriptions/subscriptions.js"));
  const secrets = new Map(), secret = randomBytes(32).toString("base64url");
  const secondSecret = multi ? randomBytes(32).toString("base64url") : undefined;
  const manager = new legacy.SharedMarketManager(profile, path.join(ext, "dist/subscription-gateway.js"),
    "Synthetic publisher", {}, {
      async get(key) { return secrets.get(key); },
      async store(key, value) { secrets.set(key, value); },
      async delete(key) { secrets.delete(key); },
    }, { user: "fixture", host: "fixture" });
  if (remote) require(path.join(ext, "dist/runtime/next-protected-remote-subscription-fixture.js"))
    .installRemoteSubscriptionFixtureTransport(manager, fixture);
  const remoteSecrets = new Map();
  let gateway, remoteGateway, remoteManager, phase = "configuration";
  try {
    await manager.configure({ enabled: false, port: 23000, advertisedHost: "127.0.0.1", displayName: "Synthetic publisher" });
    let share = await manager.upsertShare({ name: "Synthetic share", protection: "secret-protected", secret,
      contentTypes: ["notes"], selected: { notes: ["Fixture"] }, controlPort: 23001 });
    const nodeId = manager.snapshot.nodeId;
    if (remote) {
      const remoteProfile = path.join(fixture, "remote-profile"), remoteRoot = path.join(fixture, "remote-original");
      fs.mkdirSync(remoteProfile, { recursive: true, mode: 0o700 });
      fs.mkdirSync(path.join(remoteRoot, "notes"), { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(remoteRoot, "notes/Second.md"), "# Synthetic restricted original\n", { mode: 0o600 });
      remoteManager = new legacy.SharedMarketManager(remoteProfile, path.join(ext, "dist/subscription-gateway.js"),
        "Synthetic remote publisher", {}, {
          async get(key) { return remoteSecrets.get(key); },
          async store(key, value) { remoteSecrets.set(key, value); },
          async delete(key) { remoteSecrets.delete(key); },
        }, { user: "remote", host: "remote" });
      await remoteManager.configure({ enabled: false, port: 23010, advertisedHost: "127.0.0.1", displayName: "Synthetic remote publisher" });
      if (remoteManager.snapshot.nodeId === nodeId) throw new Error("Remote publisher identity is not distinct.");
      setRoot(remoteRoot);
    }
    const secondManager = remoteManager || manager;
    phase = "second-publisher";
    let secondShare = multi ? await secondManager.upsertShare({ name: "Synthetic restricted share", protection: "secret-protected", secret: secondSecret,
      contentTypes: ["notes"], selected: { notes: ["Second"] }, controlPort: 23002,
      accountMode: "white-list", accountRules: [nodeId] }) : undefined;
    setRoot(path.join(fixture, "original"));
    gateway = spawn(process.execPath, [path.join(ext, "dist/subscription-gateway.js"),
      path.join(profile, "gateway-state.json"), "synthetic"], { env: process.env, stdio: "ignore" });
    if (remote) remoteGateway = spawn(process.execPath, [path.join(ext, "dist/subscription-gateway.js"),
      path.join(fixture, "remote-profile/gateway-state.json"), "synthetic"], { env: process.env, stdio: "ignore" });
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (gateway.exitCode !== null) break;
      try { if ((await fetch("http://127.0.0.1:23001/.well-known/pkm-node")).ok
        && (!remote || (await fetch("http://127.0.0.1:23002/.well-known/pkm-node")).ok)) { ready = true; break; } } catch {}
      await delay(100);
    }
    if (!ready) throw new Error("Legacy fixture gateway unavailable.");
    phase = "first-subscribe";
    const record = await manager.subscribe(manager.magicLink(share.shareId), "Synthetic old subscription",
      await manager.shareSecret(share.shareId));
    phase = "second-subscribe";
    const secondRecord = secondShare && await manager.subscribe(secondManager.magicLink(secondShare.shareId), "Synthetic restricted subscription",
      await secondManager.shareSecret(secondShare.shareId));
    if (remote) {
      const proof = secondManager.subscriberProof(secondShare.shareId);
      const base = scryptSync(secondSecret, Buffer.from(secondShare.secretSalt, "base64url"), 32);
      const verifier = createHmac("sha256", base).update("pkm-share-auth:v1").digest();
      try {
        const denied = await fetch(`http://127.0.0.1:23002/v1/shares/${secondShare.shareId}/summary`, {
          headers: { "X-PKM-Subscriber-Proof": proof,
            "X-PKM-Share-Secret-Proof": createHmac("sha256", verifier).update(proof).digest("base64url") },
        });
        if (denied.status !== 403) throw new Error("Remote publisher ACL admitted a different identity.");
      } finally { base.fill(0); verifier.fill(0); }
    }
    if (record.revision !== 1 || manager.cachedGroups("notes").length !== (multi ? 2 : 1)) throw new Error("Legacy fixture cache unavailable.");
    const stopped = new Promise(resolve => gateway.once("exit", resolve));
    gateway.kill("SIGTERM"); await stopped; gateway = undefined;
    if (remoteGateway) {
      const stoppedRemote = new Promise(resolve => remoteGateway.once("exit", resolve));
      remoteGateway.kill("SIGTERM"); await stoppedRemote; remoteGateway = undefined;
    }
    fs.writeFileSync(path.join(fixture, "original/notes/Fixture.md"), "# Synthetic refreshed note revision 2\n", { mode: 0o600 });
    phase = "first-publish";
    share = await manager.upsertShare({ shareId: share.shareId, name: "Synthetic share v2",
      protection: "secret-protected", contentTypes: ["notes"], selected: { notes: ["Fixture"] }, controlPort: 23001 });
    if (share.revision !== 2) throw new Error("Legacy fixture revision unavailable.");
    if (secondShare) {
      phase = "second-publish";
      const secondRoot = path.join(fixture, remote ? "remote-original" : "original");
      setRoot(secondRoot);
      fs.writeFileSync(path.join(secondRoot, "notes/Second.md"), "# Synthetic restricted revision 2\n", { mode: 0o600 });
      secondShare = await secondManager.upsertShare({ shareId: secondShare.shareId, name: "Synthetic restricted share v2",
        protection: "secret-protected", contentTypes: ["notes"], selected: { notes: ["Second"] }, controlPort: 23002,
        accountMode: "white-list", accountRules: [nodeId] });
      fs.writeFileSync(path.join(secondRoot, "notes/Second.md"), "# Synthetic restricted revision 3\n", { mode: 0o600 });
      secondShare = await secondManager.upsertShare({ shareId: secondShare.shareId, name: "Synthetic restricted share v3",
        protection: "secret-protected", contentTypes: ["notes"], selected: { notes: ["Second"] }, controlPort: 23002,
        accountMode: "white-list", accountRules: [nodeId] });
      if (secondShare.revision !== 3 || secondRecord.revision !== 1) throw new Error("Legacy restricted fixture revision unavailable.");
      setRoot(path.join(fixture, "original"));
    }
    const state = fs.readFileSync(statePath);
    if (secrets.get(`personalKnowledge.subscription.${nodeId}.${share.shareId}.secret`) !== secret)
      throw new Error("Legacy subscriber fixture secret unavailable.");
    if (multi && secrets.get(`personalKnowledge.subscription.${secondRecord.nodeId}.${secondShare.shareId}.secret`) !== secondSecret)
      throw new Error("Legacy restricted subscriber fixture secret unavailable.");
    return { secret: Buffer.from(secret), state, shareId: share.shareId, statePath, share, nodeId, subscriptionId: record.id,
      secondShareId: secondShare?.shareId, secondSubscriptionId: secondRecord?.id,
      secondNodeId: secondRecord?.nodeId,
      secondSecret: secondSecret ? Buffer.from(secondSecret) : undefined,
      parseShareMagicLink: legacy.parseShareMagicLink, verifyShareSummary: legacy.verifyShareSummary };
  } catch (error) {
    throw new Error(`Legacy synthetic profile setup failed at ${phase}: ${error instanceof Error ? error.message : "unknown"}`);
  } finally {
    manager.dispose();
    remoteManager?.dispose();
    if (gateway && gateway.exitCode === null && gateway.signalCode === null) {
      const stopped = new Promise(resolve => gateway.once("exit", resolve)); gateway.kill("SIGTERM"); await stopped;
    }
    if (remoteGateway && remoteGateway.exitCode === null && remoteGateway.signalCode === null) {
      const stopped = new Promise(resolve => remoteGateway.once("exit", resolve)); remoteGateway.kill("SIGTERM"); await stopped;
    }
  }
}

function inventory(dir) {
  const out = {};
  function walk(file, rel) {
    const stat = fs.lstatSync(file);
    const pin = { dev: stat.dev, ino: stat.ino, mode: stat.mode };
    if (stat.isSymbolicLink()) { out[rel] = { ...pin, type: "link" }; return; }
    if (stat.isDirectory()) {
      out[rel] = { ...pin, type: "directory" };
      for (const name of fs.readdirSync(file).sort()) walk(path.join(file, name), `${rel}/${name}`);
    } else if (stat.isFile()) out[rel] = { ...pin, type: "file", sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex") };
  }
  walk(dir, "");
  return out;
}

async function main(fixture, short) {
  if (!fixture || path.dirname(fixture) !== work || !/^pkm-protected-state-fixture-[a-f0-9-]{36}$/.test(path.basename(fixture))) throw new Error("Invalid fixture.");
  if (!short || path.dirname(short) !== project || !/^\.ps[a-f0-9]{6}$/.test(path.basename(short)) || fs.realpathSync(short) !== fixture)
    throw new Error("Invalid private socket alias.");
  if (remote) process.env.PKM_PRIVATE_SUBSCRIPTION_STATE_IMPORT = fixture;
  for (const name of ["original/notes", "profile", "u/User/globalStorage/uone.personal-knowledge", "x", "driver", "workspace"])
    fs.mkdirSync(path.join(fixture, name), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(fixture, "original/notes/Fixture.md"), "# Synthetic original note\n", { mode: 0o600 });
  if (multi) fs.writeFileSync(path.join(fixture, "original/notes/Second.md"), "# Synthetic restricted original\n", { mode: 0o600 });
  fs.writeFileSync(path.join(fixture, "u/User/settings.json"), JSON.stringify({
    "personalKnowledge.openOnStartup": false, "security.workspace.trust.enabled": false,
    "telemetry.telemetryLevel": "off", "update.mode": "none", "extensions.autoUpdate": false,
  }), { mode: 0o600 });
  const ext = path.join(fixture, `x/uone.personal-knowledge-${require("../package.json").version}`);
  fs.mkdirSync(ext, { mode: 0o700 });
  fs.copyFileSync(path.join(project, "package.json"), path.join(ext, "package.json"));
  execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", project,
    "--outDir", path.join(ext, "dist"), "--sourceMap", "false"], { cwd: project, env: process.env, stdio: "ignore", timeout: 120_000 });
  if (physicalIdentity) execFileSync(require.resolve("esbuild/bin/esbuild"), [
    path.join(project, "src/subscriptions/subscription-gateway-entry.ts"), "--bundle", "--platform=node", "--format=cjs",
    `--outfile=${path.join(ext, "dist/subscription-gateway.js")}`], { cwd: project, env: process.env, stdio: "ignore", timeout: 120_000 });
  require("./next-rehearsal-runtime.js").stage(path.join(ext, "next-runtime"), { production: true });
  fs.symlinkSync(path.join(project, "node_modules"), path.join(ext, "node_modules"), "dir");
  if (uiMode) {
    fs.copyFileSync(path.join(ext, "dist/subscriptions/subscription-materialize-worker.js"),
      path.join(ext, "dist/subscription-materialize-worker.js"));
    execFileSync(require.resolve("esbuild/bin/esbuild"), [path.join(project, "src/subscriptions/subscription-mqtt-client.ts"),
      "--bundle", "--platform=node", "--format=cjs", "--define:navigator=undefined",
      `--outfile=${path.join(ext, "dist/subscriptions/subscription-mqtt-client.js")}`],
    { cwd: project, env: process.env, stdio: "ignore", timeout: 120_000 });
    const ui = path.join(ext, "private-subscription-ui"); fs.mkdirSync(ui);
    fs.copyFileSync(path.join(project, "src/webview/panel/45-subscriptions.js"), path.join(ui, "45-subscriptions.js"));
    fs.copyFileSync(path.join(project, "next-server/tests/legacy-protected-subscription-ui-bridge.js"), path.join(ui, "bridge.js"));
    fs.copyFileSync(path.join(project, "next-server/tests/legacy-protected-subscription-ui-start.js"), path.join(ui, "start.js"));
    const mount = path.join(fixture, "u/User/globalStorage/uone.personal-knowledge/subscriptions");
    fs.mkdirSync(mount, { mode: 0o700 });
    if (spawnSync("mount", ["--bind", path.join(fixture, "profile"), mount], { stdio: "ignore" }).status !== 0)
      throw new Error("Private legacy profile bind mount unavailable.");
    if (spawnSync("ip", ["link", "set", "lo", "up"], { stdio: "ignore" }).status !== 0)
      throw new Error("Private loopback unavailable.");
  }
  const original = uiMode ? await legacyUiFixture(fixture, ext) : await legacyFixture(fixture), nonce = randomUUID();
  if (setupOnly) {
    try {
      if (original.nodeId === original.secondNodeId || !original.secondSubscriptionId)
        throw new Error("Remote identity isolation failed.");
      const state = JSON.parse(original.state.toString());
      const record = state.subscriptions.find(item => item.id === original.secondSubscriptionId);
      if (record?.revision !== 1 || record.nodeId !== original.secondNodeId
        || !fs.readFileSync(path.join(fixture, "profile/cache", record.nodeId, record.shareId, "content/notes/Second.md"), "utf8")
          .includes("Synthetic restricted original")) throw new Error("Remote initial pull failed.");
      console.log("PASS: isolated distinct-identity legacy manager and remote fixture transport.");
      return;
    } finally { original.secret.fill(0); original.secondSecret?.fill(0); original.state.fill(0); }
  }
  const signingKey = Buffer.from(JSON.parse(original.state.toString()).privateKey);
  const remoteSigningKey = remote ? Buffer.from(JSON.parse(fs.readFileSync(path.join(fixture, "remote-profile/subscriptions.json"))).privateKey) : undefined;
  let wrong;
  const rootStat = fs.lstatSync(path.join(fixture, "original"), { bigint: true }), profileStat = fs.lstatSync(path.join(fixture, "profile"), { bigint: true });
  fs.writeFileSync(path.join(fixture, "subscription-state-fixture.json"), JSON.stringify({
    schema: "pkm.protected-subscription-state-fixture/v1", nonce,
    rootPin: `${rootStat.dev}:${rootStat.ino}`, profilePin: `${profileStat.dev}:${profileStat.ino}`,
  }), { mode: 0o600 });
  fs.writeFileSync(path.join(fixture, "driver-config.json"), JSON.stringify({ nonce, shareId: original.shareId,
    ...(multi ? { shareIds: [original.shareId, original.secondShareId], secondNodeId: original.secondNodeId } : {}),
    ...(uiMode ? { subscriberNodeId: original.nodeId } : {}) }), { mode: 0o600 });
  for (const name of ["package.nls.json", "package.nls.zh-cn.json"]) fs.copyFileSync(path.join(project, name), path.join(ext, name));
  const verifier = require(path.join(ext, "dist/runtime/next-payload-verifier.js"));
  const payload = verifier.verifyNextPayload(ext);
  const entry = path.join(payload.root, "server/dist/legacy-protected-state-vscode-child.js");
  assert(fs.lstatSync(entry).isFile());
  const driver = path.join(fixture, "driver");
  fs.writeFileSync(path.join(driver, "package.json"), JSON.stringify({ name: "protected-host-driver", publisher: "fixture",
    version: "0.0.1", engines: { vscode: "^1.90.0" }, activationEvents: ["*"], main: "./extension.cjs" }));
  fs.copyFileSync(path.join(project, "next-server/tests/legacy-protected-host-driver.cjs"), path.join(driver, "extension.cjs"));
  const seedShim = path.join(ext, "seed-shim.cjs"), manifest = fs.readFileSync(path.join(ext, "package.json"));
  const env = { ...process.env, HOME: path.join(fixture, "h"), USERPROFILE: path.join(fixture, "h"),
    TMPDIR: path.join(fixture, "t"), XDG_RUNTIME_DIR: path.join(short, "run"),
    PKM_PRIVATE_SUBSCRIPTION_NODE: process.execPath,
    PKM_PRIVATE_SUBSCRIPTION_STATE_IMPORT: fixture, PKM_PRIVATE_SUBSCRIPTION_SOCKET_ROOT: short, DISPLAY: "127.0.0.1:91",
    HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1", ALL_PROXY: "http://127.0.0.1:1", NO_PROXY: "127.0.0.1" };
  assert.equal(spawnSync("ip", ["link", "set", "lo", "up"], { env }).status, 0);
  const desktop = spawn(xvfb, [":91", "-screen", "0", "1280x800x24", "-nolock", "-nolisten", "unix", "-listen", "tcp", "-ac"],
    { env, stdio: "ignore" });
  const keyring = spawn("gnome-keyring-daemon", ["--unlock", "--foreground", "--components=secrets"],
    { env, stdio: ["pipe", "ignore", "ignore"] });
  const password = randomBytes(32).toString("hex");
  keyring.stdin.end(`${password}\n`);
  let secretEverSent = false;
  try {
    let displayReady = false;
    for (let i = 0; i < 100; i++) {
      if (spawnSync("xdpyinfo", ["-display", env.DISPLAY], { env, stdio: "ignore" }).status === 0) { displayReady = true; break; }
      await delay(50);
    }
    if (!displayReady || keyring.exitCode !== null) throw new Error("Isolated display or keyring unavailable.");
    const secretService = (object, iface, property) => spawnSync("gdbus", ["call", "--session", "--dest", "org.freedesktop.secrets",
      "--object-path", object, "--method", "org.freedesktop.DBus.Properties.Get", iface, property], { env, encoding: "utf8", timeout: 5000 });
    let serviceReady = false;
    for (let i = 0; i < 50; i++) {
      if (secretService("/org/freedesktop/secrets", "org.freedesktop.Secret.Service", "Collections").status === 0) { serviceReady = true; break; }
      await delay(100);
    }
    if (!serviceReady) throw new Error("Isolated Secret Service unavailable.");
    const args = [path.join(short, "workspace"), "--no-sandbox", "--new-window", `--user-data-dir=${path.join(short, "u")}`,
      `--extensions-dir=${path.join(short, "x")}`, "--disable-gpu", "--disable-dev-shm-usage",
      "--disable-telemetry", "--disable-updates", "--skip-welcome", "--skip-release-notes", "--password-store=gnome-libsecret"];
    function clearCache() {
      const dir = path.join(fixture, "u/CachedProfilesData/__default__profile__");
      if (fs.existsSync(dir)) for (const name of fs.readdirSync(dir)) if (/^extensions\.user(?:\.[a-z0-9-]+)?\.cache$/.test(name)) fs.rmSync(path.join(dir, name));
    }
    function launch(withDriver, signing = false) {
      const child = spawn(code, [...args, ...(withDriver ? [`--extensionDevelopmentPath=${driver}`] : [])],
        { env: { ...env, PKM_PRIVATE_SUBSCRIPTION_SIGNING: signing ? "1" : "0" }, stdio: ["ignore", "pipe", "pipe"] });
      let diagnostics = "";
      for (const stream of [child.stdout, child.stderr]) stream.on("data", data => {
        if (diagnostics.length < 16_384) diagnostics += data.toString().slice(0, 16_384 - diagnostics.length);
      });
      return new Promise((resolveExit, reject) => {
        const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
        child.once("error", error => { clearTimeout(timer); reject(error); });
        child.once("exit", (status, signal) => {
          clearTimeout(timer);
          if (status === 0) resolveExit(); else {
            const safe = secretEverSent ? "diagnostics suppressed after credential transfer" : diagnostics.split(password).join("[redacted]");
            reject(new Error(`Isolated VS Code exited ${status ?? signal}; ${safe.slice(0, 5000)}`));
          }
        });
      });
    }
    async function socketServer(name, handler) {
      const socketPath = path.join(short, name), connections = new Set();
      const server = net.createServer(socket => {
        connections.add(socket); socket.once("close", () => connections.delete(socket)); handler(socket);
      });
      await new Promise((yes, no) => { server.once("error", no); server.listen(socketPath, yes); });
      fs.chmodSync(socketPath, 0o600);
      return { server, close: async () => {
        for (const socket of connections) socket.destroy();
        await new Promise(yes => server.close(yes)); fs.rmSync(socketPath, { force: true });
      } };
    }
    async function seed(value, subscriberOnly = false) {
      const data = JSON.parse(manifest.toString()); data.main = "./seed-shim.cjs"; data.activationEvents = ["*"];
      fs.copyFileSync(path.join(project, "next-server/tests/legacy-protected-host-seed.cjs"), seedShim);
      fs.writeFileSync(path.join(ext, "package.json"), JSON.stringify(data)); clearCache();
      let completed;
      const done = new Promise((yes, no) => { completed = { yes, no }; });
      const broker = await socketServer("seed.sock", socket => {
        let line = "";
        socket.on("data", chunk => {
          line += chunk.toString();
          if (line === "ready\n") { line = ""; secretEverSent = true; socket.write(JSON.stringify({ secret: value.toString(), subscriberOnly,
            ...(multi ? { secondSecret: original.secondSecret.toString() } : {}) }) + "\n"); }
          else if (line === "ok\n") { socket.end(); completed.yes(); }
          else if (line.length > 32) { socket.destroy(); completed.no(new Error("Seed protocol denied.")); }
        });
        socket.on("error", () => completed.no(new Error("Seed socket failed.")));
      });
      try { await Promise.all([done, launch(false)]); }
      finally {
        await broker.close(); fs.writeFileSync(path.join(ext, "package.json"), manifest); fs.rmSync(seedShim, { force: true }); clearCache();
      }
    }
    async function importer(secret, action, statePlan) {
      const child = fork(physicalIdentity ? entry : path.join(project, "next-server/tests/legacy-protected-state-host-bootstrap.mjs"), [], {
        cwd: project, execArgv: physicalIdentity ? [] : ["--experimental-test-module-mocks"],
        env: { PATH: env.PATH, HOME: env.HOME, TMPDIR: env.TMPDIR, PKM_PRIVATE_SUBSCRIPTION_STATE_IMPORT: fixture },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      return await new Promise((yes, no) => {
        let result;
        const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
        child.on("message", message => {
          if (message.type === "ready") child.send({ fixture, nonce, shareId: original.shareId, secret: secret.toString(), action, statePlan });
          else result = message;
        });
        child.once("error", error => { clearTimeout(timer); no(error); });
        child.once("exit", status => { clearTimeout(timer); status === 0 && result ? yes(result) : no(new Error("Private importer stopped.")); });
        if (physicalIdentity) child.send({ fixture, nonce, shareId: original.shareId, secret: secret.toString(), action, statePlan,
          ...(multi ? { shareIds: [original.shareId, original.secondShareId],
            secrets: { [original.shareId]: secret.toString(), [original.secondShareId]: original.secondSecret.toString() } } : {}) });
        else child.send({ statePath: original.statePath, state: original.state.toString(), entry });
      });
    }
    async function capture(callback, signing = false) {
      fs.rmSync(path.join(fixture, "driver-result.json"), { force: true });
      let completed;
      const done = new Promise((yes, no) => { completed = { yes, no }; });
      const broker = await socketServer("credential.sock", socket => {
        let input = "";
        socket.on("data", data => {
          input += data.toString();
          if (input.length > 8192) { socket.destroy(); completed.no(new Error("Credential protocol denied.")); return; }
          if (!input.endsWith("\n")) return;
          socket.pause();
          void (async () => {
            let secret;
            try {
              const msg = JSON.parse(input); input = "";
              assert.equal(msg.nonce, nonce); assert.equal(msg.shareId, original.shareId);
              secret = Buffer.from(msg.secret);
              await callback(secret, msg);
              socket.end("ok\n"); completed.yes();
            } catch { socket.destroy(); completed.no(new Error("Credential callback failed.")); }
            finally { secret?.fill(0); }
          })();
        });
        socket.on("error", () => completed.no(new Error("Credential socket failed.")));
      });
      try {
        await Promise.all([done, launch(true, signing)]);
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fixture, "driver-result.json"), "utf8")), { ok: true });
      } finally { await broker.close(); }
    }
    async function signingDenied() {
      fs.rmSync(path.join(fixture, "driver-result.json"), { force: true });
      let connected = false;
      const broker = await socketServer("credential.sock", socket => { connected = true; socket.destroy(); });
      try {
        await launch(true, true);
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fixture, "driver-result.json"), "utf8")), { ok: false });
        assert.equal(connected, false);
      } finally { await broker.close(); }
    }
    await seed(original.secret);
    const collections = secretService("/org/freedesktop/secrets", "org.freedesktop.Secret.Service", "Collections");
    const collectionPaths = [...new Set(collections.stdout.match(/\/org\/freedesktop\/secrets\/collection\/[A-Za-z0-9_]+/g) || [])];
    if (collections.status !== 0 || !collectionPaths.length) throw new Error("Secret Service collection unavailable.");
    if (!collectionPaths.some(collection => {
      const items = secretService(collection, "org.freedesktop.Secret.Collection", "Items");
      return items.status === 0 && items.stdout.includes(`${collection}/`);
    }))
      throw new Error("VS Code did not create an isolated Secret Service item.");
    const sourceBefore = inventory(path.join(fixture, "original")), profileBefore = inventory(path.join(fixture, "profile"));
    await capture(async secret => {
      assert(secret.equals(original.secret));
      const blocked = await importer(secret, "import");
      assert.equal(blocked.type, "error"); assert.equal(blocked.code, "LEGACY_WRITERS_ACTIVE");
    });
    assert.deepEqual(inventory(path.join(fixture, "original")), sourceBefore);
    assert.deepEqual(inventory(path.join(fixture, "profile")), profileBefore);
    let stored;
    await capture(async secret => { assert(secret.equals(original.secret)); stored = Buffer.from(secret); });
    const imported = await importer(stored, "import");
    if (imported.type !== "result") throw new Error(`Private import denied: ${/^[A-Z_]+$/.test(imported.code || "") ? imported.code : "UNKNOWN"} (${Number.isInteger(imported.reason) ? imported.reason : -1}).`);
    stored.fill(0);
    if (uiMode) {
      assert.equal(imported.statePlan.protectedSubscriptions.emptyDownloads, true);
      assert(imported.statePlan.entries.some(row => row.destination.startsWith("subscriptions/cache/")));
    }
    const stagedState = JSON.parse(fs.readFileSync(path.join(fixture, "imported/subscriptions/subscriptions.json")));
    assert.equal(stagedState.nodeId, JSON.parse(original.state.toString()).nodeId);
    assert.equal(imported.statePlan.protectedSubscriptions.snapshots.filter(row => row.status === "authenticated-current").length, multi && !remote ? 2 : 1);
    assert.equal(imported.statePlan.protectedSubscriptions.snapshots.filter(row => row.status === "unverified").length, multi && !remote ? 2 : 1);
    for (const snapshot of imported.statePlan.protectedSubscriptions.snapshots) {
      assert.deepEqual(fs.readFileSync(path.join(fixture, "imported/subscriptions/snapshots", snapshot.name)),
        fs.readFileSync(path.join(fixture, "profile/snapshots", snapshot.name)));
    }
    const destinationBefore = inventory(path.join(fixture, "imported"));
    wrong = Buffer.from(randomBytes(32).toString("base64url")); await seed(wrong);
    await capture(async secret => { assert(secret.equals(wrong)); stored = Buffer.from(secret); });
    const denied = await importer(stored, "read", imported.statePlan);
    assert.equal(denied.type, "error"); assert.equal(denied.code, "SNAPSHOT_DENIED"); stored.fill(0);
    assert.deepEqual(inventory(path.join(fixture, "original")), sourceBefore);
    assert.deepEqual(inventory(path.join(fixture, "profile")), profileBefore);
    assert.deepEqual(inventory(path.join(fixture, "imported")), destinationBefore);
    if (physicalIdentity && !uiMode) await signingDenied();
    await seed(original.secret);
    await capture(async secret => { assert(secret.equals(original.secret)); stored = Buffer.from(secret); });
    const reopened = await importer(stored, "read", imported.statePlan); stored.fill(0);
    if (reopened.type !== "result") throw new Error(`Private reopen denied: ${/^[A-Z_]+$/.test(reopened.code || "") ? reopened.code : "UNKNOWN"}.`);
    assert.equal(reopened.itemCount, 1);
    assert.deepEqual(inventory(path.join(fixture, "original")), sourceBefore);
    assert.deepEqual(inventory(path.join(fixture, "profile")), profileBefore);
    if (physicalIdentity) {
      if (!uiMode) {
      const projectedPath = path.join(fixture, "imported/subscriptions/subscriptions.json");
      const projectedBytes = fs.readFileSync(projectedPath);
      try {
        fs.writeFileSync(projectedPath, Buffer.concat([projectedBytes, Buffer.from(" ")]), { mode: 0o600 });
        await signingDenied();
      } finally { fs.writeFileSync(projectedPath, projectedBytes, { mode: 0o600 }); }
      const offset = original.state.indexOf("Synthetic share v2");
      assert(offset >= 0);
      const updateStateByte = value => {
        const fd = fs.openSync(original.statePath, "r+");
        try { fs.writeSync(fd, value, 0, 1, offset); fs.fsyncSync(fd); }
        finally { fs.closeSync(fd); }
      };
      try {
        updateStateByte(Buffer.from("T"));
        const damaged = inventory(path.join(fixture, "profile"));
        await signingDenied();
        assert.deepEqual(inventory(path.join(fixture, "profile")), damaged);
      } finally { updateStateByte(original.state.subarray(offset, offset + 1)); }
      if (!fs.readFileSync(original.statePath).equals(original.state)) throw new Error("Original identity state changed.");
      }
      const gatewayState = multi ? path.join(fixture, "isolated-gateway-state.json") : path.join(fixture, "profile/gateway-state.json");
      if (multi) fs.copyFileSync(path.join(fixture, "profile/gateway-state.json"), gatewayState);
      const gateway = spawn(process.execPath, [path.join(ext, "dist/subscription-gateway.js"),
        gatewayState, "synthetic"], { env, stdio: "ignore" });
      const remoteGatewayState = remote ? path.join(fixture, "isolated-remote-gateway-state.json") : undefined;
      if (remote) fs.copyFileSync(path.join(fixture, "remote-profile/gateway-state.json"), remoteGatewayState);
      const remoteGateway = remote ? spawn(process.execPath, [path.join(ext, "dist/subscription-gateway.js"),
        remoteGatewayState, "synthetic"], { env, stdio: "ignore" }) : undefined;
      try {
        let ready = false;
        for (let i = 0; i < 100; i++) {
          if (gateway.exitCode !== null) break;
          try { if ((await fetch("http://127.0.0.1:23001/.well-known/pkm-node")).ok
            && (!remote || (await fetch("http://127.0.0.1:23002/.well-known/pkm-node")).ok)) { ready = true; break; } } catch {}
          await delay(100);
        }
        assert(ready, "Legacy gateway did not become ready.");
        const sync = async (secret, msg) => {
          const parsed = original.parseShareMagicLink(msg.magicLink);
          assert.equal(parsed.nodeId, JSON.parse(original.state.toString()).nodeId);
          assert.equal(parsed.shareId, original.shareId);
          assert.equal(msg.nodeId, parsed.nodeId);
          const separator = msg.magicLink.lastIndexOf(".") + 1;
          const changedLink = `${msg.magicLink.slice(0, separator)}${msg.magicLink[separator] === "A" ? "B" : "A"}${msg.magicLink.slice(separator + 1)}`;
          assert.throws(() => original.parseShareMagicLink(changedLink));
          const base = scryptSync(secret, Buffer.from(original.share.secretSalt, "base64url"), 32);
          const verifier = createHmac("sha256", base).update("pkm-share-auth:v1").digest();
          const contentKey = createHmac("sha256", base).update("pkm-share-content:v1").digest();
          try {
            const headers = { "X-PKM-Subscriber-Proof": msg.proof,
              "X-PKM-Share-Secret-Proof": createHmac("sha256", verifier).update(msg.proof).digest("base64url") };
            const url = `http://127.0.0.1:23001/v1/shares/${original.shareId}`;
            const bad = JSON.parse(Buffer.from(msg.proof, "base64url").toString("utf8"));
            bad.signature = `${bad.signature[0] === "A" ? "B" : "A"}${bad.signature.slice(1)}`;
            const badProof = Buffer.from(JSON.stringify(bad)).toString("base64url");
            const badResponse = await fetch(`${url}/summary`, { headers: {
              "X-PKM-Subscriber-Proof": badProof,
              "X-PKM-Share-Secret-Proof": createHmac("sha256", verifier).update(badProof).digest("base64url"),
            } });
            assert.equal(badResponse.status, 401);
            const response = await fetch(`${url}/summary`, { headers });
            assert.equal(response.status, 200);
            const summary = await response.json();
            original.verifyShareSummary(summary, parsed.publicKey, parsed.nodeId, original.shareId);
            const ticketResponse = await fetch(`${url}/sync-ticket`, { method: "POST", headers });
            assert.equal(ticketResponse.status, 200);
            const ticket = await ticketResponse.json();
            assert.equal(ticket.collectionHash, summary.collectionHash);
            assert.equal(ticket.revision, summary.revision);
            const transfer = await fetch(`${ticket.brokerUrl}/sync/bundle`, { headers: { Authorization: `Bearer ${ticket.ticket}` } });
            assert.equal(transfer.status, 200);
            const wire = Buffer.from(await transfer.arrayBuffer());
            assert.equal(wire.subarray(0, 8).toString(), "PKMENC1\n");
            const port = Number(new URL(ticket.brokerUrl).port);
            const transferKey = createHmac("sha256", verifier)
              .update(`pkm-transfer:v1:${msg.nodeId}:${original.shareId}:${summary.revision}:${port}:${ticket.ticket}`).digest();
            try {
              const outer = createDecipheriv("aes-256-gcm", transferKey, wire.subarray(8, 20));
              outer.setAuthTag(wire.subarray(-16));
              const encrypted = Buffer.concat([outer.update(wire.subarray(20, -16)), outer.final()]);
              try {
                assert.equal(`sha256:${createHash("sha256").update(encrypted).digest("hex")}`, summary.collectionHash);
                assert.deepEqual(encrypted, fs.readFileSync(path.join(fixture, "imported/subscriptions/snapshots",
                  `${original.shareId}-${summary.revision}.json`)));
                const envelope = JSON.parse(encrypted.toString());
                const inner = createDecipheriv("aes-256-gcm", contentKey, Buffer.from(envelope.iv, "base64url"));
                inner.setAuthTag(Buffer.from(envelope.tag, "base64url"));
                const plaintext = Buffer.concat([inner.update(Buffer.from(envelope.ciphertext, "base64url")), inner.final()]);
                try { assert.equal(JSON.parse(plaintext.toString()).notes[0].slug, "Fixture"); }
                finally { plaintext.fill(0); }
              } finally { encrypted.fill(0); }
            } finally { transferKey.fill(0); }
          } finally { base.fill(0); verifier.fill(0); contentKey.fill(0); }
        };
        if (!uiMode) { await capture(sync, true); await capture(sync, true); }
        if (uiMode) {
          fs.copyFileSync(path.join(project, "next-server/tests/legacy-protected-host-ui-driver.cjs"), path.join(driver, "extension.cjs"));
          const nextReads = await import(require("node:url").pathToFileURL(path.join(payload.root, "server/dist/subscription-reads.js")).href);
          const nextRetrieval = await import(require("node:url").pathToFileURL(path.join(payload.root, "server/dist/legacy-retrieval-subscriptions.js")).href);
          let secondRevision = 1, secondStatus = "current";
          async function verifyNext(revision, text, nextRoot = path.join(fixture, "imported"), priority) {
            const page = await nextReads.readSubscriptions(nextRoot, { operation: "subscription.list", actorId: "native:fixture",
              args: { offset: 0, limit: 100 } });
            const first = page.items.find(item => item.id === original.subscriptionId);
            if (page.items.length !== (multi ? 2 : 1) || !first || first.revision !== revision
              || priority && first.priority !== priority) throw new Error("Next Subscription revision differs.");
            const result = await nextRetrieval.legacyRetrievalSubscriptions(nextRoot);
            const group = result.groups.find(item => item.subscriptionId === original.subscriptionId);
            if (!group || group.revision !== revision || group.items.length !== 1
              || !result.read(group.items[0].key).content.includes(text)
              || result.read(group.items[0].key).content.includes("Synthetic restricted")) throw new Error("Next Subscription cache differs.");
            if (multi) {
              const record = page.items.find(item => item.id === original.secondSubscriptionId);
              const restricted = result.groups.find(item => item.subscriptionId === original.secondSubscriptionId);
              const expected = secondRevision === 1 ? "Synthetic restricted original" : "Synthetic restricted revision 3";
              if (!record || record.revision !== secondRevision || record.status !== secondStatus || !restricted || restricted.revision !== secondRevision
                || restricted.items.length !== 1 || !result.read(restricted.items[0].key).content.includes(expected)
                || result.read(restricted.items[0].key).content.includes("Synthetic refreshed note"))
                throw new Error("Next restricted Subscription cache differs.");
            }
          }
          async function verifyNextHttp(present = true) {
            const token = randomBytes(32).toString("base64url");
            const server = spawn(process.execPath, [path.join(payload.root, "server/dist/cli.js"),
              "http", "--data", path.join(fixture, "imported"), "--port", "0"],
            { env: { ...env, PKM_NEXT_TOKEN: token }, stdio: ["ignore", "pipe", "ignore"] });
            let exited = false, lines = "";
            const exit = new Promise(resolve => server.once("exit", () => { exited = true; resolve(); }));
            try {
              const url = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error("Next HTTP fixture readiness timed out.")), 30000);
                server.stdout.on("data", data => {
                  lines += data.toString();
                  for (;;) {
                    const end = lines.indexOf("\n");
                    if (end < 0) break;
                    const line = lines.slice(0, end); lines = lines.slice(end + 1);
                    try {
                      const message = JSON.parse(line);
                      if (message.ready && typeof message.url === "string") {
                        clearTimeout(timer); resolve(message.url);
                      }
                    } catch {}
                  }
                });
                server.once("exit", () => { clearTimeout(timer); reject(new Error("Next HTTP fixture exited before readiness.")); });
              });
              if (!url.startsWith("http://127.0.0.1:")) throw new Error("Next fixture transport is not loopback.");
              const response = await fetch(`${url}/v1/capability_read`, { method: "POST",
                headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
                body: JSON.stringify({ operation: "subscription.list", version: 1, arguments: { offset: 0, limit: 100 } }) });
              const result = await response.json();
              const found = result.result?.items?.filter(item =>
                item.nodeId === original.secondNodeId && item.shareId === original.secondShareId) || [];
              if (!response.ok || result.error || (present
                ? found.length !== 1 || found[0].id !== original.secondSubscriptionId || found[0].revision !== 3
                : found.length !== 0))
                throw new Error("Next HTTP client did not read the remote subscription.");
            } finally {
              if (!exited) { server.kill("SIGTERM"); await Promise.race([exit, delay(10000)]); }
              if (!exited) { server.kill("SIGKILL"); await exit; }
            }
          }
          await verifyNext(1, "Synthetic original note");
          async function runUi(stage) {
            fs.rmSync(path.join(fixture, "ui-driver-result.json"), { force: true });
            fs.rmSync(path.join(fixture, "ui-driver-open"), { force: true });
            const uiEnv = { ...env, PKM_PRIVATE_SUBSCRIPTION_SIGNING: "1", PKM_PRIVATE_SUBSCRIPTION_UI: "1",
              PKM_PRIVATE_SUBSCRIPTION_REFRESH_FAULT: ["crash", "remote-crash"].includes(stage) ? "1" : stage === "conflict" ? "2"
                : stage === "same-revision" ? "3" : ["post-commit", "remote-post-commit"].includes(stage) ? "4" : stage === "foreign-conflict" ? "5"
                : ["member-add-crash", "member-remove-crash"].includes(stage) ? "6" : stage === "member-remove-post-commit" ? "7" : "0" };
            for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]) delete uiEnv[key];
            const child = spawn(code, [...args, `--extensionDevelopmentPath=${driver}`, "--remote-debugging-address=127.0.0.1",
              "--remote-debugging-port=9334"], { env: uiEnv, stdio: "ignore" });
            let exited;
            const exit = new Promise(resolve => child.once("exit", (status, signal) => { exited = { status, signal }; resolve(); }));
            try {
              let ready = false;
              for (let i = 0; i < 300; i++) {
                if (exited) break;
                try { if ((await fetch("http://127.0.0.1:9334/json/list")).ok) { ready = true; break; } } catch {}
                await delay(100);
              }
              if (!ready) throw new Error("Private Subscription UI did not become ready.");
              let input;
              if (stage.startsWith("member-add")) {
                const source = JSON.parse(original.state.toString()).subscriptions.find(item => item.id === original.secondSubscriptionId
                  || item.nodeId === original.secondNodeId && item.shareId === original.secondShareId);
                if (!source || !original.secondSecret) throw new Error("Synthetic remote invitation is unavailable.");
                input = JSON.stringify({ magicLink: source.magicLink,
                  secret: `pkms:v1:23002:${source.secretSalt}:${original.secondSecret.toString()}` }) + "\n";
              }
              const test = spawnSync("python3", ["-B", path.join(project, "next-server/tests/legacy-protected-subscription-ui.py"), stage],
                { env, input, encoding: "utf8", timeout: 120_000 });
              if (test.status !== 0) {
                const step = test.stderr.match(/UI_STEP_FAILED ([a-z-]+)/)?.[1] || "unknown";
                const detail = test.stderr.match(/UI_DETAIL tabs=\d+ pages=\d+ frames=\d+ iframes=\d+ complete=\d+ schemes=[a-z,-]*/)?.[0] || "";
                const errorClass = test.stderr.match(/UI_ERROR_CLASS ([A-Za-z]+)/)?.[1] || "unknown";
                let opened = "missing";
                try {
                  const driverResult = JSON.parse(fs.readFileSync(path.join(fixture, "ui-driver-result.json"), "utf8"));
                  opened = driverResult.opened ? "yes" : driverResult.reason || "no";
                } catch {}
                throw new Error(`Private Subscription renderer ${stage} failed at ${step} (${errorClass}, opened=${opened}). ${detail}`);
              }
              if (!JSON.parse(fs.readFileSync(path.join(fixture, "ui-driver-result.json"), "utf8")).opened)
                throw new Error("Private Subscription UI activation denied.");
              await Promise.race([exit, delay(20_000)]);
              if (!exited || exited.status !== 0) throw new Error("Private Subscription UI did not close cleanly.");
            } finally {
              if (!exited) {
                child.kill("SIGTERM"); await Promise.race([exit, delay(10_000)]);
                if (!exited) { child.kill("SIGKILL"); await exit; }
              }
            }
          }
          await runUi("crash");
          await verifyNext(1, "Synthetic original note");
          await runUi("resume");
          await verifyNext(2, "Synthetic refreshed note revision 2");
          const nextRefresh = await import(require("node:url").pathToFileURL(path.join(payload.root, "server/dist/legacy-subscription-refresh.js")).href);
          const beforeLostAck = nextRefresh.readProtectedRefreshAtRoot(path.join(fixture, "imported")).head;
          await runUi("post-commit");
          await verifyNext(2, "Synthetic refreshed note revision 2", path.join(fixture, "imported"), "normal");
          if (nextRefresh.readProtectedRefreshAtRoot(path.join(fixture, "imported")).head === beforeLostAck)
            throw new Error("Committed Subscription fault did not publish its receipt.");
          await runUi("after-commit");
          await verifyNext(2, "Synthetic refreshed note revision 2", path.join(fixture, "imported"), "highest");
          const committedHead = nextRefresh.readProtectedRefreshAtRoot(path.join(fixture, "imported")).head;
          await delay(1000);
          await runUi("restart");
          await verifyNext(2, "Synthetic refreshed note revision 2");
          if (nextRefresh.readProtectedRefreshAtRoot(path.join(fixture, "imported")).head !== committedHead)
            throw new Error("Subscription replay changed its receipt.");
          await runUi("conflict");
          if (nextRefresh.readProtectedRefreshAtRoot(path.join(fixture, "imported")).head !== committedHead)
            throw new Error("Conflicting Subscription replay changed its receipt.");
          if (multi) {
            await runUi("foreign-conflict");
            if (nextRefresh.readProtectedRefreshAtRoot(path.join(fixture, "imported")).head !== committedHead)
              throw new Error("Foreign Subscription write was published unexpectedly.");
          }
          const cached = path.join(fixture, "profile/cache", original.nodeId, original.shareId, "content/notes/Fixture.md");
          const originalCache = fs.readFileSync(cached);
          try {
            fs.writeFileSync(cached, Buffer.concat([originalCache, Buffer.from("\nSynthetic conflicting revision.\n")]));
            await runUi("same-revision");
            if (nextRefresh.readProtectedRefreshAtRoot(path.join(fixture, "imported")).head !== committedHead)
              throw new Error("Same-revision conflict changed its receipt.");
          } finally { fs.writeFileSync(cached, originalCache); }
          const beforeDenied = JSON.parse(fs.readFileSync(original.statePath, "utf8")).subscriptions[0];
          await seed(wrong, true);
          await runUi("invalid-secret");
          const afterDenied = JSON.parse(fs.readFileSync(original.statePath, "utf8")).subscriptions[0];
          if (JSON.stringify(afterDenied) !== JSON.stringify(beforeDenied))
            throw new Error("Denied subscriber credential changed durable subscription state.");
          await seed(original.secret, true);
          const current = JSON.parse(fs.readFileSync(original.statePath, "utf8"));
          if (current.nodeId !== original.nodeId || current.publicKey !== JSON.parse(original.state.toString()).publicKey
            || current.subscriptions.length !== (multi ? 2 : 1) || current.subscriptions[0].id !== original.subscriptionId
            || current.subscriptions[0].revision !== 2 || current.subscriptions[0].priority !== "highest")
            throw new Error("Legacy subscriber identity or durable state changed unexpectedly.");
          if (!fs.readFileSync(cached, "utf8").includes("Synthetic refreshed note revision 2")) throw new Error("Legacy subscriber cache is unavailable.");
          if (multi) {
            if (remote) {
              const headBeforeRemote = nextRefresh.readProtectedRefreshAtRoot(path.join(fixture, "imported")).head;
              await runUi("remote-crash");
              await verifyNext(2, "Synthetic refreshed note revision 2");
              assert.equal(nextRefresh.readProtectedRefreshAtRoot(path.join(fixture, "imported")).head, headBeforeRemote);
            }
            await runUi(remote ? "remote-resume" : "multi");
            secondRevision = 3;
            await verifyNext(2, "Synthetic refreshed note revision 2", path.join(fixture, "imported"), "highest");
            if (remote) {
              await runUi("remote-post-commit");
              const committed = nextRefresh.readProtectedRefreshAtRoot(path.join(fixture, "imported")).head;
              await runUi("remote-post-restart");
              assert.equal(nextRefresh.readProtectedRefreshAtRoot(path.join(fixture, "imported")).head, committed);
              await verifyNext(2, "Synthetic refreshed note revision 2");
            }
            const restrictedGateway = remoteGateway || gateway;
            restrictedGateway.kill("SIGSTOP");
            try { await runUi("multi-offline"); } finally { restrictedGateway.kill("SIGCONT"); }
            secondStatus = "offline";
            const disconnected = JSON.parse(fs.readFileSync(original.statePath)).subscriptions.find(item => item.id === original.secondSubscriptionId);
            assert(["fetch failed", "The operation was aborted due to timeout"].includes(disconnected.error));
            await verifyNext(2, "Synthetic refreshed note revision 2", path.join(fixture, "imported"), "highest");
            await runUi("multi-recover");
            secondStatus = "current";
            await verifyNext(2, "Synthetic refreshed note revision 2");
            const restrictedGatewayState = remoteGatewayState || gatewayState;
            const allowedGateway = fs.readFileSync(restrictedGatewayState);
            const revoked = JSON.parse(allowedGateway);
            const restrictedShare = revoked.shares.find(item => item.summary.shareId === original.secondShareId);
            assert(restrictedShare && restrictedShare.accountMode === "white-list");
            restrictedShare.accountRules = [];
            try {
              fs.writeFileSync(restrictedGatewayState, JSON.stringify(revoked), { mode: 0o600 });
              await delay(1200);
              await runUi("multi-offline");
              secondStatus = "offline";
              const denied = JSON.parse(fs.readFileSync(original.statePath)).subscriptions.find(item => item.id === original.secondSubscriptionId);
              assert.equal(denied.error, "Broker returned 403.");
              await verifyNext(2, "Synthetic refreshed note revision 2");
            } finally { fs.writeFileSync(restrictedGatewayState, allowedGateway, { mode: 0o600 }); }
            await delay(1200);
            await runUi("multi-recover");
            secondStatus = "current";
            await verifyNext(2, "Synthetic refreshed note revision 2");
            if (remote) await verifyNextHttp();
            if (membershipMode) {
              const getPending = () => {
                const sqlite = require("node:sqlite"), db = new sqlite.DatabaseSync(path.join(fixture, "imported/core.sqlite"), { readOnly: true });
                try {
                  const id = JSON.parse(fs.readFileSync(path.join(fixture, "imported/.pkm-next-workspace"))).id;
                  return membershipJournal.readMembershipIntent(db, id);
                } finally { db.close(); }
              };
              const membershipJournal = await import(require("node:url").pathToFileURL(
                path.join(payload.root, "server/dist/legacy-subscription-membership-intent.js")).href);
              const profileSnapshot = () => {
                const root = path.dirname(original.statePath), entries = [];
                const walk = (dir, relative = "") => {
                  for (const name of fs.readdirSync(dir).sort()) {
                    const file = path.join(dir, name), rel = path.join(relative, name), stat = fs.lstatSync(file, { bigint: true });
                    if (stat.isDirectory()) { entries.push([rel, "dir"]); walk(file, rel); }
                    else if (stat.isFile()) entries.push([rel, stat.mode.toString(), stat.mtimeNs.toString(),
                      createHash("sha256").update(fs.readFileSync(file)).digest("hex")]);
                    else throw new Error("Unexpected profile entry.");
                  }
                };
                walk(root);
                return JSON.stringify(entries);
              };
              const verifyReadOnlyOpen = async () => {
                const before = profileSnapshot();
                await runUi("member-open-only");
                if (profileSnapshot() !== before) throw new Error("Opening Subscription UI modified the source profile.");
              };
              await verifyReadOnlyOpen();
              await runUi("member-remove");
              await verifyNextHttp(false);
              await runUi("member-restart-removed");
              const beforeAdd = nextRefresh.readProtectedRefreshAtRoot(path.join(fixture, "imported")).head;
              await runUi("member-add-crash");
              if (!getPending() || nextRefresh.readProtectedRefreshAtRoot(path.join(fixture, "imported")).head !== beforeAdd)
                throw new Error("Interrupted membership was silently published.");
              await verifyReadOnlyOpen();
              const profileBeforeConflict = fs.readFileSync(original.statePath);
              try {
                const foreign = JSON.parse(profileBeforeConflict.toString());
                foreign.subscriptions.find(item => item.id === original.subscriptionId).priority = "normal";
                const changed = Buffer.from(JSON.stringify(foreign, null, 2));
                fs.writeFileSync(original.statePath, changed, { mode: 0o600 });
                await runUi("member-add-denied");
                if (!fs.readFileSync(original.statePath).equals(changed) || !getPending()
                  || nextRefresh.readProtectedRefreshAtRoot(path.join(fixture, "imported")).head !== beforeAdd)
                  throw new Error("Unknown external state was replayed or admitted.");
              } finally { fs.writeFileSync(original.statePath, profileBeforeConflict, { mode: 0o600 }); }
              await runUi("member-add-recover");
              if (getPending()) throw new Error("Recovered membership remains pending.");
              original.secondSubscriptionId = JSON.parse(fs.readFileSync(original.statePath)).subscriptions
                .find(item => item.nodeId === original.secondNodeId && item.shareId === original.secondShareId).id;
              await verifyNextHttp();
              await verifyNext(2, "Synthetic refreshed note revision 2");
              const beforeRemove = nextRefresh.readProtectedRefreshAtRoot(path.join(fixture, "imported")).head;
              await runUi("member-remove-crash");
              if (!getPending() || nextRefresh.readProtectedRefreshAtRoot(path.join(fixture, "imported")).head !== beforeRemove)
                throw new Error("Interrupted removal was silently published.");
              await runUi("member-recover-remove");
              if (getPending()) throw new Error("Recovered removal remains pending.");
              await verifyNextHttp(false);
              await runUi("member-add");
              original.secondSubscriptionId = JSON.parse(fs.readFileSync(original.statePath)).subscriptions
                .find(item => item.nodeId === original.secondNodeId && item.shareId === original.secondShareId).id;
              await verifyNextHttp();
              await runUi("member-remove-post-commit");
              if (getPending()) throw new Error("Committed removal has an unexpected pending intent.");
              const removalHead = nextRefresh.readProtectedRefreshAtRoot(path.join(fixture, "imported")).head;
              await runUi("member-restart-removed");
              if (nextRefresh.readProtectedRefreshAtRoot(path.join(fixture, "imported")).head !== removalHead)
                throw new Error("Committed removal was replayed on restart.");
              await verifyNextHttp(false);
              await runUi("member-add");
              original.secondSubscriptionId = JSON.parse(fs.readFileSync(original.statePath)).subscriptions
                .find(item => item.nodeId === original.secondNodeId && item.shareId === original.secondShareId).id;
              await verifyNextHttp();
              await verifyNext(2, "Synthetic refreshed note revision 2");
              console.log("PASS: explicit remote membership add/remove, transaction faults, restart and Next HTTP.");
            }
          }
          assert.equal(JSON.parse(fs.readFileSync(path.join(fixture, "imported/subscriptions/subscriptions.json"), "utf8"))
            .subscriptions[0].revision, 1);
          const mirror = path.join(fixture, "tampered-import");
          fs.cpSync(path.join(fixture, "imported"), mirror, { recursive: true,
            filter: file => !["core.sqlite", "core.sqlite-wal", "core.sqlite-shm"].includes(path.basename(file)) });
          const sqlite = require("node:sqlite"), sourceDb = new sqlite.DatabaseSync(path.join(fixture, "imported/core.sqlite"), { readOnly: true });
          try { await sqlite.backup(sourceDb, path.join(mirror, "core.sqlite")); } finally { sourceDb.close(); }
          const genesisFile = path.join(mirror, "subscriptions/cache", original.nodeId, original.shareId, "content/notes/Fixture.md");
          const genesisBytes = fs.readFileSync(genesisFile);
          fs.writeFileSync(genesisFile, "Synthetic tampering.");
          await assert.rejects(() => nextReads.readSubscriptions(mirror, {
            operation: "subscription.list", actorId: "native:fixture", args: { offset: 0, limit: 100 },
          }), { code: "IMPORT_RECEIPT_INVALID" });
          fs.writeFileSync(genesisFile, genesisBytes);
          const alteredDb = new sqlite.DatabaseSync(path.join(mirror, "core.sqlite"));
          try {
            alteredDb.exec("DROP TRIGGER fixture_subscription_refresh_files_no_update");
            alteredDb.prepare("UPDATE fixture_subscription_refresh_files SET bytes=? WHERE rowid=(SELECT MIN(rowid) FROM fixture_subscription_refresh_files)")
              .run(Buffer.from("synthetic corruption"));
          } finally { alteredDb.close(); }
          await assert.rejects(() => nextReads.readSubscriptions(mirror, {
            operation: "subscription.list", actorId: "native:fixture", args: { offset: 0, limit: 100 },
          }), { code: "IMPORT_RECEIPT_INVALID" });
          const nextStorage = await import(require("node:url").pathToFileURL(path.join(payload.root, "server/dist/storage.js")).href);
          const nextBackup = await import(require("node:url").pathToFileURL(path.join(payload.root, "server/dist/workspace-backup.js")).href);
          const authority = await import(require("node:url").pathToFileURL(path.join(project, "next-server/tests/host-composition-legacy-batch16-restore-fixture.mjs")).href);
          const store = await nextStorage.Storage.open(path.join(fixture, "imported"));
          try {
            await nextBackup.createWorkspaceBackup(store, path.join(fixture, "backup"), {
              acquireQuiescence: async () => ({ assertHeld() {}, release() {} }),
            });
          } finally { await store.close(); }
          await nextBackup.restoreWorkspaceBackup(path.join(fixture, "backup"), path.join(fixture, "restored"), {
            nativeRestoreAuthority: authority.nativeRestoreAuthority,
          });
          const restored = await nextStorage.Storage.open(path.join(fixture, "restored"));
          try { await verifyNext(2, "Synthetic refreshed note revision 2", path.join(fixture, "restored")); }
          finally { await restored.close(); }
        }
        if (!uiMode && !fs.readFileSync(original.statePath).equals(original.state)) throw new Error("Original identity state changed.");
      } finally {
        if (gateway.exitCode === null && gateway.signalCode === null) {
          const stopped = new Promise(resolve => gateway.once("exit", resolve)); gateway.kill("SIGTERM"); await stopped;
        }
        if (remoteGateway && remoteGateway.exitCode === null && remoteGateway.signalCode === null) {
          const stopped = new Promise(resolve => remoteGateway.once("exit", resolve)); remoteGateway.kill("SIGTERM"); await stopped;
        }
      }
    }
    for (const folder of ["u", "profile", "original", "imported", "h",
      ...(remote ? ["remote-profile", "remote-original"] : []),
      ...(uiMode ? ["backup", "restored", "tampered-import"] : [])]) {
      function scan(file) {
        const stat = fs.lstatSync(file);
        if (stat.isDirectory()) for (const name of fs.readdirSync(file)) scan(path.join(file, name));
        else if (stat.isFile()) {
          const bytes = fs.readFileSync(file);
          const mountState = path.join(fixture, "u/User/globalStorage/uone.personal-knowledge/subscriptions/subscriptions.json");
          const allowedState = physicalIdentity && (file === original.statePath || uiMode && file === mountState
            && stat.dev === fs.lstatSync(original.statePath).dev && stat.ino === fs.lstatSync(original.statePath).ino);
          const remoteState = remote && file === path.join(fixture, "remote-profile/subscriptions.json");
          assert(!bytes.includes(original.secret) && (!original.secondSecret || !bytes.includes(original.secondSecret))
            && !bytes.includes(wrong) && (allowedState || !bytes.includes(signingKey))
            && (!remoteSigningKey || remoteState || !bytes.includes(remoteSigningKey)));
        }
      }
      scan(path.join(fixture, folder));
    }
    console.log(uiMode
      ? "PASS: original Subscription renderer and client; Next cache, conflicts, interrupted transactions, restart and backup restore."
      : physicalIdentity
      ? "PASS: physical legacy synthetic state, receipt-bound VS Code host signing, legacy gateway sync pull and restart."
      : "PASS: real isolated VS Code SecretStorage; live-host refusal; offline old-share import and cross-restart read; wrong secret unchanged.");
    console.log(physicalIdentity
      ? "Qualifier: private state remains only in the isolated legacy profile; this is a guarded copy import, not production cutover."
      : "Qualifier: legacy private-key state is virtual in-memory; no production host, physical original profile, or in-place cutover was tested.");
  } finally {
    wrong?.fill(0); signingKey.fill(0); remoteSigningKey?.fill(0); original.secret.fill(0); original.secondSecret?.fill(0); original.state.fill(0);
    for (const proc of [desktop, keyring]) if (proc.exitCode === null && proc.signalCode === null) {
      const stopped = new Promise(resolve => proc.once("exit", resolve)); proc.kill("SIGTERM"); await stopped;
    }
  }
}

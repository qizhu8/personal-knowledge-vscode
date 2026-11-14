import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { fork, spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url), esbuild = require("esbuild");
const dist = resolve(process.env.PKM_TEST_NEXT_DIST || "next-server/dist");
const candidateVsix = process.env.PKM_TEST_SUBSCRIPTION_VSIX;
const { prepareLegacyRootAdoptionExperimental, resumeLegacyRootAdoptionExperimental } =
  await import(pathToFileURL(join(dist, "legacy-root-adoption.js")));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test("private UI coordinator uses the real Next CLI and never replays unknown membership", async () => {
  const fixture = resolve(".migration-test-work", `pkm-native-subscription-ui-${randomUUID()}`);
  const shortTemp = resolve(`.ns-${randomUUID().slice(0, 8)}`);
  const shortTempEnv = `/proc/${process.pid}/cwd/${shortTemp.split("/").at(-1)}`;
  const root = join(fixture, "root"), profile = join(fixture, "profile"), publisherProfile = join(fixture, "publisher-profile");
  const publisherRoot = join(fixture, "publisher-root"), host = join(fixture, "runtime", "host");
  const server = join(fixture, "runtime", "server"), extensionProfile = join(fixture, "u", "User", "globalStorage", "uone.personal-knowledge");
  const grant = join(extensionProfile, "native-subscription-ui.json");
  for (const dir of [join(root, "notes"), join(publisherRoot, "notes"), profile, publisherProfile,
    join(host, "subscriptions"), extensionProfile]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(root, "notes", "Local.md"), "# Synthetic local\n", { mode: 0o600 });
  writeFileSync(join(publisherRoot, "notes", "Shared.md"), "# Synthetic remote\n", { mode: 0o600 });
  cpSync(dist, join(server, "dist"), { recursive: true });
  for (const name of ["compat", "browser"])
    cpSync(candidateVsix ? resolve(dist, "..", name) : resolve("next-server", name), join(server, name), { recursive: true });
  symlinkSync(candidateVsix ? resolve(dist, "..", "node_modules") : resolve("next-server/node_modules"),
    join(server, "node_modules"), "dir");
  const build = (contents, output) => esbuild.buildSync({ stdin: { contents, resolveDir: resolve("."), loader: "js" },
    bundle: true, platform: "node", format: "cjs", packages: "external", outfile: output });
  build(`module.exports = {
    ...require(${JSON.stringify(resolve("src/subscriptions/subscriptions.ts"))}),
    ...require(${JSON.stringify(resolve("src/subscriptions/native-remote-transport.ts"))}),
    setRoot(p) { require(${JSON.stringify(resolve("src/knowledge/filestore.ts"))}).setStorePath(p);
      require(${JSON.stringify(resolve("src/knowledge/storage.ts"))}).setStorePath(p); }
  };`, join(host, "subscriptions", "legacy.js"));
  build(`require(${JSON.stringify(resolve("src/subscriptions/native-membership-coordinator.ts"))})
    .runNativeSubscriptionCoordinator(JSON.parse(process.env.TEST_BINDING))
    .catch(error => { console.error(error.message); process.exitCode = 1; });`, join(host, "subscriptions", "controller.js"));
  for (const [source, output] of [["src/subscriptions/subscription-gateway-entry.ts", "subscription-gateway.js"],
    ["src/subscriptions/subscription-materialize-worker.ts", "subscription-materialize-worker.js"]])
    esbuild.buildSync({ entryPoints: [resolve(source)], bundle: true, platform: "node", format: "cjs",
      packages: "external", outfile: join(host, output) });
  const legacy = require(join(host, "subscriptions", "legacy.js"));
  const memory = () => { const map = new Map(); return { async get(key) { return map.get(key); },
    async store(key, value) { map.set(key, value); }, async delete(key) { map.delete(key); } }; };
  const originalGate = process.env.PKM_EXPERIMENTAL_SUBSCRIPTION_HOST;
  process.env.PKM_EXPERIMENTAL_SUBSCRIPTION_HOST = "1";
  const subscriber = new legacy.SharedMarketManager(profile, join(host, "subscription-gateway.js"), "Synthetic subscriber", {}, memory(),
    { user: "subscriber", host: "local" });
  const publisher = new legacy.SharedMarketManager(publisherProfile, join(host, "subscription-gateway.js"), "Synthetic publisher", {}, memory(),
    { user: "publisher", host: "local" });
  const actualUi = process.env.PKM_TEST_ACTUAL_SUBSCRIPTION_UI === "1";
  const vsix = candidateVsix;
  let gateway, controller, blocker, display, code;
  const stop = async child => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const done = new Promise(resolve => child.once("exit", resolve));
    child.kill("SIGTERM");
    await Promise.race([done, wait(5000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await done;
  };
  const startGateway = async () => {
    gateway = spawn(process.execPath, [join(host, "subscription-gateway.js"), join(publisherProfile, "gateway-state.json"), "synthetic"],
      { stdio: "ignore" });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (gateway.exitCode !== null) throw new Error("Synthetic gateway exited.");
      try { if ((await fetch("http://127.0.0.1:23002/.well-known/pkm-node")).ok) return; } catch {}
      await wait(100);
    }
    throw new Error("Synthetic gateway did not become ready.");
  };
  const startController = async () => {
    controller = spawn(process.execPath, [join(host, "subscriptions", "controller.js")], {
      env: { ...process.env, PKM_PRIVATE_NATIVE_SUBSCRIPTION: "1", PKM_EXPERIMENTAL_SUBSCRIPTION_HOST: "1",
        TEST_BINDING: JSON.stringify({ fixture, root, profile, cli: join(server, "dist", "cli.js"),
          gateway: join(host, "subscription-gateway.js"), grant }) }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", stderr = "";
    controller.stderr.on("data", chunk => { stderr += chunk.toString(); });
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Coordinator startup timed out.")), 30000);
      controller.once("exit", code => { clearTimeout(timeout); reject(new Error(`Coordinator exited ${code}: ${stderr}`)); });
      controller.stdout.on("data", chunk => {
        output += chunk.toString();
        if (output.includes("\n")) { clearTimeout(timeout); resolve(JSON.parse(output.slice(0, output.indexOf("\n")))); }
      });
    });
  };
  const rpc = async body => {
    const data = JSON.parse(readFileSync(grant, "utf8"));
    const result = await fetch(`${data.endpoint}/subscription`, { method: "POST",
      headers: { authorization: `Bearer ${data.bearer}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: result.status, ...(await result.json()) };
  };
  const uiEnvironment = () => ({ ...process.env, HOME: join(fixture, "h"), USERPROFILE: join(fixture, "h"),
    TMPDIR: join(fixture, "t"), TMP: join(fixture, "t"), TEMP: join(fixture, "t"),
    XDG_RUNTIME_DIR: shortTempEnv, DISPLAY: "127.0.0.1:91",
    PKM_PRIVATE_NATIVE_SUBSCRIPTION: "1", PKM_PRIVATE_NATIVE_SUBSCRIPTION_GRANT: grant,
    PKM_NATIVE_SUBSCRIPTION_DRIVER_READY: join(fixture, "driver-ready") });
  const prepareUi = async () => {
    for (const dir of ["h", "t", "workspace", "x", "driver"]) mkdirSync(join(fixture, dir), { mode: 0o700 });
    symlinkSync(join(fixture, "t"), shortTemp, "dir");
    writeFileSync(join(fixture, "u", "User", "settings.json"), JSON.stringify({
      "personalKnowledge.storePath": root, "personalKnowledge.openOnStartup": false,
      "security.workspace.trust.enabled": false, "telemetry.telemetryLevel": "off", "update.mode": "none",
      "extensions.autoUpdate": false,
    }), { mode: 0o600 });
    const xvfb = process.env.PKM_TRIAL_XVFB || "/home/yuwang8/.cache/pkm-vscode-test/tools/xvfb/usr/bin/Xvfb";
    display = spawn(xvfb, [":91", "-screen", "0", "1440x1100x24", "-nolock", "-nolisten", "unix",
      "-nolisten", "local", "-listen", "tcp", "-ac"], { env: uiEnvironment(), stdio: "ignore" });
    let displayReady = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (spawnSync("xdpyinfo", ["-display", "127.0.0.1:91"], { env: uiEnvironment(), stdio: "ignore" }).status === 0) { displayReady = true; break; }
      if (display.exitCode !== null) throw new Error("Private X display exited.");
      await wait(50);
    }
    if (!displayReady) throw new Error("Private X display did not become ready.");
    if (vsix) {
      if (!/\/\.migration-test-work\/native-chat-ui-build-[a-f0-9-]{36}\/native-chat-ui-candidate\.vsix$/.test(vsix)
        || resolve(vsix) !== vsix) throw new Error("Private candidate VSIX path denied.");
      const editor = process.env.PKM_VSCODE_EXECUTABLE || "/home/yuwang8/.cache/pkm-vscode-test/vscode-linux-x64-1.143.0/code";
      const install = spawnSync(join(dirname(editor), "bin", "code"), ["--no-sandbox", `--user-data-dir=${join(fixture, "u")}`,
        `--extensions-dir=${join(fixture, "x")}`, "--install-extension", vsix, "--force"],
      { env: uiEnvironment(), encoding: "utf8", timeout: 120000 });
      if (install.status !== 0) throw new Error(`Private candidate VSIX installation failed: ${install.stderr}`);
      const names = readdirSync(join(fixture, "x")).filter(name => /^uone\.personal-knowledge-/.test(name));
      if (names.length !== 1) throw new Error("Private installed extension identity denied.");
      const installed = join(fixture, "x", names[0], "next-runtime", "server");
      const compare = (source, target, relative = "") => {
        for (const item of readdirSync(join(source, relative), { withFileTypes: true })) {
          const next = join(relative, item.name);
          if (item.isDirectory()) compare(source, target, next);
          else if (!item.isFile() || !readFileSync(join(source, next)).equals(readFileSync(join(target, next))))
            throw new Error("Installed Next runtime differs from the frozen test runtime.");
        }
      };
      for (const name of ["dist", "compat", "browser"]) compare(join(server, name), join(installed, name));
    } else {
      const extension = join(fixture, "x", `uone.personal-knowledge-${require("../legacy/package.json").version}`);
      mkdirSync(extension, { mode: 0o700 });
      cpSync(resolve("package.json"), join(extension, "package.json"));
      for (const name of readdirSync(resolve(".")).filter(name => /^package\.nls(?:\.[^.]+)?\.json$/.test(name)))
        cpSync(resolve(name), join(extension, name));
      cpSync(resolve("resources"), join(extension, "resources"), { recursive: true });
      symlinkSync(resolve("node_modules"), join(extension, "node_modules"), "dir");
      const compiler = spawnSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", resolve("."),
        "--outDir", join(extension, "dist"), "--sourceMap", "false"], { cwd: resolve("."), env: uiEnvironment(), encoding: "utf8", timeout: 120000 });
      if (compiler.status !== 0) throw new Error(`Synthetic extension compile failed: ${compiler.stderr || compiler.stdout}`);
      cpSync(resolve("dist/webview"), join(extension, "dist", "webview"), { recursive: true });
      cpSync(resolve("src/webview"), join(extension, "dist", "webview"), { recursive: true });
      mkdirSync(join(extension, "src"), { recursive: true, mode: 0o700 });
      cpSync(resolve("src/webview"), join(extension, "src", "webview"), { recursive: true });
      mkdirSync(join(extension, "scripts"), { mode: 0o700 });
      cpSync(resolve("scripts/build-panel.js"), join(extension, "scripts", "build-panel.js"));
      const panel = spawnSync(process.execPath, [join(extension, "scripts", "build-panel.js")],
        { cwd: extension, env: uiEnvironment(), encoding: "utf8", timeout: 30000 });
      if (panel.status !== 0) throw new Error("Synthetic original panel build failed.");
    }
    const driver = join(fixture, "driver");
    writeFileSync(join(driver, "package.json"), JSON.stringify({ name: "native-subscription-ui-driver", publisher: "fixture",
      version: "0.0.1", engines: { vscode: "^1.90.0" }, activationEvents: ["*"], main: "./extension.cjs" }), { mode: 0o600 });
    cpSync(resolve("next-server/tests/native-subscription-ui-driver.cjs"), join(driver, "extension.cjs"));
  };
  const runUi = async (stage, invitation) => {
    rmSync(join(fixture, "driver-ready"), { force: true });
    const editor = process.env.PKM_VSCODE_EXECUTABLE || "/home/yuwang8/.cache/pkm-vscode-test/vscode-linux-x64-1.143.0/code";
    code = spawn(editor, [join(fixture, "workspace"), "--no-sandbox", "--new-window", `--user-data-dir=${join(fixture, "u")}`,
      `--extensions-dir=${join(fixture, "x")}`, `--extensionDevelopmentPath=${join(fixture, "driver")}`,
      "--disable-gpu", "--disable-dev-shm-usage", "--disable-site-isolation-trials", "--disable-telemetry", "--disable-updates", "--skip-welcome",
      "--skip-release-notes", "--password-store=basic", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=9334"],
    { env: uiEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
    let diagnostics = "";
    for (const stream of [code.stdout, code.stderr]) stream.on("data", chunk => {
      if (diagnostics.length < 8192) diagnostics += chunk.toString().slice(0, 8192 - diagnostics.length);
    });
    try {
      for (let attempt = 0; attempt < 300; attempt++) {
        if (code.exitCode !== null) throw new Error(`Private VS Code exited before readiness: ${diagnostics}`);
        try {
          if (existsSync(join(fixture, "driver-ready")) && (await fetch("http://127.0.0.1:9334/json/list")).ok) break;
        } catch {}
        if (attempt === 299) throw new Error(`Private VS Code UI did not become ready: ${diagnostics}`);
        await wait(100);
      }
      const result = spawnSync("python3", ["-B", resolve("next-server/tests/native-subscription-ui-playwright.py"), stage], {
        env: uiEnvironment(), input: invitation ? `${JSON.stringify(invitation)}\n` : "", encoding: "utf8", timeout: 120000 });
      if (result.status !== 0) {
        const detail = invitation?.secret ? result.stderr.split(invitation.secret).join("[redacted]") : result.stderr;
        const codeDetail = invitation?.secret ? diagnostics.split(invitation.secret).join("[redacted]") : diagnostics;
        throw new Error(`Original Subscription panel ${stage} failed: ${detail}\nVS Code: ${codeDetail}`);
      }
      if (stage === "offline" || stage === "refresh-offline") {
        for (let attempt = 0; attempt < 100 && !(await rpc({ command: "state" })).result.pending; attempt++) await wait(100);
      } else if (stage === "refresh-retry") {
        let current;
        for (let attempt = 0; attempt < 100; attempt++) {
          current = await rpc({ command: "state" });
          if (!current.result?.pending && current.result?.subscriptions.find(item => item.alias === "Renamed membership")?.revision === 3) break;
          await wait(100);
        }
        assert.equal(current.result?.subscriptions.find(item => item.alias === "Renamed membership")?.revision, 3);
        assert.equal(current.result?.pending, null);
      } else if (stage === "priority") {
        let current;
        for (let attempt = 0; attempt < 100; attempt++) {
          current = await rpc({ command: "state" });
          if (current.result?.subscriptions.find(item => item.alias === "Original old membership")?.priority === "highest"
            && !current.result.pending) break;
          await wait(100);
        }
        assert.equal(current.result?.subscriptions.find(item => item.alias === "Original old membership")?.priority, "highest");
        assert.equal(current.result?.pending, null);
      }
    } finally { await stop(code); code = undefined; await wait(1000); }
  };
  try {
    subscriber.connectMqtt = () => {};
    legacy.installNativeRemoteSubscriptionTransport(subscriber, profile, {
      control: url => ["http://127.0.0.1:23001", "http://127.0.0.1:23002"].includes(url.origin),
      transfer: url => url.protocol === "http:" && url.hostname === "127.0.0.1" && !["23001", "23002"].includes(url.port),
    });
    legacy.setRoot(publisherRoot);
    await publisher.configure({ enabled: false, port: 23010, advertisedHost: "127.0.0.1", displayName: "Synthetic publisher" });
    const makeShare = (name, controlPort) => publisher.upsertShare({ name, protection: "secret-protected", secret: "synthetic-long-share-secret-1234",
      contentTypes: ["notes"], selected: { notes: ["Shared"] }, controlPort, accountMode: "white-list",
      accountRules: [subscriber.snapshot.nodeId] });
    const first = await makeShare("First old share", 23001), second = await makeShare("Second new share", 23002);
    const firstLink = publisher.magicLink(first.shareId), firstSecret = await publisher.shareSecret(first.shareId);
    const secondLink = publisher.magicLink(second.shareId), secondSecret = await publisher.shareSecret(second.shareId);
    await startGateway();
    const seeded = await subscriber.subscribe(firstLink, "Original old membership", firstSecret);
    subscriber.dispose(); publisher.dispose();
    await stop(gateway); gateway = undefined;
    await prepareLegacyRootAdoptionExperimental(root, {});
    const adopted = await resumeLegacyRootAdoptionExperimental(root, {}); await adopted.storage.close();
    const rootStat = (await import("node:fs")).lstatSync(root, { bigint: true });
    const profileStat = (await import("node:fs")).lstatSync(profile, { bigint: true });
    writeFileSync(join(fixture, "native-subscription-fixture.json"), JSON.stringify({
      schema: "pkm.native-subscription-ui-fixture/v1", nonce: randomUUID(),
      root: `${rootStat.dev}:${rootStat.ino}`, profile: `${profileStat.dev}:${profileStat.ino}`,
    }), { mode: 0o600 });
    blocker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", "--type=extensionHost"], { stdio: "ignore" });
    await wait(200);
    await assert.rejects(startController(), /LEGACY_WRITERS_ACTIVE/);
    assert.equal(existsSync(grant), false);
    await stop(blocker); blocker = undefined;
    await startGateway(); await startController();
    if (actualUi) await prepareUi();
    const original = await rpc({ command: "state" });
    assert.equal(original.result.subscriptions.length, 1);
    assert.equal(original.result.subscriptions[0].id, seeded.id);
    assert.equal((await rpc({ command: "priority", id: seeded.id, priority: "invalid" })).status, 409);
    assert.equal((await rpc({ command: "priority", id: "unknown", priority: "high" })).status, 409);
    assert.equal((await rpc({ command: "priority", id: seeded.id, priority: "high" })).status, 200);
    assert.equal((await rpc({ command: "state" })).result.subscriptions[0].priority, "high");
    assert.equal(JSON.parse(readFileSync(join(profile, "subscriptions.json"), "utf8")).subscriptions[0].priority, "high");
    if (actualUi) {
      await runUi("priority");
      assert.equal((await rpc({ command: "state" })).result.subscriptions[0].priority, "highest");
    }
    await stop(gateway); gateway = undefined;
    if (actualUi) await runUi("offline", { magicLink: secondLink, secret: secondSecret });
    else assert.equal((await rpc({ command: "add", magicLink: secondLink, secret: secondSecret, alias: "New membership" })).status, 409);
    const pending = (await rpc({ command: "state" })).result.pending;
    assert.equal(pending.action, "add");
    const before = readFileSync(join(profile, "subscriptions.json"));
    const children = readFileSync(`/proc/${controller.pid}/task/${controller.pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean);
    assert.equal(children.length, 1);
    const stopped = new Promise(resolve => controller.once("exit", resolve));
    controller.kill("SIGKILL"); await stopped; controller = undefined;
    assert.equal(existsSync(grant), true);
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        const stat = readFileSync(`/proc/${children[0]}/stat`, "utf8");
        if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ")) break;
      } catch (error) { if (error.code === "ENOENT") break; throw error; }
      if (attempt === 199) throw new Error("Orphaned native CLI did not release its lease after controller death.");
      await wait(100);
    }
    await startController();
    assert.equal((await rpc({ command: "state" })).result.pending.operationId, pending.operationId);
    assert.deepEqual(readFileSync(join(profile, "subscriptions.json")), before);
    assert.equal((await rpc({ command: "add", magicLink: secondLink, secret: secondSecret, alias: "New membership" })).status, 409);
    await startGateway();
    if (actualUi) await runUi("retry", { magicLink: secondLink, secret: secondSecret });
    else assert.equal((await rpc({ command: "add", magicLink: secondLink, secret: secondSecret, alias: "New membership", retry: true })).status, 200);
    const added = (await rpc({ command: "state" })).result.subscriptions;
    assert.equal(added.length, 2);
    const newId = added.find(item => item.alias === "New membership").id;
    if (actualUi) await runUi("rename");
    else assert.equal((await rpc({ command: "rename", id: newId, alias: "Renamed membership" })).status, 200);
    assert.equal((await rpc({ command: "rename", id: "unknown", alias: "Wrong" })).status, 409);
    await stop(gateway); gateway = undefined;
    const material = secondSecret.split(":").at(-1);
    assert.equal((await rpc({ command: "refresh", id: newId, material: "" })).status, 409);
    if (actualUi) await runUi("refresh-offline");
    else {
      const offline = await rpc({ command: "refresh", id: newId, material });
      assert.equal(offline.status, 409);
      assert.equal(offline.code, "BROKER_UNREACHABLE");
    }
    const refreshPending = (await rpc({ command: "state" })).result.pending;
    assert.equal(refreshPending.action, "refresh");
    const refreshBefore = readFileSync(join(profile, "subscriptions.json"));
    const refreshChild = readFileSync(`/proc/${controller.pid}/task/${controller.pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean);
    assert.equal(refreshChild.length, 1);
    const refreshStopped = new Promise(resolve => controller.once("exit", resolve));
    controller.kill("SIGKILL"); await refreshStopped; controller = undefined;
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        const stat = readFileSync(`/proc/${refreshChild[0]}/stat`, "utf8");
        if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ")) break;
      } catch (error) { if (error.code === "ENOENT") break; throw error; }
      if (attempt === 199) throw new Error("Orphaned refresh CLI did not release its lease.");
      await wait(100);
    }
    const refreshedMember = (await import("node:fs")).readFileSync(join(profile, "subscriptions.json"), "utf8");
    const refreshRecord = JSON.parse(refreshedMember).subscriptions.find(item => item.id === newId);
    const nodeCache = join(profile, "cache", refreshRecord.nodeId);
    const inputPath = join(fixture, "partial-materializer-input.json");
    const input = Buffer.from(JSON.stringify({ notes: Array.from({ length: 2000 },
      (_, index) => ({ slug: `partial-${index}`, content: "Synthetic partial data ".repeat(100) })) }));
    writeFileSync(inputPath, input, { mode: 0o600 });
    const worker = fork(join(host, "subscription-materialize-worker.js"), [], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    let staging;
    try {
      worker.send({ inputPath, storageDir: profile, record: refreshRecord,
        summary: { name: "Synthetic incomplete", revision: 2,
          collectionHash: `sha256:${createHash("sha256").update(input).digest("hex")}` },
        syncedAt: new Date().toISOString() });
      for (let attempt = 0; attempt < 1000; attempt++) {
        const name = readdirSync(nodeCache).find(value => value.startsWith(`.${refreshRecord.shareId}.`) && value.endsWith(".staging"));
        if (name && existsSync(join(nodeCache, name, "content", "notes", "partial-0.md"))) {
          staging = join(nodeCache, name); break;
        }
        if (worker.exitCode !== null) throw new Error("Synthetic materializer completed before interruption.");
        await wait(5);
      }
      if (!staging) throw new Error("Synthetic materializer did not reach partial staging.");
    } finally {
      if (worker.exitCode === null && worker.signalCode === null) {
        const stopped = new Promise(done => worker.once("exit", done));
        worker.kill("SIGKILL"); await stopped;
      }
    }
    const stagedNames = readdirSync(staging);
    const stagedContent = readFileSync(join(staging, "content", "notes", "partial-0.md"));
    const inventory = directory => readdirSync(directory, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile()).map(entry => {
        const file = join(entry.parentPath, entry.name);
        return [file.slice(directory.length), createHash("sha256").update(readFileSync(file)).digest("hex")];
      }).sort((a, b) => a[0].localeCompare(b[0]));
    const stagedInventory = inventory(staging);
    assert.ok(stagedNames.length);
    await startController();
    assert.equal((await rpc({ command: "state" })).result.recoveryBlocked, true);
    assert.deepEqual(readdirSync(staging), stagedNames);
    assert.deepEqual(readFileSync(join(staging, "content", "notes", "partial-0.md")), stagedContent);
    assert.deepEqual(inventory(staging), stagedInventory);
    const inspection = await rpc({ command: "inspect-recovery" });
    assert.equal(inspection.status, 200);
    assert.equal(inspection.result.canRetry, false);
    assert.ok(inspection.result.entries.includes(basename(staging)));
    assert.equal((await rpc({ command: "recheck-recovery" })).status, 409);
    assert.deepEqual(inventory(staging), stagedInventory);
    if (actualUi) await runUi("recovery-blocked");
    else assert.equal((await rpc({ command: "refresh", id: newId, material, retry: true })).status, 409);
    assert.deepEqual(readdirSync(staging), stagedNames);
    await stop(controller); controller = undefined;
    renameSync(staging, join(fixture, "preserved-staging"));
    assert.deepEqual(readdirSync(join(fixture, "preserved-staging")), stagedNames);
    assert.deepEqual(readFileSync(join(fixture, "preserved-staging", "content", "notes", "partial-0.md")), stagedContent);
    assert.deepEqual(inventory(join(fixture, "preserved-staging")), stagedInventory);
    const emptyStaging = join(nodeCache, `.${refreshRecord.shareId}.0123456789.staging`);
    mkdirSync(emptyStaging, { mode: 0o700 });
    await startController();
    assert.equal(existsSync(emptyStaging), false);
    const linkedStaging = join(nodeCache, `.${refreshRecord.shareId}.0123456789.staging`);
    symlinkSync(join(fixture, "preserved-staging"), linkedStaging, "dir");
    const linkedInspection = await rpc({ command: "inspect-recovery" });
    assert.ok(linkedInspection.result.entries.includes(basename(linkedStaging)));
    assert.equal(linkedInspection.result.canRetry, false);
    assert.equal((await rpc({ command: "recheck-recovery" })).status, 409);
    assert.deepEqual(inventory(join(fixture, "preserved-staging")), stagedInventory);
    rmSync(linkedStaging);
    if (actualUi) await runUi("recovery-recheck");
    else {
      assert.equal((await rpc({ command: "inspect-recovery" })).result.canRetry, true);
      assert.equal((await rpc({ command: "recheck-recovery" })).result.canRetry, true);
    }
    assert.equal((await rpc({ command: "state" })).result.pending.operationId, refreshPending.operationId);
    assert.deepEqual(readFileSync(join(profile, "subscriptions.json")), refreshBefore);
    assert.equal((await rpc({ command: "refresh", id: newId, material })).status, 409);
    writeFileSync(join(publisherRoot, "notes", "Shared.md"), "# Synthetic remote revision two\n", { mode: 0o600 });
    const republished = await publisher.upsertShare({ shareId: second.shareId, name: "Second new share",
      protection: "secret-protected", secret: "synthetic-long-share-secret-1234", contentTypes: ["notes"],
      selected: { notes: ["Shared"] }, controlPort: 23002, accountMode: "white-list", accountRules: ["a".repeat(64)] });
    assert.equal(republished.revision, 2);
    await startGateway();
    if (actualUi) await runUi("refresh-denied");
    else {
      const revoked = await rpc({ command: "refresh", id: newId, material, retry: true });
      assert.equal(revoked.status, 409);
      assert.equal(revoked.code, "BROKER_FORBIDDEN");
    }
    assert.equal((await rpc({ command: "state" })).result.pending.operationId, refreshPending.operationId);
    assert.match(JSON.parse(readFileSync(join(profile, "subscriptions.json"), "utf8"))
      .subscriptions.find(item => item.id === newId).error, /Broker returned (401|403)\./);
    await stop(gateway); gateway = undefined;
    await publisher.upsertShare({ shareId: second.shareId, name: "Second new share",
      protection: "secret-protected", secret: "synthetic-long-share-secret-1234", contentTypes: ["notes"],
      selected: { notes: ["Shared"] }, controlPort: 23002, accountMode: "white-list", accountRules: [subscriber.snapshot.nodeId] });
    await startGateway();
    if (actualUi) await runUi("refresh-retry");
    else assert.equal((await rpc({ command: "refresh", id: newId, material, retry: true })).status, 200);
    assert.equal((await rpc({ command: "state" })).result.subscriptions.find(item => item.id === newId).revision, 3);
    if (actualUi) await runUi("remove");
    else assert.equal((await rpc({ command: "remove", id: seeded.id })).status, 200);
    await stop(controller); controller = undefined;
    await startController();
    const after = (await rpc({ command: "state" })).result;
    assert.equal(after.pending, null);
    assert.equal(after.subscriptions.length, 1);
    assert.equal(after.subscriptions[0].alias, "Renamed membership");
    for (const name of ["core.sqlite", "core.sqlite-wal"]) {
      const file = join(root, name);
      if (existsSync(file)) {
        assert.equal(readFileSync(file).includes(Buffer.from(secondSecret)), false);
        assert.equal(readFileSync(file).includes(Buffer.from(material)), false);
      }
    }
  } finally {
    await stop(code); await stop(controller); await stop(gateway); await stop(blocker); await stop(display);
    subscriber.dispose(); publisher.dispose();
    if (originalGate === undefined) delete process.env.PKM_EXPERIMENTAL_SUBSCRIPTION_HOST;
    else process.env.PKM_EXPERIMENTAL_SUBSCRIPTION_HOST = originalGate;
    rmSync(shortTemp, { force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
});

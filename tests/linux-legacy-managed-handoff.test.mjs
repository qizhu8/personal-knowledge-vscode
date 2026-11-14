import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const source = process.env.PKM_LEGACY_GENERATED_FIXTURE;
const python = process.env.PKM_LEGACY_PYTHON;
const tests = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const projectDist = resolve(process.env.PKM_TEST_DIST || join(tests, "../legacy/dist"));
const nextDist = resolve(process.env.PKM_TEST_NEXT_DIST || join(tests, "../dist"));
const { acquireLinuxRootWriterFence, markLinuxRootNextOwned } =
  await import(pathToFileURL(join(nextDist, "linux-root-writer-fence.js")).href);

test("enrolled profile launchers retain pending until actual FastMCP quiesce and EOF", {
  skip: process.platform !== "linux" || !source || !python, timeout: 120_000,
}, async () => {
  const project = resolve(tests, "../legacy"), original = resolve(source);
  const allowed = await realpath(join(project, ".migration-test-work"));
  assert.equal(await realpath(original), original);
  assert(original.startsWith(allowed + sep));
  const scratch = join(tests, `.profile-session-real-${randomUUID()}`);
  let root = join(scratch, "knowledge"), id = randomUUID();
  const session = require(join(projectDist, "runtime/managed-writer-session.js"));
  const { managedMcpLauncher } = require(join(projectDist, "mcp/mcp-lifecycle.js"));
  const children = [], clients = [];
  let ownedChat;
  const digest = bytes => createHash("sha256").update(bytes).digest("hex");
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await writeFile(join(scratch, "package.json"), '{"type":"commonjs"}');
    await mkdir(join(scratch, "home"), { mode: 0o700 });
    await mkdir(join(scratch, "temp"), { mode: 0o700 });
    session.provisionManagedWriterSession(root, id);
    async function setup(name) {
      const profile = join(scratch, name), managed = join(profile, "legacy-mcp-server");
      await mkdir(profile, { mode: 0o700 });
      await cp(join(original, "legacy-mcp-server"), managed, { recursive: true });
      await rm(join(managed, "instances"), { recursive: true, force: true });
      const active = JSON.parse(await readFile(join(managed, "active-generation.json"), "utf8"));
      const generation = join(managed, "generations", active.generation);
      const manifestFile = join(generation, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
      assert.equal(manifest.extensionVersion, "4.0.22");
      for (const [file, hash] of Object.entries(manifest.files)) {
        const target = resolve(generation, file);
        assert(relative(generation, target) && !relative(generation, target).startsWith(`..${sep}`));
        const bytes = await readFile(target);
        assert.equal(digest(bytes), hash);
        if (bytes.includes(Buffer.from(original))) {
          assert(["server.py", "recipe_compiler_config.json"].includes(file));
          const replaced = bytes.toString("utf8").replaceAll(join(original, "knowledge"), root).replaceAll(original, profile);
          await writeFile(target, replaced); manifest.files[file] = digest(Buffer.from(replaced));
        }
      }
      const serverPath = join(generation, "server.py");
      const server = (await readFile(serverPath, "utf8")).replace(/^_KNOWLEDGE_NODE = .+$/m, `_KNOWLEDGE_NODE = ${JSON.stringify(process.execPath)}`);
      await writeFile(serverPath, server); manifest.files["server.py"] = digest(Buffer.from(server));
      const fence = await readFile(join(project, "resources/root_writer_fence.py"));
      await writeFile(join(generation, "root_writer_fence.py"), fence); manifest.files["root_writer_fence.py"] = digest(fence);
      const runtime = join(generation, "runtime/dist/runtime");
      await cp(join(projectDist, "runtime"), runtime, { recursive: true, force: true });
      for (const file of await readdir(runtime)) {
        const bytes = await readFile(join(runtime, file));
        manifest.files[`runtime/dist/runtime/${file}`] = digest(bytes);
      }
      manifest.managedRoot = managed;
      manifest.runtimeMaintenance = join(profile, "runtime-maintenance.json");
      await writeFile(manifestFile, JSON.stringify(manifest));
      await writeFile(join(managed, "server.py"), managedMcpLauncher(manifest, root));
      return managed;
    }
    const profiles = await Promise.all([setup("a"), setup("b")]);
    const launchIds = [randomUUID(), randomUUID()];
    const env = { PATH: process.env.PATH || "", HOME: join(scratch, "home"), TMPDIR: join(scratch, "temp"),
      PYTHONDONTWRITEBYTECODE: "1", PKM_NODE_EXECUTABLE: process.execPath,
      HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1", ALL_PROXY: "http://127.0.0.1:1",
      NO_PROXY: "127.0.0.1" };
    for (const [index, managed] of profiles.entries()) {
      const client = new Client({ name: "isolated-profile-session", version: "1" });
      const transport = new StdioClientTransport({ command: resolve(python), args: [join(managed, "server.py")],
        cwd: scratch, stderr: "pipe", env: { ...env, PKM_MANAGED_WRITER_LAUNCH_ID: launchIds[index] } });
      clients.push(client);
      await client.connect(transport);
      const child = transport._process;
      assert(child?.pid);
      children.push({ child, exited: new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal }))) });
      session.assertManagedMcpLaunchRegistered(root, id, launchIds[index]);
    }
    assert.throws(() => session.assertManagedMcpLaunchRegistered(root, id, randomUUID()), /did not register/);
    const Module = require("node:module"), originalLoad = Module._load;
    let connectManagedChatMcp;
    try {
      Module._load = function(name, ...args) { return name === "vscode" ? {} : originalLoad.call(this, name, ...args); };
      ({ connectManagedChatMcp } = require(join(projectDist, "chat/api-chat-mcp.js")));
    } finally { Module._load = originalLoad; }
    const previousSession = process.env.PKM_MANAGED_WRITER_SESSION;
    try {
      process.env.PKM_MANAGED_WRITER_SESSION = id;
      ownedChat = await connectManagedChatMcp({ command: resolve(python), args: [join(profiles[0], "server.py")],
        cwd: scratch, env }, new AbortController().signal, profiles[0], { knowledgeRoot: root });
    } finally {
      if (previousSession === undefined) delete process.env.PKM_MANAGED_WRITER_SESSION;
      else process.env.PKM_MANAGED_WRITER_SESSION = previousSession;
    }
    const call = (client, name, args = {}) => client.callTool({ name, arguments: args });
    const unpack = result => result.structuredContent ?? JSON.parse(result.content[0].text);
    const note = await call(clients[0], "add_note", { title: "Session profile A", content: "isolated" });
    assert.notEqual(note.isError, true, JSON.stringify(note));
    assert.equal(unpack(note).ok, true);
    session.closeManagedWriterAdmission(root, id);
    const restart = spawnSync(resolve(python), [join(profiles[0], "server.py")], { cwd: scratch, env, encoding: "utf8", timeout: 10000 });
    assert.notEqual(restart.status, 0);
    assert.match(restart.stderr, /session is fenced/);
    let releaseSecond;
    const firstDone = new Promise(resolve => { releaseSecond = resolve; });
    const handles = clients.map((client, i) => ({ drain: async () => {
      if (i === 1) await firstDone;
      const drained = unpack(await call(client, "mcp_lifecycle_quiesce"));
      assert.equal(drained.phase, "drained");
      assert.equal(drained.inFlight, 0);
      assert.equal(drained.uncertainCalls, 0);
      children[i].child.stdin.end();
      assert.deepEqual(await children[i].exited, { code: 0, signal: null });
      if (i === 0) {
        await assert.rejects(session.waitForManagedWriterDrain(root, id, 100), /active or has an unknown outcome/);
        releaseSecond();
      }
    } }));
    handles.push({ drain: () => ownedChat.close() });
    assert.equal((await session.orchestrateManagedWriterHandoff(root, id, handles, 5000)).cutoverAuthorized, false);

    root = join(scratch, "crash-knowledge");
    id = randomUUID();
    await mkdir(root, { mode: 0o700 });
    session.provisionManagedWriterSession(root, id);
    const crashManaged = await setup("crash");
    const launch = async () => {
      const client = new Client({ name: "isolated-crash-restart", version: "1" });
      const transport = new StdioClientTransport({ command: resolve(python), args: [join(crashManaged, "server.py")],
        cwd: scratch, stderr: "pipe", env });
      clients.push(client);
      await client.connect(transport);
      const child = transport._process;
      assert(child?.pid);
      const exited = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
      children.push({ child, exited });
      return { client, child, exited };
    };
    const failed = await launch();
    assert.equal(unpack(await call(failed.client, "add_note", { title: "Before SIGKILL", content: "written" })).ok, true);
    failed.child.kill("SIGKILL");
    assert.equal((await failed.exited).signal, "SIGKILL");
    const recovered = await launch();
    assert.equal(unpack(await call(recovered.client, "add_note", { title: "After restart", content: "written" })).ok, true);
    assert.equal(unpack(await call(recovered.client, "mcp_lifecycle_quiesce")).phase, "drained");
    recovered.child.stdin.end();
    assert.deepEqual(await recovered.exited, { code: 0, signal: null });
    session.closeManagedWriterAdmission(root, id);
    await assert.rejects(session.waitForManagedWriterDrain(root, id, 100), /active or has an unknown outcome/);
    const crashOperations = await readdir(join(root, ".pkm/state/managed-writer-session/operations"));
    assert.equal(crashOperations.filter(name => name.endsWith(".pending")).length, 2);
    assert.equal(crashOperations.filter(name => name.endsWith(".complete")).length, 1);
  } finally {
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.all(children.map(({ exited }) => exited));
    if (ownedChat) await ownedChat.close().catch(() => {});
    for (const client of clients) await client.close().catch(() => {});
    await rm(scratch, { recursive: true, force: true });
  }
});

// The supplied fixture must be a closed, isolated installed-old profile, not a user profile.
test("released managed MCP maintenance is profile-scoped, not a root writer fence", {
  skip: process.platform !== "linux" || !source || !python,
  timeout: 120_000,
}, async () => {
  const original = resolve(source);
  const project = resolve(tests, "../legacy");
  const allowed = await realpath(join(project, ".migration-test-work"));
  assert.equal(await realpath(original), original);
  assert(original.startsWith(allowed + sep));
  const scratch = join(tests, `.legacy-managed-handoff-${randomUUID()}`);
  const root = join(scratch, "knowledge");
  const clients = [];
  const owned = new WeakMap();
  let fence;
  const digest = bytes => createHash("sha256").update(bytes).digest("hex");
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await writeFile(join(scratch, "package.json"), '{"type":"commonjs"}');
    await mkdir(join(scratch, "home"), { mode: 0o700 });
    await mkdir(join(scratch, "temp"), { mode: 0o700 });
    const vsix = join(project, "personal-knowledge-4.0.22.vsix");
    assert.equal(digest(await readFile(vsix)), "1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27");
    const released = name => execFileSync("unzip", ["-p", vsix, `extension/${name}`], { maxBuffer: 8 * 1024 * 1024 });
    const publisherDir = join(scratch, "published");
    for (const name of ["dist/mcp/mcp-lifecycle.js", "dist/mcp/mcp-attribution.js", "dist/runtime/cross-process-lock.js"]) {
      const file = join(publisherDir, name);
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(file, released(name));
    }
    const publishedMutation = released("resources/knowledge_mutations.py");
    const publishedGuard = released("resources/mcp_call_guard.py");
    const publishedHelper = released("resources/knowledge_mutations.js");
    const setup = async name => {
      const profile = join(scratch, name);
      const managed = join(profile, "legacy-mcp-server");
      await mkdir(profile, { mode: 0o700 });
      await cp(join(original, "legacy-mcp-server"), managed, { recursive: true });
      await rm(join(managed, "instances"), { recursive: true, force: true });
      const active = JSON.parse(await readFile(join(managed, "active-generation.json"), "utf8"));
      assert.match(active.generation, /^[a-f0-9-]{36}$/);
      const generation = join(managed, "generations", active.generation);
      const manifestPath = join(generation, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      assert.equal(manifest.extensionVersion, "4.0.22");
      for (const [name, expected] of Object.entries(manifest.files)) {
        const file = resolve(generation, name);
        const rel = relative(generation, file);
        assert(rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
        assert((await lstat(file)).isFile());
        assert.equal(await realpath(file), file);
        const bytes = await readFile(file);
        assert.equal(digest(bytes), expected, `Original generation hash mismatch: ${name}`);
        if (!bytes.includes(Buffer.from(original))) continue;
        assert(["server.py", "recipe_compiler_config.json"].includes(name), `Unexpected original fixture path in ${name}`);
        const replaced = bytes.toString("utf8").replaceAll(join(original, "knowledge"), root).replaceAll(original, profile);
        await writeFile(file, replaced);
        manifest.files[name] = digest(replaced);
      }
      const serverPath = join(generation, "server.py");
      const server = await readFile(serverPath, "utf8");
      assert(server.includes(root));
      assert.equal((server.match(/^_KNOWLEDGE_NODE = .+$/gm) ?? []).length, 1);
      const configuredServer = server.replace(/^_KNOWLEDGE_NODE = .+$/m, `_KNOWLEDGE_NODE = ${JSON.stringify(process.execPath)}`);
      await writeFile(serverPath, configuredServer);
      manifest.files["server.py"] = digest(configuredServer);
      assert.deepEqual(await readFile(join(generation, "mcp_call_guard.py")), publishedGuard);
      assert.deepEqual(await readFile(join(generation, "knowledge_mutations.js")), publishedHelper);
      assert.deepEqual(await readFile(join(generation, "knowledge_mutations.py")), publishedMutation);
      assert.deepEqual(await readFile(join(generation, "runtime", "dist", "mcp", "mcp-lifecycle.js")),
        released("dist/mcp/mcp-lifecycle.js"));
      manifest.managedRoot = managed;
      manifest.runtimeMaintenance = join(profile, "runtime-maintenance.json");
      await writeFile(manifestPath, JSON.stringify(manifest));
      return { managed, generation, manifest };
    };
    const a = await setup("a");
    const b = await setup("b");
    const env = {
      PATH: process.env.PATH || "", HOME: join(scratch, "home"),
      TMPDIR: join(scratch, "temp"), PYTHONDONTWRITEBYTECODE: "1",
      HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1",
      ALL_PROXY: "http://127.0.0.1:1", NO_PROXY: "127.0.0.1",
    };
    const connect = async managed => {
      const client = new Client({ name: "isolated-legacy-handoff", version: "1" });
      const transport = new StdioClientTransport({
        command: resolve(python), args: [join(managed, "server.py")],
        cwd: scratch, stderr: "pipe",
        env,
      });
      clients.push(client);
      await client.connect(transport);
      assert(transport.pid > 0);
      assert.equal(transport._process?.pid, transport.pid);
      owned.set(client, transport._process);
      return client;
    };
    const call = (client, name, args = {}) => client.callTool({ name, arguments: args });
    const unpack = result => result.structuredContent ?? JSON.parse(result.content[0].text);
    const first = await connect(a.managed);
    let other = await connect(b.managed);
    const session = require(join(projectDist, "runtime/managed-writer-session.js"));
    const enrollment = session.bootstrapManagedProfile(root, "a".repeat(64), true);
    const beforeCrash = unpack(await call(other, "add_note", { title: "Existing before crash", content: "still operational" }));
    assert.equal(beforeCrash.ok, true);
    const oldChild = owned.get(other);
    const oldExit = new Promise(resolve => oldChild.once("close", (code, signal) => resolve({ code, signal })));
    oldChild.kill("SIGKILL");
    assert.equal((await oldExit).signal, "SIGKILL");
    await other.close().catch(() => {});
    other = await connect(b.managed);
    const afterCrash = unpack(await call(other, "add_note", { title: "Existing after crash", content: "restarted old client" }));
    assert.equal(afterCrash.ok, true);
    const operations = await readdir(join(root, ".pkm/state/managed-writer-session/operations"));
    assert.equal(operations.length, 1, "original 4.0.22 did not register a managed MCP operation");
    assert.match(operations[0], new RegExp(`^${enrollment.registration.operationId}\\.pending$`));
    fence = await acquireLinuxRootWriterFence(root);

    // Publish a compatible synthetic successor using the actual old publisher.
    // Merely changing the current generation does not drain an already connected MCP.
    const nextId = randomUUID();
    const nextGeneration = join(a.managed, "generations", nextId);
    await cp(a.generation, nextGeneration, { recursive: true });
    const nextManifest = { ...a.manifest, generation: nextId, extensionVersion: "4.0.23" };
    await writeFile(join(nextGeneration, "manifest.json"), JSON.stringify(nextManifest));
    const publisher = require(join(publisherDir, "dist", "mcp", "mcp-lifecycle.js"));
    publisher.publishManagedMcpGeneration(a.managed, nextManifest);
    const compatible = unpack(await call(first, "mcp_lifecycle_status"));
    assert.equal(compatible.generation, a.manifest.generation);
    assert.equal(compatible.updateAvailable, true);
    assert.equal(compatible.acceptingNewCalls, true);
    const oldWrite = unpack(await call(first, "add_note", { title: "Before drain", content: "old generation still writes" }));
    assert.equal(oldWrite.ok, true);
    assert.equal(oldWrite.slug, "Before drain");
    assert.match(await readFile(join(root, "notes", `${oldWrite.slug}.md`), "utf8"), /old generation still writes/);
    fence.assertHeld();

    const { withCrossProcessLock } = require(join(publisherDir, "dist", "runtime", "cross-process-lock.js"));
    const lockPath = join(root, ".pkm", "state", "markdown-assets.lock");
    await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
    let unlock;
    let signalLocked;
    const entered = new Promise(resolve => { signalLocked = resolve; });
    const release = new Promise(resolve => { unlock = resolve; });
    const held = withCrossProcessLock(lockPath, "isolated handoff test", 2000, async () => {
      signalLocked();
      await release;
    });
    await entered;
    let pending;
    try {
      pending = call(first, "add_note", { title: "In flight", content: "completed before drain" });
      void pending.catch(() => {});
      let before;
      for (let i = 0; i < 30; i++) {
        before = unpack(await call(first, "mcp_lifecycle_status"));
        if (before.inFlight === 1) break;
        await delay(20);
      }
      assert.equal(before.inFlight, 1);
      await writeFile(join(a.managed, "runtime-maintenance.json"), "isolated maintenance\n", { flag: "wx" });
      const draining = unpack(await call(first, "mcp_lifecycle_quiesce"));
      assert.equal(draining.pid, owned.get(first).pid);
      assert.equal(draining.generation, a.manifest.generation);
      assert.equal(draining.phase, "draining");
      assert.equal(draining.inFlight, 1);
      assert.equal((await call(first, "add_note", { title: "Blocked profile", content: "blocked" })).isError, true);
    } finally {
      unlock();
      await held;
    }
    const completed = unpack(await pending);
    assert.equal(completed.ok, true);
    assert.equal(completed.slug, "In flight");
    assert.match(await readFile(join(root, "notes", `${completed.slug}.md`), "utf8"), /completed before drain/);
    const status = unpack(await call(first, "mcp_lifecycle_status"));
    assert.equal(status.phase, "drained");
    assert.equal(status.inFlight, 0);
    assert.equal(status.uncertainCalls, 0);
    const blockedLaunch = spawnSync(resolve(python), [join(a.managed, "server.py")], {
      cwd: scratch, env, encoding: "utf8", timeout: 10_000,
    });
    assert.equal(blockedLaunch.status, 1);
    assert.match(blockedLaunch.stderr, /runtime maintenance is action-required/);

    const write = await call(other, "add_note", { title: "Other profile", content: "still writes" });
    assert.notEqual(write.isError, true, JSON.stringify(write));
    const firstWrite = unpack(write);
    assert.equal(firstWrite.ok, true);
    assert.equal(firstWrite.slug, "Other profile");
    assert.match(await readFile(join(root, "notes", `${firstWrite.slug}.md`), "utf8"), /still writes/);
    fence.assertHeld();

    // The released extension's maintenance cleanup can remove a foreign marker.
    // A replacement process then accepts calls even though the old process remains drained.
    await rm(join(a.managed, "runtime-maintenance.json"));
    assert.equal((await call(first, "add_note", { title: "Still blocked", content: "blocked" })).isError, true);
    const firstChild = owned.get(first);
    const firstExit = new Promise(resolve => firstChild.once("close", (code, signal) => resolve({ code, signal })));
    await first.close();
    assert.deepEqual(await firstExit, { code: 0, signal: null });
    const restarted = await connect(a.managed);
    const after = await call(restarted, "add_note", { title: "Restarted profile", content: "still writes" });
    assert.notEqual(after.isError, true, JSON.stringify(after));
    const secondWrite = unpack(after);
    assert.equal(secondWrite.ok, true);
    assert.equal(secondWrite.slug, "Restarted profile");
    assert.match(await readFile(join(root, "notes", `${secondWrite.slug}.md`), "utf8"), /still writes/);
    fence.assertHeld();

    // Overlay only the current Note mutation wrapper in a new synthetic generation.
    // This is not a complete upgraded extension or a fleet-enrollment proof.
    const fencedId = randomUUID();
    const fencedGeneration = join(a.managed, "generations", fencedId);
    await cp(nextGeneration, fencedGeneration, { recursive: true });
    const fencedManifest = { ...nextManifest, generation: fencedId, extensionVersion: "4.0.24", files: { ...nextManifest.files } };
    for (const name of ["knowledge_mutations.py", "root_writer_fence.py", "node_runtime.py"]) {
      const bytes = await readFile(join(project, "resources", name));
      await writeFile(join(fencedGeneration, name), bytes);
      fencedManifest.files[name] = digest(bytes);
    }
    await writeFile(join(fencedGeneration, "manifest.json"), JSON.stringify(fencedManifest));
    publisher.publishManagedMcpGeneration(a.managed, fencedManifest);
    await fence.release();
    fence = undefined;
    const upgraded = await connect(a.managed);
    const participatingCall = await call(upgraded, "add_note", { title: "Participating", content: "before cutover" });
    assert.notEqual(participatingCall.isError, true, JSON.stringify(participatingCall));
    const participating = unpack(participatingCall);
    assert.equal(participating.ok, true);
    assert.equal(participating.slug, "Participating");
    assert.match(await readFile(join(root, "notes", `${participating.slug}.md`), "utf8"), /before cutover/);
    fence = await acquireLinuxRootWriterFence(root);
    await markLinuxRootNextOwned(root, fence);
    await fence.release();
    fence = undefined;
    const denied = await call(upgraded, "add_note", { title: "Upgraded blocked", content: "blocked" });
    assert.equal(denied.isError, true);
    assert.match(JSON.stringify(denied), /handed to next-server/);
    const unupgraded = unpack(await call(restarted, "add_note", { title: "Old after marker", content: "bypasses marker" }));
    assert.equal(unupgraded.ok, true);
    assert.equal(unupgraded.slug, "Old after marker");
    assert.match(await readFile(join(root, "notes", `${unupgraded.slug}.md`), "utf8"), /bypasses marker/);

    // Replace only the copied profile launcher with the current source launcher.
    // The existing predecessor remains live, but a newly started launcher now
    // refuses ownership before serving any tools.
    const currentLauncher = require(join(projectDist, "mcp", "mcp-lifecycle.js"));
    await writeFile(join(a.managed, "server.py"), currentLauncher.managedMcpLauncher(fencedManifest, root));
    const deniedRestart = spawnSync(resolve(python), [join(a.managed, "server.py")], {
      cwd: scratch, env, encoding: "utf8", timeout: 10_000,
    });
    assert.notEqual(deniedRestart.status, 0);
    assert.match(deniedRestart.stderr, /handed to next-server/);
  } finally {
    for (const client of clients.reverse()) await client.close().catch(() => {});
    await fence?.release();
    await rm(scratch, { recursive: true, force: true });
  }
});

test("changing file permissions does not revoke a legacy writer's open descriptor", {
  skip: process.platform !== "linux",
  timeout: 30_000,
}, async () => {
  const scratch = join(tests, `.legacy-open-handle-${randomUUID()}`);
  const root = join(scratch, "knowledge");
  let child;
  let fence;
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const file = join(root, "note.md");
    await writeFile(file, "before", { mode: 0o600 });
    child = spawn(process.execPath, ["-e", `
      const fs = require("node:fs");
      const fd = fs.openSync(process.argv[1], "r+");
      fs.writeSync(1, "opened\\n");
      process.stdin.once("data", () => {
        fs.writeSync(fd, "after!", 0, "utf8");
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fs.writeSync(1, "written\\n");
        process.exit(0);
      });
    `, file], { cwd: scratch, stdio: ["pipe", "pipe", "pipe"] });
    const closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
    const wait = word => new Promise((resolveWait, reject) => {
      let output = "";
      const timer = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for ${word}`)); }, 10_000);
      const onData = chunk => {
        output += chunk.toString();
        if (output.includes(`${word}\n`)) { cleanup(); resolveWait(); }
      };
      const onClose = () => { cleanup(); reject(new Error(`Writer exited before ${word}`)); };
      const cleanup = () => {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        child.off("close", onClose);
      };
      child.stdout.on("data", onData);
      child.once("close", onClose);
    });
    await wait("opened");
    await chmod(file, 0o400);
    fence = await acquireLinuxRootWriterFence(root);
    const written = wait("written");
    child.stdin.write("write\n");
    await written;
    assert.deepEqual(await closed, { code: 0, signal: null });
    assert.equal(await readFile(file, "utf8"), "after!");
    assert.equal((await lstat(file)).mode & 0o777, 0o400);
    fence.assertHeld();
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = new Promise(resolve => child.once("close", resolve));
      child.kill("SIGTERM");
      await closed;
    }
    await fence?.release();
    await rm(scratch, { recursive: true, force: true });
  }
});

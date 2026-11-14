const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { fork } = require("node:child_process");
const { randomUUID } = require("node:crypto");

const project = path.resolve(__dirname, "..");
const build = process.env.PKM_SERVICE_BUILD_DIR || path.join(project, "dist");
const service = require(path.join(build, "runtime/pkm-service.js"));
const session = require(path.join(build, "runtime/managed-writer-session.js"));

if (process.argv[2] === "--service-child") {
  const options = JSON.parse(process.argv[3]);
  void service.startPkmService(options).then(async runtime => {
    process.send({ started: true });
    await runtime.stopped;
    process.send({ stopped: true });
    process.disconnect();
  }).catch(error => { console.error(error.stack); process.exitCode = 1; process.disconnect(); });
} else {
  test("managed Sync daemon drains itself after the session is fenced", { skip: process.platform !== "linux", timeout: 20000 }, async () => {
    const scratch = path.join(project, ".migration-test-work", `managed-sync-fence-${randomUUID()}`);
    const root = path.join(scratch, "root"), storage = path.join(scratch, "storage"), home = path.join(scratch, "home");
    for (const dir of [root, storage, home]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    session.provisionManagedWriterSession(root, id);
    const child = fork(__filename, ["--service-child", JSON.stringify({ knowledgeRoot: root, globalStoragePath: storage,
      extensionVersion: require(path.join(project, "package.json")).version })], {
      cwd: scratch, env: { ...process.env, HOME: "/proc/self/cwd/home", TMPDIR: scratch,
        PKM_MANAGED_WRITER_SESSION: id, PKM_SERVICE_TEST_LIFECYCLE_MS: "50" }, stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    const exit = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
    const message = type => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out: ${type}; ${stderr}`)), 10000);
      child.on("message", function onMessage(value) {
        if (!value[type]) return;
        clearTimeout(timer);
        child.off("message", onMessage);
        resolve();
      });
    });
    try {
      await message("started");
      const stopped = message("stopped");
      session.closeManagedWriterAdmission(root, id);
      await stopped;
      assert.deepEqual(await exit, { code: 0, signal: null });
      const records = path.join(root, ".pkm/state/managed-writer-session/operations");
      const pending = fs.readdirSync(records).filter(file => file.endsWith(".pending"));
      assert.equal(pending.length, 1);
      assert(fs.existsSync(path.join(records, pending[0].replace(".pending", ".complete"))));
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await exit;
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
}

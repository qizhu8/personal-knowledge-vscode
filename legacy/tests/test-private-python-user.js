const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), { randomUUID } = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const launcher = path.resolve("scripts/run-private-python-user.py");
function fixture(t) {
  const root = path.resolve("tests", ".private-python-user-" + randomUUID());
  fs.mkdirSync(root, { mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
test("private qualification preserves actual non-admin UID and has private PID/loopback", t => {
  const root = fixture(t), uid = process.getuid();
  const result = spawnSync("/usr/bin/python3", ["-I", "-B", launcher, process.execPath, "-e",
    `console.log(JSON.stringify({uid:process.getuid(),pid:process.pid,namespace:require('node:fs').readlinkSync('/proc/self/ns/net'),up:require('node:child_process').execFileSync('ip',['link','show','lo'],{encoding:'utf8'}).includes('UP')}))`],
  { env: { PATH: process.env.PATH, HOME: root, TMPDIR: root }, encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.uid, uid); assert.notEqual(value.uid, 0); assert.equal(value.pid, 2); assert(value.up);
  assert.notEqual(value.namespace, fs.readlinkSync("/proc/self/ns/net"));
});
test("stopping the owned launcher destroys its private PID namespace rather than leaving a detached worker", async t => {
  const root = fixture(t), receipt = path.join(root, "namespace.json");
  const child = spawn("/usr/bin/python3", ["-I", "-B", launcher, process.execPath, "-e",
    `require('node:fs').writeFileSync(${JSON.stringify(receipt)},JSON.stringify({namespace:require('node:fs').readlinkSync('/proc/self/ns/pid')}));setInterval(()=>{},1000);`],
  { env: { PATH: process.env.PATH, HOME: root, TMPDIR: root }, stdio: "ignore" });
  const closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); });
  for (let n = 0; n < 100 && !fs.existsSync(receipt); n++) await new Promise(resolve => setTimeout(resolve, 25));
  assert(fs.existsSync(receipt), "Private worker must actually start before testing cleanup.");
  const { namespace } = JSON.parse(fs.readFileSync(receipt));
  child.kill("SIGTERM");
  const exit = await Promise.race([closed, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(Error("Owned launcher did not stop")), 5000); timer.unref();
  })]);
  assert.equal(exit.code, 143);
  const matches = [];
  for (const pid of fs.readdirSync("/proc").filter(p => /^\d+$/.test(p))) {
    try { if (fs.readlinkSync(`/proc/${pid}/ns/pid`) === namespace) matches.push(pid); } catch {}
  }
  assert.deepEqual(matches, []);
});

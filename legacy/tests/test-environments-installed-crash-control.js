const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), { randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const { awaitInstalledCrash } = require("../scripts/environments-installed-crash-control.cjs");
function fixture(t) {
  const root = path.resolve("tests", `.conda-crash-control-${randomUUID()}`);
  fs.mkdirSync(path.join(root, "u"), { recursive: true, mode: 0o700 });
  const children = [];
  t.after(() => { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    fs.rmSync(root, { recursive: true, force: true }); });
  return { root, children };
}
test("crash controller refuses a completed journey without the observed crash boundary", async t => {
  const { root } = fixture(t);
  await assert.rejects(awaitInstalledCrash(Promise.resolve(), { root, editor: process.execPath,
    userDataArgument: `--user-data-dir=${root}/u` }), /before crash evidence/);
});
test("crash controller reaps only the exact owned process after real child SIGKILL (controller unit, not installed Code)", async t => {
  const { root, children } = fixture(t), argument = `--user-data-dir=${root}/u`;
  const main = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)", "--", argument], { cwd: root, stdio: "ignore" });
  const host = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { cwd: root, stdio: "ignore" });
  children.push(main, host);
  const run = new Promise(resolve => main.once("exit", resolve));
  const exited = new Promise(resolve => host.once("exit", resolve));
  const backup = path.join(root, "private-backup.json"); fs.writeFileSync(backup, "{}");
  const control = awaitInstalledCrash(run, { root, editor: process.execPath, userDataArgument: argument });
  host.kill("SIGKILL"); await exited;
  fs.writeFileSync(path.join(root, "conda-crash-observed.json"), JSON.stringify({
    hostPid: host.pid, sourceAbsent: true, catalogUncommitted: true, signalRequested: "SIGKILL", backupReceipt: backup,
  }));
  await control;
  const result = JSON.parse(fs.readFileSync(path.join(root, "conda-installed-crash-controller.json")));
  assert.equal(result.actualHostGone, true);
  assert.deepEqual(result.stoppedOwnedProcesses.map(item => item.pid), [main.pid]);
  assert.equal(result.restartAfterOldWindowAndBrokerStopped, true);
});

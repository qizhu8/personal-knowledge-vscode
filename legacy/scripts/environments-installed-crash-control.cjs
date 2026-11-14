"use strict";
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function alive(pid) {
  try { return !/^\d+ \(.*\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8")); }
  catch (error) { if (error.code === "ENOENT" || error.code === "ESRCH") return false; throw error; }
}
exports.awaitInstalledCrash = async (run, { root, editor, userDataArgument }) => {
  let settled = false, result;
  run.then(value => { settled = true; result = { success: true, value }; },
    error => { settled = true; result = { success: false, error: String(error) }; });
  const marker = path.join(root, "conda-crash-observed.json"), deadline = Date.now() + 240000;
  while (!fs.existsSync(marker)) {
    if (settled) throw new Error(`Installed journey exited before crash evidence: ${JSON.stringify(result)}`);
    if (Date.now() > deadline) throw new Error("Actual installed conda crash boundary was never reached.");
    await delay(50);
  }
  const observed = JSON.parse(fs.readFileSync(marker));
  assert(observed.sourceAbsent && observed.catalogUncommitted && observed.signalRequested === "SIGKILL");
  assert(Number.isSafeInteger(observed.hostPid) && observed.hostPid > 1);
  assert(fs.existsSync(observed.backupReceipt));
  const hostDeadline = Date.now() + 10000;
  while (alive(observed.hostPid)) {
    if (Date.now() > hostDeadline) throw new Error("SIGKILL-marked actual extension host is still alive.");
    await delay(25);
  }
  const owned = [];
  const userData = userDataArgument.slice("--user-data-dir=".length);
  assert.equal(fs.realpathSync(path.dirname(userData)), root);
  const extensionPrefixes = [path.join(root, "x") + path.sep, path.join(path.dirname(userData), "x") + path.sep];
  for (const name of fs.readdirSync("/proc").filter(n => /^\d+$/.test(n))) {
    const pid = Number(name); if (pid === process.pid) continue;
    try {
      const argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
      const main = argv[0] === editor && argv.includes(userDataArgument) && !argv.some(a => a.startsWith("--type="));
      const broker = argv.some(a => extensionPrefixes.some(prefix => a.startsWith(prefix))
        && a.endsWith("/next-managed-client-child.js"));
      if (main || broker) owned.push({ pid, role: main ? "owned Code main" : "owned orphan trial broker" });
    } catch (error) { if (!["ENOENT", "ESRCH", "EACCES"].includes(error.code)) throw error; }
  }
  assert(owned.some(item => item.role === "owned Code main") || settled, "Cannot safely identify the owned Code window.");
  for (const item of owned) if (alive(item.pid)) { try { process.kill(item.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; } }
  const stopDeadline = Date.now() + 10000;
  while (owned.some(item => alive(item.pid)) && Date.now() < stopDeadline) await delay(50);
  for (const item of owned) if (alive(item.pid)) { process.kill(item.pid, "SIGKILL"); item.forcedStop = true; }
  const reapDeadline = Date.now() + 10000;
  while ((!settled || owned.some(item => alive(item.pid))) && Date.now() < reapDeadline) await delay(50);
  assert(settled && owned.every(item => !alive(item.pid)), "Old owned Code/trial broker not fully stopped before restart.");
  const summary = { actualExtensionHostPid: observed.hostPid, actualHostGone: true,
    observedBoundary: observed, stoppedOwnedProcesses: owned, installedTestExit: result,
    restartAfterOldWindowAndBrokerStopped: true,
    scope: "exact private namespace Code/trial-broker cleanup; not global process exclusion" };
  fs.writeFileSync(path.join(root, "conda-installed-crash-controller.json"), JSON.stringify(summary, null, 2));
};

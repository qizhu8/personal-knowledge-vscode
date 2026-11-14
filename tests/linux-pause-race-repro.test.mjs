import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const file = fileURLToPath(import.meta.url), mode = process.argv[2], directory = process.argv[3];

if (mode === "--legacy-guardian") {
  const anchor = spawn(process.execPath, [file, "--legacy-anchor", directory], {
    detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  process.on("message", () => {
    process.kill(-anchor.pid, "SIGSTOP");
    process.send("between-stop-and-continue");
  });
} else if (mode === "--legacy-anchor") {
  process.on("disconnect", () => {
    process.kill(-process.pid, "SIGTERM");
    process.kill(-process.pid, "SIGCONT");
    setTimeout(() => process.kill(-process.pid, "SIGKILL"), 100);
  });
  spawn(process.execPath, [file, "--tree", directory, "0"], { stdio: "ignore" });
} else if (mode === "--tree") {
  const depth = Number(process.argv[4]);
  writeFileSync(join(directory, `pid-${depth}`), String(process.pid));
  if (depth < 2) spawn(process.execPath, [file, "--tree", directory, String(depth + 1)], { stdio: "ignore" });
  setInterval(() => appendFileSync(join(directory, `tick-${depth}`), "x"), 20);
} else if (mode === "--isolated") {
  const root = directory;
    const watchdog = setTimeout(() => process.exit(1), 8000);
    const guardian = spawn(process.execPath, [file, "--legacy-guardian", root], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const deadline = Date.now() + 5000;
    while (![0, 1, 2].every(n => existsSync(join(root, `tick-${n}`)))) {
      if (Date.now() >= deadline) throw new Error("Old process tree did not start.");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const pids = [0, 1, 2].map(n => Number(readFileSync(join(root, `pid-${n}`), "utf8")));
    const between = once(guardian, "message");
    guardian.send("pause");
    assert.equal((await between)[0], "between-stop-and-continue");
    assert.equal(guardian.kill("SIGKILL"), true);
    await once(guardian, "exit");
    await new Promise(resolve => setTimeout(resolve, 80));
    const before = [0, 1, 2].map(n => readFileSync(join(root, `tick-${n}`)).length);
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.deepEqual([0, 1, 2].map(n => readFileSync(join(root, `tick-${n}`)).length), before);
    for (const pid of pids) assert.equal(readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /, "")[0], "T");
    clearTimeout(watchdog);
    process.stdout.write("REPRODUCED\n");
} else {
  test("old STOP/CONT transition strands the actual process group if guardian dies between signals", {
    skip: process.platform !== "linux", timeout: 15000,
  }, async t => {
    const root = resolve("tests", `.pause-race-${randomUUID()}`);
    mkdirSync(root, { mode: 0o700 });
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const isolated = spawn("unshare", ["-Urnmpf", "--mount-proc", process.execPath, file, "--isolated", root],
      { stdio: ["ignore", "pipe", "pipe"] });
    t.after(() => { if (isolated.exitCode === null && isolated.signalCode === null) isolated.kill("SIGKILL"); });
    let stdout = "", stderr = "";
    isolated.stdout.on("data", chunk => { stdout += chunk; });
    isolated.stderr.on("data", chunk => { stderr += chunk; });
    const [code] = await once(isolated, "close");
    assert.equal(code, 0, stderr);
    assert.match(stdout, /REPRODUCED/);
  });
}

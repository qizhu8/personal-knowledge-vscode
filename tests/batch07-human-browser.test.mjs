import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { cliFixture, until } from "./batch07-cli-fixtures.mjs";
import { chatTurnInput } from "./chat-turn-fixtures.mjs";

test("actual Chromium native human modal uses separate one-use authentication and real CLI Chat approvals", { timeout: 45000 }, async t => {
  const f = await cliFixture(t), cli = await f.launch(["--human-review", "browser"]);
  const enrollment = await until(() => cli.diagnostics.find(value => value.humanEnrollment));
  const child = spawn(process.env.PYTHON ?? "python", [resolve(import.meta.dirname, "batch07-human-browser.py")],
    { env: { ...process.env, TMPDIR: f.root }, stdio: ["pipe", "pipe", "pipe"] });
  let output = "", diagnostics = "";
  child.stdout.on("data", bytes => { output += bytes; });
  child.stderr.on("data", bytes => { diagnostics += bytes; });
  const closed = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  const deadline = setTimeout(() => child.kill("SIGTERM"), 35000);
  t.after(async () => {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await closed;
  });
  child.stdin.end(JSON.stringify({ url: cli.url, root: f.root, token: f.token, code: enrollment.humanEnrollment,
    workspaceId: f.identity.id, turns: ["approve", "reject", "cancel"].map(decision => chatTurnInput({
      messages: [{ role: "user", content: `browser-${decision}` }], deadlineMs: 15000,
    })) }) + "\n");
  assert.equal(await closed, 0, diagnostics);
  clearTimeout(deadline);
  assert.match(output, /"nativeModal": true/);
  const screenshot = resolve(f.root, "native-human-modal.png");
  const bytes = await readFile(screenshot);
  assert.equal(bytes.readUInt32BE(0), 0x89504e47);
  assert(bytes.length > 10000);
  if (process.env.PKM_BATCH07_INSPECT === "1")
    await copyFile(screenshot, resolve(import.meta.dirname, ".batch07-native-review-inspect.png"));
});

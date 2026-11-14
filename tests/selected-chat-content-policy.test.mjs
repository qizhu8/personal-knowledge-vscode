import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { LegacyApiChatProcesses } from "../dist/legacy-api-chat-process.js";
import { createLegacyChatProcessApprovalBridge } from "../dist/legacy-api-chat-process-approval.js";
import { createSelectedChatProfilePolicy } from "../dist/selected-chat-profile-policy.js";

function fixture(t, setup) {
  const dir = resolve("tests", `.content-policy-${randomUUID()}`);
  const source = join(dir, "source"), cwd = join(dir, "cwd"), capture = join(dir, "capture");
  for (const path of [source, cwd, capture]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const config = setup({ dir, cwd });
  const chatId = randomUUID(), prompts = [];
  let mode = "ask", allowed = true, swaps = 0;
  const selected = { workspaceId: "workspace", actorId: "local:owner", assertCurrent() {} };
  const profile = createSelectedChatProfilePolicy({ selected, connection: new AbortController().signal,
    profile: { id: "fixture", workspaceId: "workspace", actorId: "local:owner", sourceRoot: source,
      assertCurrent() {}, async policy(binding) {
        return { available: binding.chatId === chatId, trusted: true, permissionMode: mode, localControls: true };
      }, async remember() {} },
    archive: { root: source, assertNoWriters() {} },
    commands: [{ id: "only", program: config.program, cwd, arguments: [config.args] }] });
  const command = profile.commands[0];
  const authorize = createLegacyChatProcessApprovalBridge({ assertOwner: () => profile.assertProfile(),
    policy: profile.policy, async requestPermission(prompt) { prompts.push(prompt); return allowed; },
    async confirmLocalStop() { return false; } });
  const database = new DatabaseSync(join(dir, "process.sqlite"));
  const processes = new LegacyApiChatProcesses({ database, captureDirectory: capture, root: source,
    workspaceId: "workspace", actorId: "local:owner", sourceFingerprint: "fixture", assertOwner: profile.assertProfile,
    commands: [{ ...command, openLaunch(args) {
      const descriptors = command.openLaunch(args);
      if (config.attack) { config.attack(); swaps++; }
      return descriptors;
    } }], authorize });
  t.after(async () => { await processes.close(); database.close(); rmSync(dir, { recursive: true, force: true }); });
  const scope = { root: source, workspaceId: "workspace", actorId: "local:owner", sourceFingerprint: "fixture",
    namespace: "0123456789abcdef", chatId };
  return { processes, scope, prompts, config, cwd, swaps: () => swaps,
    setMode(value) { mode = value; }, setAllowed(value) { allowed = value; } };
}
function attacker(code, ...args) {
  const child = spawnSync(process.execPath, ["-e", code, ...args]);
  assert.equal(child.status, 0, child.stderr.toString());
}

for (const kind of ["in-place-executable", "script-argument", "shebang-interpreter"]) test(
  `approved command does not freeze ${kind} content`, { skip: process.platform !== "linux", timeout: 15000 }, async t => {
    let originalIdentity;
    const f = fixture(t, ({ dir }) => {
      const program = join(dir, "program"), script = join(dir, "script.js"), interpreter = join(dir, "interpreter");
      if (kind === "in-place-executable") {
        writeFileSync(program, "#!/bin/sh\nprintf original\n", { mode: 0o700 });
        originalIdentity = statSync(program);
        return { program, args: [], attack() {
          attacker("require('fs').writeFileSync(process.argv[1], '#!/bin/sh\\nprintf modified\\n')", program);
          const current = statSync(program);
          assert.equal(current.ino, originalIdentity.ino);
          assert.equal(current.dev, originalIdentity.dev);
        } };
      }
      if (kind === "script-argument") {
        writeFileSync(script, "process.stdout.write('original')\n");
        return { program: process.execPath, args: [script], attack() {
          attacker("require('fs').writeFileSync(process.argv[1], \"process.stdout.write('modified')\\n\")", script);
        } };
      }
      const replacement = join(dir, "replacement");
      writeFileSync(interpreter, "#!/bin/sh\nprintf original\n", { mode: 0o700 });
      writeFileSync(replacement, "#!/bin/sh\nprintf modified\n", { mode: 0o700 });
      writeFileSync(program, `#!${interpreter}\nignored\n`, { mode: 0o700 });
      return { program, args: [], attack() {
        attacker("require('fs').renameSync(process.argv[1],process.argv[2])", replacement, interpreter);
      } };
    });
    const input = { program: f.config.program, arguments: f.config.args, cwd: f.cwd, timeoutSeconds: 8 };
    f.setAllowed(false);
    await assert.rejects(f.processes.run(f.scope, input, new AbortController().signal), /denied/);
    assert.equal(f.swaps(), 0);
    f.setAllowed(true);
    const result = await f.processes.run(f.scope, input, new AbortController().signal);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "modified");
    assert.equal(f.swaps(), 1);
    assert.match(f.prompts[1].detail, /not a content digest.*interpreters, scripts and dependencies can change/);
    assert.equal(f.prompts[1].binding.chatId, f.scope.chatId);
  });

test("descriptor permission failure is visible for foreground and background without weakening approval", {
  skip: process.platform !== "linux" || process.getuid?.() === 0, timeout: 15000,
}, async t => {
  const f = fixture(t, ({ dir }) => {
    const program = join(dir, "execute-only");
    writeFileSync(program, "#!/bin/sh\nprintf should-not-start\n", { mode: 0o111 });
    return { program, args: [] };
  });
  const input = { program: f.config.program, arguments: [], cwd: f.cwd, timeoutSeconds: 5 };
  f.setMode("read-only");
  await assert.rejects(f.processes.run(f.scope, input, new AbortController().signal), /denied/);
  assert.equal(f.prompts.length, 0);
  f.setMode("ask");
  await assert.rejects(f.processes.run(f.scope, input, new AbortController().signal), /did not start.*readable executable/s);
  assert.equal(f.prompts.length, 1);
  const background = await f.processes.run(f.scope, { ...input, background: true, idempotency_key: randomUUID() }, new AbortController().signal);
  let status = background;
  for (let n = 0; n < 100 && status.state === "launching"; n++) {
    await new Promise(resolve => setTimeout(resolve, 10));
    status = await f.processes.control(f.scope, background.handle, "status");
  }
  assert.equal(status.state, "failed");
  assert.match(status.detail, /did not start.*readable executable/s);
  assert.equal(f.prompts.at(-1).once, true);
});

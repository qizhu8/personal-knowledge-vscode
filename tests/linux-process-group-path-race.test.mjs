import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeSync, constants, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { LinuxProcessGroup } from "../dist/linux-process-group.js";
import { LegacyApiChatProcesses } from "../dist/legacy-api-chat-process.js";
import { createLegacyChatProcessApprovalBridge } from "../dist/legacy-api-chat-process-approval.js";
import { createSelectedChatProfilePolicy } from "../dist/selected-chat-profile-policy.js";

test("unpinned legacy-style group follows an executable replaced after admission", { skip: process.platform !== "linux", timeout: 10000 }, async t => {
  const dir = resolve("tests", `.group-path-race-${randomUUID()}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const program = join(dir, "program"), replacement = join(dir, "replacement");
  writeFileSync(program, "#!/bin/sh\nprintf approved\n", { mode: 0o700 });
  writeFileSync(replacement, "#!/bin/sh\nprintf replaced\n", { mode: 0o700 });
  const group = new LinuxProcessGroup({ executable: program, args: [], cwd: dir, env: {}, stdin: false, graceMs: 200 });
  let output = "";
  group.child.stdout.on("data", bytes => { output += bytes; });
  const attacker = spawnSync(process.execPath, ["-e", "require('fs').renameSync(process.argv[1],process.argv[2])", replacement, program]);
  assert.equal(attacker.status, 0, attacker.stderr.toString());
  const result = await group.done;
  assert.equal(result.code, 0);
  assert.equal(output, "replaced");
});

test("approved selected Chat retains opened executable and cwd across a real pathname replacement", { skip: process.platform !== "linux", timeout: 10000 }, async t => {
  const dir = resolve("tests", `.selected-path-race-${randomUUID()}`);
  const source = join(dir, "source"), cwd = join(dir, "cwd"), capture = join(dir, "capture");
  const program = join(dir, "program"), replacement = join(dir, "replacement");
  for (const path of [source, cwd, capture]) mkdirSync(path, { recursive: true, mode: 0o700 });
  writeFileSync(join(cwd, "location"), "original\n");
  writeFileSync(program, "#!/bin/sh\nread x < location\nprintf 'approved:%s' \"$x\"\n", { mode: 0o700 });
  writeFileSync(replacement, "#!/bin/sh\nprintf replaced\n", { mode: 0o700 });
  const selected = { workspaceId: "workspace", actorId: "local:owner", assertCurrent() {} };
  const policy = createSelectedChatProfilePolicy({ selected, connection: new AbortController().signal,
    profile: { id: "fixture", workspaceId: "workspace", actorId: "local:owner", sourceRoot: source,
      assertCurrent() {}, async policy() { return { available: true, trusted: true, permissionMode: "ask", localControls: true }; },
      async remember() {} },
    archive: { root: source, assertNoWriters() {} },
    commands: [{ id: "only", program, cwd, arguments: [[]] }] });
  let approvals = 0, swaps = 0, allow = false;
  const database = new DatabaseSync(join(dir, "process.sqlite"));
  const command = policy.commands[0];
  const authorize = createLegacyChatProcessApprovalBridge({ assertOwner: () => policy.assertProfile(),
    policy: policy.policy, async requestPermission() { approvals++; return allow; }, async confirmLocalStop() { return false; } });
  const processes = new LegacyApiChatProcesses({ database, captureDirectory: capture, root: source,
    workspaceId: "workspace", actorId: "local:owner", sourceFingerprint: "fixture", assertOwner: policy.assertProfile,
    commands: [{ ...command, openLaunch(args) {
      const descriptors = command.openLaunch(args);
      assert.equal(approvals, 2);
      const attacker = spawnSync(process.execPath, ["-e", `
        const fs = require("node:fs"), p = require("node:path");
        fs.renameSync(process.argv[1], process.argv[2]);
        fs.renameSync(process.argv[3], process.argv[3] + ".original");
        fs.mkdirSync(process.argv[3]); fs.writeFileSync(p.join(process.argv[3], "location"), "replacement\\n");
      `, replacement, program, cwd]);
      assert.equal(attacker.status, 0, attacker.stderr.toString());
      swaps++;
      return descriptors;
    } }], authorize });
  t.after(async () => { await processes.close(); database.close(); rmSync(dir, { recursive: true, force: true }); });
  const scope = { root: source, workspaceId: "workspace", actorId: "local:owner", sourceFingerprint: "fixture",
    namespace: "0123456789abcdef", chatId: randomUUID() };
  const input = { program, arguments: [], cwd, timeoutSeconds: 5 };
  await assert.rejects(processes.run(scope, input, new AbortController().signal), /denied/);
  assert.equal(approvals, 1);
  assert.equal(swaps, 0);
  allow = true;
  const result = await processes.run(scope, input, new AbortController().signal);
  assert.equal(approvals, 2);
  assert.equal(swaps, 1);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "approved:original");
});

test("open descriptors do not freeze an executable inode against in-place modification", { skip: process.platform !== "linux", timeout: 10000 }, async t => {
  const dir = resolve("tests", `.mutable-fd-race-${randomUUID()}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const program = join(dir, "program");
  writeFileSync(program, "#!/bin/sh\nprintf approved\n", { mode: 0o700 });
  const executable = openSync(program, constants.O_RDONLY | constants.O_NOFOLLOW);
  const cwd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const attacker = spawnSync(process.execPath, ["-e", "require('fs').writeFileSync(process.argv[1], '#!/bin/sh\\nprintf modified\\n')", program]);
  assert.equal(attacker.status, 0, attacker.stderr.toString());
  let group;
  try { group = new LinuxProcessGroup({ executable: program, args: [], cwd: dir, env: {}, stdin: false,
    graceMs: 200, descriptors: { executable, cwd } }); }
  finally { closeSync(executable); closeSync(cwd); }
  let output = "";
  group.child.stdout.on("data", bytes => { output += bytes; });
  assert.equal((await group.done).code, 0);
  assert.equal(output, "modified");
});

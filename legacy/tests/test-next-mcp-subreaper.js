"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");

const python = process.env.PKM_TEST_LEGACY_PYTHON;
const wrapper = path.resolve("resources/next_mcp_subreaper.py");
const exit = child => new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", (code, signal) => resolve({ code, signal }));
});

test("private subreaper waits for an orphaned detached descendant before successful exit",
  { skip: process.platform !== "linux" || !python, timeout: 10000 }, async () => {
    const root = path.resolve(".migration-test-work", `next-reaper-${randomUUID()}`);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const marker = path.join(root, "descendant-finished");
    const grandchild = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "done"), 400)`;
    const script = `const c=require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(grandchild)}],{detached:true,stdio:"ignore"});c.unref();`;
    const start = Date.now();
    const child = spawn(python, ["-B", wrapper, process.execPath, "-e", script], { cwd: root, stdio: "ignore" });
    assert.deepEqual(await exit(child), { code: 0, signal: null });
    assert(Date.now() - start >= 300);
    assert.equal(fs.readFileSync(marker, "utf8"), "done");
  });

test("private subreaper times out without claiming a still-running descendant exited",
  { skip: process.platform !== "linux" || !python, timeout: 12000 }, async () => {
    const root = path.resolve(".migration-test-work", `next-reaper-timeout-${randomUUID()}`);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const marker = path.join(root, "descendant-finished");
    const grandchild = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "done"), 6000)`;
    const script = `const c=require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(grandchild)}],{detached:true,stdio:"ignore"});c.unref();`;
    const child = spawn(python, ["-B", wrapper, process.execPath, "-e", script], { cwd: root, stdio: "ignore" });
    assert.deepEqual(await exit(child), { code: 125, signal: null });
    assert.equal(fs.existsSync(marker), false);
    for (let i = 0; i < 250 && !fs.existsSync(marker); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(fs.readFileSync(marker, "utf8"), "done");
  });

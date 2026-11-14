"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { acquirePrivateNextMcpLease } = require(path.join(
  process.env.PKM_TEST_DIST || path.resolve("dist"), "runtime/next-mcp-private-lease"));

test("private lease blocks a second or abandoned owner until verified release", () => {
  const parent = path.resolve(".migration-test-work", `next-owner-lease-${randomUUID()}`);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const lease = acquirePrivateNextMcpLease(parent);
  assert.throws(() => acquirePrivateNextMcpLease(parent), error => error.code === "EEXIST");
  lease.release();
  const successor = acquirePrivateNextMcpLease(parent);
  successor.release();
});

test("changed private lease is preserved and blocks a successor", () => {
  const parent = path.resolve(".migration-test-work", `next-owner-lease-changed-${randomUUID()}`);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const lease = acquirePrivateNextMcpLease(parent);
  const directory = path.join(parent, ".pkm-private-next-mcp-owner");
  fs.writeFileSync(path.join(directory, "owner.json"), "changed");
  assert.throws(() => lease.release(), /changed/);
  assert.throws(() => acquirePrivateNextMcpLease(parent), error => error.code === "EEXIST");
  assert.equal(fs.readFileSync(path.join(directory, "owner.json"), "utf8"), "changed");
});

test("an owner process exit leaves its lease blocking automatic takeover", () => {
  const parent = path.resolve(".migration-test-work", `next-owner-lease-crash-${randomUUID()}`);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const modulePath = path.join(process.env.PKM_TEST_DIST || path.resolve("dist"), "runtime/next-mcp-private-lease");
  const child = spawnSync(process.execPath, ["-e", "require(process.argv[1]).acquirePrivateNextMcpLease(process.argv[2])",
    modulePath, parent], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.throws(() => acquirePrivateNextMcpLease(parent), error => error.code === "EEXIST");
  assert(fs.existsSync(path.join(parent, ".pkm-private-next-mcp-owner", "owner.json")));
});

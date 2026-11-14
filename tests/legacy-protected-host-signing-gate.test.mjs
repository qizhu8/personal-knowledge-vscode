import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, lstat, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
import { test } from "node:test";
import ts from "typescript";

test("host signer refuses non-fixture and mismatched fixture gates", { skip: process.platform !== "linux" }, async t => {
  const root = resolve(".migration-test-work", `pkm-protected-state-fixture-${randomUUID()}`);
  const source = readFileSync(new URL("../legacy/src/runtime/next-protected-subscription-signing-fixture.ts", import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} }, require = createRequire(import.meta.url);
  runInThisContext(`(function(require,module,exports){${code}\n})`)(
    name => name === "../subscriptions/subscriptions" ? {} : require(name), module, module.exports);
  const sign = module.exports.signProtectedSubscriptionFixture;
  const oldFixture = process.env.PKM_PRIVATE_SUBSCRIPTION_STATE_IMPORT;
  const oldSigning = process.env.PKM_PRIVATE_SUBSCRIPTION_SIGNING;
  t.after(async () => {
    if (oldFixture === undefined) delete process.env.PKM_PRIVATE_SUBSCRIPTION_STATE_IMPORT;
    else process.env.PKM_PRIVATE_SUBSCRIPTION_STATE_IMPORT = oldFixture;
    if (oldSigning === undefined) delete process.env.PKM_PRIVATE_SUBSCRIPTION_SIGNING;
    else process.env.PKM_PRIVATE_SUBSCRIPTION_SIGNING = oldSigning;
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const name of ["original", "profile", "imported"]) await mkdir(join(root, name), { mode: 0o700 });
  const sourcePin = await lstat(join(root, "original"), { bigint: true });
  const profilePin = await lstat(join(root, "profile"), { bigint: true });
  const nonce = randomUUID();
  await writeFile(join(root, "subscription-state-fixture.json"), JSON.stringify({
    schema: "pkm.protected-subscription-state-fixture/v1", nonce,
    rootPin: `${sourcePin.dev}:${sourcePin.ino}`, profilePin: `${profilePin.dev}:${profilePin.ino}`,
  }), { mode: 0o600 });
  const invoke = (fixture = root, n = nonce, share = "fixture-share") => sign(fixture, n, share, "fixture-secret", {});
  delete process.env.PKM_PRIVATE_SUBSCRIPTION_SIGNING;
  process.env.PKM_PRIVATE_SUBSCRIPTION_STATE_IMPORT = root;
  assert.throws(() => invoke(), /signing denied/);
  process.env.PKM_PRIVATE_SUBSCRIPTION_SIGNING = "1";
  assert.throws(() => invoke(resolve("production")), /signing denied/);
  assert.throws(() => invoke(root, randomUUID()), /signing denied/);
  assert.throws(() => invoke(root, nonce, "../invalid"), /signing denied/);
  assert.throws(() => invoke(), /signing denied/);
  await writeFile(join(root, "subscription-state-fixture.json"), "not-json");
  assert.throws(() => invoke(), error => error.message === "Private Subscription signing denied.");
});

test("remote transfer adapter rejects ordinary and mismatched profiles", { skip: process.platform !== "linux" }, async t => {
  const root = resolve(".migration-test-work", `pkm-protected-state-fixture-${randomUUID()}`);
  const source = readFileSync(new URL("../legacy/src/runtime/next-protected-remote-subscription-fixture.ts", import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} }, require = createRequire(import.meta.url);
  runInThisContext(`(function(require,module,exports){${code}\n})`)(
    name => name === "../subscriptions/subscriptions" ? { MAX_SUBSCRIPTION_CACHE_BYTES: 512 * 1024 * 1024 } : require(name),
    module, module.exports);
  const oldFixture = process.env.PKM_PRIVATE_SUBSCRIPTION_STATE_IMPORT;
  const oldRemote = process.env.PKM_PRIVATE_SUBSCRIPTION_REMOTE;
  t.after(async () => {
    if (oldFixture === undefined) delete process.env.PKM_PRIVATE_SUBSCRIPTION_STATE_IMPORT;
    else process.env.PKM_PRIVATE_SUBSCRIPTION_STATE_IMPORT = oldFixture;
    if (oldRemote === undefined) delete process.env.PKM_PRIVATE_SUBSCRIPTION_REMOTE;
    else process.env.PKM_PRIVATE_SUBSCRIPTION_REMOTE = oldRemote;
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, "profile"), { recursive: true, mode: 0o700 });
  const install = module.exports.installRemoteSubscriptionFixtureTransport;
  const manager = { storageDir: join(root, "profile"), downloadSnapshot() {} };
  delete process.env.PKM_PRIVATE_SUBSCRIPTION_REMOTE;
  process.env.PKM_PRIVATE_SUBSCRIPTION_STATE_IMPORT = root;
  assert.throws(() => install(manager, root), /transport denied/);
  process.env.PKM_PRIVATE_SUBSCRIPTION_REMOTE = "1";
  assert.throws(() => install(manager, resolve("production")), /transport denied/);
  assert.throws(() => install({ ...manager, storageDir: root }, root), /transport denied/);
});

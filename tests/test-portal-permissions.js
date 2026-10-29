const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");

const sourcePath = path.join(__dirname, "../src/chatroom/portal-permissions.ts");
const source = fs.readFileSync(sourcePath, "utf8");

function loadModule() {
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: sourcePath,
  });
  const mod = new Module(sourcePath);
  mod.filename = sourcePath;
  mod._compile(outputText, sourcePath);
  return mod.exports;
}

const P = loadModule();
const MIN = 60 * 1000;

function fixture() {
  const clock = { t: 1_000_000 };
  const perms = new P.PortalPermissions({ chatId: "chat-1", connectionId: "conn-1", now: () => clock.t });
  return { clock, perms };
}

test("exposes the ten independent dimensions and constants", () => {
  assert.deepEqual([...P.PORTAL_PERMISSION_DIMENSIONS], [
    "chat-read", "progress-read", "files-read", "files-write", "code-execute",
    "pkm-read", "pkm-write", "git-read", "git-write", "environment-manage",
  ]);
  assert.equal(P.PORTAL_PERMISSION_DEFAULT_DURATION_MS, 15 * MIN);
  assert.equal(P.PORTAL_PERMISSION_DIMENSIONS.includes("file-transfer"), false);
});

test("no permission is held by default and dimensions are independent", () => {
  const { perms } = fixture();
  for (const p of P.PORTAL_PERMISSION_DIMENSIONS) assert.equal(perms.allows(p), false);
  perms.grant({ mode: "scoped", permissions: ["files-read"] });
  assert.equal(perms.allows("files-read"), true);
  assert.equal(perms.allows("files-write"), false);
  assert.equal(perms.allows("code-execute"), false);
});

test("default fixed expiry is 15 minutes and use never renews", () => {
  const { clock, perms } = fixture();
  const g = perms.grant({ mode: "scoped", permissions: ["chat-read"] });
  assert.equal(g.lifecycle, "fixed");
  assert.equal(g.expiresAt, clock.t + 15 * MIN);
  clock.t += 14 * MIN;
  assert.equal(perms.allows("chat-read"), true);
  clock.t += MIN - 1;
  assert.equal(perms.allows("chat-read"), true);
  clock.t += 1;
  assert.equal(perms.allows("chat-read"), false);
  assert.equal(perms.snapshot().grants.length, 0);
});

test("custom longer duration is accepted and flagged for UI warning; invalid durations rejected", () => {
  const { clock, perms } = fixture();
  assert.equal(P.portalPermissionDurationNeedsWarning(60 * MIN), true);
  assert.equal(P.portalPermissionDurationNeedsWarning(null), true);
  assert.equal(P.portalPermissionDurationNeedsWarning(5 * MIN), false);
  assert.equal(P.portalPermissionDurationNeedsWarning(undefined), false);
  const g = perms.grant({ mode: "scoped", permissions: ["pkm-read"], durationMs: 60 * MIN });
  assert.equal(g.expiresAt, clock.t + 60 * MIN);
  clock.t += 59 * MIN;
  assert.equal(perms.allows("pkm-read"), true);
  clock.t += MIN;
  assert.equal(perms.allows("pkm-read"), false);
  const week = perms.grant({ mode: "scoped", permissions: ["git-read"], durationMs: 7 * 24 * 60 * MIN });
  assert.equal(week.expiresAt, clock.t + 7 * 24 * 60 * MIN);
  const max = P.PORTAL_PERMISSION_MAX_EXPIRY_EPOCH_MS - clock.t;
  assert.equal(perms.grant({ mode: "scoped", permissions: ["git-read"], durationMs: max }).expiresAt, P.PORTAL_PERMISSION_MAX_EXPIRY_EPOCH_MS);
  assert.throws(() => perms.grant({ mode: "scoped", permissions: ["git-read"], durationMs: max + 1 }), /overflow/);
  assert.throws(() => perms.grant({ mode: "scoped", permissions: ["git-read"], durationMs: Number.MAX_SAFE_INTEGER }), /overflow/);
  for (const durationMs of [0, -1, 1.5, Infinity, NaN, "10", Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => perms.grant({ mode: "scoped", permissions: ["pkm-read"], durationMs }), /positive safe integer/);
  }
});

test("until-disconnected lasts until disconnect and disconnect is terminal", () => {
  const { clock, perms } = fixture();
  const g = perms.grant({ mode: "scoped", permissions: ["git-read"], durationMs: null });
  assert.equal(g.lifecycle, "until-disconnected");
  assert.equal(g.expiresAt, null);
  clock.t += 7 * 24 * 60 * MIN;
  assert.equal(perms.allows("git-read"), true);
  perms.invalidate("disconnect");
  assert.equal(perms.allows("git-read"), false);
  assert.equal(perms.isClosed, true);
  assert.throws(() => perms.grant({ mode: "scoped", permissions: ["git-read"] }), /disconnected/);
  assert.equal(perms.snapshot().lastInvalidation.reason, "disconnect");
});

test("revoke/root/trust/role changes invalidate all leases but allow re-grant", () => {
  for (const reason of ["revoke", "root-change", "trust-change", "role-change"]) {
    const { perms } = fixture();
    perms.grant({ mode: "all", durationMs: null });
    perms.consentFileTransferBatch({ batchId: "b", direction: "to-controller", files: ["/r/a"] });
    perms.invalidate(reason);
    for (const p of P.PORTAL_PERMISSION_DIMENSIONS) assert.equal(perms.allows(p), false, `${reason} ${p}`);
    assert.equal(perms.consumeFileTransferBatch({ batchId: "b", direction: "to-controller", files: ["/r/a"] }), false);
    assert.deepEqual(perms.snapshot().pendingFileTransferBatches, []);
    perms.grant({ mode: "scoped", permissions: ["chat-read"] });
    assert.equal(perms.allows("chat-read"), true);
  }
  const { perms } = fixture();
  assert.throws(() => perms.invalidate("whatever"));
});

test("once grants are consumed per permission; remembered leases preferred", () => {
  const { perms } = fixture();
  perms.grant({ mode: "once", permissions: ["files-write", "git-write"] });
  assert.equal(perms.allows("files-write"), true);
  assert.equal(perms.allows("files-write"), false);
  assert.equal(perms.snapshot().grants[0].remaining.join(), "git-write");
  assert.equal(perms.allows("git-write"), true);
  assert.equal(perms.snapshot().grants.length, 0);

  perms.grant({ mode: "once", permissions: ["pkm-write"] });
  perms.grant({ mode: "scoped", permissions: ["pkm-write"] });
  assert.equal(perms.allows("pkm-write"), true);
  assert.equal(perms.snapshot().grants.find((g) => g.mode === "once").remaining.join(), "pkm-write");
});

test("allow-all covers every dimension but never file-transfer", () => {
  const { perms } = fixture();
  perms.grant({ mode: "all", durationMs: null });
  for (const p of P.PORTAL_PERMISSION_DIMENSIONS) assert.equal(perms.allows(p), true);
  assert.equal(perms.allows("file-transfer"), false);
  assert.equal(perms.allows(P.PORTAL_FILE_TRANSFER_OPERATION, "/repo/a.txt"), false);
  assert.equal(perms.consumeFileTransferBatch({ batchId: "x", direction: "to-controller", files: ["/repo/a.txt"] }), false);
  assert.ok(Object.values(perms.snapshot().effective).every(Boolean));
  assert.equal("file-transfer" in perms.snapshot().effective, false);
});

test("file-transfer and unknown dimensions cannot be granted or allowed", () => {
  const { perms } = fixture();
  assert.throws(() => perms.grant({ mode: "scoped", permissions: ["file-transfer"] }), /per-batch/);
  assert.throws(() => perms.grant({ mode: "all", permissions: ["file-transfer"] }), /per-batch/);
  assert.throws(() => perms.grant({ mode: "scoped", permissions: ["shell"] }), /Unknown/);
  assert.throws(() => perms.grant({ mode: "scoped", permissions: [] }));
  assert.throws(() => perms.grant({ mode: "forever", permissions: ["chat-read"] }), /mode/);
  assert.throws(() => perms.grant({ mode: "scoped", permissions: ["files-read"], scopes: { "files-write": ["/r"] } }));
  assert.throws(() => perms.grant({ mode: "scoped", permissions: ["files-read"], scopes: { "file-transfer": ["/r"] } }));
  perms.grant({ mode: "all" });
  for (const op of ["shell", "admin", "", "__proto__", "constructor", undefined, null, 42]) {
    assert.equal(perms.allows(op), false);
  }
});

test("per-batch file-transfer consent is explicit, exact and single-use", () => {
  const { clock, perms } = fixture();
  const batch = { batchId: "b1", direction: "to-controller", files: ["/repo/a.txt", "/repo/b.txt"] };
  perms.consentFileTransferBatch(batch);
  assert.throws(() => perms.consentFileTransferBatch(batch), /already/);
  assert.equal(perms.consumeFileTransferBatch({ ...batch, files: ["/repo/b.txt", "/repo/a.txt"] }), true);
  assert.equal(perms.consumeFileTransferBatch(batch), false);

  perms.consentFileTransferBatch({ ...batch, batchId: "b2" });
  assert.equal(perms.consumeFileTransferBatch({ ...batch, batchId: "b2", files: ["/repo/a.txt", "/repo/c.txt"] }), false);
  assert.equal(perms.consumeFileTransferBatch({ ...batch, batchId: "b2" }), false, "mismatch consumed consent");

  perms.consentFileTransferBatch({ ...batch, batchId: "b3" });
  assert.equal(perms.consumeFileTransferBatch({ ...batch, batchId: "b3", direction: "to-controlled" }), false);

  perms.consentFileTransferBatch({ ...batch, batchId: "b4" });
  clock.t += P.PORTAL_FILE_TRANSFER_CONSENT_TTL_MS;
  assert.equal(perms.consumeFileTransferBatch({ ...batch, batchId: "b4" }), false);

  assert.throws(() => perms.consentFileTransferBatch({ batchId: "b5", direction: "to-controller", files: [] }));
  assert.throws(() => perms.consentFileTransferBatch({ batchId: "b5", direction: "to-controller", files: ["/r/../etc"] }));
});

test("scoped resource prefixes are bounded and boundary-safe", () => {
  const { perms } = fixture();
  perms.grant({
    mode: "scoped",
    permissions: ["files-read", "pkm-read", "chat-read"],
    scopes: { "files-read": ["/repo/src", "C:\\work\\proj\\"], "pkm-read": ["pkm:notes/"] },
  });
  assert.equal(perms.allows("files-read", "/repo/src"), true);
  assert.equal(perms.allows("files-read", "/repo/src/a/b.ts"), true);
  assert.equal(perms.allows("files-read", "/repo//src///x.ts"), true);
  assert.equal(perms.allows("files-read", "/repo/srcevil/x.ts"), false);
  assert.equal(perms.allows("files-read", "/repo/src/../secret"), false);
  assert.equal(perms.allows("files-read", "/repo"), false);
  assert.equal(perms.allows("files-read"), false, "scoped permission needs a resource");
  assert.equal(perms.allows("files-read", "C:\\work\\proj\\a.txt"), true);
  assert.equal(perms.allows("files-read", "C:/work/project/a.txt"), false);
  assert.equal(perms.allows("pkm-read", "pkm:notes/x"), true);
  assert.equal(perms.allows("pkm-read", "pkm:papers/x"), false);
  assert.equal(perms.allows("chat-read"), true, "unscoped permission needs no resource");
  assert.equal(perms.allows("chat-read", "/../x"), false, "invalid resource always denied");

  assert.throws(() => perms.grant({ mode: "scoped", permissions: ["files-read"], scopes: { "files-read": ["/"] } }), /unbounded/);
  assert.throws(() => perms.grant({ mode: "scoped", permissions: ["files-read"], scopes: { "files-read": ["/a/../b"] } }));
  assert.throws(() => perms.grant({ mode: "scoped", permissions: ["files-read"], scopes: { "files-read": [] } }));
  const many = Array.from({ length: P.PORTAL_PERMISSION_MAX_SCOPES_PER_PERMISSION + 1 }, (_, i) => `/r/${i}`);
  assert.throws(() => perms.grant({ mode: "scoped", permissions: ["files-read"], scopes: { "files-read": many } }));
});

test("snapshot is plain data, connection-scoped, and mutation-safe", () => {
  const { perms } = fixture();
  perms.grant({ mode: "scoped", permissions: ["progress-read"], scopes: { "progress-read": ["run:1"] } });
  const snap = perms.snapshot();
  assert.equal(snap.chatId, "chat-1");
  assert.equal(snap.connectionId, "conn-1");
  assert.equal(snap.effective["progress-read"], true);
  assert.equal(snap.effective["files-read"], false);
  assert.deepEqual(JSON.parse(JSON.stringify(snap)), snap);
  snap.grants[0].permissions.push("code-execute");
  snap.grants[0].scopes["progress-read"].push("run:2");
  assert.equal(perms.allows("code-execute"), false);
  assert.equal(perms.allows("progress-read", "run:2"), false);
  assert.ok(perms.revokeGrant(snap.grants[0].id));
  assert.equal(perms.allows("progress-read", "run:1"), false);
  assert.throws(() => new P.PortalPermissions({ chatId: "", connectionId: "c" }));
});

test("leases are memory-only: no disk I/O and no restore API", () => {
  assert.doesNotMatch(source, /require\(|from\s+["'](node:)?(fs|path|os|vscode)/);
  assert.equal(typeof P.PortalPermissions.fromSnapshot, "undefined");
  assert.equal(typeof P.PortalPermissions.prototype.restore, "undefined");
  const { perms } = fixture();
  perms.grant({ mode: "all", durationMs: null });
  const fresh = new P.PortalPermissions({ chatId: "chat-1", connectionId: "conn-1", now: () => 0 });
  assert.equal(fresh.allows("chat-read"), false);
});

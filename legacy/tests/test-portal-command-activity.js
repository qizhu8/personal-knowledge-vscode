const { test } = require("node:test");
const assert = require("node:assert/strict");
const { recordPortalCommand, validPortalCommandRecords, PORTAL_COMMAND_RECORD_LIMIT } = require("../dist/chat/portal-command-activity");
const { recordPortalTransfer, validPortalTransferRecords, PORTAL_TRANSFER_RECORD_LIMIT } = require("../dist/chat/portal-transfer-activity");

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const command = { program: "python.exe", arguments: ["-c", "print(1)"], timeoutSeconds: 60 };
const activity = (n, state, extra = {}) => ({ requestId: id(n), role: "controlled", peerName: "yuwang8@host", command, state, ...extra });

test("Portal file trace upserts progress, bounds history and preserves final receipts", () => {
  const file = { name: "extension.vsix", size: 100, sha256: "a".repeat(64) };
  const status = { transferId: id(1), direction: "incoming", state: "awaiting-approval", bytes: 0, totalBytes: 100, files: [file] };
  const started = new Date("2026-01-01T00:00:00Z");
  let records = recordPortalTransfer(undefined, status, "peer", started);
  records = recordPortalTransfer(records, { ...status, state: "transferring", bytes: 50 }, "peer");
  assert.equal(records.length, 1);
  assert.equal(records[0].bytes, 50);
  records = recordPortalTransfer(records, { ...status, state: "completed", bytes: 100, verifiedFiles: [file], savedPaths: ["/received/extension.vsix"] }, "peer");
  records = recordPortalTransfer(records, status, "peer");
  assert.equal(records[0].state, "completed");
  assert.equal(records[0].startedAt, started.toISOString());
  assert(validPortalTransferRecords(records));
  assert(!validPortalTransferRecords([{ ...records[0], bytes: 101 }]));
  assert(!validPortalTransferRecords([records[0], records[0]]));
  assert(!validPortalTransferRecords([{ ...records[0], state: "unrecognized" }]));
  for (let n = 2; n <= 55; n++) records = recordPortalTransfer(records, { ...status, transferId: id(n) }, "peer");
  assert.equal(records.length, PORTAL_TRANSFER_RECORD_LIMIT);
  assert(validPortalTransferRecords(records));
});

test("Portal command trace upserts by request, keeps output tails and never downgrades a finished command", () => {
  let records = recordPortalCommand(undefined, activity(1, "awaiting-approval"), new Date("2026-01-01T00:00:00Z"));
  records = recordPortalCommand(records, activity(1, "running"), new Date("2026-01-01T00:00:01Z"));
  records = recordPortalCommand(records, activity(1, "failed", { result: { exitCode: 1, stdout: "x".repeat(5000) + "END", stderr: "boom", detail: "EPERM" } }), new Date("2026-01-01T00:00:02Z"));
  records = recordPortalCommand(records, activity(1, "running"), new Date("2026-01-01T00:00:03Z"));
  assert.equal(records.length, 1);
  const [record] = records;
  assert.equal(record.state, "failed");
  assert.equal(record.exitCode, 1);
  assert.equal(record.startedAt, "2026-01-01T00:00:00.000Z");
  assert.match(record.stdout, /END$/);
  assert(record.stdout.length <= 2001 && record.truncated);
  assert.equal(record.stderr, "boom");
  assert.equal(record.detail, "EPERM");
  assert(validPortalCommandRecords(records));
});

test("Portal command trace is bounded and invalid persisted records are rejected", () => {
  let records;
  for (let n = 0; n < PORTAL_COMMAND_RECORD_LIMIT + 5; n++) records = recordPortalCommand(records, activity(n, "completed", { result: { exitCode: 0 } }));
  assert.equal(records.length, PORTAL_COMMAND_RECORD_LIMIT);
  assert.equal(records[0].requestId, id(5));
  assert(validPortalCommandRecords(records));
  assert(!validPortalCommandRecords([{ ...records[0], state: "bogus" }]));
  assert(!validPortalCommandRecords([records[0], records[0]]));
  assert(!validPortalCommandRecords([{ ...records[0], stdout: "x".repeat(10_000) }]));
});

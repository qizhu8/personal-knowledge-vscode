import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

test("Next rejects even a completed Environment refresh record without an adoption protocol", async t => {
  const dist = process.env.PKM_TEST_NEXT_DIST;
  assert.ok(dist, "PKM_TEST_NEXT_DIST must select an isolated Next build");
  const { inspectLegacyManagedWriterSession } = await import(pathToFileURL(join(dist, "legacy-managed-writer-session.js")));
  const root = resolve(".migration-test-work", `next-environment-session-${randomUUID()}`);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const old = randomUUID(), current = randomUUID(), operation = randomUUID();
  const base = join(root, ".pkm/state/managed-writer-session"), archive = join(base, `operations.${old}`);
  mkdirSync(archive, { recursive: true, mode: 0o700 });
  mkdirSync(join(base, "operations"), { mode: 0o700 });
  const schema = "pkm.managed-writer-session/v1";
  const write = (name, value) => writeFileSync(name, JSON.stringify(value), { mode: 0o600 });
  write(join(base, "session.json"), { schema, id: current });
  write(join(base, "fenced"), { schema, sessionId: current });
  write(join(base, `rotation.${old}.json`), { schema, previousSessionId: old, nextSessionId: current });
  const operationRecords = kind => {
    for (const phase of ["pending", "complete"])
      write(join(archive, `${operation}.${phase}`), { schema, sessionId: old, operationId: operation, kind, phase });
  };
  operationRecords("environment-refresh");
  assert.throws(() => inspectLegacyManagedWriterSession(root), { code: "PKM_STATE_UNSUPPORTED" });
  operationRecords("github-sync");
  assert.equal(inspectLegacyManagedWriterSession(root).sessionId, current);
  const confirmation = join(base, `confirmed.${operation}.json`);
  write(confirmation, { schema: "pkm.managed-profile-confirmation/v1", sessionId: old, operationId: operation });
  assert.throws(() => inspectLegacyManagedWriterSession(root), { code: "PKM_STATE_UNSUPPORTED" });
  rmSync(confirmation);
});

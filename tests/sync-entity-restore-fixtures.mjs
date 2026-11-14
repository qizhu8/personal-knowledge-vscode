import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { syncPlanHash } from "../dist/sync-plan.js";

export const restoreActor = { id: "native:sync-entity-owner", canWrite: true };
export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const file = (member, bytes) => ({
  type: "skills", itemId: "synthetic-restore", category: "", privacy: "public", member,
  path: `skills/synthetic-restore/${member}`, digest: sha256(bytes), contentBase64: bytes.toString("base64"),
});
const snapshot = files => {
  const manifest = {
    schema: 3, capabilities: { storage: "pkm.github.publication/v1", required: ["explicit-deletions", "stable-entity-identity"] },
    files, deletions: [],
  };
  return { manifest, sha256: syncPlanHash(manifest) };
};
export function restoreFixture(options = {}) {
  const bytes = [
    Buffer.from("\uFEFF# Synthetic restore\r\nExact remote body.\r\n"),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0xff, 0x13]),
    Buffer.from("# Dependency\nExact remote reference.\n"),
  ];
  const remote = [
    file("SKILL.md", bytes[0]),
    file("SKILL.assets/preview.png", bytes[1]),
    file("references/dependency.md", bytes[2]),
  ];
  const base = structuredClone(remote);
  base[0] = file("SKILL.md", Buffer.from("# Previous body\n"));
  const local = options.partial ? [structuredClone(remote[1])] : [];
  if (options.previousLocal) local.push(file("SKILL.md", Buffer.from("\uFEFF# Local body\r\n")));
  if (options.missingMember) remote.pop();
  if (options.missingBytes) delete remote[1].contentBase64;
  if (options.invalidDependency) remote[2] = file("references/dependency.md", Buffer.from([0xff]));
  const input = { base: snapshot(base), local: snapshot(local), remote: snapshot(remote) };
  return { input, remote, base, local, bytes, sessionId: randomUUID() };
}
export function writeLocal(root, fixture) {
  for (const entry of fixture.local) {
    const destination = join(root, entry.path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, Buffer.from(entry.contentBase64, "base64"));
  }
}
export function decideRemote(store, db, fixture) {
  const session = store.create({
    sessionId: fixture.sessionId, operationId: randomUUID(), actorId: restoreActor.id, input: fixture.input,
  });
  db.prepare("INSERT INTO sync_plan_owners VALUES (?, ?)").run(fixture.sessionId, restoreActor.id);
  store.decide({
    sessionId: fixture.sessionId, operationId: randomUUID(), actorId: restoreActor.id,
    expectedRevision: session.revision, conflictId: session.plan.conflicts[0].id,
    choice: "remote", reason: "Restore the entire pinned entity and its dependencies.",
  });
  return { sessionId: fixture.sessionId, actorId: restoreActor.id, input: fixture.input };
}

"use strict";
const fs = require("node:fs"), path = require("node:path"), { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const sha = value => createHash("sha256").update(value).digest("hex");
exports.sourceIdentity = database => {
  const stat = fs.statSync(database, { bigint: true });
  return Object.fromEntries(["dev", "ino", "mode", "uid", "gid", "size", "mtimeNs", "ctimeNs"]
    .map(key => [key, String(stat[key])]));
};

exports.create = async ({ extension, profileStorage, root, chatId }) => {
  const { MemoryEngineClient } = require(path.join(extension, "dist/memory/memory-engine-client.js"));
  const { ExplicitMemoryService } = require(path.join(extension, "dist/memory/explicit-memory-service.js"));
  const { repositoryMemoryScope } = require(path.join(extension, "dist/capabilities/memory-contract.js"));
  const database = path.join(profileStorage, "memory", `${sha(fs.realpathSync(root)).slice(0, 24)}.sqlite3`);
  fs.mkdirSync(path.dirname(database), { recursive: true, mode: 0o700 });
  const python = execFileSync("python3", ["-I", "-B", "-c", "import os,sys; print(os.path.realpath(sys.executable))"],
    { encoding: "utf8" }).trim();
  const client = new MemoryEngineClient({ python, extensionRoot: extension, database, identity: `pkm-chat:${root}` });
  const sources = [{ id: "synthetic-old-memory-evidence", chat: chatId, revision: "synthetic-original-v1",
    locator: "synthetic-source/original-memory-fixture" }];
  const scope = repositoryMemoryScope(root);
  const authorize = async request => ({ decisionId: `synthetic-original-${request.operationId}`, actorId: "user:synthetic-original" });
  const service = new ExplicitMemoryService(client, scope, authorize);
  let original, pending, foreign;
  try {
    original = await service.propose({ content: "SATURN original confirmed convention: use amber envelopes.", sources },
      { operationId: "synthetic-old-memory-propose" });
    original = await service.confirm(original.id, original.revision, { operationId: "synthetic-old-memory-confirm" });
    pending = await service.propose({ content: "SATURN_PENDING_SECRET never active recall.", sources },
      { operationId: "synthetic-old-memory-pending" });
    const other = new ExplicitMemoryService(client, { account: "synthetic-foreign", project: "foreign", repository: "foreign" }, authorize);
    foreign = await other.propose({ content: "SATURN_FOREIGN_SECRET must not cross scope.", sources },
      { operationId: "synthetic-foreign-memory" });
    foreign = await other.confirm(foreign.id, foreign.revision, { operationId: "synthetic-foreign-confirm" });
  } finally { await client.close(); }
  execFileSync(python, ["-I", "-B", "-c",
    "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); r=c.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone(); assert r[0]==0,r; c.close()", database]);
  fs.chmodSync(database, 0o600);
  for (const suffix of ["-wal", "-shm"]) if (fs.existsSync(database + suffix)) throw Error("Original Memory Engine is not checkpointed/closed.");
  return { database, sourceSha256: sha(fs.readFileSync(database)), sourceIdentity: exports.sourceIdentity(database),
    original, pendingId: pending.id, foreignId: foreign.id, scope };
};

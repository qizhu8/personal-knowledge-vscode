import { openSync, writeFileSync, fsyncSync, closeSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { encodeMarkdown, sha256 } from "../dist/markdown.js";
import { Storage } from "../dist/storage.js";

// These are harness boundaries, not hooks in the production storage worker.
const [root, point, operationId] = process.argv.slice(2);
const id = "fault-document", actorId = "test:fault-owner";
const args = { id, operationId, title: "Fault fixture", content: "synthetic recovery body" };
const request = { operation: "knowledge.document.create", actorId, args };
const raw = encodeMarkdown(id, args.title, args.content, 1, false);
writeSync(1, `${sha256(raw)}\n`);
const stop = name => { if (point === name) process.exit(86); };
const db = new DatabaseSync(join(root, "core.sqlite"));
db.exec("BEGIN IMMEDIATE");
db.prepare("INSERT INTO pending_write(singleton,operation_id,fingerprint,actor_id,operation,document_id,before_sha256,after_markdown) VALUES(1,?,?,?,?,?,?,?)")
  .run(operationId, sha256(JSON.stringify(request)), actorId, request.operation, id, null, raw);
stop("dbcommit");
db.exec("COMMIT");
db.close();
stop("write");
const staged = join(root, "notes", `.pkm-write-${operationId}`);
const fd = openSync(staged, "wx", 0o600);
writeFileSync(fd, raw);
stop("fsync");
fsyncSync(fd);
closeSync(fd);
stop("rename");
renameSync(staged, join(root, "notes", `${id}.md`));
const storage = await Storage.open(root);
await storage.request(request);
await storage.close();
stop("receipt-close");
throw new Error(`Unknown fault point ${point}`);

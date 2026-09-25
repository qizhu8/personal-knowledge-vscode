import * as fs from "fs";
import * as path from "path";
import { createDecipheriv, createHash, randomBytes } from "crypto";

interface MaterializeTask {
  inputPath: string;
  storageDir: string;
  record: {
    id: string;
    alias: string;
    priority: "normal" | "high" | "highest";
    publisher: string;
    nodeId: string;
    shareId: string;
    endpoint: string;
  };
  summary: {
    name: string;
    revision: number;
    collectionHash: string;
    secretProtected?: boolean;
    [key: string]: unknown;
  };
  syncedAt: string;
  transferKey?: string;
  contentKey?: string;
}

function hash(value: Buffer | string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function atomicWrite(filePath: string, content: string | Buffer, mode?: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, content, mode ? { mode } : undefined);
  fs.renameSync(temporary, filePath);
}

function safeRelativePath(...parts: unknown[]): string {
  const cleaned = parts.flatMap(part => String(part || "").replace(/\\/g, "/").split("/"))
    .map(part => part.trim().replace(/[<>:"|?*\u0000-\u001f]/g, "-")).filter(part => part && part !== "." && part !== "..");
  return cleaned.length ? cleaned.join("/") : "untitled";
}

function decryptTransfer(bytes: Buffer<ArrayBufferLike>, keyValue: string): Buffer<ArrayBufferLike> {
  if (bytes.length < 36 || bytes.subarray(0, 8).toString("ascii") !== "PKMENC1\n") {
    throw new Error("Secret Protected Broker returned an invalid encrypted transfer.");
  }
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(keyValue, "base64url"), bytes.subarray(8, 20));
  decipher.setAuthTag(bytes.subarray(bytes.length - 16));
  return Buffer.concat([decipher.update(bytes.subarray(20, bytes.length - 16)), decipher.final()]);
}

function decryptSnapshot(envelope: Buffer<ArrayBufferLike>, keyValue: string): Buffer<ArrayBufferLike> {
  const parsed = JSON.parse(envelope.toString("utf8"));
  if (parsed?.v !== 1 || parsed?.alg !== "A256GCM") throw new Error("Encrypted Sync snapshot format is invalid.");
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(keyValue, "base64url"), Buffer.from(parsed.iv, "base64url"));
  decipher.setAuthTag(Buffer.from(parsed.tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(parsed.ciphertext, "base64url")), decipher.final()]);
}

function materialize(task: MaterializeTask): number {
  let bytes: Buffer<ArrayBufferLike> = fs.readFileSync(task.inputPath);
  if (task.summary.secretProtected) {
    if (!task.transferKey || !task.contentKey) throw new Error("Secret Protected Broker keys are missing.");
    bytes = decryptTransfer(bytes, task.transferKey);
  }
  if (hash(bytes) !== task.summary.collectionHash) throw new Error("Background Sync checksum mismatch.");
  if (task.summary.secretProtected) bytes = decryptSnapshot(bytes, task.contentKey!);
  const bundle = JSON.parse(bytes.toString("utf8"));
  const parent = path.join(task.storageDir, "cache", task.record.nodeId);
  const destination = path.join(parent, task.record.shareId);
  const staging = path.join(parent, `.${task.record.shareId}.${randomBytes(5).toString("hex")}.staging`);
  fs.mkdirSync(staging, { recursive: true });
  const writeCached = (type: string, remotePath: string, content: string): void => {
    const relative = safeRelativePath("content", type, remotePath);
    const target = path.join(staging, ...relative.split("/"));
    atomicWrite(target, content, 0o600);
    atomicWrite(`${target}.pkm-source.json`, JSON.stringify({
      schema: 1,
      subscriptionId: task.record.id,
      subscriptionAlias: task.record.alias,
      brokerName: task.summary.name,
      publisher: task.record.publisher,
      nodeId: task.record.nodeId,
      shareId: task.record.shareId,
      remotePath,
      type,
      revision: task.summary.revision,
      contentHash: hash(content),
      syncedAt: task.syncedAt,
    }, null, 2), 0o600);
  };
  for (const skill of bundle.skills || []) writeCached("skills", `${skill.metadata?.category ? `${skill.metadata.category}/` : ""}${skill.name}.md`, String(skill.content || ""));
  for (const note of bundle.notes || []) writeCached("notes", `${note.slug || note.title || "note"}.md`, String(note.content || ""));
  for (const paper of bundle.papers || []) writeCached("papers", `${paper.category ? `${paper.category}/` : ""}${paper.slug || paper.title || "paper"}.md`, String(paper.content || ""));
  for (const prompt of bundle.prompts || []) writeCached("prompts", `${prompt.project}/${prompt.task}/${prompt.version}/${prompt.file}`, String(prompt.content || ""));
  for (const script of bundle.scripts || []) writeCached("scripts", `${script.category === "(root)" ? "" : `${script.category}/`}${script.file}`, String(script.content || ""));
  for (const pkg of bundle.packages || []) for (const file of pkg.files || []) writeCached("packages", `${pkg.name}/${file.path}`, String(file.content || ""));
  for (const server of bundle.servers || []) writeCached("servers", `${server.slug}/server.link.json`, JSON.stringify({ name: server.name, category: server.category, tags: server.tags, url: server.url || "" }, null, 2));
  for (const recipe of bundle.recipes || []) writeCached("recipes", `${recipe.category ? `${recipe.category}/` : ""}${recipe.recipeId}.json`, JSON.stringify(recipe, null, 2));
  atomicWrite(path.join(staging, "bundle.json"), bytes, 0o600);
  atomicWrite(path.join(staging, "summary.json"), JSON.stringify(task.summary, null, 2), 0o600);
  atomicWrite(path.join(staging, "_subscription.json"), JSON.stringify({
    schema: 1,
    subscriptionId: task.record.id,
    alias: task.record.alias,
    priority: task.record.priority,
    brokerName: task.summary.name,
    publisher: task.record.publisher,
    nodeId: task.record.nodeId,
    shareId: task.record.shareId,
    endpoint: task.record.endpoint,
    revision: task.summary.revision,
    collectionHash: task.summary.collectionHash,
    syncedAt: task.syncedAt,
    physicalIsolation: "VS Code globalStorage; outside Knowledge Root",
  }, null, 2), 0o600);
  const backup = `${destination}.previous`;
  fs.rmSync(backup, { recursive: true, force: true });
  if (fs.existsSync(destination)) fs.renameSync(destination, backup);
  try {
    fs.renameSync(staging, destination);
    fs.rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (!fs.existsSync(destination) && fs.existsSync(backup)) fs.renameSync(backup, destination);
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return bytes.length;
}

process.once("message", (task: MaterializeTask) => {
  try {
    const snapshotBytes = materialize(task);
    process.send?.({ ok: true, snapshotBytes });
  } catch (error) {
    process.send?.({ ok: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    try { fs.rmSync(task.inputPath, { force: true }); } catch { /* parent also cleans up */ }
    process.disconnect?.();
  }
});

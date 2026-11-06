import { Worker } from "node:worker_threads";
import { mkdir, readFile, readdir, writeFile, lstat, realpath } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { CoreError, type StorageRequest } from "./contracts.js";

const marker = ".pkm-next-workspace";
export async function initialize(directory: string) {
  const root = resolve(directory);
  await mkdir(root, { mode: 0o700 });
  await writeFile(join(root, marker), JSON.stringify({ schema: "pkm.next-workspace/v1", id: randomUUID() }), { flag: "wx", mode: 0o600 });
  return root;
}
export async function validateWorkspace(directory: string) {
  const root = resolve(directory);
  if ((await lstat(root)).isSymbolicLink()) throw new CoreError("INVALID_WORKSPACE", "Workspace symlinks are not supported.");
  const entries = await readdir(root);
  const allowed = new Set([marker, "core.sqlite", "core.sqlite-wal", "core.sqlite-shm"]);
  if (entries.some(name => !allowed.has(name))) throw new CoreError("INVALID_WORKSPACE", "Not an isolated next-server workspace. Legacy data directories must not be used.");
  for (const name of entries) if (!(await lstat(join(root, name))).isFile()) throw new CoreError("INVALID_WORKSPACE", "Workspace entries must be regular files.");
  const identity: unknown = JSON.parse(await readFile(join(root, marker), "utf8"));
  if (!identity || typeof identity !== "object" || !("schema" in identity) || identity.schema !== "pkm.next-workspace/v1") throw new CoreError("INVALID_WORKSPACE", "Initialize a new isolated workspace first.");
  return realpath(root);
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };
export class Storage {
  private readonly pending = new Map<number, Pending>();
  private sequence = 0;
  private closed = false;
  private drain: (() => void) | undefined;
  private closing: Promise<void> | undefined;
  private worker: Worker;
  private constructor(root: string) {
    this.worker = new Worker(new URL("./storage-worker.js", import.meta.url), { workerData: root });
  }
  static async open(directory: string) {
    const store = new Storage(await validateWorkspace(directory));
    await new Promise<void>((resolve, reject) => {
      store.worker.once("error", reject);
      store.worker.once("exit", code => reject(new CoreError("STORAGE_UNAVAILABLE", `Storage exited before ready (${code}).`)));
      store.worker.on("message", message => {
        if (message.ready) { resolve(); return; }
        const pending = store.pending.get(message.id);
        if (!pending) return;
        store.pending.delete(message.id);
        if (message.error) pending.reject(new CoreError(message.error.code, message.error.message, message.error.effect));
        else pending.resolve(message.result);
        if (!store.pending.size) store.drain?.();
      });
      store.worker.on("exit", code => {
        store.closed = true;
        for (const pending of store.pending.values()) pending.reject(new CoreError("STORAGE_UNAVAILABLE", `Storage worker exited (${code}); reconcile pending writes.`, "unknown"));
        store.pending.clear();
        store.drain?.();
      });
    });
    store.worker.on("error", error => {
      console.error("PKM next storage worker:", error);
    });
    return store;
  }
  request(request: StorageRequest): Promise<unknown> {
    if (this.closed) return Promise.reject(new CoreError("STORAGE_UNAVAILABLE", "Storage is closed."));
    if (this.pending.size >= 32) return Promise.reject(new CoreError("BUSY", "Storage queue is full; request was not dispatched."));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      this.pending.set(id, { resolve, reject });
      try { this.worker.postMessage({ id, request }); }
      catch (error) {
        this.pending.delete(id);
        console.error("PKM next storage dispatch:", error);
        reject(new CoreError("STORAGE_UNAVAILABLE", "Could not dispatch the request to storage."));
      }
    });
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      if (this.pending.size) await new Promise<void>(resolve => { this.drain = resolve; });
      await this.worker.terminate();
    })();
    return this.closing;
  }
}

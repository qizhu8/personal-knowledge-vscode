import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { withCrossProcessLockSync } from "../runtime/cross-process-lock";

const schema = "pkm.markdown-migration-fence/v1";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const directory = (root: string) => path.join(root, ".pkm", "state", "markdown-migration-fence");
const lock = (root: string) => path.join(root, ".pkm", "state", "markdown-assets.lock");

function syncDirectory(dir: string): void {
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function createDurable(file: string, value: string): void {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, value); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  syncDirectory(path.dirname(file));
}

function present(file: string): boolean {
  try { fs.lstatSync(file); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function completed(dir: string): void {
  const operations = path.join(dir, "operations");
  const stat = fs.lstatSync(operations);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Markdown migration operations are invalid; recovery required.");
  const entries = fs.readdirSync(operations);
  const ids = new Set<string>();
  for (const entry of entries) {
    const match = /^([a-f0-9-]{36})\.(pending|complete)$/.exec(entry);
    if (!match || !uuid.test(match[1])) throw new Error("Markdown migration operation is invalid; recovery required.");
    ids.add(match[1]);
  }
  for (const id of ids) {
    for (const suffix of ["pending", "complete"]) {
      const file = path.join(operations, `${id}.${suffix}`);
      if (!present(file)) throw new Error("Markdown write outcome is unknown; explicit recovery required.");
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > 1024) throw new Error("Markdown migration operation is invalid; recovery required.");
        const value = JSON.parse(fs.readFileSync(fd, "utf8"));
        if (value?.schema !== schema || value?.writerId !== id || value?.phase !== suffix)
          throw new Error("Markdown migration operation is invalid; recovery required.");
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
    }
  }
  syncDirectory(operations);
}

function state(root: string): { dir: string; operationId: string } | undefined {
  const dir = directory(root);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(dir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Markdown migration control is invalid; recovery required.");
  const file = path.join(dir, "tracking.json");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let record: unknown;
  try { record = JSON.parse(fs.readFileSync(fd, "utf8")); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (!record || typeof record !== "object" || Array.isArray(record)
    || (record as { schema?: unknown }).schema !== schema
    || typeof (record as { operationId?: unknown }).operationId !== "string"
    || !uuid.test((record as { operationId: string }).operationId)) {
    throw new Error("Markdown migration control is invalid; recovery required.");
  }
  syncDirectory(dir);
  return { dir, operationId: (record as { operationId: string }).operationId };
}

export function markdownMigrationTrackingActive(root: string): boolean {
  return state(root) !== undefined;
}

/** Call only while holding markdown-assets.lock. Unknown outcomes remain durable. */
export function withTrackedMarkdownMutation<T>(root: string, action: () => T): T {
  const control = state(root);
  if (!control) return action();
  const { dir } = control;
  if (present(path.join(dir, "fenced"))) throw new Error("Markdown writes are fenced for migration.");
  completed(dir);
  const writerId = randomUUID();
  const operations = path.join(dir, "operations");
  createDurable(path.join(operations, `${writerId}.pending`), JSON.stringify({ schema, writerId, phase: "pending" }));
  const result = action();
  if (result !== null && (typeof result === "object" || typeof result === "function")
    && typeof (result as { then?: unknown }).then === "function") {
    throw new Error("Asynchronous Markdown mutations cannot be tracked; outcome is unknown.");
  }
  createDurable(path.join(operations, `${writerId}.complete`), JSON.stringify({ schema, writerId, phase: "complete" }));
  return result;
}

/** Linux-only internal preparation; it is not evidence that other writers are stopped. */
export function beginMarkdownMigrationTracking(root: string, operationId: string): void {
  if (process.platform !== "linux" || !uuid.test(operationId))
    throw new Error("Markdown migration tracking requires Linux and a valid operation ID.");
  withCrossProcessLockSync(lock(root), "Markdown migration preparation", () => {
    const dir = directory(root);
    fs.mkdirSync(dir, { mode: 0o700 });
    syncDirectory(path.dirname(dir));
    fs.mkdirSync(path.join(dir, "operations"), { mode: 0o700 });
    syncDirectory(dir);
    createDurable(path.join(dir, "tracking.json"), JSON.stringify({ schema, operationId }));
  }, { timeoutMs: 30_000, rejectAbandoned: true });
}

/** Waits for this lock's admitted writes only; never authorizes a production cutover. */
export function fenceTrackedMarkdownWrites(root: string, operationId: string): void {
  if (process.platform !== "linux") throw new Error("Markdown migration fence is Linux-only.");
  withCrossProcessLockSync(lock(root), "Markdown migration drain", () => {
    const control = state(root);
    if (!control) throw new Error("Markdown migration tracking is not prepared.");
    const { dir } = control;
    if (control.operationId !== operationId) throw new Error("Markdown migration operation does not match.");
    completed(dir);
    const marker = path.join(dir, "fenced");
    if (present(marker)) {
      const fd = fs.openSync(marker, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      let existing: unknown;
      try { existing = JSON.parse(fs.readFileSync(fd, "utf8")); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      if (!existing || typeof existing !== "object" || Array.isArray(existing)
        || (existing as { schema?: unknown }).schema !== schema
        || (existing as { operationId?: unknown }).operationId !== operationId) {
        throw new Error("Markdown migration fence is invalid; recovery required.");
      }
      syncDirectory(dir);
      return;
    }
    createDurable(marker, JSON.stringify({ schema, operationId }));
  }, { timeoutMs: 30_000, rejectAbandoned: true });
}

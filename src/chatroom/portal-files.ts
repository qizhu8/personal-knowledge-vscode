/**
 * Portal file transfer engine (transport neutral).
 *
 * Parent integration:
 *  - Create one `PortalFiles` per Portal pairing with `send` (wraps payloads in the peer
 *    protocol), `approve` (shows an explicit, per-batch modal; never satisfy it from timed or
 *    allow-all grants), `destination` (approved directory or chooser) and `controlled`.
 *  - Outgoing: `const { transferId, done } = await files.offer(paths)`; `done` resolves with the
 *    final `PortalTransferResult` once the receiver acknowledges verified receipt.
 *  - Incoming: pass every peer payload with `kind === "portal-file"` to `files.handle(payload)`.
 *  - `files.cancel(transferId)` cancels locally and notifies the peer; `files.dispose()` cancels all.
 *  - Operations: manifest, approved, chunk, complete (sender end + receiver ack), cancel.
 *  - Every transfer has an idle timeout (`timeoutMs`, default 10 min) covering pending approval,
 *    destination choice and stalled transfer; on expiry it is cancelled, cleaned up and the peer told.
 *  - The incoming destination's realpath + dev/ino are pinned when chosen and re-verified before
 *    temp creation, every chunk write and every finalize. This narrows but does not eliminate
 *    directory-swap races (Node has no openat/dirfd sandbox).
 *
 * Consent: the controlled side always approves locally. A controlled sender approves before any
 * manifest/bytes are published; every receiver approves the incoming manifest with a destination
 * it chose itself. A remote "approved" never substitutes for the controlled side's own approval.
 * Files are written only as inert data: nothing is executed, unpacked or installed.
 */
import { createHash, randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";

export const PORTAL_FILE_KIND = "portal-file";
export const PORTAL_CHUNK_BYTES = 18 * 1024; // 24 KiB once base64 encoded
export const PORTAL_CHUNK_BASE64 = Math.ceil(PORTAL_CHUNK_BYTES / 3) * 4;

export interface PortalFileLimits { maxFiles: number; maxFileBytes: number; maxBatchBytes: number; maxIncoming: number }
export const DEFAULT_PORTAL_FILE_LIMITS: PortalFileLimits = Object.freeze({
  maxFiles: 64, maxFileBytes: 100 * 1024 * 1024, maxBatchBytes: 100 * 1024 * 1024, maxIncoming: 4,
});

export interface PortalManifestFile { name: string; size: number; sha256: string }
export interface PortalManifest { transferId: string; files: PortalManifestFile[]; totalBytes: number }
export interface PortalPreparedFile extends PortalManifestFile { path: string; dev: number; ino: number; mtimeMs: number }
export interface PortalPreparedBatch { transferId: string; files: PortalPreparedFile[]; totalBytes: number }

export type PortalDirection = "incoming" | "outgoing";
export interface PortalApprovalRequest extends PortalManifest {
  direction: PortalDirection;
  /** Absolute local directory for incoming batches. */
  destination?: string;
  /** Absolute local source paths for outgoing batches. */
  sources?: string[];
}

export type PortalTransferState = "awaiting-approval" | "offered" | "transferring" | "completed" | "cancelled" | "failed";
export interface PortalTransferStatus {
  transferId: string; direction: PortalDirection; state: PortalTransferState;
  bytes: number; totalBytes: number; reason?: string; savedPaths?: string[];
  /** Expected batch metadata from the approved/offered manifest (never source paths). Not proof of delivery. */
  files: PortalManifestFile[];
  /**
   * Present only when state is "completed". Receiver: every file matched size+sha256 and was finalized.
   * Sender: the receiver's acknowledgement echoed metadata identical to the manifest.
   */
  verifiedFiles?: PortalManifestFile[];
}
export interface PortalTransferResult {
  transferId: string; state: "completed" | "cancelled" | "failed"; reason?: string; savedPaths?: string[];
  files: PortalManifestFile[]; verifiedFiles?: PortalManifestFile[];
}

export type PortalFilePayload =
  | { kind: typeof PORTAL_FILE_KIND; op: "manifest"; transferId: string; files: PortalManifestFile[]; totalBytes: number }
  | { kind: typeof PORTAL_FILE_KIND; op: "approved"; transferId: string }
  | { kind: typeof PORTAL_FILE_KIND; op: "chunk"; transferId: string; index: number; offset: number; data: string }
  /** Sender end-of-data has no metadata; the receiver acknowledgement carries the verified manifest metadata. */
  | { kind: typeof PORTAL_FILE_KIND; op: "complete"; transferId: string; files?: PortalManifestFile[]; totalBytes?: number }
  | { kind: typeof PORTAL_FILE_KIND; op: "cancel"; transferId: string; reason: string };

export type PortalApproveCallback = (request: PortalApprovalRequest) => Promise<boolean>;
export type PortalDestinationCallback = (manifest: PortalManifest) => string | undefined | Promise<string | undefined>;
export type PortalStatusCallback = (status: PortalTransferStatus) => void;

export const DEFAULT_PORTAL_TRANSFER_TIMEOUT_MS = 10 * 60 * 1000;

export interface PortalFilesOptions {
  send(payload: PortalFilePayload): void | Promise<void>;
  /** Must resolve exactly `true` only after an explicit per-batch user decision; anything else declines. */
  approve: PortalApproveCallback;
  /** Absolute existing directory, or a chooser per incoming manifest (undefined/"" = decline). Called before approve. */
  destination: string | PortalDestinationCallback;
  /** Whether this side is the controlled machine. A function is evaluated at each offer. */
  controlled: boolean | (() => boolean);
  limits?: Partial<PortalFileLimits>;
  /** Idle timeout per transfer, reset on progress (default 10 minutes). */
  timeoutMs?: number;
  onStatus?: PortalStatusCallback;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

function limitsOf(partial?: Partial<PortalFileLimits>): PortalFileLimits {
  const limits = { ...DEFAULT_PORTAL_FILE_LIMITS, ...(partial ?? {}) };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid Portal file limit ${key}.`);
  }
  return limits;
}

export function assertSafePortalFileName(name: unknown): string {
  if (typeof name !== "string" || !name || Buffer.byteLength(name, "utf8") > 255) throw new Error("Invalid Portal file name.");
  // eslint-disable-next-line no-control-regex
  if (name === "." || name === ".." || /[\u0000-\u001f\u007f/\\<>:"|?*]/.test(name) || /[. ]$/.test(name)
    || WINDOWS_RESERVED.test(name) || name !== name.normalize("NFC")) {
    throw new Error(`Unsafe Portal file name: ${JSON.stringify(name)}.`);
  }
  return name;
}

/** Validates an untrusted manifest against limits; returns a normalized copy. */
export function validatePortalManifest(value: unknown, partialLimits?: Partial<PortalFileLimits>): PortalManifest {
  const limits = limitsOf(partialLimits);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Portal manifest.");
  const item = value as Record<string, unknown>;
  if (typeof item.transferId !== "string" || !UUID.test(item.transferId)) throw new Error("Invalid Portal transfer id.");
  if (!Array.isArray(item.files) || item.files.length === 0 || item.files.length > limits.maxFiles) {
    throw new Error(`Portal batch must contain 1-${limits.maxFiles} files.`);
  }
  const seen = new Set<string>();
  let total = 0;
  const files = item.files.map(raw => {
    if (!raw || typeof raw !== "object") throw new Error("Invalid Portal manifest file.");
    const file = raw as Record<string, unknown>;
    const name = assertSafePortalFileName(file.name);
    const key = name.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate Portal file name: ${name}.`);
    seen.add(key);
    if (!Number.isSafeInteger(file.size) || (file.size as number) < 0 || (file.size as number) > limits.maxFileBytes) {
      throw new Error(`Portal file ${name} exceeds the ${limits.maxFileBytes} byte limit.`);
    }
    if (typeof file.sha256 !== "string" || !SHA256.test(file.sha256)) throw new Error(`Invalid sha256 for ${name}.`);
    total += file.size as number;
    return { name, size: file.size as number, sha256: file.sha256 };
  });
  if (total > limits.maxBatchBytes) throw new Error(`Portal batch exceeds the ${limits.maxBatchBytes} byte limit.`);
  if (item.totalBytes !== total) throw new Error("Portal manifest total does not match file sizes.");
  return { transferId: item.transferId, files, totalBytes: total };
}

const NOFOLLOW = (fs.constants as Record<string, number>).O_NOFOLLOW ?? 0;

async function openRegular(file: string): Promise<{ handle: fs.promises.FileHandle; stat: fs.Stats }> {
  const link = await fs.promises.lstat(file);
  if (!link.isFile()) throw new Error(`Portal source is not a regular file: ${file}.`);
  const handle = await fs.promises.open(file, fs.constants.O_RDONLY | NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.ino !== link.ino || stat.dev !== link.dev) throw new Error(`Portal source changed while opening: ${file}.`);
    return { handle, stat };
  } catch (error) { await handle.close(); throw error; }
}

/** Hashes local regular files (no symlinks/directories) into an immutable batch description. */
export async function preparePortalBatch(paths: string[], partialLimits?: Partial<PortalFileLimits>): Promise<PortalPreparedBatch> {
  const limits = limitsOf(partialLimits);
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > limits.maxFiles) throw new Error(`Select 1-${limits.maxFiles} files.`);
  const files: PortalPreparedFile[] = [];
  let total = 0;
  for (const raw of paths) {
    if (typeof raw !== "string" || !path.isAbsolute(raw)) throw new Error("Portal source paths must be absolute.");
    const source = path.resolve(raw);
    const { handle, stat } = await openRegular(source);
    try {
      if (stat.size > limits.maxFileBytes) throw new Error(`${source} exceeds the ${limits.maxFileBytes} byte limit.`);
      total += stat.size;
      if (total > limits.maxBatchBytes) throw new Error(`Portal batch exceeds the ${limits.maxBatchBytes} byte limit.`);
      const hash = createHash("sha256");
      const buffer = Buffer.alloc(64 * 1024);
      let size = 0;
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, size);
        if (!bytesRead) break;
        hash.update(buffer.subarray(0, bytesRead));
        size += bytesRead;
      }
      if (size !== stat.size) throw new Error(`Portal source changed while hashing: ${source}.`);
      files.push({ name: path.basename(source), size, sha256: hash.digest("hex"), path: source, dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs });
    } finally { await handle.close(); }
  }
  const batch = { transferId: randomUUID(), files, totalBytes: total };
  validatePortalManifest(batch, limits);
  return batch;
}

/** Re-reads an approved source and returns its bytes only if identical to the approved digest. */
async function readApproved(file: PortalPreparedFile): Promise<Buffer> {
  const { handle, stat } = await openRegular(file.path);
  try {
    if (stat.dev !== file.dev || stat.ino !== file.ino || stat.size !== file.size || stat.mtimeMs !== file.mtimeMs) {
      throw new Error(`Source changed after approval: ${file.name}.`);
    }
    const bytes = Buffer.alloc(file.size);
    let offset = 0;
    while (offset < file.size) {
      const { bytesRead } = await handle.read(bytes, offset, file.size - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== file.size || createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
      throw new Error(`Source changed after approval: ${file.name}.`);
    }
    return bytes;
  } finally { await handle.close(); }
}

interface Outgoing {
  direction: "outgoing"; batch: PortalPreparedBatch; state: PortalTransferState; bytes: number;
  sentComplete: boolean; timer?: NodeJS.Timeout; finish(result: PortalTransferResult): void;
}
interface PinnedDirectory { path: string; dev: number; ino: number }
interface IncomingFile { temp: string; target: string; fd?: number; received: number; hash: ReturnType<typeof createHash>; verified: boolean }
interface Incoming {
  direction: "incoming"; manifest: PortalManifest; state: PortalTransferState; bytes: number;
  files: IncomingFile[]; chain: Promise<void>; timer?: NodeJS.Timeout; destination?: PinnedDirectory;
}
type Session = Outgoing | Incoming;

export class PortalFiles {
  private readonly limits: PortalFileLimits;
  private readonly sessions = new Map<string, Session>();
  private readonly timeoutMs: number;

  constructor(private readonly options: PortalFilesOptions) {
    this.limits = limitsOf(options.limits);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_PORTAL_TRANSFER_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) throw new Error("Invalid Portal transfer timeout.");
    if (typeof options.send !== "function" || typeof options.approve !== "function") throw new Error("PortalFiles requires send and approve callbacks.");
  }

  /** Starts an outgoing batch. A controlled sender approves before anything is published. */
  async offer(input: string[] | PortalPreparedBatch): Promise<{ transferId: string; done: Promise<PortalTransferResult> }> {
    const batch = Array.isArray(input) ? await preparePortalBatch(input, this.limits) : input;
    validatePortalManifest(batch, this.limits);
    const manifest = { transferId: batch.transferId, files: batch.files.map(({ name, size, sha256 }) => ({ name, size, sha256 })), totalBytes: batch.totalBytes };
    if (this.sessions.has(batch.transferId)) throw new Error("Portal transfer already exists.");
    let finish!: (result: PortalTransferResult) => void;
    const done = new Promise<PortalTransferResult>(resolve => { finish = resolve; });
    const session: Outgoing = { direction: "outgoing", batch, state: "awaiting-approval", bytes: 0, sentComplete: false, finish };
    this.sessions.set(batch.transferId, session);
    this.touch(batch.transferId, session);
    if (this.isControlled()) {
      this.status(batch.transferId, session);
      let approved = false;
      try { approved = await this.options.approve({ ...manifest, files: manifest.files.map(f => ({ ...f })), direction: "outgoing", sources: batch.files.map(f => f.path) }) === true; }
      catch { approved = false; }
      if (session.state !== "awaiting-approval") return { transferId: batch.transferId, done };
      if (!approved) { this.end(batch.transferId, "cancelled", "Declined by the controlled user."); return { transferId: batch.transferId, done }; }
    }
    session.state = "offered";
    this.status(batch.transferId, session);
    try { await this.options.send({ kind: PORTAL_FILE_KIND, op: "manifest", ...manifest }); }
    catch (error) { this.end(batch.transferId, "failed", errorText(error)); }
    return { transferId: batch.transferId, done };
  }

  /** Handles one untrusted payload from the peer. Throws only for payloads without a usable transfer id. */
  async handle(payload: unknown): Promise<void> {
    if (!payload || typeof payload !== "object") throw new Error("Invalid Portal file payload.");
    const item = payload as Record<string, unknown>;
    if (item.kind !== PORTAL_FILE_KIND || typeof item.transferId !== "string" || !UUID.test(item.transferId)) throw new Error("Invalid Portal file payload.");
    const id = item.transferId;
    const session = this.sessions.get(id);
    if (item.op === "manifest") {
      if (session) return;
      return this.receiveManifest(item);
    }
    if (!session) return;
    if (item.op === "cancel") {
      return this.end(id, "cancelled", typeof item.reason === "string" ? item.reason.slice(0, 500) : "Cancelled by peer.", false);
    }
    if (session.direction === "outgoing") {
      if (item.op === "approved" && session.state === "offered") { session.state = "transferring"; this.touch(id, session); void this.pump(id, session); return; }
      if (item.op === "complete" && session.sentComplete && session.state === "transferring") {
        if (!sameFiles(item.files, manifestFiles(session.batch.files)) || item.totalBytes !== session.batch.totalBytes) {
          return this.end(id, "failed", "Receiver acknowledgement does not match the approved manifest.");
        }
        return this.end(id, "completed", undefined, false);
      }
      return this.end(id, "failed", `Unexpected Portal ${String(item.op)} for outgoing transfer.`);
    }
    const run = () => this.receive(id, session, item);
    session.chain = session.chain.then(run, run);
    return session.chain;
  }

  cancel(transferId: string, reason = "Cancelled locally."): void { this.end(transferId, "cancelled", reason); }
  dispose(): void { for (const id of [...this.sessions.keys()]) this.end(id, "cancelled", "Portal closed."); }

  private async receiveManifest(item: Record<string, unknown>): Promise<void> {
    const id = item.transferId as string;
    let manifest: PortalManifest;
    try {
      manifest = validatePortalManifest(item, this.limits);
      if ([...this.sessions.values()].filter(s => s.direction === "incoming").length >= this.limits.maxIncoming) throw new Error("Too many pending incoming Portal transfers.");
    } catch (error) { return this.sendCancel(id, errorText(error)); }
    const session: Incoming = { direction: "incoming", manifest, state: "awaiting-approval", bytes: 0, files: [], chain: Promise.resolve() };
    this.sessions.set(id, session);
    this.touch(id, session);
    this.status(id, session);
    let approved = false;
    let destination: string;
    try {
      const chosen = typeof this.options.destination === "function" ? await this.options.destination(copy(manifest)) : this.options.destination;
      if (session.state !== "awaiting-approval") return;
      if (!chosen) return this.end(id, "cancelled", "No destination chosen.");
      session.destination = pinDirectory(chosen);
      destination = session.destination.path;
      for (const file of manifest.files) {
        if (exists(path.join(destination, file.name))) throw new Error(`Destination already contains ${file.name}.`);
      }
      approved = await this.options.approve({ ...copy(manifest), direction: "incoming", destination }) === true;
    } catch (error) {
      if (session.state === "awaiting-approval") this.end(id, "failed", errorText(error));
      return;
    }
    if (session.state !== "awaiting-approval") return;
    if (!approved) return this.end(id, "cancelled", "Declined by the receiving user.");
    try {
      verifyDirectory(session.destination!);
      for (const [index, file] of manifest.files.entries()) {
        const target = path.join(destination, file.name);
        if (path.dirname(target) !== destination) throw new Error("Unsafe Portal destination path.");
        const temp = path.join(destination, `.pkm-part-${id}-${index}`);
        const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600);
        session.files.push({ temp, target, fd, received: 0, hash: createHash("sha256"), verified: false });
      }
      for (const [index, file] of manifest.files.entries()) if (file.size === 0) this.verifyFile(session, index);
      session.state = "transferring";
      this.touch(id, session);
      this.status(id, session);
      await this.options.send({ kind: PORTAL_FILE_KIND, op: "approved", transferId: id });
    } catch (error) { this.end(id, "failed", errorText(error)); }
  }

  private async receive(id: string, session: Incoming, item: Record<string, unknown>): Promise<void> {
    if (session.state !== "transferring") return;
    try {
      if (item.op === "chunk") {
        const current = session.files.findIndex(f => !f.verified);
        const { index, offset, data } = item;
        if (index !== current || current < 0) throw new Error("Portal chunk out of order.");
        const file = session.files[current];
        const expected = session.manifest.files[current];
        if (offset !== file.received) throw new Error("Portal chunk offset mismatch or duplicate.");
        if (typeof data !== "string" || !data || data.length > PORTAL_CHUNK_BASE64 || data.length % 4 || !BASE64.test(data)) throw new Error("Malformed Portal chunk.");
        const bytes = Buffer.from(data, "base64");
        if (bytes.toString("base64") !== data || bytes.length > PORTAL_CHUNK_BYTES) throw new Error("Malformed Portal chunk.");
        if (file.received + bytes.length > expected.size) throw new Error("Portal chunk exceeds approved file size.");
        verifyDirectory(session.destination!);
        let written = 0;
        while (written < bytes.length) written += fs.writeSync(file.fd!, bytes, written, bytes.length - written, file.received + written);
        file.hash.update(bytes);
        file.received += bytes.length;
        session.bytes += bytes.length;
        this.touch(id, session);
        if (file.received === expected.size) this.verifyFile(session, current);
        this.status(id, session);
        return;
      }
      if (item.op === "complete") {
        if (session.files.some(f => !f.verified)) throw new Error("Portal transfer completed before all bytes were received.");
        const saved: string[] = [];
        try {
          for (const file of session.files) {
            verifyDirectory(session.destination!);
            try { fs.linkSync(file.temp, file.target); }
            catch (error) {
              if ((error as NodeJS.ErrnoException).code === "EEXIST") throw error;
              fs.copyFileSync(file.temp, file.target, fs.constants.COPYFILE_EXCL);
            }
            saved.push(file.target);
            fs.unlinkSync(file.temp);
          }
        } catch (error) {
          if (directoryIntact(session.destination!)) for (const target of saved) { try { fs.unlinkSync(target); } catch { /* best effort */ } }
          throw error;
        }
        session.state = "completed";
        clearTimeout(session.timer);
        this.sessions.delete(id);
        this.cleanup(session);
        this.status(id, session, undefined, saved);
        await this.options.send({ kind: PORTAL_FILE_KIND, op: "complete", transferId: id, files: manifestFiles(session.manifest.files), totalBytes: session.manifest.totalBytes });
        return;
      }
      throw new Error(`Unexpected Portal ${String(item.op)} for incoming transfer.`);
    } catch (error) { this.end(id, "failed", errorText(error)); }
  }

  private isControlled(): boolean {
    const controlled = this.options.controlled;
    return typeof controlled === "function" ? controlled() === true : controlled === true;
  }

  /** (Re)arms the idle timeout for a live transfer. */
  private touch(id: string, session: Session): void {
    clearTimeout(session.timer);
    session.timer = setTimeout(() => this.end(id, "cancelled", "Portal transfer timed out."), this.timeoutMs);
    session.timer.unref?.();
  }

  private verifyFile(session: Incoming, index: number): void {
    const file = session.files[index];
    fs.fsyncSync(file.fd!);
    fs.closeSync(file.fd!);
    file.fd = undefined;
    if (file.hash.digest("hex") !== session.manifest.files[index].sha256) throw new Error(`Digest mismatch for ${session.manifest.files[index].name}.`);
    file.verified = true;
  }

  private async pump(id: string, session: Outgoing): Promise<void> {
    try {
      for (const [index, file] of session.batch.files.entries()) {
        const bytes = await readApproved(file);
        for (let offset = 0; offset < bytes.length; offset += PORTAL_CHUNK_BYTES) {
          if (session.state !== "transferring") return;
          const data = bytes.subarray(offset, offset + PORTAL_CHUNK_BYTES);
          await this.options.send({ kind: PORTAL_FILE_KIND, op: "chunk", transferId: id, index, offset, data: data.toString("base64") });
          session.bytes += data.length;
          this.touch(id, session);
          this.status(id, session);
        }
      }
      if (session.state !== "transferring") return;
      session.sentComplete = true;
      await this.options.send({ kind: PORTAL_FILE_KIND, op: "complete", transferId: id });
    } catch (error) { this.end(id, "failed", errorText(error)); }
  }

  private end(id: string, state: "completed" | "cancelled" | "failed", reason?: string, notify = true): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    clearTimeout(session.timer);
    const published = session.direction === "incoming" || session.state !== "awaiting-approval";
    session.state = state;
    if (session.direction === "incoming") this.cleanup(session);
    if (notify && state !== "completed" && published) this.sendCancel(id, reason ?? state);
    this.status(id, session, reason);
    if (session.direction === "outgoing") {
      const files = manifestFiles(session.batch.files);
      session.finish({ transferId: id, state, reason, files, ...(state === "completed" ? { verifiedFiles: manifestFiles(files) } : {}) });
    }
  }

  /** Closes and removes only the temporary files this session created. */
  private cleanup(session: Incoming): void {
    const intact = !session.destination || directoryIntact(session.destination);
    for (const file of session.files) {
      if (file.fd !== undefined) { try { fs.closeSync(file.fd); } catch { /* already closed */ } file.fd = undefined; }
      // Never unlink through a swapped destination path; orphaned temps stay in the original directory.
      if (intact) { try { fs.unlinkSync(file.temp); } catch { /* already finalized or removed */ } }
    }
  }

  private sendCancel(transferId: string, reason: string): void {
    void Promise.resolve().then(() => this.options.send({ kind: PORTAL_FILE_KIND, op: "cancel", transferId, reason: reason.slice(0, 500) })).catch(() => undefined);
  }

  private status(transferId: string, session: Session, reason?: string, savedPaths?: string[]): void {
    const totalBytes = session.direction === "outgoing" ? session.batch.totalBytes : session.manifest.totalBytes;
    const files = manifestFiles(session.direction === "outgoing" ? session.batch.files : session.manifest.files);
    const verifiedFiles = session.state === "completed" ? manifestFiles(files) : undefined;
    try { this.options.onStatus?.({ transferId, direction: session.direction, state: session.state, bytes: session.bytes, totalBytes, reason, savedPaths, files, ...(verifiedFiles ? { verifiedFiles } : {}) }); }
    catch { /* observer errors must not affect the transfer */ }
  }
}

function manifestFiles(files: readonly PortalManifestFile[]): PortalManifestFile[] {
  return files.map(({ name, size, sha256 }) => ({ name, size, sha256 }));
}

function sameFiles(value: unknown, expected: PortalManifestFile[]): boolean {
  return Array.isArray(value) && value.length === expected.length && expected.every((file, index) => {
    const item = value[index] as Record<string, unknown> | null;
    return !!item && typeof item === "object" && item.name === file.name && item.size === file.size && item.sha256 === file.sha256;
  });
}

function copy(manifest: PortalManifest): PortalManifest {
  return { transferId: manifest.transferId, files: manifest.files.map(f => ({ ...f })), totalBytes: manifest.totalBytes };
}

function pinDirectory(dir: string): PinnedDirectory {
  if (typeof dir !== "string" || !path.isAbsolute(dir)) throw new Error("Portal destination must be an absolute directory.");
  const real = fs.realpathSync(dir);
  const stat = fs.lstatSync(real);
  if (!stat.isDirectory()) throw new Error("Portal destination must be a directory.");
  return { path: real, dev: stat.dev, ino: stat.ino };
}

/** Rejects if the authorized destination no longer resolves to the same real directory. */
function verifyDirectory(pinned: PinnedDirectory): void {
  let current: PinnedDirectory;
  try { current = pinDirectory(pinned.path); } catch { throw new Error("Portal destination changed after approval."); }
  if (current.path !== pinned.path || current.dev !== pinned.dev || current.ino !== pinned.ino) {
    throw new Error("Portal destination changed after approval.");
  }
}

function exists(file: string): boolean {
  try { fs.lstatSync(file); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function directoryIntact(pinned: PinnedDirectory): boolean {
  try { verifyDirectory(pinned); return true; } catch { return false; }
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }

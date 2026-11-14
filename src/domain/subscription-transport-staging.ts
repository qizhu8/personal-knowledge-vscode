import { constants, closeSync, fsyncSync, fstatSync, linkSync, lstatSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { subscriptionMaterializeLimits } from "../subscription-materialize-contracts.js";
import { transportError } from "./subscription-transport-protocol.js";

export const transportHash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
export class SubscriptionTransportStaging {
  readonly root: string;
  private readonly identity: string;
  constructor(root: string) {
    this.root = resolve(root);
    this.identity = this.check();
  }
  private check(): string {
    for (let current = this.root; ; current = dirname(current)) {
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) transportError("INVALID_WORKSPACE", "Staging root/ancestors must be real directories.");
      if (current === this.root && this.identity && `${stat.dev}:${stat.ino}` !== this.identity) transportError("RECOVERY_CONFLICT", "Staging root changed.");
      if (dirname(current) === current) break;
    }
    const stat = lstatSync(this.root);
    return `${stat.dev}:${stat.ino}`;
  }
  private path(id: string, suffix: string) {
    this.check();
    if (!/^[a-f0-9-]{36}$/.test(id)) transportError("INVALID_ARGUMENT", "Unsafe staging operation ID.");
    return join(this.root, `${id}.${suffix}`);
  }
  discardPartial(id: string) {
    const file = this.path(id, "partial");
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) transportError("RECOVERY_CONFLICT", "Unsafe partial transfer.");
      unlinkSync(file);
    } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  }
  verified(id: string, digest: string, bytes: number): Buffer {
    const fd = openSync(this.path(id, "snapshot"), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== bytes || stat.size > subscriptionMaterializeLimits.snapshotBytes) transportError("RECOVERY_CONFLICT", "Unsafe verified transfer.");
      const value = readFileSync(fd);
      if (`sha256:${transportHash(value)}` !== digest) transportError("RECOVERY_CONFLICT", "Verified transfer changed.");
      this.check();
      return value;
    } finally { closeSync(fd); }
  }
  async receive(id: string, body: AsyncIterable<Uint8Array>, bytes: number, digest: string, fence: () => Promise<void>) {
    this.discardPartial(id);
    const partial = this.path(id, "partial"), destination = this.path(id, "snapshot");
    try { lstatSync(destination); transportError("RECOVERY_CONFLICT", "Unknown completed staging file requires reconciliation."); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    const fd = openSync(partial, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let count = 0;
    const hash = createHash("sha256");
    try {
      for await (const chunk of body) {
        if ((count += chunk.byteLength) > bytes || count > subscriptionMaterializeLimits.snapshotBytes) transportError("INVALID_ARGUMENT", "Transfer byte limit exceeded.");
        await fence();
        this.check();
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.byteLength) offset += writeSync(fd, chunk, offset);
      }
      if (count !== bytes || `sha256:${hash.digest("hex")}` !== digest) transportError("CONFLICT", "Incomplete transfer or snapshot checksum mismatch.");
      await fence();
      const stat = fstatSync(fd), named = lstatSync(partial);
      if (!named.isFile() || named.isSymbolicLink() || stat.nlink !== 1 || named.dev !== stat.dev || named.ino !== stat.ino) transportError("RECOVERY_CONFLICT", "Partial transfer path changed.");
      fsyncSync(fd);
    } catch (error) {
      const owned = fstatSync(fd);
      closeSync(fd);
      try {
        const named = lstatSync(this.path(id, "partial"));
        if (named.isFile() && !named.isSymbolicLink() && named.dev === owned.dev && named.ino === owned.ino) this.discardPartial(id);
      } catch (cleanupError) {
        if (!(cleanupError instanceof Error && "code" in cleanupError && cleanupError.code === "ENOENT")) throw cleanupError;
      }
      throw error;
    }
    closeSync(fd);
    this.check();
    // A verified orphan is deliberately not reused unless the durable state records verification.
    linkSync(partial, destination);
    unlinkSync(partial);
    const dir = openSync(this.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(dir); } finally { closeSync(dir); }
    return count;
  }
}

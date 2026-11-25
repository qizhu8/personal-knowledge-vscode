import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CoreError } from "./host-composition-legacy-batch15-errors.js";
import { RenameNoReplaceError, renameNoReplaceSync } from "./rename-no-replace.js";

export const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

export function atomicFileWrite(destination: string, content: string | Uint8Array, expected: string | null, operationId?: string) {
  return atomicFileWriteInternal(destination, content, expected, operationId, false);
}

export function atomicFileCreateNoReplace(destination: string, content: string | Uint8Array, operationId?: string,
  beforePublication?: () => void) {
  return atomicFileWriteInternal(destination, content, null, operationId, true, beforePublication);
}

function atomicFileWriteInternal(
  destination: string, content: string | Uint8Array, expected: string | null, operationId: string | undefined, noReplace: boolean,
  beforePublication?: () => void,
) {
  beforePublication?.();
  function digest() {
    let stat;
    try { stat = lstatSync(destination); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
    if (noReplace) throw new CoreError("RECOVERY_CONFLICT", "Destination appeared during no-replace publication; preserve the pending intent.");
    if (!stat.isFile() || stat.isSymbolicLink()) throw new CoreError("INVALID_DOCUMENT", "Refusing to overwrite a non-regular file.");
    return sha256(readFileSync(destination));
  }
  if (digest() !== expected) throw new CoreError("RECOVERY_CONFLICT", "File changed outside the server. No recovery write was made; preserve both versions and reconcile the pending journal.");
  if (operationId !== undefined && !/^[a-fA-F0-9-]{36}$/.test(operationId)) throw new CoreError("INVALID_WORKSPACE", "Pending operation has an invalid temporary-file identity.");
  const directory = dirname(destination), temporary = join(directory, `.pkm-write-${operationId ?? randomUUID()}`);
  if (operationId !== undefined) {
    try {
      const stale = lstatSync(temporary);
      if (!stale.isFile() || stale.isSymbolicLink()) throw new CoreError("INVALID_DOCUMENT", "Pending operation temporary path is not a regular file.");
      unlinkSync(temporary);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  try {
    const descriptor = openSync(temporary, "wx", 0o600);
    try { writeFileSync(descriptor, content); fsyncSync(descriptor); }
    finally { closeSync(descriptor); }
    if (digest() !== expected) throw new CoreError("RECOVERY_CONFLICT", "File changed while preparing a write; the pending operation requires reconciliation.");
    if (noReplace) {
      beforePublication?.();
      try { renameNoReplaceSync(temporary, destination); }
      catch (error) {
        if (error instanceof RenameNoReplaceError && error.code === "UNAVAILABLE") {
          throw new CoreError("UNSUPPORTED_OPERATION", error.message, "unknown");
        }
        throw new CoreError("RECOVERY_CONFLICT", "No-replace publication failed; preserve the source and pending intent for reconciliation.", "unknown");
      }
    } else renameSync(temporary, destination);
    if (process.platform !== "win32") {
      const descriptor = openSync(directory, "r");
      try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
    }
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

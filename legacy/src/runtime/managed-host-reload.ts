import * as fs from "node:fs";
import * as path from "node:path";
import { HostWriterAdmission } from "./host-writer-admission";

type DirectoryIdentity = { path: string; dev: bigint; ino: bigint };

function directoryIdentity(value: string): DirectoryIdentity {
  if (!path.isAbsolute(value) || fs.realpathSync(value) !== value)
    throw new Error("The root or profile storage is not canonical.");
  const stat = fs.lstatSync(value, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("The root or profile storage is not a directory.");
  return { path: value, dev: stat.dev, ino: stat.ino };
}

function sameDirectory(expected: DirectoryIdentity): boolean {
  try {
    const actual = directoryIdentity(expected.path);
    return actual.dev === expected.dev && actual.ino === expected.ino;
  } catch { return false; }
}

/**
 * One user-confirmed drain and reload of this host only. Registry entries,
 * profile paths and process identities do not authorize a root handoff.
 */
export function createManagedHostReload(options: {
  root: string;
  profileStorage: string;
  owner: HostWriterAdmission;
  isCurrent(): boolean;
  confirm(root: string): Promise<boolean>;
  drain(): Promise<void>;
  reload(): Promise<void>;
  onDrainError?(error: unknown): void;
}): () => Promise<"cancelled" | "reload-requested" | "reload-requested-drain-unknown"> {
  let running = false;
  return async () => {
    if (running) throw new Error("A managed host reload is already pending.");
    running = true;
    try {
      const root = directoryIdentity(options.root);
      const profile = directoryIdentity(options.profileStorage);
      const initial = options.owner.status();
      if (!options.isCurrent() || initial.state !== "accepting")
        throw new Error("The current host is not available for a managed drain.");
      if (!await options.confirm(root.path)) return "cancelled";
      const current = options.owner.status();
      if (!options.isCurrent() || !sameDirectory(root) || !sameDirectory(profile)
        || current.ownerId !== initial.ownerId || current.state !== "accepting")
        throw new Error("The host, root or profile changed during confirmation; no drain was started.");

      let unknown = false;
      try {
        await options.drain();
        const drained = options.owner.status();
        if (!options.isCurrent() || !sameDirectory(root) || !sameDirectory(profile)
          || drained.ownerId !== initial.ownerId || drained.state !== "drained" || drained.inFlight !== 0)
          throw new Error("The confirmed host drain could not be verified.");
      }
      catch (error) {
        unknown = true;
        try { options.onDrainError?.(error); } catch {}
      }
      // A reload is recovery for this window, not evidence that child effects
      // or writers outside this host have stopped.
      try { await options.reload(); }
      catch {
        throw new Error("Window reload failed after admission was closed. Reload this window manually; drain and recovery remain unknown.");
      }
      return unknown ? "reload-requested-drain-unknown" : "reload-requested";
    } finally { running = false; }
  };
}

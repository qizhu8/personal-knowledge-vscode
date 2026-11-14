import {
  closeManagedWriterAdmission, completeManagedProfile, discoverManagedProfiles, managedWriterAdmissionState,
  orchestrateManagedWriterHandoff, registerManagedProfile, rotateManagedWriterSession,
  resolveManagedWriterSession, recordConfirmedManagedProfile, MANAGED_PROFILE_SUCCESSOR_PROTOCOL, type ManagedProfileRegistration,
  bindManagedProfileHostAdmission, createManagedDrainedSnapshotHost, type ManagedDrainedSnapshotHost,
} from "./managed-writer-session";
import { HostWriterAdmission } from "./host-writer-admission";
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { readExtensionBuild } from "./extension-host-runtime";

type State = "accepting" | "draining" | "drained" | "unknown";
export interface ManagedProfileAutomaticUpgrade {
  updateAvailable(): boolean;
  restartReady(): boolean;
  canRestart(): boolean;
  restart(): Promise<void>;
}

/** A shared globalStorageUri does not identify a named VS Code profile. */
export function unambiguousDefaultProfileStorage(globalStorage: string): boolean {
  try {
    const global = path.dirname(globalStorage), user = path.dirname(global);
    if (path.basename(global) !== "globalStorage" || path.basename(user) !== "User") return false;
    const profiles = path.join(user, "profiles");
    try {
      const stat = fs.lstatSync(profiles);
      return stat.isDirectory() && !stat.isSymbolicLink() && fs.readdirSync(profiles).length === 0;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  } catch { return false; }
}

/** Require the installed package's existing build fingerprints and known-compatible coordinator bytes. */
export function installedManagedProfileCompatible(directory: string): boolean {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(directory, "dist", "build-info.json"), "utf8"));
    const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
    if (info?.schema !== "pkm.extension-build/v1" || !info.files
      || info.buildId !== hash(JSON.stringify(info.files))) return false;
    for (const name of ["dist/runtime/managed-profile-activation.js", "dist/runtime/managed-writer-session.js", "dist/extension.js"]) {
      const installed = fs.readFileSync(path.join(directory, name));
      if (hash(installed) !== info.files[name]) return false;
      if (name !== "dist/extension.js"
        && hash(installed) !== hash(fs.readFileSync(path.join(__dirname, path.basename(name))))) return false;
      if (name === "dist/extension.js" && !installed.includes("resolveManagedWriterSession")) return false;
    }
    return true;
  } catch { return false; }
}

/**
 * Observe all local profile indexes rather than guessing which profile owns a
 * shared globalStorageUri. An ambiguous or incompatible candidate fails closed.
 */
export function observeManagedProfileInstallations(
  globalStorage: string, extensionPath: string, extensionId: string,
): { ready(): boolean; changed(): boolean } {
  const global = path.dirname(globalStorage), user = path.dirname(global), root = path.dirname(extensionPath);
  const read = (): string | undefined => {
    try {
      if (path.basename(global) !== "globalStorage" || path.basename(user) !== "User") return undefined;
      const indexes = [path.join(root, "extensions.json")], profiles = path.join(user, "profiles");
      let profileStat: fs.Stats | undefined;
      try {
        profileStat = fs.lstatSync(profiles);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
      }
      if (profileStat) {
        if (!profileStat.isDirectory() || profileStat.isSymbolicLink()) return undefined;
        const entries = fs.readdirSync(profiles, { withFileTypes: true });
        if (entries.length > 500) return undefined;
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.isSymbolicLink()) return undefined;
          indexes.push(path.join(profiles, entry.name, "extensions.json"));
        }
      }
      const found: string[] = [];
      for (const index of indexes) {
        let stat: fs.Stats;
        try { stat = fs.lstatSync(index); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          return undefined;
        }
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) return undefined;
        const entries = JSON.parse(fs.readFileSync(index, "utf8"));
        if (!Array.isArray(entries)) return undefined;
        const matches = entries.filter(entry => entry?.identifier?.id?.toLowerCase() === extensionId.toLowerCase());
        if (matches.length > 1) return undefined;
        if (!matches.length) continue;
        const entry = matches[0], location = entry.location?.fsPath || entry.location?.path;
        if (entry.location?.scheme !== "file" || typeof location !== "string" || !path.isAbsolute(location)
          || path.resolve(path.dirname(location)) !== path.resolve(root)) return undefined;
        const build = readExtensionBuild(location);
        if (!build || build.version !== entry.version || !installedManagedProfileCompatible(location)) return undefined;
        found.push(JSON.stringify([index, path.resolve(location), build.buildId]));
      }
      return found.length ? JSON.stringify(found.sort()) : undefined;
    } catch { return undefined; }
  };
  const initial = read();
  const includesLoaded = (snapshot: string) => (JSON.parse(snapshot) as string[])
    .some(entry => (JSON.parse(entry) as string[])[1] === path.resolve(extensionPath));
  return {
    ready: () => read() !== undefined,
    changed: () => {
      const current = read();
      return initial !== undefined && current !== undefined
        && (current !== initial || (!includesLoaded(initial) && !includesLoaded(current)));
    },
  };
}

/** Only explicitly bound extension hosts participate; absence of a host is never evidence. */
export function activateManagedProfileWriter(
  root: string, sessionId: string, drainOwned: () => Promise<void>, intervalMs = 250,
  isCurrent: () => boolean = () => true,
  profileId?: string,
  automatic?: ManagedProfileAutomaticUpgrade,
  enrolled?: ManagedProfileRegistration,
  hostAdmission?: HostWriterAdmission,
): {
  status(): { state: State; detail?: string; preexistingAndExternalWriters: "unknown"; cutoverAuthorized: false };
  discover(): ReturnType<typeof discoverManagedProfiles>;
  handoff(timeoutMs?: number): ReturnType<typeof orchestrateManagedWriterHandoff>;
  rotate(): ReturnType<typeof rotateManagedWriterSession>;
  confirmLocalDrain(profileStorage: string, confirm: () => Promise<boolean>, confirmationCurrent?: () => boolean): Promise<"cancelled" | "drained">;
  holdSnapshotTransition(): void;
  snapshotHost(profileStorage: string, profileUri: string): ManagedDrainedSnapshotHost;
  dispose(): void;
} {
  const admission = managedWriterAdmissionState(root, sessionId);
  if (!isCurrent()) throw new Error("Managed profile root or session binding changed; enrollment is unknown.");
  if (profileId && !enrolled && admission === "fenced")
    throw new Error("Managed writer session is fenced; a new profile cannot join.");
  if (enrolled && (enrolled.sessionId !== sessionId || enrolled.profileId !== profileId))
    throw new Error("Managed profile enrollment binding changed.");
  const automaticParticipant = enrolled
    ? enrolled.protocol === MANAGED_PROFILE_SUCCESSOR_PROTOCOL : !!automatic && automatic.restartReady();
  if (automaticParticipant && (!automatic || !automatic.restartReady()))
    throw new Error("Enrolled profile cannot safely restart on a successor session.");
  const registration = enrolled || (profileId && admission === "accepting"
    ? registerManagedProfile(root, sessionId, profileId, automaticParticipant) : undefined);
  let snapshotHostBound = false;
  if (registration && hostAdmission) {
    try { bindManagedProfileHostAdmission(root, registration, hostAdmission); snapshotHostBound = true; }
    catch { /* The ordinary managed lifecycle remains available, without snapshot authority. */ }
  }
  let state: State = "accepting", detail: string | undefined, draining: Promise<void> | undefined;
  let disposed = false, coordinating = false, restarting = false, confirming = false;
  let snapshotTransition = false;
  const lifetime = new AbortController();
  const drain = () => {
    if (draining) return draining;
    state = "draining";
    draining = Promise.resolve().then(() => {
      if (!isCurrent()) throw new Error("Managed profile root or session binding changed; drain is unknown.");
      return drainOwned();
    }).then(() => {
      if (!isCurrent()) throw new Error("Managed profile binding changed during drain; outcome is unknown.");
      if (automaticParticipant && automatic && !automatic.restartReady()) throw new Error("Installed profile cannot safely restart on a successor session.");
      if (registration) completeManagedProfile(root, registration);
      state = "drained";
    }).catch(error => {
      state = "unknown";
      detail = error instanceof Error ? error.message : String(error);
      throw error;
    });
    return draining;
  };
  const poll = () => {
    if (disposed) return;
    try {
      if (!isCurrent()) throw new Error("Managed profile root or session binding changed; state is unknown.");
      if (automaticParticipant && automatic && state === "drained") {
        if (snapshotTransition) return;
        const successor = resolveManagedWriterSession(root, sessionId);
        if (successor !== sessionId) {
          if (!restarting && automatic.restartReady() && automatic.canRestart()) {
            restarting = true;
            void Promise.resolve().then(() => automatic.restart()).catch(error => {
              restarting = false; state = "unknown";
              detail = error instanceof Error ? error.message : String(error);
            });
          }
          return;
        }
      }
      if (!draining && managedWriterAdmissionState(root, sessionId) === "fenced") void drain().catch(() => {});
      if (automaticParticipant && automatic && !coordinating && automatic.updateAvailable()) {
        coordinating = true;
        void Promise.resolve().then(async () => {
          closeManagedWriterAdmission(root, sessionId, true);
          await orchestrateManagedWriterHandoff(root, sessionId, [{ drain }], 2000);
          rotateManagedWriterSession(root, sessionId);
        }).catch(error => {
          detail = error instanceof Error ? error.message : String(error);
          if (state !== "draining" && state !== "drained") state = "unknown";
        }).finally(() => { coordinating = false; });
      }
    } catch (error) {
      state = "unknown";
      detail = error instanceof Error ? error.message : String(error);
    }
  };
  // Invalid binding must not silently activate or create a session.
  if (admission === "fenced") void drain().catch(() => {});
  const timer = setInterval(poll, Math.max(50, intervalMs));
  timer.unref();
  return {
    status: () => ({ state, ...(detail ? { detail } : {}), preexistingAndExternalWriters: "unknown", cutoverAuthorized: false }),
    discover: () => {
      if (!isCurrent()) throw new Error("Managed profile root or session binding changed; discovery is unknown.");
      return discoverManagedProfiles(root, sessionId);
    },
    confirmLocalDrain: async (profileStorage, confirm, confirmationCurrent = () => true) => {
      if (!registration || !snapshotHostBound || state !== "accepting" || draining || confirming || !isCurrent() || !confirmationCurrent()
        || managedWriterAdmissionState(root, sessionId) !== "accepting")
        throw new Error("The registered profile is not available for a confirmed drain.");
      const directoryPin = (directory: string) => {
        if (!path.isAbsolute(directory) || fs.realpathSync(directory) !== directory)
          throw new Error("Managed Root/profile is not canonical.");
        const stat = fs.lstatSync(directory, { bigint: true });
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Managed Root/profile is unavailable.");
        return `${stat.dev}:${stat.ino}`;
      };
      const rootPin = directoryPin(root), profilePin = directoryPin(profileStorage);
      confirming = true;
      try {
        if (!await confirm()) return "cancelled";
        if (state !== "accepting" || draining || !isCurrent() || !confirmationCurrent()
          || directoryPin(root) !== rootPin || directoryPin(profileStorage) !== profilePin
          || managedWriterAdmissionState(root, sessionId) !== "accepting")
          throw new Error("The profile or session changed during confirmation; no confirmed drain was started.");
        await drain();
        if (!isCurrent() || !confirmationCurrent() || directoryPin(root) !== rootPin || directoryPin(profileStorage) !== profilePin)
          throw new Error("Managed Root/profile changed during drain; confirmation remains unknown.");
        recordConfirmedManagedProfile(root, profileStorage, registration);
        return "drained";
      } finally { confirming = false; }
    },
    handoff: async timeoutMs => {
      try {
        if (!isCurrent()) throw new Error("Managed profile root or session binding changed; no handoff was started.");
        return await orchestrateManagedWriterHandoff(root, sessionId, [{ drain }], timeoutMs);
      } catch (error) {
        state = "unknown";
        detail = error instanceof Error ? error.message : String(error);
        throw error;
      }
    },
    rotate: () => {
      if (!isCurrent() || state !== "drained") throw new Error("Managed profile must be bound and drained before rotation.");
      return rotateManagedWriterSession(root, sessionId);
    },
    holdSnapshotTransition: () => {
      if (disposed || !registration || !hostAdmission || !snapshotHostBound || state !== "drained" || !isCurrent())
        throw new Error("A current drained managed host is required for a snapshot transition.");
      hostAdmission.assertDrainedRoot(root);
      snapshotTransition = true;
    },
    snapshotHost: (profileStorage, profileUri) => {
      if (!snapshotTransition || disposed || !registration || !hostAdmission || !snapshotHostBound || state !== "drained" || !isCurrent())
        throw new Error("Managed snapshot transition is not held by this drained host.");
      return createManagedDrainedSnapshotHost({ root, profileStorage, profileUri, registration,
        hostAdmission, scopeSignal: lifetime.signal });
    },
    dispose: () => { disposed = true; lifetime.abort(); clearInterval(timer); void drain().catch(() => {}); },
  };
}

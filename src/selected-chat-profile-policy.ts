import { accessSync, closeSync, constants, fstatSync, openSync, realpathSync, statSync, type Stats } from "node:fs";
import { isAbsolute } from "node:path";
import type { StandaloneHost } from "./standalone-host.js";
import type { LegacyChatProcessScope } from "./legacy-api-chat-process.js";
import type { LegacyChatProcessPolicy } from "./legacy-api-chat-process-approval.js";

type SelectedOwner = ReturnType<StandaloneHost["selectedOwnerContext"]>;
type Profile = {
  id: string;
  workspaceId: string;
  actorId: string;
  sourceRoot: string;
  assertCurrent(): void;
  policy(binding: LegacyChatProcessScope): Promise<LegacyChatProcessPolicy>;
  /** The profile writer must itself fence the durable commit, not just its return. */
  remember(binding: LegacyChatProcessScope, scope: string, choice: "approve" | "allow-all", assertCommitCurrent: () => void): Promise<void>;
};
type ExactCommand = { id: string; program: string; cwd: string; arguments: readonly (readonly string[])[] };
type Archive = { kind?: "writer-fenced"; root: string; assertNoWriters(): void }
  | { kind: "optimistic-snapshot"; root: string; assertSnapshotCurrent(): void };

function fence(callback: () => void) {
  const result = callback() as unknown;
  if (result !== undefined) {
    if (result && (typeof result === "object" || typeof result === "function")
      && typeof (result as { then?: unknown }).then === "function")
      void Promise.resolve(result).catch(() => {});
    throw new Error("Chat authority fence must be synchronous and return undefined.");
  }
}

/**
 * Compose explicit authority supplied by the actual owner. A source must supply
 * either a live writer fence or a separately owned optimistic snapshot checker.
 * Neither mode establishes writer exclusion or an atomic snapshot by itself.
 */
export function createSelectedChatProfilePolicy(options: {
  selected: SelectedOwner;
  connection: AbortSignal;
  profile: Profile;
  archive: Archive;
  commands: readonly ExactCommand[];
}) {
  const { selected, connection, profile, archive } = options;
  if (!selected || !connection || !profile || !archive
    || (archive.kind === "optimistic-snapshot" ? typeof archive.assertSnapshotCurrent !== "function"
      : (archive.kind !== undefined && archive.kind !== "writer-fenced") || typeof archive.assertNoWriters !== "function")
    || typeof profile.assertCurrent !== "function" || typeof profile.policy !== "function"
    || typeof profile.remember !== "function" || !profile.id || !Array.isArray(options.commands))
    throw new Error("A live selected Chat profile and archive source fence or snapshot conflict checker are required.");
  const profileId = profile.id, workspaceId = profile.workspaceId, actorId = profile.actorId, root = archive.root, archiveKind = archive.kind;
  let rootIdentity: { dev: number; ino: number } | undefined;
  const assertCurrent = () => {
    if (connection.aborted || profile.id !== profileId || profile.workspaceId !== workspaceId
      || profile.actorId !== actorId || profile.sourceRoot !== root || archive.root !== root
      || archive.kind !== archiveKind
      || workspaceId !== selected.workspaceId || actorId !== selected.actorId)
      throw new Error("Selected Chat profile identity or connection changed.");
    fence(() => selected.assertCurrent());
    fence(() => profile.assertCurrent());
    if (archive.kind === "optimistic-snapshot") fence(() => archive.assertSnapshotCurrent());
    else fence(() => archive.assertNoWriters());
    if (!isAbsolute(root) || realpathSync(root) !== root)
      throw new Error("Selected Chat archive root is unavailable or not canonical.");
    const rootStat = statSync(root);
    if (!rootStat.isDirectory() || (rootIdentity && (rootStat.dev !== rootIdentity.dev || rootStat.ino !== rootIdentity.ino)))
      throw new Error("Selected Chat archive root changed.");
    fence(() => selected.assertCurrent());
    if (connection.aborted || profile.id !== profileId || profile.workspaceId !== workspaceId
      || profile.actorId !== actorId || profile.sourceRoot !== root || archive.root !== root || archive.kind !== archiveKind)
      throw new Error("Selected Chat profile identity or connection changed.");
  };
  assertCurrent();
  const rootStat = statSync(root);
  rootIdentity = { dev: rootStat.dev, ino: rootStat.ino };
  const programs = new Set<string>(), ids = new Set<string>();
  const commands = options.commands.map(spec => {
    if (!spec || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(spec.id)
      || !isAbsolute(spec.program) || realpathSync(spec.program) !== spec.program
      || !isAbsolute(spec.cwd) || realpathSync(spec.cwd) !== spec.cwd
      || programs.has(spec.program) || ids.has(spec.id) || !Array.isArray(spec.arguments) || !spec.arguments.length)
      throw new Error("Invalid exact Chat command.");
    programs.add(spec.program); ids.add(spec.id);
    const executable = statSync(spec.program), cwd = statSync(spec.cwd);
    if (!executable.isFile() || !cwd.isDirectory()) throw new Error("Chat command executable or working directory is invalid.");
    accessSync(spec.program, constants.X_OK);
    const allowed = spec.arguments.map((args: readonly string[]) => {
      if (!Array.isArray(args) || args.length > 32 || args.some(arg => typeof arg !== "string" || arg.includes("\0"))
        || JSON.stringify(args).length > 8000) throw new Error("Invalid exact Chat command arguments.");
      return JSON.stringify(args);
    });
    const program = spec.program, workingDirectory = spec.cwd;
    const sameExecutable = (current: Stats) => current.isFile()
      && current.dev === executable.dev && current.ino === executable.ino
      && current.size === executable.size && current.mtimeMs === executable.mtimeMs && current.ctimeMs === executable.ctimeMs
      && current.mode === executable.mode && current.uid === executable.uid && current.gid === executable.gid;
    const sameCwd = (current: Stats) => current.isDirectory()
      && current.dev === cwd.dev && current.ino === cwd.ino;
    const validate = (args: readonly string[]) => {
      assertCurrent();
      const current = statSync(program), currentCwd = statSync(workingDirectory);
      if (realpathSync(program) !== program || realpathSync(workingDirectory) !== workingDirectory
        || !sameExecutable(current) || !sameCwd(currentCwd))
        throw new Error("Selected Chat executable or working directory changed.");
      accessSync(program, constants.X_OK);
      return allowed.includes(JSON.stringify(args));
    };
    return Object.freeze({ id: spec.id, program, cwd: workingDirectory, arguments: validate,
      openLaunch(args: readonly string[]) {
        if (process.platform !== "linux" || !validate(args)) throw new Error("Pinned Chat command is unavailable.");
        let executableFd: number | undefined, cwdFd: number | undefined;
        try {
          executableFd = openSync(program, constants.O_RDONLY | constants.O_NOFOLLOW);
          cwdFd = openSync(workingDirectory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          if (!sameExecutable(fstatSync(executableFd)) || !sameCwd(fstatSync(cwdFd)))
            throw new Error("Selected Chat executable or working directory changed before open.");
          assertCurrent();
          return { executable: executableFd, cwd: cwdFd };
        } catch (error) {
          if (executableFd !== undefined) closeSync(executableFd);
          if (cwdFd !== undefined) closeSync(cwdFd);
          throw error;
        }
      } });
  });
  const assertBinding = (binding: LegacyChatProcessScope) => {
    assertCurrent();
    if (binding.root !== root || binding.workspaceId !== workspaceId || binding.actorId !== actorId)
      throw new Error("Chat profile binding changed.");
  };
  return Object.freeze({
    assertProfile: assertCurrent,
    chatSource: Object.freeze({ root, assertCurrent }),
    commands: Object.freeze(commands),
    async policy(binding: LegacyChatProcessScope) {
      assertBinding(binding);
      const result = await profile.policy(structuredClone(binding));
      assertBinding(binding);
      return result;
    },
    async remember(binding: LegacyChatProcessScope, scope: string, choice: "approve" | "allow-all") {
      assertBinding(binding);
      await profile.remember(structuredClone(binding), scope, choice, () => assertBinding(binding));
      assertBinding(binding);
    },
  });
}

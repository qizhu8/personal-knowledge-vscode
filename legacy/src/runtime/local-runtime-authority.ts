import * as fs from "fs";
import * as path from "path";
import { LocalEnvironmentCatalog } from "./local-environment-catalog";
import { captureNodeProject, validateNodeProject, type LocalNodeProject } from "./local-node-project";

type Pin = Readonly<{ dev: string; ino: string; mode: string; size: string; mtimeNs: string; ctimeNs: string }>;
export type LocalJournalHandle = Readonly<{
  schema: "pkm.local-runtime-journal/v1"; workspaceId: string; actorId: string;
  directory: string; identity: string;
}>;
export type LocalRuntimeHandle = Readonly<{
  schema: "pkm.local-runtime-executor/v1"; workspaceId: string; actorId: string;
  environmentId: string; executorId: string; provider: "node-diagnostic/v1" | "dotnet8-diagnostic/v1" | "node-project/v1";
  catalogDigest: string; executable: string; target: string; entryPin: Pin; targetPin: Pin;
  project?: LocalNodeProject;
}>;
export type LocalProgramParameters = { args: string[]; waitMs: number };
function pin(file: string, follow: boolean): Pin {
  const stat = follow ? fs.statSync(file, { bigint: true }) : fs.lstatSync(file, { bigint: true });
  return Object.freeze(Object.fromEntries(["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs"]
    .map(key => [key, String(stat[key as keyof typeof stat])])) as Pin);
}
const principal = /^[^\0\r\n]{1,256}$/;
/** Explicit native provider capabilities, not a generic path/language execution API. */
export class LocalRuntimeAuthority {
  private readonly journals = new Set<LocalJournalHandle>();
  private readonly runtimes = new Set<LocalRuntimeHandle>();
  constructor(private readonly trusted: () => boolean, private readonly catalog: LocalEnvironmentCatalog,
    private readonly directory: string) {}
  selectJournal(workspaceId: string, actorId: string): LocalJournalHandle {
    if (!this.trusted() || !principal.test(workspaceId) || !principal.test(actorId))
      throw new Error("Trusted current workspace and actor required.");
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(this.directory);
    if (!path.isAbsolute(this.directory) || path.resolve(this.directory) !== this.directory
      || fs.realpathSync(this.directory) !== this.directory || !stat.isDirectory()
      || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
      throw new Error("Environment run journal must be a canonical private owned directory.");
    const handle = Object.freeze({ schema: "pkm.local-runtime-journal/v1" as const, workspaceId, actorId,
      directory: this.directory, identity: `${stat.dev}:${stat.ino}` });
    this.journals.add(handle);
    return handle;
  }
  validateJournal(handle: LocalJournalHandle, workspaceId: string, actorId: string): void {
    if (!this.trusted()) this.revoke();
    if (!this.journals.has(handle) || handle.workspaceId !== workspaceId || handle.actorId !== actorId)
      throw new Error("Environment journal authority unavailable; reselect in a fresh trusted trial.");
    const stat = fs.lstatSync(this.directory);
    if (handle.directory !== this.directory || fs.realpathSync(this.directory) !== this.directory
      || `${stat.dev}:${stat.ino}` !== handle.identity || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
      throw new Error("Environment journal directory changed.");
  }
  selectRuntime(journal: LocalJournalHandle, environmentId: string, executorId: string, entrypoint?: string): LocalRuntimeHandle {
    this.validateJournal(journal, journal.workspaceId, journal.actorId);
    const view = this.catalog.read(), entry = view.catalog.entries.find(item => item.id === environmentId);
    const executor = entry?.executors.find(item => item.id === executorId);
    const provider = entry?.language === "javascript" && entry.kind === "runtime" && executorId === "node"
      ? "node-diagnostic/v1" : entry?.language === "javascript" && entry.kind === "environment"
        && entry.manager === "node-project" && executorId === "node" ? "node-project/v1"
        : entry?.language === "csharp" && entry.kind === "executor-set" ? "dotnet8-diagnostic/v1" : undefined;
    if (!entry || !executor || !provider) throw new Error("No qualified native provider for this registered language/executor.");
    const executable = executor.executable, target = fs.realpathSync(executable);
    if (fs.realpathSync(path.dirname(executable)) !== path.dirname(executable) || !fs.statSync(target).isFile())
      throw new Error("Registered executor mapping is not canonical.");
    fs.accessSync(executable, fs.constants.X_OK);
    if (provider === "node-project/v1" && (!entry.root || !entrypoint))
      throw new Error("Explicitly select the registered Node project's CommonJS entry.");
    const handle = Object.freeze({ schema: "pkm.local-runtime-executor/v1" as const,
      workspaceId: journal.workspaceId, actorId: journal.actorId, environmentId, executorId, provider,
      catalogDigest: view.digest, executable, target, entryPin: pin(executable, false), targetPin: pin(target, true),
      ...(provider === "node-project/v1" ? { project: captureNodeProject(entry.root!, entrypoint!) } : {}) });
    this.runtimes.add(handle);
    return handle;
  }
  validateRuntime(handle: LocalRuntimeHandle, journal: LocalJournalHandle): void {
    try {
      this.validateJournal(journal, handle.workspaceId, handle.actorId);
      const view = this.catalog.read(), entry = view.catalog.entries.find(item => item.id === handle.environmentId);
      if (!this.runtimes.has(handle) || view.digest !== handle.catalogDigest
        || entry?.executors.find(item => item.id === handle.executorId)?.executable !== handle.executable
        || fs.realpathSync(path.dirname(handle.executable)) !== path.dirname(handle.executable)
        || fs.realpathSync(handle.executable) !== handle.target
        || JSON.stringify(pin(handle.executable, false)) !== JSON.stringify(handle.entryPin)
        || JSON.stringify(pin(handle.target, true)) !== JSON.stringify(handle.targetPin))
        throw new Error("Registered runtime changed; reselect and approve again.");
      fs.accessSync(handle.executable, fs.constants.X_OK);
      if (handle.provider === "node-project/v1") {
        if (!handle.project || entry?.root !== handle.project.root) throw new Error("Node project mapping changed.");
        validateNodeProject(handle.project);
      }
    } catch (error) { this.runtimes.delete(handle); throw error; }
  }
  revoke(): void { this.journals.clear(); this.runtimes.clear(); }
}

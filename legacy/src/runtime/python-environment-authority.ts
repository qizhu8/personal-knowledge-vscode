import { constants, accessSync, lstatSync, realpathSync, statSync, type BigIntStats } from "fs";
import * as path from "path";
import { pyenvList, pyenvRegistryReady, type PyEnv } from "../servers/pyenvs";

type Pin = Readonly<{ dev: string; ino: string; mode: string; size: string; mtimeNs: string; ctimeNs: string }>;
export type PythonEnvironmentHandle = Readonly<{
  schema: "pkm.host-python-environment/v1";
  workspaceId: string;
  actorId: string;
  environmentId: string;
  root: string;
  executable: string;
  target: string;
  rootPin: Pin;
  entryPin: Pin;
  targetPin: Pin;
}>;

const identifier = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;
const principal = /^[^\0\r\n]{1,256}$/;
function pin(stat: BigIntStats): Pin {
  return Object.freeze({ dev: String(stat.dev), ino: String(stat.ino), mode: String(stat.mode),
    size: String(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) });
}
function same(a: Pin, b: Pin): boolean { return JSON.stringify(a) === JSON.stringify(b); }

/** In-memory host authority. Only the local VS Code host may create or transmit handles. */
export class PythonEnvironmentAuthority {
  private readonly handles = new Set<PythonEnvironmentHandle>();
  constructor(private readonly trusted: () => boolean, private readonly registry: () => PyEnv[] = () => {
    if (!pyenvRegistryReady()) throw new Error("Host environment registry is not initialized.");
    return pyenvList();
  }) {}

  select(workspaceId: string, actorId: string, environmentId: string): PythonEnvironmentHandle {
    if (!this.trusted() || !principal.test(workspaceId) || !principal.test(actorId) || !identifier.test(environmentId))
      throw new Error("Trusted workspace, actor and registered environment ID are required.");
    const matches = this.registry().filter(env => env.id === environmentId);
    if (matches.length !== 1) throw new Error("Environment ID is missing or ambiguous in the host registry.");
    const env = matches[0];
    const root = env.path, executable = env.python;
    if (!path.isAbsolute(root) || path.resolve(root) !== root || realpathSync(root) !== root
      || !path.isAbsolute(executable) || path.resolve(executable) !== executable
      || ![path.join(root, "bin", "python"), path.join(root, "Scripts", "python.exe")].includes(executable)
      || realpathSync(path.dirname(executable)) !== path.dirname(executable))
      throw new Error("Environment root and interpreter must be canonical registered environment paths.");
    const rootStat = lstatSync(root, { bigint: true }), entryStat = lstatSync(executable, { bigint: true });
    const target = realpathSync(executable), targetStat = statSync(target, { bigint: true });
    if (!rootStat.isDirectory() || !targetStat.isFile() || !(entryStat.isFile() || entryStat.isSymbolicLink()))
      throw new Error("Registered interpreter is not an executable file.");
    accessSync(executable, constants.X_OK);
    const handle = Object.freeze({ schema: "pkm.host-python-environment/v1" as const, workspaceId, actorId,
      environmentId, root, executable, target, rootPin: pin(rootStat), entryPin: pin(entryStat), targetPin: pin(targetStat) });
    this.handles.add(handle);
    this.validate(handle, workspaceId, actorId);
    return handle;
  }

  validate(handle: PythonEnvironmentHandle, workspaceId: string, actorId: string): void {
    if (!this.trusted()) {
      this.handles.clear();
      throw new Error("Environment authority is unavailable for this workspace or actor.");
    }
    if (!this.handles.has(handle) || handle.workspaceId !== workspaceId || handle.actorId !== actorId)
      throw new Error("Environment authority is unavailable for this workspace or actor.");
    let matches: PyEnv[];
    try { matches = this.registry().filter(env => env.id === handle.environmentId); }
    catch {
      this.handles.delete(handle);
      throw new Error("Environment registry is unavailable; select it again.");
    }
    if (matches.length !== 1 || matches[0].path !== handle.root || matches[0].python !== handle.executable) {
      this.handles.delete(handle);
      throw new Error("Environment registry binding changed.");
    }
    try {
      if (realpathSync(handle.root) !== handle.root || realpathSync(path.dirname(handle.executable)) !== path.dirname(handle.executable)
        || realpathSync(handle.executable) !== handle.target || !same(pin(lstatSync(handle.root, { bigint: true })), handle.rootPin)
        || !same(pin(lstatSync(handle.executable, { bigint: true })), handle.entryPin)
        || !same(pin(statSync(handle.target, { bigint: true })), handle.targetPin)) throw new Error("changed");
      accessSync(handle.executable, constants.X_OK);
    } catch {
      this.handles.delete(handle);
      throw new Error("Environment interpreter or root changed; select it again.");
    }
  }

  revoke(): void { this.handles.clear(); }
}

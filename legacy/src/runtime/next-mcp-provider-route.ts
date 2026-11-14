import { constants, accessSync, lstatSync, realpathSync } from "node:fs";
import * as path from "node:path";
import { verifyNextPayload } from "./next-payload-verifier";

type Definition = {
  readonly label: string;
  command: string;
  args: string[];
  env: Record<string, string | number | null>;
  version?: string;
  cwd?: unknown;
};
export interface NextMcpRouteAuthority {
  readonly root: string;
  assertCurrent(): void;
}

/**
 * Route one explicitly admitted Next workspace through its verified stdio MCP
 * entrypoint. This is not a legacy-root adoption or an ownership capability.
 */
export function createNextMcpProviderRoute<T extends Definition>(options: {
  authority: NextMcpRouteAuthority;
  extensionPath: string;
  executable: string;
  profile?: "next" | "legacy-compact-experimental";
  compatibilityPython?: string;
  createDefinition(label: string, command: string, args: string[], env: Record<string, string>, version: string): T;
}) {
  const { authority } = options;
  if (!authority || typeof authority.assertCurrent !== "function" || !path.isAbsolute(authority.root)
    || !path.isAbsolute(options.extensionPath) || !path.isAbsolute(options.executable)
    || (options.profile !== undefined && options.profile !== "next" && options.profile !== "legacy-compact-experimental")
    || (options.profile === "legacy-compact-experimental"
      ? typeof options.compatibilityPython !== "string" || !path.isAbsolute(options.compatibilityPython)
      : options.compatibilityPython !== undefined))
    throw new Error("An admitted Next workspace and absolute launch paths are required.");
  authority.assertCurrent();
  const root = path.resolve(authority.root), executable = realpathSync(options.executable);
  if (realpathSync(root) !== root || !lstatSync(root).isDirectory()) throw new Error("Next workspace identity is unavailable.");
  if (!lstatSync(executable).isFile()) throw new Error("Next MCP runtime is unavailable.");
  accessSync(executable, constants.X_OK);
  const rootStat = lstatSync(root), executableStat = lstatSync(executable), payload = verifyNextPayload(options.extensionPath);
  const cli = path.join(payload.root, "server", "dist", "cli.js");
  const python = options.compatibilityPython ? path.resolve(options.compatibilityPython) : undefined;
  const pythonLinkStat = python ? lstatSync(python) : undefined, pythonReal = python ? realpathSync(python) : undefined;
  const pythonStat = pythonReal ? lstatSync(pythonReal) : undefined;
  if (python && (!pythonStat?.isFile() || !pythonReal)) throw new Error("Next compatibility runtime is unavailable.");
  if (python) accessSync(python, constants.X_OK);
  const command = python || executable;
  const definitionVersion = python ? `${payload.buildId}.legacy-compact-experimental` : payload.buildId;
  const expectedArgs = python
    ? ["-B", path.join(payload.root, "server", "compat", "legacy-compact-mcp.py"),
      "--data", root, "--node", executable, "--allow-writes"]
    : [cli, "mcp", "--data", root];
  let disposed = false;
  const check = () => {
    if (disposed || authority.root !== root) throw new Error("Next MCP route is closed or changed.");
    authority.assertCurrent();
    const current = lstatSync(root);
    if (realpathSync(root) !== root || !current.isDirectory() || current.dev !== rootStat.dev || current.ino !== rootStat.ino)
      throw new Error("Next workspace was replaced.");
    const runtime = lstatSync(executable);
    if (!runtime.isFile() || runtime.dev !== executableStat.dev || runtime.ino !== executableStat.ino)
      throw new Error("Next MCP runtime was replaced.");
    accessSync(executable, constants.X_OK);
    if (python && pythonLinkStat && pythonStat && pythonReal) {
      const link = lstatSync(python), target = lstatSync(pythonReal);
      if (link.dev !== pythonLinkStat.dev || link.ino !== pythonLinkStat.ino || realpathSync(python) !== pythonReal
        || !target.isFile() || target.dev !== pythonStat.dev || target.ino !== pythonStat.ino)
        throw new Error("Next compatibility runtime was replaced.");
      accessSync(python, constants.X_OK);
    }
    const latest = verifyNextPayload(options.extensionPath);
    if (latest.root !== payload.root || latest.buildId !== payload.buildId)
      throw new Error("Next MCP payload changed.");
    authority.assertCurrent();
  };
  const checkDefinition = (definition: T) => {
    if (definition.label !== "pkm" || definition.command !== command || definition.cwd !== undefined
      || definition.version !== definitionVersion || !Array.isArray(definition.args)
      || JSON.stringify(definition.args) !== JSON.stringify(expectedArgs)
      || !definition.env || Object.keys(definition.env).length !== 1 || definition.env.ELECTRON_RUN_AS_NODE !== "1")
      throw new Error("Next MCP definition changed.");
  };
  let active: T | undefined;
  return {
    provideMcpServerDefinitions(): T[] {
      check();
      active = options.createDefinition("pkm", command, [...expectedArgs],
        { ELECTRON_RUN_AS_NODE: "1" }, definitionVersion);
      checkDefinition(active);
      return [active];
    },
    resolveMcpServerDefinition(definition: T): T {
      check();
      if (!active || active !== definition) throw new Error("Next MCP definition is stale.");
      checkDefinition(definition);
      return definition;
    },
    dispose() { disposed = true; active = undefined; },
  };
}

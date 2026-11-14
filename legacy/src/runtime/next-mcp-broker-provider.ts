import { constants, accessSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import * as path from "node:path";

type Definition = {
  label: string;
  command: string;
  args: string[];
  env: Record<string, string | number | null>;
  version?: string;
  cwd?: unknown;
};

/** Builds VS Code-compatible definitions for an already-authorized per-host broker. */
export function createNextMcpBrokerProvider<T extends Definition>(options: {
  bridge: string;
  executable: string;
  payloadVersion: string;
  label?: string;
  assertCurrent(): void;
  environment(): Record<string, string>;
  createDefinition(label: string, command: string, args: string[], env: Record<string, string>, version: string): T;
}) {
  if (!path.isAbsolute(options.bridge) || !path.isAbsolute(options.executable)
    || (options.label !== undefined && options.label !== "pkm-next-private")
    || !/^[a-f0-9]{64}$/.test(options.payloadVersion)) throw new Error("Bound broker launch paths are required.");
  options.assertCurrent();
  const bridge = path.resolve(options.bridge), executable = realpathSync(options.executable);
  const label = options.label || "pkm";
  if (realpathSync(bridge) !== bridge || !lstatSync(bridge).isFile() || !lstatSync(executable).isFile())
    throw new Error("Broker bridge or runtime is unavailable.");
  accessSync(executable, constants.X_OK);
  const bridgeStat = lstatSync(bridge), runtimeStat = lstatSync(executable);
  const digest = () => createHash("sha256").update(readFileSync(bridge)).digest("hex");
  const bridgeDigest = digest(), version = `${options.payloadVersion}.broker-${bridgeDigest}`;
  let active: T | undefined, disposed = false;
  const check = () => {
    if (disposed) throw new Error("Next MCP broker provider is closed.");
    options.assertCurrent();
    const b = lstatSync(bridge), n = lstatSync(executable);
    if (realpathSync(bridge) !== bridge || !b.isFile() || b.dev !== bridgeStat.dev || b.ino !== bridgeStat.ino
      || digest() !== bridgeDigest || !n.isFile() || n.dev !== runtimeStat.dev || n.ino !== runtimeStat.ino)
      throw new Error("Broker bridge or runtime changed.");
    accessSync(executable, constants.X_OK);
    const env = options.environment();
    if (Object.keys(env).sort().join(",") !== "ELECTRON_RUN_AS_NODE,PKM_NEXT_MCP_BROKER,PKM_NEXT_MCP_BROKER_TOKEN"
      || env.ELECTRON_RUN_AS_NODE !== "1" || !/^pkm-next-[a-f0-9]{48}$/.test(env.PKM_NEXT_MCP_BROKER)
      || !/^[a-f0-9]{64}$/.test(env.PKM_NEXT_MCP_BROKER_TOKEN)) throw new Error("Invalid broker binding.");
    options.assertCurrent();
    return env;
  };
  const checkDefinition = (definition: T, env: Record<string, string>) => {
    if (definition.label !== label || definition.command !== executable || definition.cwd !== undefined
      || definition.version !== version || JSON.stringify(definition.args) !== JSON.stringify([bridge])
      || !definition.env || Object.keys(definition.env).length !== Object.keys(env).length
      || Object.entries(env).some(([name, value]) => definition.env[name] !== value))
      throw new Error("Next MCP broker definition changed.");
  };
  return {
    provideMcpServerDefinitions(): T[] {
      const env = check();
      active = options.createDefinition(label, executable, [bridge], { ...env }, version);
      checkDefinition(active, env);
      return [active];
    },
    resolveMcpServerDefinition(definition: T): T {
      const env = check();
      if (!active || active !== definition) throw new Error("Next MCP broker definition is stale.");
      checkDefinition(definition, env);
      return definition;
    },
    dispose() { disposed = true; active = undefined; },
  };
}

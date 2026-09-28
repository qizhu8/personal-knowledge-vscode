import * as fs from "fs";
import * as path from "path";

export interface McpStdioCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export function mcpStdioCommand(
  python: string,
  serverArgs: string[],
  platform = process.platform,
  extensionRoot = path.resolve(__dirname, ".."),
  hostExecutable = process.execPath,
  exists: (candidate: string) => boolean = fs.existsSync,
): McpStdioCommand {
  if (platform !== "win32") return { command: python, args: serverArgs };
  const proxy = path.join(extensionRoot, "resources", "windows", "pkm-stdio-proxy.js");
  if (!exists(proxy)) {
    throw new Error(`PKM Windows stdio proxy is missing: ${proxy}`);
  }
  return {
    command: hostExecutable,
    args: [proxy, python, ...serverArgs],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
}

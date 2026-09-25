import * as fs from "fs";
import * as path from "path";

export interface McpStdioCommand {
  command: string;
  args: string[];
}

function windowsLauncherArchitecture(arch: string): string {
  if (arch === "arm64") return "arm64";
  if (arch === "ia32") return "ia32";
  return "x64";
}

export function mcpStdioCommand(
  python: string,
  serverArgs: string[],
  platform = process.platform,
  arch = process.arch,
  extensionRoot = path.resolve(__dirname, ".."),
  exists: (candidate: string) => boolean = fs.existsSync,
): McpStdioCommand {
  if (platform !== "win32") return { command: python, args: serverArgs };
  const launcher = path.join(extensionRoot, "resources", "windows", `pkm-stdio-launcher-${windowsLauncherArchitecture(arch)}.exe`);
  if (!exists(launcher)) {
    throw new Error(`PKM Windows stdio launcher is missing: ${launcher}`);
  }
  return { command: launcher, args: [python, ...serverArgs] };
}

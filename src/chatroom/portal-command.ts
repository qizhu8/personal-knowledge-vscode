import * as path from "path";
import * as fs from "fs/promises";
import { getChatProcess, launchChatProcess, cancelChatProcess, readChatProcessOutput, ChatProcessSpec } from "../chat/chat-process-runtime";

export interface PortalCommand {
  program: string;
  arguments: string[];
  cwd?: string;
  timeoutSeconds: number;
}

export function parsePortalCommand(value: unknown): PortalCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Provide a structured Portal command.");
  const command = value as Record<string, unknown>;
  if (typeof command.program !== "string" || !command.program.trim() || command.program.length > 1024 || command.program.includes("\0")
    || !Array.isArray(command.arguments) || command.arguments.length > 32
    || command.arguments.some(arg => typeof arg !== "string" || arg.includes("\0"))
    || JSON.stringify(command.arguments).length > 8000
    || command.cwd !== undefined && (typeof command.cwd !== "string" || !command.cwd || command.cwd.length > 4096 || command.cwd.includes("\0"))) {
    throw new Error("Invalid Portal program, arguments or working directory.");
  }
  const timeoutSeconds = command.timeoutSeconds ?? 60;
  if (typeof timeoutSeconds !== "number" || !Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 86400) throw new Error("Portal timeoutSeconds must be 1-86400.");
  return { program: command.program, arguments: command.arguments.slice(), ...(typeof command.cwd === "string" ? { cwd: command.cwd } : {}), timeoutSeconds };
}

/** Advertise availability only: no command is run and no credentials are inspected. */
export async function portalCommandCapabilities(): Promise<string[]> {
  const programs = process.platform === "win32" ? ["cmd.exe", "powershell.exe", "pwsh.exe"] : ["sh", "bash", "pwsh"];
  const directories = (process.env.PATH || process.env.Path || "").split(path.delimiter).filter(Boolean);
  const available: string[] = [];
  for (const program of programs) {
    for (const directory of directories) {
      try {
        await fs.access(path.join(directory, program), process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
        available.push(`program:${program.replace(/\.exe$/i, "").toLowerCase()}`);
        break;
      } catch (error) {
        if (!["ENOENT", "ENOTDIR", "EACCES"].includes((error as NodeJS.ErrnoException).code || "")) throw error;
      }
    }
  }
  return [`platform:${process.platform}`, ...available];
}

export async function executePortalCommand(root: string, key: string, command: PortalCommand, defaultCwd: string, signal: AbortSignal) {
  if (signal.aborted) throw new Error("Portal command cancelled before launch.");
  const spec: ChatProcessSpec = { ...parsePortalCommand(command), cwd: command.cwd || defaultCwd };
  if (!path.isAbsolute(spec.cwd)) throw new Error("Portal command working directory must be absolute on the executing Host.");
  let record = await launchChatProcess(root, key, spec);
  let cancellationRequestedAt: number | undefined;
  while (["launching", "running"].includes(record.state)) {
    if (signal.aborted && cancellationRequestedAt === undefined) {
      cancelChatProcess(root, record.handle);
      cancellationRequestedAt = Date.now();
    }
    if (cancellationRequestedAt !== undefined && Date.now() - cancellationRequestedAt > 10_000) {
      throw new Error(`Cancellation is unconfirmed for ${record.handle}; inspect this process, never relaunch it.`);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
    record = getChatProcess(root, record.handle);
  }
  const stdout = readChatProcessOutput(root, record.handle, "stdout", 0, 8000);
  const stderr = readChatProcessOutput(root, record.handle, "stderr", 0, 8000);
  return { execution: "direct-command", modelCalls: 0, handle: record.handle, state: record.state, exitCode: record.exitCode ?? null,
    exitSignal: record.exitSignal ?? null, stdout: stdout.text, stderr: stderr.text,
    stdoutBytes: record.stdoutBytes, stderrBytes: record.stderrBytes, truncated: stdout.end < record.stdoutBytes || stderr.end < record.stderrBytes,
    detail: record.detail };
}

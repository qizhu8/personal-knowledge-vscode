import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { spawn } from "child_process";
import { withCrossProcessLock } from "../runtime/cross-process-lock";
import { mcpStdioCommand } from "../mcp/mcp-stdio-command";

export async function runModelEnvironmentCommand(python: string, args: string[], signal: AbortSignal,
  report: (detail: string) => void): Promise<void> {
  signal.throwIfAborted();
  const launch = mcpStdioCommand(python, args);
  await new Promise<void>((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, ...launch.env, PYTHONNOUSERSITE: "1", PIP_USER: "0", PIP_DISABLE_PIP_VERSION_CHECK: "1" };
    for (const key of ["PYTHONHOME", "PYTHONPATH", "PIP_TARGET", "PIP_PREFIX"]) delete env[key];
    const child = spawn(launch.command, launch.args, {
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    let output = "", failure: Error | undefined;
    const abort = () => { failure = new Error("Embedding runtime preparation cancelled."); child.kill(); };
    const timeout = setTimeout(() => {
      failure = new Error("Embedding runtime preparation exceeded 15 minutes. Check the package download network and retry setup.");
      child.kill();
    }, 15 * 60_000);
    signal.addEventListener("abort", abort, { once: true });
    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      output = (output + text).slice(-16_384);
      const lines = text.trim().split(/\r?\n/);
      const line = lines[lines.length - 1];
      if (line) report(line.slice(0, 300));
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("error", error => { failure = error; });
    child.once("close", code => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0) {
        const network = /SSLError|HANDSHAKE_FAILURE|ProxyError|NewConnectionError|ConnectTimeout|Could not fetch URL|No matching distribution found/i.test(output);
        const hint = network ? "\nPackage download was blocked or unreachable. If your network requires a package mirror, set index-url in pip.ini/pip.conf (or PIP_INDEX_URL) and retry; PKM uses your pip configuration for every package except the CPU torch wheel from download.pytorch.org." : "";
        reject(new Error(`PKM embedding runtime preparation failed (${code}):\n${output}${hint}`));
      }
      else resolve();
    });
    if (signal.aborted) abort();
  });
}

export async function ensureRetrievalModelEnvironment(options: {
  directory: string;
  basePython: string;
  requirements: string;
  signal: AbortSignal;
  report: (detail: string) => void;
  verify: (python: string) => Promise<void>;
  run?: typeof runModelEnvironmentCommand;
}): Promise<string> {
  const { directory, basePython, requirements, signal, report, verify } = options;
  if (!path.isAbsolute(directory)) throw new Error("The PKM embedding environment path must be absolute.");
  const run = options.run || runModelEnvironmentCommand;
  const python = path.join(directory, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  return withCrossProcessLock(`${directory}.setup.lock`, "PKM embedding environment setup", 1000, async () => {
    signal.throwIfAborted();
    const marker = path.join(directory, ".pkm-retrieval-environment.json");
    const fingerprint = createHash("sha256").update(fs.readFileSync(requirements)).update("torch==2.6.0;cpu;no-deps").digest("hex");
    if (fs.existsSync(directory)) {
      if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink() || !fs.existsSync(marker)) {
        throw new Error(`Refusing to install packages into an unrecognized environment: ${directory}. Choose another PKM environments directory.`);
      }
      const saved = JSON.parse(fs.readFileSync(marker, "utf8"));
      if (saved.schema !== 1) throw new Error("Invalid PKM embedding environment ownership marker.");
      if (saved.fingerprint === fingerprint && fs.existsSync(python)) {
        try {
          report("Checking the existing PKM embedding environment");
          await verify(python);
          signal.throwIfAborted();
          return python;
        } catch (error) {
          signal.throwIfAborted();
          if (!(error instanceof Error) || !/\b(?:ImportError|ModuleNotFoundError)\b/.test(error.message)) throw error;
          report(`Repairing missing embedding dependencies: ${error.message}`);
        }
      }
    } else {
      fs.mkdirSync(directory, { mode: 0o700 });
      fs.writeFileSync(marker, JSON.stringify({ schema: 1 }), { mode: 0o600 });
    }
    if (!fs.existsSync(python)) {
      report("Creating the PKM-managed embedding Python environment");
      await run(basePython, ["-m", "venv", directory], signal, report);
    }
    report("Installing CPU model dependencies in the PKM environment");
    await run(python, ["-m", "ensurepip", "--upgrade"], signal, report);
    // Only the CPU torch wheel comes from the PyTorch index; its dependencies and all other
    // requirements resolve through the user's pip configuration (e.g. an IT-mandated mirror).
    if (process.platform !== "darwin") {
      await run(python, ["-m", "pip", "install", "--no-input", "--no-deps", "torch==2.6.0+cpu",
        "--index-url", "https://download.pytorch.org/whl/cpu"], signal, report);
    }
    await run(python, ["-m", "pip", "install", "--no-input", "-r", requirements], signal, report);
    signal.throwIfAborted();
    report("Verifying embedding runtime imports");
    await verify(python);
    signal.throwIfAborted();
    const temporary = `${marker}.${process.pid}.pending`;
    fs.writeFileSync(temporary, JSON.stringify({ schema: 1, fingerprint }), { mode: 0o600 });
    fs.renameSync(temporary, marker);
    return python;
  });
}

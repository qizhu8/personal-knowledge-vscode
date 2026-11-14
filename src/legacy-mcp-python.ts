import { spawn } from "node:child_process";

export async function runLegacyMcpPython(script: string, args: string[], input: unknown): Promise<unknown> {
  const output = await new Promise<string>((resolve, reject) => {
    const isolatedCommand = process.env.PKM_ISOLATED_PYTHON_COMMAND;
    const isolatedBootstrap = process.env.PKM_ISOLATED_PYTHON_BOOTSTRAP;
    if (!!isolatedCommand !== !!isolatedBootstrap) {
      reject(new Error("Incomplete isolated Python executor configuration"));
      return;
    }
    const child = spawn(isolatedCommand || "python3",
      isolatedBootstrap ? ["-I", "-S", isolatedBootstrap, script, ...args] : [script, ...args], {
      stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.stdin.on("error", reject);
    child.once("close", code => {
      if (code !== 0) reject(new Error(`Legacy MCP executor failed: ${Buffer.concat(stderr).toString("utf8").trim() || `exit ${code}`}`));
      else resolve(Buffer.concat(stdout).toString("utf8"));
    });
    child.stdin.end(JSON.stringify(input));
  });
  return JSON.parse(output);
}

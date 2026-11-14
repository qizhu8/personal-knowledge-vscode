import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { CoreError } from "./contracts.js";

/** Owned stdio process only; no endpoint discovery, source-database access, or automatic replay. */
export class LegacyMcpPythonWorker {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending: { resolve: (value: unknown) => void; reject: (error: Error) => void }[] = [];
  private error: Error | undefined;
  private diagnostics = "";
  private readonly exited: Promise<void>;
  private readonly onExit = () => { this.child.kill(); };
  constructor(script: string) {
    const command = process.env.PKM_ISOLATED_PYTHON_COMMAND;
    const bootstrap = process.env.PKM_ISOLATED_PYTHON_BOOTSTRAP;
    if (!!command !== !!bootstrap) throw new CoreError("NOT_AVAILABLE", "Incomplete isolated Python executor configuration.");
    this.child = spawn(command || "python3", bootstrap
      ? ["-I", "-S", bootstrap, script, "--persistent"] : [script, "--persistent"],
    { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
    process.once("exit", this.onExit);
    this.child.stderr.on("data", chunk => { this.diagnostics = (this.diagnostics + chunk.toString()).slice(-8192); });
    createInterface({ input: this.child.stdout }).on("line", line => {
      const call = this.pending.shift();
      if (!call) { this.fail(new CoreError("NOT_AVAILABLE", "Persistent retrieval worker returned an unsolicited result.")); return; }
      try {
        const result = JSON.parse(line);
        if (result.error) call.reject(new CoreError("NOT_AVAILABLE", `Original retrieval worker refused request: ${result.error}`));
        else call.resolve(result.result);
      } catch (error) { call.reject(new CoreError("NOT_AVAILABLE", `Persistent retrieval response is invalid: ${String(error)}`)); }
    });
    this.child.once("error", error => this.fail(error));
    this.child.stdin.on("error", error => this.fail(error));
    this.exited = new Promise(resolve => this.child.once("close", code => {
      process.removeListener("exit", this.onExit);
      this.fail(new CoreError("NOT_AVAILABLE", `Persistent retrieval worker exited (${code}); reconnect explicitly. ${this.diagnostics}`));
      resolve();
    }));
  }
  private fail(error: Error) {
    this.error ??= error;
    for (const call of this.pending.splice(0)) call.reject(this.error);
  }
  execute(input: unknown): Promise<unknown> {
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.child.stdin.write(JSON.stringify(input) + "\n", error => { if (error) this.fail(error); });
    });
  }
  async close() {
    this.child.stdin.end();
    await this.exited;
  }
}

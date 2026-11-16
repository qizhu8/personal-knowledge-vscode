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
  private accepting = true;
  private closing?: Promise<void>;
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
      } catch (error) {
        const failure = new CoreError("NOT_AVAILABLE", `Persistent retrieval response is invalid: ${String(error)}`);
        call.reject(failure);
        this.fail(failure);
      }
    });
    this.child.once("error", error => this.fail(error));
    this.child.stdin.on("error", error => this.fail(error));
    this.exited = new Promise(resolve => this.child.once("close", (code, signal) => {
      process.removeListener("exit", this.onExit);
      if (code !== 0 || signal !== null || this.accepting || this.pending.length)
        this.fail(new CoreError("NOT_AVAILABLE",
          `Persistent retrieval worker exited (${code}, ${signal}); shutdown is unconfirmed. ${this.diagnostics}`));
      this.accepting = false;
      resolve();
    }));
  }
  private fail(error: Error) {
    this.error ??= error;
    for (const call of this.pending.splice(0)) call.reject(this.error);
  }
  execute(input: unknown): Promise<unknown> {
    if (this.error) return Promise.reject(this.error);
    if (!this.accepting) return Promise.reject(new CoreError("NOT_AVAILABLE", "Persistent retrieval worker is closing or exited."));
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.child.stdin.write(JSON.stringify(input) + "\n", error => { if (error) this.fail(error); });
    });
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.accepting = false;
    this.closing = (async () => {
      this.child.stdin.end();
      await this.exited;
      if (this.error) throw this.error;
    })();
    return this.closing;
  }
}

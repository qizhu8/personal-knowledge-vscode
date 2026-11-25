import { Worker } from "node:worker_threads";
import { setImmediate as yieldTurn, setTimeout as sleep } from "node:timers/promises";
import { auditDeployment, stagedValidationMode, type DeploymentAudit, type StartupReceipt } from "./deployment-integrity-worker.js";

export class DeploymentIntegrity {
  private readonly control = new Int32Array(new SharedArrayBuffer(16));
  private worker?: Worker;
  private timer?: NodeJS.Timeout;
  private task?: Promise<DeploymentAudit>;
  private result?: DeploymentAudit;
  private foregroundTask?: Promise<void>;
  private closing?: Promise<void>;
  private stopped = false;
  private phase = "pending";
  private critical?: () => void;
  private warned = false;
  private initializedAt = 0;

  constructor(readonly directory: string, readonly receipt: StartupReceipt) {}

  onCritical(callback: () => void) { this.critical = callback; if (this.result?.state === "critical-failure") callback(); }
  status() {
    return { schema: "pkm.deployment-integrity/v2", mode: stagedValidationMode, phase: this.phase,
      fullVerified: this.result?.state === "verified",
      failedGroups: [...new Set(this.result?.failures.map(failure => failure.group) ?? [])],
      filesChecked: this.result?.files ?? Atomics.load(this.control, 2), bytesRead: this.result?.bytes ?? 0,
      backgroundQuanta: Atomics.load(this.control, 3) };
  }
  assertAdmitted(group = "basic") {
    if (this.result?.state === "critical-failure"
      || group === "browser-ui" && this.result?.failures.some(failure => failure.group === group)
      || group === "all-deployment" && this.result !== undefined && this.result.state !== "verified")
      throw new Error("DEPLOYMENT_INTEGRITY: Deployment validation refused this operation; reconnect and verify. A started mutation may have committed; never replay automatically.");
  }
  async foreground<T>(work: () => Promise<T>): Promise<T> {
    Atomics.add(this.control, 0, 1);
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    try {
      return await work();
    } finally {
      Atomics.sub(this.control, 0, 1);
      this.schedule();
    }
  }
  initialized() { this.initializedAt ||= performance.now() || 1; this.schedule(); }
  private schedule() {
    if (!this.initializedAt || this.stopped || this.task || this.timer || this.result
      || Atomics.load(this.control, 0) > 0) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.start(); }, 100);
    this.timer.unref();
  }
  private accept(result: DeploymentAudit) {
    if (this.result?.state === "critical-failure") return;
    this.result = result;
    this.phase = result.state;
    if (["critical-failure", "partial-failure"].includes(result.state) && !this.warned) {
      this.warned = true;
      process.stderr.write(`PKM deployment integrity: ${result.state}; ${[...new Set(result.failures.map(item => item.group))].join(",")} unavailable; no automatic repair.\n`);
    }
    if (result.state === "critical-failure") { this.cancel(); this.critical?.(); }
  }
  private start() {
    if (this.task || this.stopped || this.result) return;
    this.phase = "verifying";
    let worker: Worker;
    try {
      worker = this.worker = new Worker(new URL("./deployment-integrity-worker.js", import.meta.url), {
        workerData: { schema: "pkm.deployment-audit-worker/v2", directory: this.directory,
          receipt: this.receipt, control: this.control.buffer },
        resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8, stackSizeMb: 2 },
      });
    } catch {
      this.accept({ state: "critical-failure", files: 0, bytes: 0,
        failures: [{ group: "critical", code: "worker-unavailable", path: "" }] });
      return;
    }
    this.task = new Promise(resolve => {
      let settled = false;
      const settle = (result: DeploymentAudit) => {
        if (settled) return;
        settled = true;
        if (!this.stopped || result.state === "critical-failure") this.accept(result);
        resolve(result);
      };
      worker.once("message", settle);
      worker.once("error", () => settle({ state: "critical-failure", files: 0, bytes: 0,
        failures: [{ group: "critical", code: "worker-unavailable", path: "" }] }));
      worker.once("exit", () => {
        if (!settled) settle({ state: this.stopped ? "cancelled" : "critical-failure", files: 0, bytes: 0,
          failures: this.stopped ? [] : [{ group: "critical", code: "worker-exited", path: "" }] });
      });
    });
    worker.unref();
  }
  async ensureCapabilities(group = "native-capabilities", signal?: AbortSignal) {
    this.assertAdmitted(group);
    if (signal?.aborted) throw new Error("Deployment validation request cancelled.");
    if (!this.result || this.result.state === "cancelled") {
      this.foregroundTask ??= (async () => {
        Atomics.add(this.control, 0, 1);
        try {
          const result = await auditDeployment(this.directory, this.receipt, async () => {
            if (this.stopped) throw new Error("deployment-audit-cancelled");
            await yieldTurn();
          });
          this.accept(result);
          if (result.state !== "cancelled") this.cancel();
          if (result.state === "cancelled") throw new Error("Deployment validation cancelled.");
        } finally { Atomics.sub(this.control, 0, 1); }
      })();
      if (!signal) await this.foregroundTask;
      else await new Promise<void>((resolve, reject) => {
        const cancel = () => reject(new Error("Deployment validation request cancelled."));
        signal.addEventListener("abort", cancel, { once: true });
        void this.foregroundTask!.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
      });
    }
    this.assertAdmitted(group);
  }
  cancel() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    Atomics.store(this.control, 1, 1);
    if (!this.result) this.phase = "cancelled";
  }
  close() {
    return this.closing ??= (async () => {
      this.cancel();
      const deadlineAbort = new AbortController();
      const deadline = sleep(150, undefined, { signal: deadlineAbort.signal }).catch(() => undefined);
      try {
        if (this.worker) {
          await Promise.race([this.task?.then(() => undefined), deadline]);
          await this.worker.terminate();
        }
        if (this.foregroundTask) await Promise.race([this.foregroundTask.catch(() => undefined), deadline]);
      } finally {
        deadlineAbort.abort();
      }
    })();
  }
}

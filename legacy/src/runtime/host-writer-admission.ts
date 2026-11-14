import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { withLegacyLinuxRootWriter } from "./linux-root-writer-fence";

type WriterKind = "ui" | "git" | "sync" | "chat";
type State = "accepting" | "draining" | "drained" | "unknown";
type Scope = { owner: HostWriterAdmission; active: boolean };
const scope = new AsyncLocalStorage<Scope>();

/**
 * Counts only work explicitly enrolled through this owner. It does not prove
 * that every writer in the host or any other process has enrolled.
 */
export class HostWriterAdmission {
  private readonly root: string;
  private readonly dev: bigint;
  private readonly ino: bigint;
  private readonly ownerId = randomUUID();
  private readonly startTimeTicks?: string;
  private state: State = "accepting";
  private closed = false;
  private denial = new AbortController();
  private readonly active = new Map<string, WriterKind>();
  private readonly waiters = new Set<() => void>();
  private failure?: string;

  constructor(root: string, private readonly currentRoot: () => string) {
    this.root = path.resolve(root);
    if (fs.realpathSync(root) !== this.root) throw new Error("Host writer root must be canonical.");
    const stat = fs.lstatSync(this.root, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Host writer root is not a real directory.");
    this.dev = stat.dev;
    this.ino = stat.ino;
    if (process.platform === "linux") {
      const processStat = fs.readFileSync("/proc/self/stat", "utf8");
      const close = processStat.lastIndexOf(")");
      const ticks = close >= 0 ? processStat.slice(close + 1).trim().split(/\s+/)[19] : undefined;
      if (!ticks || !/^\d+$/.test(ticks)) throw new Error("Host process identity is unavailable.");
      this.startTimeTicks = ticks;
    }
    this.assertBinding();
  }

  private assertBinding(): void {
    if (this.currentRoot() !== this.root || fs.realpathSync(this.root) !== this.root)
      throw new Error("Host writer root binding changed.");
    const stat = fs.lstatSync(this.root, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== this.dev || stat.ino !== this.ino)
      throw new Error("Host writer root identity changed.");
  }

  /** Preserve the legacy workflow if observation is unavailable, but never
   * turn that loss of coverage into handoff evidence. */
  observe<T>(kind: WriterKind, work: () => Promise<T> | T): Promise<T> {
    if (this.state === "accepting") {
      try { this.assertBinding(); }
      catch {
        this.failure = "root binding changed";
        this.state = "unknown";
      }
    }
    if (this.state === "unknown" && !this.closed) {
      try { return Promise.resolve(work()); }
      catch (error) { return Promise.reject(error); }
    }
    return this.runInternal(kind, work, false);
  }

  run<T>(kind: WriterKind, work: () => Promise<T> | T): Promise<T> {
    return this.runInternal(kind, work, false);
  }

  observeRootReconfiguration<T>(work: () => Promise<T> | T): Promise<T> {
    if (this.state === "accepting") {
      try { this.assertBinding(); }
      catch { this.failure = "root binding changed"; this.state = "unknown"; }
    }
    if (this.state === "unknown" && !this.closed) return this.observe("ui", work);
    return this.runInternal("ui", work, false, true);
  }

  markUncertain(detail: string): void {
    this.failure ||= detail;
    if (this.closed) this.state = "unknown";
  }

  observeSync<T>(kind: WriterKind, work: () => T): T {
    if (this.state === "accepting") {
      try { this.assertBinding(); }
      catch { this.failure = "root binding changed"; this.state = "unknown"; }
    }
    if (this.state === "unknown" && !this.closed) return work();
    const parent = scope.getStore();
    if (this.state !== "accepting" && !((this.state === "draining" || this.state === "unknown" && this.closed)
      && parent?.owner === this && parent.active)) throw new Error("Host writer admission is closed.");
    this.assertBinding();
    const id = randomUUID(), ownScope = { owner: this, active: true };
    this.active.set(id, kind);
    try {
      const result = scope.run(ownScope, work);
      this.assertBinding();
      return result;
    } catch (error) {
      this.failure = "an enrolled writer failed or its outcome is unknown";
      throw error;
    } finally {
      ownScope.active = false;
      this.active.delete(id);
      for (const waiter of this.waiters) waiter();
    }
  }

  /** Cancellation may settle an already admitted request, but cannot prove it
   * had no effects. A drain that used it therefore remains unknown. */
  observeCancellation<T>(work: () => Promise<T> | T): Promise<T> {
    if (this.state === "accepting" || this.state === "unknown" && !this.closed)
      return this.observe("chat", work);
    if ((this.state === "draining" || this.state === "unknown" && this.closed) && this.active.size > 0) {
      this.failure = "cancellation was requested while draining";
      return this.runInternal("chat", work, true);
    }
    return Promise.reject(new Error("Host writer admission is closed."));
  }

  private runInternal<T>(kind: WriterKind, work: () => Promise<T> | T, control: boolean, mayChangeRoot = false): Promise<T> {
    const parent = scope.getStore();
    if (this.state !== "accepting" && !(this.state === "draining"
      && (control || parent?.owner === this && parent.active))
      && !(this.state === "unknown" && this.closed
        && (control && this.active.size > 0 || parent?.owner === this && parent.active)))
      return Promise.reject(new Error("Host writer admission is closed."));
    try { this.assertBinding(); }
    catch (error) {
      this.failure = "root binding changed";
      this.state = "unknown";
      if (!control) return Promise.reject(error);
    }
    const id = randomUUID(), ownScope = { owner: this, active: true };
    this.active.set(id, kind);
    let result: Promise<T>;
    try { result = Promise.resolve(scope.run(ownScope, work)); }
    catch (error) { result = Promise.reject(error); }
    return result.then(value => {
      try { this.assertBinding(); }
      catch (error) {
        this.failure = "root binding changed";
        this.state = "unknown";
        if (!control && !mayChangeRoot) throw error;
      }
      return value;
    }).catch(error => {
      this.failure = "an enrolled writer failed or its outcome is unknown";
      throw error;
    }).finally(() => {
      ownScope.active = false;
      this.active.delete(id);
      for (const waiter of this.waiters) waiter();
    });
  }

  status(): Readonly<{
    ownerId: string; pid: number; startTimeTicks?: string; state: State; inFlight: number;
    kinds: Record<WriterKind, number>; detail?: string;
    completeHostCoverage: false; cutoverAuthorized: false;
  }> {
    if (this.state !== "unknown") {
      try { this.assertBinding(); }
      catch {
        this.failure ||= "root binding changed";
        this.state = "unknown";
      }
    }
    const kinds: Record<WriterKind, number> = { ui: 0, git: 0, sync: 0, chat: 0 };
    for (const kind of this.active.values()) kinds[kind]++;
    return { ownerId: this.ownerId, pid: process.pid,
      ...(this.startTimeTicks ? { startTimeTicks: this.startTimeTicks } : {}),
      state: this.state, inFlight: this.active.size, kinds,
      ...(this.failure ? { detail: this.failure } : {}), completeHostCoverage: false, cutoverAuthorized: false };
  }

  /** This generation's enrolled host scope is synchronously denied on drain. */
  get denySignal(): AbortSignal { return this.denial.signal; }

  assertCurrentRoot(root: string): void {
    if (root !== this.root || this.state !== "accepting" || this.closed || this.failure || this.denial.signal.aborted)
      throw new Error("Host writer scope is not current and accepting.");
    this.assertBinding();
  }

  assertDrainedRoot(root: string): void {
    if (root !== this.root || this.state !== "drained" || !this.closed || this.failure
      || !this.denial.signal.aborted || this.active.size)
      throw new Error("Host writer scope is not completely drained.");
    this.assertBinding();
  }

  resumeAfterFailedDrain(): void {
    if (this.state !== "unknown" || !this.closed || this.active.size)
      throw new Error("Host writer admission cannot resume until failed drain work has settled.");
    withLegacyLinuxRootWriter(this.root, () => {
      this.assertBinding();
      this.closed = false;
      this.denial = new AbortController();
      this.state = "accepting";
    }, 1000);
  }

  async drain(timeoutMs = 30_000): Promise<void> {
    if (this.state !== "accepting") throw new Error("Host writer owner cannot start another drain.");
    this.closed = true;
    this.state = "draining";
    this.denial.abort();
    try {
      this.assertBinding();
      const deadline = Date.now() + Math.max(0, timeoutMs);
      while (this.active.size) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("Host writer drain timed out.");
        await new Promise<void>(resolve => {
          let timer: NodeJS.Timeout;
          const wake = () => { clearTimeout(timer); this.waiters.delete(wake); resolve(); };
          this.waiters.add(wake);
          timer = setTimeout(wake, remaining);
        });
      }
      this.assertBinding();
      if (this.failure) throw new Error(this.failure);
      this.state = "drained";
    } catch (error) {
      this.state = "unknown";
      this.failure = error instanceof Error ? error.message : "Host writer drain failed.";
      throw error;
    }
  }
}

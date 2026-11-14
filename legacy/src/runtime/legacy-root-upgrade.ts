import { ChildProcess, execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export type LegacyRootUpgradeStatus = {
  state: "pending" | "checking" | "blocked" | "unavailable" | "unsupported";
  root: string;
  cutoverAuthorized: false;
  blockers: Array<{ code: string; count: number }>;
  detail: string;
  managedHandoff: ManagedHandoffEvidence;
};

export type ManagedHandoffEvidence = {
  binding: "none" | "bound" | "unknown";
  state?: "accepting" | "draining" | "drained" | "unknown";
  preexistingAndExternalWriters: "unknown";
  cutoverAuthorized: false;
};

// Verify the packaged payload and inspect in a separate process: large roots and
// package hashing must not block the extension host or start a Next server.
const inspectScript = `
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const [verifier, extension, root] = process.argv.slice(1);
(async () => {
  const v = process.versions.node.split(".").map(Number);
  if (v[0] < 22 || (v[0] === 22 && v[1] < 18)) throw new Error("runtime-too-old");
  const payload = require(verifier).verifyNextPayload(extension);
  const api = await import(pathToFileURL(path.join(payload.root, "server/dist/legacy-import.js")).href);
  const report = await api.inspectLegacyRootForAdoption(root);
  if (report.ready !== false || !Array.isArray(report.blockers)) throw new Error("invalid-inspection");
  const counts = Object.create(null);
  for (const blocker of report.blockers) {
    if (typeof blocker.code !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(blocker.code))
      throw new Error("invalid-inspection");
    counts[blocker.code] = (counts[blocker.code] || 0) + 1;
  }
  process.stdout.write(JSON.stringify({ ready: false, blockers: counts }));
})().catch(error => {
  process.stderr.write(error && error.message === "runtime-too-old" ? "runtime-too-old" : "inspection-failed");
  process.exitCode = 1;
});
`;

export class LegacyRootUpgradeCheck {
  private child?: ChildProcess;
  private timer?: NodeJS.Timeout;
  private pending?: Promise<LegacyRootUpgradeStatus>;
  private disposed = false;
  private inspectedRoot?: { device: bigint; inode: bigint };
  private managedRoot?: { device: bigint; inode: bigint };
  private managedProfile?: () => { state: "accepting" | "draining" | "drained" | "unknown";
    preexistingAndExternalWriters: "unknown"; cutoverAuthorized: false };
  private current: LegacyRootUpgradeStatus;

  private rootIdentity(): { device: bigint; inode: bigint } | undefined {
    try {
      if (!this.rootStillCurrent()) return undefined;
      const stat = fs.lstatSync(this.root, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
      return { device: stat.dev, inode: stat.ino };
    } catch {
      return undefined;
    }
  }

  private sameInspectedRoot(): boolean {
    const identity = this.rootIdentity();
    return !!identity && !!this.inspectedRoot && identity.device === this.inspectedRoot.device
      && identity.inode === this.inspectedRoot.inode;
  }

  constructor(private readonly extensionPath: string, private readonly root: string,
    private readonly rootStillCurrent: () => boolean, private readonly executable = process.execPath) {
    this.current = {
      state: process.platform === "linux" ? "pending" : "unsupported", root,
      cutoverAuthorized: false, blockers: [],
      detail: "Read-only assessment only; no automatic original-root cutover is authorized.",
      managedHandoff: { binding: "none", preexistingAndExternalWriters: "unknown", cutoverAuthorized: false },
    };
  }

  bindManagedProfile(observer: () => { state: "accepting" | "draining" | "drained" | "unknown";
    preexistingAndExternalWriters: "unknown"; cutoverAuthorized: false }): void {
    if (this.disposed || this.managedProfile) throw new Error("Managed profile observation is unavailable or already bound.");
    this.managedRoot = this.rootIdentity();
    this.managedProfile = observer;
  }

  status(): LegacyRootUpgradeStatus {
    let managedHandoff: ManagedHandoffEvidence = {
      binding: "none", preexistingAndExternalWriters: "unknown", cutoverAuthorized: false,
    };
    if (this.managedProfile) {
      try {
        const identity = this.rootIdentity();
        if (this.disposed || !identity || !this.managedRoot || identity.device !== this.managedRoot.device
          || identity.inode !== this.managedRoot.inode) throw new Error("stale root binding");
        const status = this.managedProfile();
        if (!["accepting", "draining", "drained", "unknown"].includes(status.state)
          || status.preexistingAndExternalWriters !== "unknown" || status.cutoverAuthorized !== false)
          throw new Error("invalid managed profile observation");
        managedHandoff = { binding: "bound", state: status.state,
          preexistingAndExternalWriters: "unknown", cutoverAuthorized: false };
      } catch {
        managedHandoff = { binding: "unknown", preexistingAndExternalWriters: "unknown", cutoverAuthorized: false };
      }
    }
    if (this.inspectedRoot && !this.sameInspectedRoot()) {
      return { ...this.current, state: "unavailable", managedHandoff, blockers: [],
        detail: "The configured Knowledge Root changed since inspection; no handoff was attempted." };
    }
    return { ...this.current, managedHandoff, blockers: this.current.blockers.map(blocker => ({ ...blocker })) };
  }

  schedule(delayMs = 15_000): void {
    if (this.disposed || this.current.state !== "pending" || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.check(); }, delayMs);
    this.timer.unref?.();
  }

  check(): Promise<LegacyRootUpgradeStatus> {
    if (this.pending) return this.pending;
    if (this.disposed || process.platform !== "linux") return Promise.resolve(this.status());
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const identity = path.isAbsolute(this.root) ? this.rootIdentity() : undefined;
    if (!identity) {
      this.inspectedRoot = undefined;
      this.current = { ...this.current, state: "unavailable", blockers: [],
        detail: "The configured Knowledge Root changed or is not absolute; no handoff was attempted." };
      return Promise.resolve(this.status());
    }
    this.inspectedRoot = identity;
    this.current = { ...this.current, state: "checking", blockers: [],
      detail: "Inspecting the existing root read-only; no handoff is in progress." };
    const task = new Promise<LegacyRootUpgradeStatus>(resolve => {
      const finish = (error: Error | null, stdout: string, stderr: string) => {
        this.child = undefined;
        if (this.disposed || !this.sameInspectedRoot()) {
          this.current = { ...this.current, state: "unavailable", blockers: [],
            detail: "The configured Knowledge Root changed or the host stopped; no handoff was attempted." };
        } else if (error) {
          this.current = { ...this.current, state: "unavailable", blockers: [],
            detail: stderr === "runtime-too-old"
              ? "The VS Code runtime is older than Node 22.18; this read-only assessment is unavailable. Existing workflows remain unchanged."
              : "Read-only assessment failed or timed out; the payload, root or runtime may be unavailable or changing. Existing workflows remain unchanged." };
        } else {
          try {
            const result = JSON.parse(stdout) as { ready: unknown; blockers: Record<string, unknown> };
            if (result.ready !== false || !result.blockers || typeof result.blockers !== "object"
              || Array.isArray(result.blockers)) throw new Error("invalid");
            const blockers = Object.entries(result.blockers).map(([code, count]) => {
              if (!/^[A-Za-z0-9_-]{1,100}$/.test(code) || !Number.isSafeInteger(count) || (count as number) < 1)
                throw new Error("invalid");
              return { code, count: count as number };
            });
            if (!blockers.some(blocker => blocker.code === "direct-adoption-unqualified"))
              throw new Error("invalid");
            this.current = { ...this.current, state: "blocked", blockers,
              detail: "No automatic original-root cutover is authorized. Continue using the existing PKM workflows; no action is needed now. Reloading this window does not complete the migration: the current host and its writers are not yet qualified for a coordinated handoff, and writer isolation, workflow parity and recovery remain unqualified. Do not terminate unrelated processes or delete or move your Knowledge Root or its state. Run this status command again when a supported migration becomes available." };
          } catch {
            this.current = { ...this.current, state: "unavailable", blockers: [],
              detail: "Invalid read-only assessment; no handoff was attempted." };
          }
        }
        resolve(this.status());
      };
      try {
        this.child = execFile(this.executable, ["-e", inspectScript,
          path.join(__dirname, "next-payload-verifier.js"), this.extensionPath, this.root], {
          timeout: 120_000, maxBuffer: 128 * 1024,
          env: { PATH: process.env.PATH || "", ELECTRON_RUN_AS_NODE: "1", NODE_NO_WARNINGS: "1" },
          windowsHide: true,
        }, finish);
      } catch {
        finish(new Error("spawn failed"), "", "");
      }
    });
    this.pending = task;
    void task.then(() => { if (this.pending === task) this.pending = undefined; });
    return task;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.child?.kill();
  }
}

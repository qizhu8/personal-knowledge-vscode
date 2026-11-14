import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { assertManagedEnvironmentHostFence, type ManagedEnvironmentHostFence } from "./managed-writer-session";
import { assertPausedLegacyEnvironmentDispatch, type LegacyEnvironmentDispatchPause } from "./ordinary-environment-legacy-dispatch";
import type { IndependentEnvironmentProfileWriter } from "./ordinary-environment-root-host-effects";
import type { OrdinaryEnvironmentRefreshIntent } from "./ordinary-environment-owner";

type Binding = Readonly<Pick<OrdinaryEnvironmentRefreshIntent, "workspaceId" | "knowledgeRoot" | "globalStorageDirectory">>;
export interface NativeEnvironmentProfileWriter extends IndependentEnvironmentProfileWriter { close(): void }
const issued = new WeakSet<NativeEnvironmentProfileWriter>();
const lockScript = "import fcntl\nfcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)\n";
const identity = (stat: fs.Stats) => `${stat.dev}:${stat.ino}`;

/** Cooperative flock on the original profile directory; no lock-file path mutation. */
export function acquireNativeEnvironmentProfileWriter(options: {
  binding: Binding;
  hostFence: ManagedEnvironmentHostFence;
  dispatchPause: LegacyEnvironmentDispatchPause;
  intent: Readonly<OrdinaryEnvironmentRefreshIntent>;
  lifetime: Readonly<{ signal: AbortSignal; expiresAtMs: number }>;
  supervisorPython: string;
}): NativeEnvironmentProfileWriter {
  const native = require("./ordinary-environment-vscode-authority") as typeof import("./ordinary-environment-vscode-authority");
  native.assertNativeOrdinaryEnvironmentRefreshIntent(options.intent, options.lifetime);
  const binding = Object.freeze({ ...options.binding });
  if (options.intent.workspaceId !== binding.workspaceId || options.intent.knowledgeRoot !== binding.knowledgeRoot
    || options.intent.globalStorageDirectory !== binding.globalStorageDirectory)
    throw new Error("Native profile writer requires the exact approved Root/profile intent.");
  assertManagedEnvironmentHostFence(options.hostFence);
  assertPausedLegacyEnvironmentDispatch(options.dispatchPause, binding);
  if (!path.isAbsolute(options.supervisorPython) || fs.realpathSync(options.supervisorPython) !== options.supervisorPython)
    throw new Error("Native profile locking requires a canonical installed Python helper.");
  const directory = binding.globalStorageDirectory;
  if (fs.realpathSync(directory) !== directory) throw new Error("Original Environment profile must be canonical.");
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  const pin = identity(fs.fstatSync(fd));
  let closed = false, mountIdentity = "";
  const currentDirectory = () => {
    if (closed) throw new Error("Native Environment profile writer is closed.");
    assertManagedEnvironmentHostFence(options.hostFence);
    assertPausedLegacyEnvironmentDispatch(options.dispatchPause, binding);
    const held = fs.fstatSync(fd), named = fs.lstatSync(directory);
    if (!held.isDirectory() || !named.isDirectory() || named.isSymbolicLink()
      || fs.realpathSync(directory) !== directory || identity(held) !== pin || identity(named) !== pin
      || held.uid !== process.getuid!())
      throw new Error("Native Environment profile directory identity changed.");
  };
  const verify = () => {
    currentDirectory();
    const fdinfo = fs.readFileSync(`/proc/self/fdinfo/${fd}`, "utf8");
    if (!/lock:\s+\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+\d+\s+\S+\s+0\s+EOF/.test(fdinfo)
      || fdinfo.match(/^mnt_id:\s*(\d+)$/m)?.[1] !== mountIdentity)
      throw new Error("Native Environment kernel profile lock is no longer current.");
    assertManagedEnvironmentHostFence(options.hostFence);
  };
  try {
    currentDirectory();
    execFileSync(options.supervisorPython, ["-I", "-B", "-c", lockScript], {
      stdio: ["ignore", "pipe", "pipe", fd], timeout: 5000, maxBuffer: 4096,
      env: { PATH: "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1" },
    });
    mountIdentity = fs.readFileSync(`/proc/self/fdinfo/${fd}`, "utf8").match(/^mnt_id:\s*(\d+)$/m)?.[1] || "";
    if (!mountIdentity) throw new Error("Native Environment kernel mount identity is unavailable.");
    const writer: NativeEnvironmentProfileWriter = Object.freeze({
      scope: "ordinary-environments:refresh-profile-writer",
      assertCurrent(expected: Binding) {
        if (expected.workspaceId !== binding.workspaceId || expected.knowledgeRoot !== binding.knowledgeRoot
          || expected.globalStorageDirectory !== binding.globalStorageDirectory)
          throw new Error("Native Environment writer binding changed.");
        verify();
      },
      close() {
        if (closed) return;
        closed = true; fs.closeSync(fd); issued.delete(writer);
      },
    });
    verify(); issued.add(writer); return writer;
  } catch (error) { fs.closeSync(fd); throw error; }
}

export function assertNativeEnvironmentProfileWriter(writer: NativeEnvironmentProfileWriter, binding: Binding): void {
  if (!issued.has(writer)) throw new Error("An actual issued native kernel profile writer is required.");
  writer.assertCurrent(binding);
}

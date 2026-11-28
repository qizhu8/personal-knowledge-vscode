import { spawn } from "node:child_process";

/** A persistent guard inode, never a backup artifact or a stale-PID sentinel. */
export async function acquireSharedManagerControlGuard(path: string, mode: "exclusive" | "shared" = "exclusive") {
  if (process.platform !== "linux") throw new Error("Shared manager controls require Linux kernel guards.");
  const child = spawn("python3", ["-I", "-S", "-u", "-c", [
    "import fcntl,os,stat,sys",
    "fd=os.open(sys.argv[1],os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)",
    "s=os.fstat(fd)",
    "assert stat.S_ISREG(s.st_mode) and s.st_uid==os.getuid() and stat.S_IMODE(s.st_mode)==0o600 and s.st_nlink==1",
    "fcntl.flock(fd,(fcntl.LOCK_SH if sys.argv[2]=='shared' else fcntl.LOCK_EX)|fcntl.LOCK_NB)",
    "print('locked',flush=True)",
    "sys.stdin.buffer.read()",
  ].join("\n"), path, mode], { stdio: ["pipe", "pipe", "pipe"] });
  let exited = false;
  const exit = new Promise<void>((ready, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      exited = true;
      code === 0 && signal === null ? ready() : reject(new Error("Shared manager guard is unavailable or already held."));
    });
  });
  void exit.catch(() => {});
  let marker = "";
  let onData: (bytes: Buffer) => void = () => {};
  try {
    await Promise.race([exit.then(() => { throw new Error("Manager guard exited before admission."); }),
      new Promise<void>((ready, reject) => {
        onData = bytes => {
          if (marker.length + bytes.length > 7) { reject(new Error("Invalid manager guard readiness.")); return; }
          marker += String(bytes);
          if (!"locked\n".startsWith(marker)) reject(new Error("Invalid manager guard readiness."));
          else if (marker === "locked\n") ready();
        };
        child.stdout!.on("data", onData);
      })]);
  } catch (error) {
    child.stdin!.destroy();
    await exit.catch(() => {});
    throw error;
  } finally { child.stdout!.off("data", onData); }
  return {
    assertHeld() { if (exited) throw new Error("Manager guard was lost."); },
    async release() { child.stdin!.end(); await exit; },
  };
}

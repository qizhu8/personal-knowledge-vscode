"""Supervise one private MCP process tree until every owned descendant has exited."""
import ctypes
import os
import subprocess
import sys
import time


def main():
    if sys.platform != "linux" or len(sys.argv) < 3:
        return 125
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:
        return 125
    enabled = ctypes.c_int()
    if libc.prctl(37, ctypes.byref(enabled), 0, 0, 0) != 0 or enabled.value != 1:
        return 125
    try:
        child = subprocess.Popen(sys.argv[1:], close_fds=True)
        code = child.wait()
    except OSError:
        return 125
    deadline = time.monotonic() + 5.0
    clean = code == 0
    while True:
        try:
            pid, status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return 0 if clean else 125
        except InterruptedError:
            continue
        if pid:
            clean = clean and os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0
            continue
        if time.monotonic() >= deadline:
            return 125
        time.sleep(0.02)


if __name__ == "__main__":
    sys.exit(main())

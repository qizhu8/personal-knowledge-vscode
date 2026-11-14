#!/usr/bin/env python3
"""Run qualification commands as the same non-admin user in private namespaces."""
import ctypes
import fcntl
import os
import signal
import socket
import struct
import sys

if len(sys.argv) < 2:
    raise SystemExit("Usage: run-private-python-user.py command [arguments...]")
uid, gid = os.getuid(), os.getgid()
if uid == 0 or os.geteuid() != uid or os.getegid() != gid:
    raise SystemExit("An actual non-admin Linux user is required; no account scanning.")
libc = ctypes.CDLL(None, use_errno=True)


def checked(result):
    if result != 0:
        raise OSError(ctypes.get_errno(), os.strerror(ctypes.get_errno()))


checked(libc.unshare(0x10000000 | 0x40000000 | 0x20000000 | 0x00020000))
with open("/proc/self/uid_map", "w") as file:
    file.write(f"{uid} {uid} 1\n")
with open("/proc/self/setgroups", "w") as file:
    file.write("deny\n")
with open("/proc/self/gid_map", "w") as file:
    file.write(f"{gid} {gid} 1\n")
checked(libc.mount(None, b"/", None, 0x4000 | 0x40000, None))
with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as control:
    request = struct.pack("16sH14s", b"lo", 0, b"")
    current = fcntl.ioctl(control, 0x8913, request)
    flags = struct.unpack_from("H", current, 16)[0]
    fcntl.ioctl(control, 0x8914, struct.pack("16sH14s", b"lo", flags | 1, b""))
child = os.fork()
if child == 0:
    checked(libc.mount(b"proc", b"/proc", b"proc", 0, None))
    os.execvp("bash", ["bash", "-c", '"$@" & workload=$!; wait "$workload"',
                       "pkm-private-user-init", *sys.argv[1:]])


def stop(signum, _frame):
    try:
        os.kill(child, signal.SIGKILL)
    except ProcessLookupError:
        pass
    os.waitpid(child, 0)
    raise SystemExit(128 + signum)


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
_, status = os.waitpid(child, 0)
raise SystemExit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status))

#!/usr/bin/env python3
"""UID-preserving Linux isolation, shared by test suites and private host runners."""
import ctypes
import fcntl
import json
import os
from pathlib import Path
import select
import signal
import socket
import struct
import sys


def checked(result):
    if result != 0:
        raise OSError(ctypes.get_errno(), os.strerror(ctypes.get_errno()))


def main():
    arguments = sys.argv[1:]
    checkout = None
    if arguments[:1] == ["--checkout"]:
        if len(arguments) < 5 or arguments[2] != "--":
            raise SystemExit("Usage: isolate.py --checkout /absolute/checkout -- command [arguments...]")
        checkout = Path(arguments[1])
        arguments = arguments[3:]
    if not arguments:
        raise SystemExit("Usage: isolate.py command [arguments...]")
    uid, gid = os.getuid(), os.getgid()
    if uid == 0 or os.geteuid() != uid or os.getegid() != gid:
        raise SystemExit("An actual non-admin Linux user is required; no uncontained fallback.")
    workspace = None
    if checkout is not None:
        if not checkout.is_absolute() or not (checkout / "package.json").is_file():
            raise SystemExit("An absolute PKM checkout is required.")
        checkout = checkout.resolve()
        workspace = Path(os.environ["PKM_TEST_WORKSPACE"]).resolve()
        if workspace == checkout or checkout in workspace.parents:
            raise SystemExit("Test workspace must be outside the checkout.")
        if json.loads((workspace / "owner.json").read_text())["token"] != os.environ["PKM_TEST_WORKSPACE_TOKEN"]:
            raise SystemExit("Test workspace ownership token does not match.")
        if any(character in str(directory) for directory in [checkout, workspace] for character in ",:\\"):
            raise SystemExit("Overlay paths cannot contain comma, colon or backslash.")

    libc = ctypes.CDLL(None, use_errno=True)
    if os.uname().machine not in ("x86_64", "aarch64"):
        raise SystemExit("Test isolation requires a supported Linux pidfd syscall ABI.")

    def pidfd_open(pid):
        # Verified Linux x86-64/AArch64 syscall ABI, including Python 3.8 without os.pidfd_open.
        descriptor = libc.syscall(434, pid, 0)
        if descriptor < 0:
            checked(-1)
        return descriptor

    coordinator_pid = int(os.environ.get("PKM_TEST_COORDINATOR_PID", os.getppid()))
    if os.getppid() != coordinator_pid:
        raise SystemExit("Test coordinator terminated before isolation setup.")
    coordinator_fd = pidfd_open(coordinator_pid)
    checked(libc.unshare(0x10000000 | 0x40000000 | 0x20000000 | 0x00020000))
    Path("/proc/self/uid_map").write_text(f"{uid} {uid} 1\n")
    Path("/proc/self/setgroups").write_text("deny\n")
    Path("/proc/self/gid_map").write_text(f"{gid} {gid} 1\n")
    checked(libc.prctl(1, signal.SIGKILL, 0, 0, 0))
    if os.getppid() != coordinator_pid or select.select([coordinator_fd], [], [], 0)[0]:
        os._exit(1)
    os.close(coordinator_fd)
    checked(libc.mount(None, b"/", None, 0x4000 | 0x40000, None))
    if checkout is not None:
        lower = str(checkout)
        if os.environ.get("PKM_TEST_PREPARED_ROOT"):
            prepared = Path(os.environ["PKM_TEST_PREPARED_ROOT"]).resolve()
            if prepared == checkout or checkout in prepared.parents:
                raise SystemExit("Prepared test sources must be outside the checkout.")
            if json.loads((prepared / "owner.json").read_text())["token"] != os.environ["PKM_TEST_PREPARED_TOKEN"]:
                raise SystemExit("Prepared test workspace ownership changed.")
            if any(character in str(prepared) for character in ",:\\"):
                raise SystemExit("Prepared overlay path is not supported.")
            checked(libc.mount(os.fsencode(prepared), os.fsencode(prepared), None, 0x1000, None))
            checked(libc.mount(None, os.fsencode(prepared), None, 0x1000 | 0x20 | 1, None))
            lower = f"{prepared / 'upper'}:{checkout}"
        options = f"lowerdir={lower},upperdir={workspace / 'upper'},workdir={workspace / 'overlay-work'},userxattr"
        checked(libc.mount(b"overlay", os.fsencode(checkout), b"overlay", 0, os.fsencode(options)))
        os.chdir(checkout)
        fixture_parent = Path(".migration-test-work")
        if fixture_parent.is_symlink():
            raise SystemExit("Legacy fixture parent must not be a symlink.")
        fixture_parent.mkdir(mode=0o700, exist_ok=True)
        if os.environ.get("PKM_TEST_SUBSCRIPTION_RAM") == "1":
            legacy = checkout / "legacy"
            if legacy.is_symlink() or not legacy.is_dir():
                raise SystemExit("Private subscription RAM fixtures require a real legacy source directory.")
            ram = legacy / ".pkm-test-subscription-ram"
            if ram.is_symlink():
                raise SystemExit("Private subscription RAM fixture parent must not be a symlink.")
            ram.mkdir(mode=0o700, exist_ok=True)
            checked(libc.mount(b"tmpfs", os.fsencode(ram), b"tmpfs", 0x2 | 0x4,
                               b"size=64m,mode=0700"))
            os.environ["PKM_SUBSCRIPTION_TEST_RAM_ROOT"] = str(ram)
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as control:
        current = fcntl.ioctl(control, 0x8913, struct.pack("16sH14s", b"lo", 0, b""))
        flags = struct.unpack_from("H", current, 16)[0]
        fcntl.ioctl(control, 0x8914, struct.pack("16sH14s", b"lo", flags | 1, b""))
    os.environ["PKM_TEST_ISOLATED_NETWORK"] = "1"

    parent_fd = pidfd_open(os.getpid())
    child = os.fork()
    if child == 0:
        # Also stop namespace PID 1 when the coordinator is forcibly killed.
        checked(libc.prctl(1, signal.SIGKILL, 0, 0, 0))
        if select.select([parent_fd], [], [], 0)[0]:
            os._exit(1)
        os.close(parent_fd)
        checked(libc.mount(b"proc", b"/proc", b"proc", 0, None))
        os.execvp("bash", ["bash", "-c", '"$@" & workload=$!; wait "$workload"',
                           "pkm-private-test-init", *arguments])
    os.close(parent_fd)
    child_fd = pidfd_open(child)

    def stop(signum, _frame):
        try:
            checked(libc.syscall(424, child_fd, signal.SIGKILL, None, 0))
        except ProcessLookupError:
            pass
        os.waitpid(child, 0)
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    _, status = os.waitpid(child, 0)
    os.close(child_fd)
    raise SystemExit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status))


if __name__ == "__main__":
    main()

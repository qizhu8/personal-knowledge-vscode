#!/usr/bin/env python3
"""SDK-only stdio runtime supervisor; never a model, credential or business provider."""
import ctypes
import errno
import json
import os
import select
import signal
import socket
import subprocess
import sys
import time

libc = ctypes.CDLL(None, use_errno=True)


def checked(result):
    if result != 0:
        raise OSError(ctypes.get_errno(), os.strerror(ctypes.get_errno()))


def identity(filename):
    info = os.stat(filename, follow_symlinks=False)
    return {key: str(getattr(info, attr)) for key, attr in (
        ("dev", "st_dev"), ("ino", "st_ino"), ("size", "st_size"),
        ("mtimeNs", "st_mtime_ns"), ("ctimeNs", "st_ctime_ns"))}


def restrictive_filter():
    machine = os.uname().machine
    if machine == "x86_64":
        arch, socket_nr, clone_nr = 0xC000003E, 41, 56
        denied = [101, 308, 272, 165, 166, 155, 321, 304, 310, 311, 438,
                  425, 426, 427, 428, 429, 430, 431, 432, 442]
    elif machine == "aarch64":
        arch, socket_nr, clone_nr = 0xC00000B7, 198, 220
        denied = [117, 268, 97, 40, 39, 41, 280, 265, 270, 271, 438,
                  425, 426, 427, 428, 429, 430, 431, 432, 442]
    else:
        raise RuntimeError("Unsupported seccomp architecture")
    # Only IPv4/IPv6 sockets in the fresh disconnected namespace are allowed.
    # No pathname UNIX/vsock proxy, ptrace/pidfd FD theft or namespace/mount escape.
    code = [(0x20, 0, 0, 4), (0x15, 1, 0, arch), (0x06, 0, 0, 0x80000000),
            (0x20, 0, 0, 0), (0x15, 0, 5, socket_nr), (0x20, 0, 0, 16),
            (0x15, 2, 0, socket.AF_INET), (0x15, 1, 0, socket.AF_INET6),
            (0x06, 0, 0, 0x50000 | errno.EPERM), (0x20, 0, 0, 0)]
    for number in denied:
        code.extend([(0x15, 0, 1, number), (0x06, 0, 0, 0x50000 | errno.EPERM)])
    code.extend([(0x15, 0, 1, 435), (0x06, 0, 0, 0x50000 | errno.ENOSYS),
                 (0x15, 0, 4, clone_nr), (0x20, 0, 0, 16),
                 (0x45, 0, 1, 0x10000000 | 0x40000000 | 0x20000000 | 0x00020000),
                 (0x06, 0, 0, 0x50000 | errno.EPERM), (0x20, 0, 0, 0),
                 (0x06, 0, 0, 0x7FFF0000)])

    class Filter(ctypes.Structure):
        _fields_ = [("code", ctypes.c_ushort), ("jt", ctypes.c_ubyte),
                    ("jf", ctypes.c_ubyte), ("k", ctypes.c_uint)]

    class Program(ctypes.Structure):
        _fields_ = [("length", ctypes.c_ushort), ("filter", ctypes.POINTER(Filter))]

    filters = (Filter * len(code))(*(Filter(*entry) for entry in code))
    checked(libc.prctl(38, 1, 0, 0, 0))
    checked(libc.prctl(22, 2, ctypes.byref(Program(len(code), filters)), 0, 0))


def drop_capabilities():
    class Header(ctypes.Structure):
        _fields_ = [("version", ctypes.c_uint), ("pid", ctypes.c_int)]

    class Data(ctypes.Structure):
        _fields_ = [("effective", ctypes.c_uint), ("permitted", ctypes.c_uint),
                    ("inheritable", ctypes.c_uint)]

    checked(libc.capset(ctypes.byref(Header(0x20080522, 0)), (Data * 2)()))


def signal_descendants(signum):
    for name in os.listdir("/proc"):
        if name.isdecimal() and int(name) > 1:
            try:
                os.kill(int(name), signum)
            except ProcessLookupError:
                pass


def main():
    manifest_file, nonce = sys.argv[1:3]
    with open(manifest_file, encoding="utf8") as stream:
        manifest = json.load(stream)
    if (manifest["schema"] != "pkm.sdk-linux-stdio-launch/v1" or manifest["nonce"] != nonce
            or os.getppid() != manifest["hostPid"] or os.getuid() != manifest["uid"]
            or os.readlink("/proc/self/ns/net") != manifest["hostNetworkNamespace"]
            or identity(manifest["python"]) != manifest["pythonIdentity"]
            or identity(manifest["runtimeFile"]) != manifest["runtimeIdentity"]):
        raise RuntimeError("SDK_LAUNCH_IDENTITY_CHANGED")
    allowed_args = ["--headless", "--no-auto-update", "--log-level", "error", "--stdio", "--no-auto-login"]
    if sys.argv[3:] != allowed_args:
        raise RuntimeError("SDK_RUNTIME_ARGUMENTS_DENIED")
    inherited_fds = {int(name) for name in os.listdir("/proc/self/fd")
                   if os.path.exists("/proc/self/fd/" + name)}
    for descriptor in inherited_fds - {0, 1, 2}:
        os.close(descriptor)
    initial_fds = {int(name) for name in os.listdir("/proc/self/fd")
                   if os.path.exists("/proc/self/fd/" + name)}
    if initial_fds - {0, 1, 2}:
        raise RuntimeError("SDK_INHERITED_DESCRIPTOR_DENIED")
    channel = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    channel.connect(manifest["controlSocket"])
    channel.settimeout(15)
    checked(libc.prctl(1, signal.SIGKILL, 0, 0, 0))
    checked(libc.prctl(36, 1, 0, 0, 0))
    supervisor_pid = os.getpid()
    uid, gid = os.getuid(), os.getgid()
    checked(libc.unshare(0x10000000 | 0x40000000 | 0x20000000 | 0x00020000))
    with open("/proc/self/uid_map", "w") as stream:
        stream.write(f"{uid} {uid} 1\n")
    with open("/proc/self/setgroups", "w") as stream:
        stream.write("deny\n")
    with open("/proc/self/gid_map", "w") as stream:
        stream.write(f"{gid} {gid} 1\n")
    checked(libc.mount(None, b"/", None, 0x4000 | 0x40000, None))
    for path in manifest["readonlyPaths"]:
        checked(libc.mount(os.fsencode(path), os.fsencode(path), None, 0x1000, None))
        checked(libc.mount(None, os.fsencode(path), None, 0x1000 | 0x20 | 1, None))
    init_pid = os.fork()
    if init_pid == 0:
        checked(libc.prctl(1, signal.SIGKILL, 0, 0, 0))
        checked(libc.mount(b"proc", b"/proc", b"proc", 0, None))
        interfaces = [name for _, name in socket.if_nameindex()]
        drop_capabilities()
        restrictive_filter()
        probes = {}
        for label, address in [("hostLoopback", ("127.0.0.1", manifest["probePort"])),
                               ("externalTestNet", ("192.0.2.1", 443))]:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
                probe.settimeout(0.25)
                try:
                    probe.connect(address)
                    raise RuntimeError("SDK_EGRESS_PROBE_ESCAPED")
                except OSError as failure:
                    probes[label] = failure.errno
        try:
            socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            raise RuntimeError("SDK_UNIX_PROXY_PROBE_ESCAPED")
        except OSError as failure:
            probes["unixProxy"] = failure.errno
        ready = {"phase": "ready", "nonce": nonce, "supervisorPid": supervisor_pid,
                 "networkNamespace": os.readlink("/proc/self/ns/net"),
                 "pidNamespace": os.readlink("/proc/self/ns/pid"),
                 "interfaces": interfaces,
                 "initialFds": sorted(initial_fds), "blockedProbes": probes}
        channel.sendall((json.dumps(ready) + "\n").encode())
        if channel.recv(128) != b"go\n":
            os._exit(125)
        checked(libc.prctl(4, 0, 0, 0, 0))
        child = subprocess.Popen([manifest["runtimeFile"]] + sys.argv[3:],
                                 stdin=sys.stdin, stdout=sys.stdout, stderr=sys.stderr,
                                 close_fds=True, env=os.environ.copy())
        channel.setblocking(False)
        ending = False
        while child.poll() is None:
            readable, _, _ = select.select([channel], [], [], 0.1)
            if readable:
                try:
                    data = channel.recv(128)
                except BlockingIOError:
                    continue
                if not data or data == b"stop\n":
                    ending = True
                    signal_descendants(signal.SIGTERM)
                    break
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            try:
                reaped, _ = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                break
            if reaped == 0:
                if not ending:
                    ending = True
                    signal_descendants(signal.SIGTERM)
                time.sleep(0.03)
        signal_descendants(signal.SIGKILL)
        while True:
            try:
                os.waitpid(-1, 0)
            except ChildProcessError:
                break
        channel.sendall((json.dumps({"phase": "drained", "nonce": nonce}) + "\n").encode())
        channel.close()
        os._exit(0)
    channel.close()
    _, status = os.waitpid(init_pid, 0)
    sys.exit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 125)


try:
    main()
except Exception as failure:
    # No runtime/provider/credential error text is sent through model/business IPC.
    code = str(failure) if isinstance(failure, RuntimeError) and str(failure).startswith("SDK_") else type(failure).__name__
    sys.stderr.write("NATIVE_SDK_EGRESS_SUPERVISOR_UNSUPPORTED: " + code + "\n")
    sys.exit(125)

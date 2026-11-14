"""Fixture-only proof of openat2 limits; never a product deletion backend."""
import ctypes
import errno
import json
import os
import subprocess
import sys


class OpenHow(ctypes.Structure):
    _fields_ = [
        ("flags", ctypes.c_uint64),
        ("mode", ctypes.c_uint64),
        ("resolve", ctypes.c_uint64),
    ]


def open_directory_at(fd, name):
    if os.uname().machine not in ("x86_64", "aarch64", "riscv64"):
        raise RuntimeError("Unverified openat2 syscall ABI; no fallback")
    libc = ctypes.CDLL(None, use_errno=True)
    libc.syscall.restype = ctypes.c_long
    how = OpenHow(
        os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
        0,
        0x01 | 0x04 | 0x08,  # NO_XDEV | NO_SYMLINKS | BENEATH
    )
    result = libc.syscall(
        ctypes.c_long(437), ctypes.c_int(fd), ctypes.c_char_p(os.fsencode(name)),
        ctypes.byref(how), ctypes.c_size_t(ctypes.sizeof(how)),
    )
    if result < 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code), name)
    return result


def identity(fd):
    stat = os.fstat(fd)
    return stat.st_dev, stat.st_ino


def main():
    base, scenario = sys.argv[1:3]
    if not os.path.isabs(base) or os.path.realpath(base) != base:
        raise RuntimeError("Use a canonical, newly created fixture")
    subprocess.run(["/usr/bin/mount", "--make-rprivate", "/"], check=True)
    parent = os.open(base, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.mkdir("target", dir_fd=parent)
        os.mkdir("victim", dir_fd=parent)
        with open(os.path.join(base, "victim", "sentinel"), "w") as file:
            file.write("keep")
        root = open_directory_at(parent, "target")
        try:
            approved = identity(root)
            if scenario in ("bind", "symlink"):
                os.mkdir("nested", dir_fd=root)
                nested = os.path.join(base, "target", "nested")
                if scenario == "bind":
                    subprocess.run(["/usr/bin/mount", "--bind", os.path.join(base, "victim"), nested], check=True)
                    assert os.stat(nested).st_dev == os.fstat(root).st_dev
                    expected = (errno.EXDEV,)
                else:
                    os.rmdir("nested", dir_fd=root)
                    os.symlink(os.path.join(base, "victim"), "nested", dir_fd=root)
                    expected = (errno.ELOOP, errno.ENOTDIR)
                try:
                    child = open_directory_at(root, "nested")
                except OSError as error:
                    assert error.errno in expected, error
                    result = {"scenario": scenario, "errno": error.errno, "victim_preserved": True}
                else:
                    os.close(child)
                    raise AssertionError("Unsafe transition was admitted")
            elif scenario == "bound-root":
                with open(os.path.join(base, "target", "owned"), "w") as file:
                    file.write("approved")
                os.rename("target", "preserved", src_dir_fd=parent, dst_dir_fd=parent)
                os.symlink(os.path.join(base, "victim"), "target", dir_fd=parent)
                assert identity(root) == approved
                os.unlink("owned", dir_fd=root)
                result = {"scenario": scenario, "root_identity_bound": True, "victim_preserved": True}
            elif scenario == "root-unlink-race":
                libc = ctypes.CDLL(None, use_errno=True)
                libc.unlinkat.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int]
                libc.unlinkat.restype = ctypes.c_int
                assert libc.unlinkat(root, b"", 0x200 | 0x1000) == -1
                fd_only_errno = ctypes.get_errno()
                assert fd_only_errno == errno.EINVAL
                stat = os.stat("target", dir_fd=parent, follow_symlinks=False)
                assert (stat.st_dev, stat.st_ino) == approved
                os.rename("target", "preserved", src_dir_fd=parent, dst_dir_fd=parent)
                os.mkdir("target", dir_fd=parent)
                replacement = open_directory_at(parent, "target")
                try:
                    assert identity(replacement) != approved
                    os.rmdir("target", dir_fd=parent)
                    assert os.fstat(replacement).st_nlink == 0
                    assert identity(root) == approved
                    result = {"scenario": scenario, "wrong_root_removed": True, "approved_root_preserved": True,
                              "fd_only_unlink_errno": fd_only_errno}
                finally:
                    os.close(replacement)
            else:
                raise RuntimeError("Unknown fixture scenario")
            assert os.path.isfile(os.path.join(base, "victim", "sentinel"))
            print(json.dumps(result))
        finally:
            os.close(root)
    finally:
        os.close(parent)


if __name__ == "__main__":
    main()

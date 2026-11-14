"""Shared Linux writer admission for legacy MCP and Action mutations."""
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import time

LOCK_DIRECTORY = ".pkm-next-root-adoption-locks"


def assert_no_sibling_preview(directory, sibling_lock, sibling_marker):
    try:
        old_directory_stat = directory.lstat()
    except FileNotFoundError:
        pass
    else:
        if (not stat.S_ISDIR(old_directory_stat.st_mode) or stat.S_ISLNK(old_directory_stat.st_mode)
                or old_directory_stat.st_uid != os.getuid() or old_directory_stat.st_mode & 0o077):
            raise RuntimeError("The previous sibling writer-fence directory is unsafe.")
    for old_path in (sibling_lock, sibling_marker):
        try:
            old_path.lstat()
        except FileNotFoundError:
            continue
        raise RuntimeError("A previous experimental sibling writer fence requires recovery.")


@contextlib.contextmanager
def legacy_writer(root, timeout_seconds=30):
    if not sys_platform_linux():
        yield
        return
    canonical = Path(root).resolve(strict=True)
    if not canonical.is_dir():
        raise RuntimeError("Writer fencing requires a real Knowledge Root.")
    root_hash = hashlib.sha256(os.fsencode(str(canonical))).hexdigest()[:40]
    directory = canonical.parent / LOCK_DIRECTORY
    sibling_lock = directory / (root_hash + ".writer.lock")
    sibling_marker = directory / (root_hash + ".writer-fenced.json")
    assert_no_sibling_preview(directory, sibling_lock, sibling_marker)
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(canonical, flags)
    try:
        lock_stat = os.fstat(descriptor)
        path_stat = os.lstat(canonical)
        if (not stat.S_ISDIR(lock_stat.st_mode)
                or stat.S_ISLNK(path_stat.st_mode) or lock_stat.st_dev != path_stat.st_dev
                or lock_stat.st_ino != path_stat.st_ino):
            raise RuntimeError("The fenced Knowledge Root identity changed.")
        deadline = time.monotonic() + timeout_seconds
        while True:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_SH | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise RuntimeError("The Knowledge Root is held by next-server; legacy writes were not started.")
                time.sleep(0.025)
        assert_no_sibling_preview(directory, sibling_lock, sibling_marker)
        path_stat = os.lstat(canonical)
        if path_stat.st_dev != lock_stat.st_dev or path_stat.st_ino != lock_stat.st_ino:
            raise RuntimeError("The fenced Knowledge Root identity changed.")
        try:
            (canonical / ".pkm-next-root-adoption-rollback.json").lstat()
        except FileNotFoundError:
            pass
        else:
            raise RuntimeError("A Knowledge Root rollback is pending; legacy writes are fenced.")
        marker_path = canonical / ".pkm-next-writer-fenced.json"
        try:
            marker_stat = marker_path.lstat()
            if (not stat.S_ISREG(marker_stat.st_mode) or stat.S_ISLNK(marker_stat.st_mode)
                    or marker_stat.st_nlink != 1 or marker_stat.st_mode & 0o077
                    or marker_stat.st_uid != os.getuid() or marker_stat.st_size > 4096):
                raise RuntimeError("The durable writer-fence marker is unsafe.")
            marker = json.loads(marker_path.read_text(encoding="utf-8"))
            root_stat = canonical.stat()
            expected = {
                "schema": "pkm.linux-root-writer-fence/v1",
                "root": str(canonical),
                "device": str(root_stat.st_dev),
                "inode": str(root_stat.st_ino),
                "owner": "next-server",
            }
            if marker != expected:
                raise RuntimeError("The durable writer-fence marker does not match this Knowledge Root.")
            raise RuntimeError("This Knowledge Root has been handed to next-server; legacy writes are fenced.")
        except FileNotFoundError:
            pass
        yield
    finally:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
        finally:
            os.close(descriptor)


def sys_platform_linux():
    return os.name == "posix" and __import__("sys").platform.startswith("linux")

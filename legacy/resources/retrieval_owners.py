import hashlib
import json
import os
import re
import secrets
import stat
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path


_UUID = re.compile(r"^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$")
_SECRET = re.compile(r"^[0-9a-f]{64}$")
_SCHEMA = "pkm.retrieval-owner/v1"


class RetrievalOwners:
    """Append-only admissions; a missing completion remains unknown after a crash."""

    def __init__(self, state):
        self.directory = Path(state) / "owners"
        self.directory.mkdir(mode=0o700, exist_ok=True)
        stat = self.directory.lstat()
        if not self.directory.is_dir() or self.directory.is_symlink() or stat.st_uid != os.getuid() or stat.st_mode & 0o077:
            raise ValueError("Retrieval owner directory is not private and owned")
        self.lock = threading.Lock()
        self.runtime = None

    @contextmanager
    def _locked(self, timeout=10):
        import fcntl
        deadline = time.monotonic() + timeout
        if not self.lock.acquire(timeout=timeout):
            raise TimeoutError("Retrieval owner lock timed out; state is unknown")
        try:
            path = self.directory / ".lock"
            fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            try:
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or info.st_mode & 0o077:
                    raise ValueError("Retrieval owner lock is unsafe")
                while True:
                    try:
                        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        break
                    except BlockingIOError:
                        if time.monotonic() >= deadline:
                            raise TimeoutError("Retrieval owner lock timed out; state is unknown")
                        time.sleep(0.01)
                try:
                    yield
                finally:
                    fcntl.flock(fd, fcntl.LOCK_UN)
            finally:
                os.close(fd)
        finally:
            self.lock.release()

    def begin_runtime(self):
        with self._locked():
            directory = self.directory / "runtimes"
            directory.mkdir(mode=0o700, exist_ok=True)
            stat = directory.lstat()
            if not directory.is_dir() or directory.is_symlink() or stat.st_uid != os.getuid() or stat.st_mode & 0o077:
                raise ValueError("Retrieval runtime receipts are unsafe")
            marker = self.directory / ".draining"
            if os.path.lexists(marker):
                record = self._read(marker)
                if set(record) != {"schema", "id"} or record["schema"] != _SCHEMA or not _UUID.fullmatch(record["id"]):
                    raise ValueError("Retrieval draining marker is invalid")
                marker.unlink()
                self._sync_directory(self.directory)
            self.runtime = str(uuid.uuid4())
            self._write(directory / (self.runtime + ".open"), {"schema": _SCHEMA, "id": self.runtime})

    def _unknown_runtimes(self):
        directory = self.directory / "runtimes"
        if self.runtime is None:
            return 0
        names = sorted(os.listdir(directory))
        if len(names) > 100000:
            raise ValueError("Retrieval runtime inventory exceeds its bound")
        ids = set()
        for name in names:
            match = re.fullmatch(r"([0-9a-f-]{36})\.(open|close)", name)
            if not match or not _UUID.fullmatch(match.group(1)):
                raise ValueError("Unknown retrieval runtime receipt")
            ids.add(match.group(1))
        unknown = 0
        for runtime in ids:
            record = {"schema": _SCHEMA, "id": runtime}
            if self._read(directory / (runtime + ".open")) != record:
                raise ValueError("Invalid retrieval runtime receipt")
            close = directory / (runtime + ".close")
            if close.exists():
                if self._read(close) != record:
                    raise ValueError("Invalid retrieval runtime completion")
            elif runtime != self.runtime:
                unknown += 1
        return unknown

    def finish_runtime(self):
        with self._locked():
            if self.runtime is None:
                raise ValueError("Retrieval runtime is not registered")
            self._write(self.directory / "runtimes" / (self.runtime + ".close"),
                        {"schema": _SCHEMA, "id": self.runtime})
            marker = self.directory / ".draining"
            if os.path.lexists(marker):
                if self._read(marker) != {"schema": _SCHEMA, "id": self.runtime}:
                    raise ValueError("Retrieval draining marker changed")
                marker.unlink()
                self._sync_directory(self.directory)

    def _mark_draining(self):
        if self.runtime is not None:
            self._write(self.directory / ".draining", {"schema": _SCHEMA, "id": self.runtime})

    def _read(self, path):
        before = path.lstat()
        if not path.is_file() or path.is_symlink() or before.st_uid != os.getuid() or before.st_nlink != 1 or before.st_mode & 0o077 or before.st_size > 4096:
            raise ValueError("Retrieval owner record is unsafe")
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            opened = os.fstat(fd)
            if (opened.st_dev, opened.st_ino, opened.st_size) != (before.st_dev, before.st_ino, before.st_size):
                raise ValueError("Retrieval owner record changed")
            with os.fdopen(fd, "rb", closefd=False) as file:
                data = file.read(4097)
            after = os.fstat(fd)
            if len(data) != before.st_size or (after.st_mtime_ns, after.st_ctime_ns) != (before.st_mtime_ns, before.st_ctime_ns):
                raise ValueError("Retrieval owner record changed")
            return json.loads(data)
        finally:
            os.close(fd)

    def _write(self, path, value):
        data = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            with os.fdopen(fd, "wb", closefd=False) as file:
                file.write(data)
                file.flush()
            os.fsync(fd)
        finally:
            os.close(fd)
        self._sync_directory(path.parent)

    def _sync_directory(self, directory):
        fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def _live(self, owner_id):
        record = self._read(self.directory / (owner_id + ".open"))
        try:
            if (record.get("boot") != Path("/proc/sys/kernel/random/boot_id").read_text().strip()
                    or record.get("pid_namespace") != os.readlink("/proc/self/ns/pid")):
                return False
            proc = Path("/proc") / str(record["pid"])
            stat = (proc / "stat").read_text()
            fields = stat[stat.rfind(")") + 2:].split()
            return (len(fields) > 19 and fields[0] not in {"Z", "X"} and fields[19] == record["start"]
                    and proc.stat().st_uid == os.getuid()
                    and os.readlink(proc / "ns/pid") == os.readlink("/proc/self/ns/pid"))
        except OSError:
            return False

    def _pending(self):
        names = sorted(name for name in os.listdir(self.directory) if name not in {"runtimes", ".lock", ".draining"})
        if len(names) > 100000:
            raise ValueError("Retrieval owner inventory exceeds its bound")
        ids = set()
        for name in names:
            match = re.fullmatch(r"([0-9a-f-]{36})\.(open|close)", name)
            if not match or not _UUID.fullmatch(match.group(1)):
                raise ValueError("Unknown retrieval owner state")
            ids.add(match.group(1))
        pending = set()
        for owner_id in ids:
            opened = self._read(self.directory / (owner_id + ".open"))
            if set(opened) not in ({"schema", "id", "host", "pid", "start", "proof"},
                                   {"schema", "id", "host", "pid", "start", "proof", "boot", "pid_namespace"}) or opened["schema"] != _SCHEMA \
                    or opened["id"] != owner_id or not _UUID.fullmatch(opened["host"]) \
                    or not isinstance(opened["pid"], int) or opened["pid"] <= 1 \
                    or not isinstance(opened["start"], str) or not opened["start"].isdigit() \
                    or not _SECRET.fullmatch(opened["proof"]):
                raise ValueError("Invalid retrieval owner admission")
            if "boot" in opened and (not isinstance(opened["boot"], str) or not _UUID.fullmatch(opened["boot"])
                                      or not isinstance(opened["pid_namespace"], str)
                                      or not re.fullmatch(r"pid:\[\d+\]", opened["pid_namespace"])):
                raise ValueError("Invalid retrieval owner namespace")
            close = self.directory / (owner_id + ".close")
            if not close.exists():
                pending.add(owner_id)
            elif self._read(close) != {"schema": _SCHEMA, "id": owner_id, "proof": opened["proof"]}:
                raise ValueError("Invalid retrieval owner completion")
        return pending

    def open(self, owner_id, host, pid, start, proof, accepting):
        if not isinstance(owner_id, str) or not _UUID.fullmatch(owner_id) or not isinstance(host, str) or not _UUID.fullmatch(host) \
                or not isinstance(pid, int) or isinstance(pid, bool) or pid <= 1 \
                or not isinstance(start, str) or not start.isdigit() or not isinstance(proof, str) or not _SECRET.fullmatch(proof):
            raise ValueError("Invalid retrieval owner")
        digest = hashlib.sha256(proof.encode()).hexdigest()
        record = {"schema": _SCHEMA, "id": owner_id, "host": host, "pid": pid, "start": start, "proof": digest,
                  "boot": Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
                  "pid_namespace": os.readlink("/proc/self/ns/pid")}
        with self._locked():
            if os.path.lexists(self.directory / ".draining") or not accepting():
                raise ValueError("Retrieval worker is draining")
            self._pending()
            target = self.directory / (owner_id + ".open")
            if target.exists():
                if self._read(target) != record or (self.directory / (owner_id + ".close")).exists():
                    raise ValueError("Retrieval owner cannot be rebound")
            else:
                self._write(target, record)

    def close(self, owner_id, proof, drain):
        if not isinstance(owner_id, str) or not _UUID.fullmatch(owner_id) or not isinstance(proof, str) or not _SECRET.fullmatch(proof):
            raise ValueError("Invalid retrieval owner proof")
        with self._locked():
            pending = self._pending()
            if owner_id not in pending:
                raise ValueError("Retrieval owner is not active")
            opened = self._read(self.directory / (owner_id + ".open"))
            digest = hashlib.sha256(proof.encode()).hexdigest()
            if not secrets.compare_digest(opened["proof"], digest):
                raise ValueError("Retrieval owner proof does not match")
            self._write(self.directory / (owner_id + ".close"), {"schema": _SCHEMA, "id": owner_id, "proof": digest})
            remaining = self._pending()
            if not remaining and not self._unknown_runtimes():
                self._mark_draining()
                drain()
                return {"remaining": 0, "shutdown": True, "unknown": False}
            return {"remaining": len(remaining), "shutdown": False,
                    "unknown": bool(self._unknown_runtimes()) or any(not self._live(owner) for owner in remaining)}

    def pending(self):
        with self._locked():
            return len(self._pending())

    def close_without_runtime(self, owner_id, proof):
        if not isinstance(owner_id, str) or not _UUID.fullmatch(owner_id) or not isinstance(proof, str) or not _SECRET.fullmatch(proof):
            raise ValueError("Invalid retrieval owner proof")
        with self._locked():
            if os.path.lexists(self.directory.parent / "worker.json"):
                return False
            directory = self.directory / "runtimes"
            if os.path.lexists(directory):
                stat = directory.lstat()
                if not directory.is_dir() or directory.is_symlink() or stat.st_uid != os.getuid() or stat.st_mode & 0o077:
                    raise ValueError("Retrieval runtime receipts are unsafe")
                names = sorted(os.listdir(directory))
                if len(names) > 100000:
                    raise ValueError("Retrieval runtime inventory exceeds its bound")
                ids = set()
                for name in names:
                    match = re.fullmatch(r"([0-9a-f-]{36})\.(open|close)", name)
                    if not match or not _UUID.fullmatch(match.group(1)):
                        raise ValueError("Unknown retrieval runtime receipt")
                    ids.add(match.group(1))
                for runtime in ids:
                    record = {"schema": _SCHEMA, "id": runtime}
                    if self._read(directory / (runtime + ".open")) != record:
                        raise ValueError("Invalid retrieval runtime receipt")
                    close = directory / (runtime + ".close")
                    if not os.path.lexists(close):
                        return False
                    if self._read(close) != record:
                        raise ValueError("Invalid retrieval runtime completion")
            pending = self._pending()
            if owner_id not in pending:
                raise ValueError("Retrieval owner is not active")
            opened = self._read(self.directory / (owner_id + ".open"))
            digest = hashlib.sha256(proof.encode()).hexdigest()
            if not secrets.compare_digest(opened["proof"], digest):
                raise ValueError("Retrieval owner proof does not match")
            self._write(self.directory / (owner_id + ".close"), {"schema": _SCHEMA, "id": owner_id, "proof": digest})
            return True

    def request_shutdown(self, drain):
        with self._locked():
            if os.path.lexists(self.directory / ".draining") or self._pending() or self._unknown_runtimes():
                return False
            self._mark_draining()
            return drain()

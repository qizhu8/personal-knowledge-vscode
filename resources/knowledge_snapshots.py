"""Private, immutable Git snapshots of active knowledge, managed through MCP."""
import argparse
import asyncio
import contextlib
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import uuid
from zoneinfo import ZoneInfo

from knowledge_mutations import trash_file

AREAS = ("skills", "notes", "papers", "prompts", "scripts")
UTC = timezone.utc


def _systemctl_user(*arguments):
    environment = os.environ.copy()
    if not environment.get("XDG_RUNTIME_DIR"):
        runtime = Path("/run/user") / str(os.getuid())
        metadata = runtime.stat(follow_symlinks=False)
        if (not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.getuid()
                or stat.S_IMODE(metadata.st_mode) != 0o700):
            raise RuntimeError("A private, user-owned systemd runtime directory is required: " + str(runtime))
        environment["XDG_RUNTIME_DIR"] = str(runtime)
    result = subprocess.run(["systemctl", "--user", *arguments], env=environment,
                            capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError("systemctl --user " + " ".join(arguments) + " failed: "
                           + (result.stderr.strip() or result.stdout.strip() or str(result.returncode)))
    return result.stdout


def _sha(content):
    return hashlib.sha256(content).hexdigest()


def _json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with temporary.open("x", encoding="utf-8") as output:
            json.dump(value, output, ensure_ascii=False, indent=2)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


@contextlib.contextmanager
def _lock(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as descriptor:
        if os.name == "nt":
            import msvcrt
            descriptor.write(b"\0")
            descriptor.flush()
            descriptor.seek(0)
            msvcrt.locking(descriptor.fileno(), msvcrt.LK_LOCK, 1)
            try:
                yield
            finally:
                descriptor.seek(0)
                msvcrt.locking(descriptor.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(descriptor.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(descriptor.fileno(), fcntl.LOCK_UN)


def next_run(local_time, zone, now=None):
    if not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", local_time):
        raise ValueError("local_time must be HH:MM.")
    location = ZoneInfo(zone)
    now = now or datetime.now(UTC)
    local = now.astimezone(location)
    hour, minute = map(int, local_time.split(":"))
    target = local.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if target <= local:
        target = (local + timedelta(days=1)).replace(hour=hour, minute=minute, second=0, microsecond=0)
    return {"next_run_utc": target.astimezone(UTC).isoformat(),
            "next_run_local": target.isoformat(), "abbreviation": target.tzname(),
            "timezone": zone, "local_time": local_time}


class KnowledgeSnapshots:
    def __init__(self, root, node=None, extension_root=None):
        self.root = Path(root).resolve(strict=True)
        self.state = self.root / ".pkm" / "state" / "knowledge-snapshots"
        for parent in (self.root / ".pkm", self.root / ".pkm" / "state", self.state):
            if parent.is_symlink():
                raise ValueError("Snapshot state must not use symlinks.")
        self.repository = self.state / "repository.git"
        self.node = node
        self.extension_root = extension_root

    def git(self, *args, content=None, env=None):
        result = subprocess.run(["git", "--git-dir=" + str(self.repository), *args],
                                input=content, capture_output=True, check=True, timeout=180,
                                env={**os.environ, **(env or {})})
        return result.stdout

    def inventory(self):
        files = {}
        def walk(directory):
            if directory.is_symlink():
                raise ValueError("Snapshot refuses symlinks: " + str(directory))
            if not directory.exists():
                return
            for file in sorted(directory.iterdir()):
                if file.name in (".git", ".trash"):
                    continue
                if file.is_symlink():
                    raise ValueError("Snapshot refuses symlinks: " + str(file))
                if file.is_dir():
                    walk(file)
                elif file.is_file():
                    before = file.stat()
                    content = file.read_bytes()
                    after = file.stat()
                    if (before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns):
                        raise RuntimeError("Knowledge changed during snapshot: " + str(file))
                    files[file.relative_to(self.root).as_posix()] = {
                        "content": content, "sha256": _sha(content),
                        "mode": "100755" if after.st_mode & 0o100 else "100644"}
        for area in AREAS:
            walk(self.root / area)
        return files

    @staticmethod
    def fingerprint(files):
        return _sha(json.dumps({path: [row["mode"], row["sha256"]]
                                for path, row in sorted(files.items())}).encode())

    def _create(self, reason):
        self.state.mkdir(parents=True, exist_ok=True)
        self.state.chmod(0o700)
        if not self.repository.exists():
            subprocess.run(["git", "init", "--bare", str(self.repository)], capture_output=True, check=True)
        files = self.inventory()
        if not files:
            raise ValueError("Refusing an empty knowledge snapshot.")
        index = self.state / ("index-" + uuid.uuid4().hex)
        environment = {"GIT_INDEX_FILE": str(index), "GIT_AUTHOR_NAME": "PKM Snapshot",
                       "GIT_AUTHOR_EMAIL": "pkm@localhost", "GIT_COMMITTER_NAME": "PKM Snapshot",
                       "GIT_COMMITTER_EMAIL": "pkm@localhost"}
        now = datetime.now(UTC)
        name = "pkm-snapshot-" + now.strftime("%Y-%m-%dT%H-%M-%SZ-") + uuid.uuid4().hex[:8]
        metadata = {"schema": "pkm.knowledge-snapshot/v1", "tag": name, "created_utc": now.isoformat(),
                    "reason": reason, "areas": list(AREAS), "files": len(files),
                    "inventory_sha256": self.fingerprint(files), "private": True}
        try:
            records = []
            for relative, row in files.items():
                blob = self.git("hash-object", "-w", "--stdin", content=row["content"]).strip().decode()
                records.append((row["mode"] + " " + blob + "\t" + relative).encode() + b"\0")
            privacy = self.root / ".pkm" / "content-privacy.json"
            if privacy.exists():
                if privacy.is_symlink():
                    raise ValueError("Privacy configuration is a symlink.")
                blob = self.git("hash-object", "-w", "--stdin", content=privacy.read_bytes()).strip().decode()
                records.append(("100644 " + blob + "\t.pkm/content-privacy.json").encode() + b"\0")
            self.git("update-index", "-z", "--index-info", content=b"".join(records), env=environment)
            tree = self.git("write-tree", env=environment).strip().decode()
            if self.fingerprint(self.inventory()) != metadata["inventory_sha256"]:
                raise RuntimeError("Knowledge changed during snapshot; no tag was published.")
            previous = self.git("for-each-ref", "--format=%(objectname)", "refs/heads/snapshots").strip().decode()
            arguments = ["commit-tree", tree, "-m", json.dumps(metadata)]
            if previous:
                arguments += ["-p", previous]
            commit = self.git(*arguments, env=environment).strip().decode()
            tag_data = (f"object {commit}\ntype commit\ntag {name}\n"
                        f"tagger PKM Snapshot <pkm@localhost> {int(now.timestamp())} +0000\n\n"
                        + json.dumps(metadata) + "\n").encode()
            tag_object = self.git("mktag", content=tag_data).strip().decode()
            transaction = (f"start\nupdate refs/heads/snapshots {commit} {previous or '0' * 40}\n"
                           f"create refs/tags/{name} {tag_object}\nprepare\ncommit\n").encode()
            self.git("update-ref", "--stdin", content=transaction)
            metadata["commit"] = commit
            _json(self.state / "latest.json", metadata)
            return metadata
        finally:
            index.unlink(missing_ok=True)
            Path(str(index) + ".lock").unlink(missing_ok=True)

    def create(self, reason="manual"):
        with _lock(self.state / "snapshot.lock"):
            return self._create(reason)

    def status(self):
        config = self.state / "schedule.json"
        settings = json.loads(config.read_text()) if config.exists() else {
            "enabled": False, "local_time": "17:00", "timezone": "America/Los_Angeles"}
        latest = self.state / "latest.json"
        tags = self.git("tag", "--list", "pkm-snapshot-*").decode().splitlines() if self.repository.exists() else []
        return {**settings, **next_run(settings["local_time"], settings["timezone"]),
                "repository": str(self.repository), "tags": tags,
                "latest": json.loads(latest.read_text()) if latest.exists() else None}

    def restore_preview(self, tag):
        if not re.fullmatch(r"pkm-snapshot-[0-9TZ-]+[0-9a-f]{8}", tag):
            raise ValueError("Select an existing PKM snapshot tag.")
        commit = self.git("rev-parse", "--verify", "refs/tags/" + tag + "^{commit}").strip().decode()
        targets = {}
        for record in self.git("ls-tree", "-r", "-z", commit).split(b"\0"):
            if not record:
                continue
            header, relative = record.split(b"\t", 1)
            mode, kind, object_id = header.decode().split()
            relative = relative.decode("utf-8")
            if relative == ".pkm/content-privacy.json":
                continue
            if (relative.split("/")[0] not in AREAS or mode not in ("100644", "100755")
                    or kind != "blob" or any(part in (".", "..", ".trash", ".git", "") for part in relative.split("/"))):
                raise ValueError("Unsafe snapshot tree.")
            targets[relative] = {"object": object_id, "mode": mode,
                                 "sha256": _sha(self.git("cat-file", "blob", object_id))}
        current = self.inventory()
        changes = []
        for relative in sorted(current.keys() | targets.keys()):
            before, target = current.get(relative), targets.get(relative)
            if before and target and before["sha256"] == target["sha256"] and before["mode"] == target["mode"]:
                continue
            changes.append({"path": relative, "before_sha256": before["sha256"] if before else None,
                            "target": target, "action": "restore" if target else "trash"})
        plan = {"schema": "pkm.snapshot-restore/v1", "tag": tag, "commit": commit,
                "knowledge_root": str(self.root), "inventory_sha256": self.fingerprint(current),
                "target_inventory_sha256": self.fingerprint(targets), "changes": changes}
        identifier = uuid.uuid4().hex
        file = self.state / "previews" / (identifier + ".json")
        _json(file, plan)
        return {"preview_id": identifier, "approved_sha256": _sha(file.read_bytes()),
                "changes": changes, "privacy_policy": "Current privacy configuration is preserved, never weakened."}

    def restore_apply(self, preview_id, approved_sha256):
        if not re.fullmatch(r"[a-f0-9]{32}", preview_id):
            raise ValueError("Invalid preview ID.")
        with _lock(self.state / "snapshot.lock"):
            file = self.state / "previews" / (preview_id + ".json")
            raw = file.read_bytes()
            if _sha(raw) != approved_sha256:
                raise ValueError("Restore preview changed.")
            plan = json.loads(raw)
            if plan["knowledge_root"] != str(self.root) or self.fingerprint(self.inventory()) != plan["inventory_sha256"]:
                raise ValueError("Knowledge changed after preview. Generate a new preview.")
            if not self.node or not self.extension_root:
                raise ValueError("PKM shared mutation runtime is required for safe restore.")
            backup = self._create("before-restore:" + plan["tag"])
            if self.fingerprint(self.inventory()) != plan["inventory_sha256"]:
                raise ValueError("Knowledge changed while preparing the safety snapshot. Generate a new preview.")
            report = {"schema": "pkm.snapshot-restore-result/v1", "status": "applying",
                      "before_snapshot": backup["tag"], "target_snapshot": plan["tag"], "applied": []}
            receipt = self.state / "restores" / (preview_id + ".json")
            _json(receipt, report)
            for change in plan["changes"]:
                relative = change["path"]
                destination = self.root / relative
                if change["before_sha256"]:
                    area, key = relative.split("/", 1)
                    trash_file(self.root, area, key, self.node, self.extension_root, change["before_sha256"])
                target = change["target"]
                if target:
                    content = self.git("cat-file", "blob", target["object"])
                    if _sha(content) != target["sha256"]:
                        raise RuntimeError("Snapshot blob validation failed.")
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    for parent in (destination, *destination.parents):
                        if parent == self.root:
                            break
                        if parent.is_symlink():
                            raise ValueError("Restore destination became a symlink.")
                    with destination.open("xb") as output:
                        output.write(content)
                        output.flush()
                        os.fsync(output.fileno())
                    destination.chmod(0o755 if target["mode"] == "100755" else 0o644)
                report["applied"].append(relative)
                _json(receipt, report)
            if self.fingerprint(self.inventory()) != plan["target_inventory_sha256"]:
                raise RuntimeError("Knowledge changed during restore; inspect the recovery receipt and safety snapshot.")
            report["status"] = "completed"
            _json(receipt, report)
            return {**report, "receipt": str(receipt), "privacy_preserved": True}

    def configure(self, enabled, local_time, zone):
        timing = next_run(local_time, zone)
        if sys.platform != "linux":
            raise ValueError("Persistent scheduling currently requires a Linux user systemd session.")
        unit_id = "pkm-knowledge-snapshot-" + _sha(str(self.root).encode())[:16]
        units = Path.home() / ".config" / "systemd" / "user"
        units.mkdir(parents=True, exist_ok=True)
        def quote(value):
            return '"' + str(value).replace("%", "%%").replace("\\", "\\\\").replace('"', '\\"') + '"'
        arguments = [sys.executable, Path(__file__).resolve(), "--root", self.root, "--run-daily"]
        if self.node and self.extension_root:
            arguments += ["--node", self.node, "--extension-root", self.extension_root]
        service = ("[Unit]\nDescription=Private PKM knowledge snapshot\n[Service]\nType=oneshot\nUMask=0077\n"
                   "ExecStart=" + " ".join(quote(value) for value in arguments) + "\n")
        timer = ("[Unit]\nDescription=Daily private PKM knowledge snapshot\n[Timer]\n"
                 f"OnCalendar=*-*-* {local_time}:00 {zone}\nPersistent=true\nAccuracySec=1s\n"
                 "[Install]\nWantedBy=timers.target\n")
        for suffix, content in (("service", service), ("timer", timer)):
            (units / (unit_id + "." + suffix)).write_text(content)
        _systemctl_user("daemon-reload")
        _systemctl_user("enable" if enabled else "disable", "--now", unit_id + ".timer")
        settings = {"enabled": enabled, "local_time": local_time, "timezone": zone, "unit": unit_id,
                    "updated_utc": datetime.now(UTC).isoformat(), **timing}
        _json(self.state / "schedule.json", settings)
        return settings


def register_knowledge_snapshot_tools(mcp, store, node=None, extension_root=None):
    snapshots = KnowledgeSnapshots(store, node, extension_root)

    @mcp.tool(annotations={"readOnlyHint": True})
    def knowledge_snapshot_status() -> dict:
        """List immutable local snapshot tags and daily schedule, with UTC and PST/PDT display."""
        return snapshots.status()

    @mcp.tool(annotations={"readOnlyHint": False})
    def knowledge_snapshot_create(reason: str = "manual") -> dict:
        """Create a byte-verified private Git snapshot tag without committing code, changing the working index or pushing."""
        return snapshots.create(reason)

    @mcp.tool(annotations={"readOnlyHint": False})
    def knowledge_snapshot_configure(enabled: bool = True, local_time: str = "17:00",
                                     timezone: str = "America/Los_Angeles") -> dict:
        """Configure a persistent daily local snapshot. Time is HH:MM in an IANA zone; executions are recorded in UTC."""
        return snapshots.configure(enabled, local_time, timezone)

    @mcp.tool(annotations={"readOnlyHint": False})
    def knowledge_snapshot_restore_preview(tag: str) -> dict:
        """Preview restoring active knowledge to a dated tag. Does not alter knowledge; current privacy is preserved."""
        return snapshots.restore_preview(tag)

    @mcp.tool(annotations={"readOnlyHint": False, "destructiveHint": True})
    def knowledge_snapshot_restore_apply(preview_id: str, approved_sha256: str) -> dict:
        """Apply an unchanged approved preview, after a safety snapshot. Replaced/extra files go to PKM Trash with journal records."""
        return snapshots.restore_apply(preview_id, approved_sha256)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--node")
    parser.add_argument("--extension-root")
    parser.add_argument("--run-daily", action="store_true")
    args = parser.parse_args()
    from fastmcp import FastMCP, Client
    server = FastMCP("pkm-knowledge-snapshots")
    register_knowledge_snapshot_tools(server, args.root, args.node, args.extension_root)
    if args.run_daily:
        async def run_daily():
            async with Client(server) as client:
                result = await client.call_tool("knowledge_snapshot_create", {"reason": "scheduled-daily"})
                print(json.dumps(result.data, ensure_ascii=False))
        asyncio.run(run_daily())
    else:
        server.run(transport="stdio")

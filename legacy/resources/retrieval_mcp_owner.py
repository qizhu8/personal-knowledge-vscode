"""Private experimental retrieval admission for an independent MCP process."""
import json
import os
import secrets
import time
import urllib.request
import uuid
from pathlib import Path

from retrieval_owners import RetrievalOwners


class McpRetrievalOwner:
    def __init__(self, state):
        self.state = Path(state)
        self.state.mkdir(parents=True, mode=0o700, exist_ok=True)
        self.owner = str(uuid.uuid4())
        self.host = str(uuid.uuid4())
        self.proof = secrets.token_hex(32)
        stat = Path("/proc/self/stat").read_text()
        start = stat[stat.rfind(")") + 2:].split()[19]
        self.registry = RetrievalOwners(self.state)
        self.registry.open(self.owner, self.host, os.getpid(), start, self.proof, lambda: True)

    def close(self, timeout=10):
        try:
            endpoint = json.loads((self.state / "worker.json").read_text())
        except FileNotFoundError:
            if self.registry.close_without_runtime(self.owner, self.proof):
                return "unused"
            raise RuntimeError("Retrieval worker outcome is unknown")
        if (endpoint.get("pid_namespace") != os.readlink("/proc/self/ns/pid")
                or endpoint.get("boot_id") != Path("/proc/sys/kernel/random/boot_id").read_text().strip()):
            raise RuntimeError("Retrieval worker namespace is unknown")
        pid = endpoint["pid"]
        stat_path = Path("/proc") / str(pid) / "stat"
        stat = stat_path.read_text()
        start = stat[stat.rfind(")") + 2:].split()[19]
        request = urllib.request.Request(
            "http://127.0.0.1:{}/owners/close".format(endpoint["port"]),
            data=json.dumps({"id": self.owner, "proof": self.proof}).encode(),
            headers={"X-PKM-Retrieval-Token": endpoint["token"], "Content-Type": "application/json"},
            method="POST",
        )
        deadline = time.monotonic() + timeout
        with urllib.request.urlopen(request, timeout=timeout) as response:
            result = json.load(response)
        if (not isinstance(result, dict) or result.get("ok") is not True
                or result.get("unknown") is not False
                or type(result.get("remaining")) is not int
                or type(result.get("shutdown")) is not bool):
            raise RuntimeError("Retrieval owner completion is unknown")
        if result["remaining"] > 0 and not result["shutdown"]:
            return "shared"
        if result["remaining"] != 0 or not result["shutdown"]:
            raise RuntimeError("Retrieval owner completion is invalid")
        while time.monotonic() < deadline:
            try:
                stat = stat_path.read_text()
                fields = stat[stat.rfind(")") + 2:].split()
                if fields[0] in {"Z", "X"} or fields[19] != start:
                    return "stopped"
            except FileNotFoundError:
                return "stopped"
            time.sleep(0.05)
        raise RuntimeError("Retrieval worker drain timed out; its outcome is unknown")

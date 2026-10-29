"""Non-destructive, byte-preserving knowledge recovery through MCP."""

import argparse
import hashlib
import json
import os
from pathlib import Path
from datetime import datetime, timezone


def _digest(content):
    return hashlib.sha256(content).hexdigest()


def _destination(root, relative):
    parts = relative.split("/")
    if (parts[0] not in ("skills", "notes") or len(parts) < 2
            or any(part in ("", ".", "..", ".trash", ".git") or "\\" in part for part in parts)):
        raise ValueError("Recovery paths must be contained in skills/ or notes/, outside Trash.")
    destination = root.joinpath(*parts)
    for parent in (destination, *destination.parents):
        if parent == root:
            break
        if parent.is_symlink():
            raise ValueError("Recovery refuses symlink destinations: " + relative)
    return destination


def _plan(root, directory):
    directory = Path(directory).resolve(strict=True)
    if directory == root or root in directory.parents:
        raise ValueError("Recovery evidence must be outside the Knowledge Root.")
    raw = (directory / "plan.json").read_bytes()
    plan = json.loads(raw)
    if plan.get("schema") != "pkm.knowledge-recovery/v1" or plan.get("knowledgeRoot") != str(root):
        raise ValueError("Recovery plan schema or Knowledge Root does not match.")
    if not isinstance(plan.get("files"), list) or len(plan["files"]) > 100000:
        raise ValueError("Recovery plan must contain a bounded file list.")
    seen = set()
    rows = []
    for entry in plan["files"]:
        relative = entry["path"]
        if relative in seen:
            raise ValueError("Duplicate recovery destination: " + relative)
        seen.add(relative)
        destination = _destination(root, relative)
        digest = entry["sha256"]
        if not isinstance(digest, str) or len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
            raise ValueError("Invalid recovery blob hash.")
        blob = directory / "blobs" / digest
        if blob.is_symlink() or directory not in blob.resolve(strict=True).parents:
            raise ValueError("Recovery blob escapes its evidence directory.")
        content = blob.read_bytes()
        if _digest(content) != digest:
            raise ValueError("Recovery blob hash mismatch: " + relative)
        if entry.get("mode") not in ("100644", "100755"):
            raise ValueError("Recovery only restores regular files.")
        if destination.exists():
            if not destination.is_file():
                raise ValueError("Recovery destination is not a file: " + relative)
            status = "identical" if _digest(destination.read_bytes()) == digest else "preserve-existing"
        else:
            status = "restore"
        rows.append((entry, destination, content, status))
    return directory, _digest(raw), rows


def register_knowledge_recovery_tools(mcp, store):
    root = Path(store).resolve(strict=True)

    @mcp.tool(annotations={"readOnlyHint": True})
    def knowledge_recovery_preview(evidence_directory: str) -> dict:
        """Verify a byte-preserving recovery plan. Never writes knowledge or overwrites existing files."""
        _, digest, rows = _plan(root, evidence_directory)
        return {
            "schema": "pkm.knowledge-recovery-preview/v1",
            "knowledge_root": str(root), "plan_sha256": digest,
            "counts": {status: sum(row[3] == status for row in rows)
                       for status in ("restore", "identical", "preserve-existing")},
            "files": [{"path": row[0]["path"], "status": row[3]} for row in rows],
        }

    @mcp.tool(annotations={"readOnlyHint": False, "destructiveHint": False})
    def knowledge_recovery_apply(evidence_directory: str, approved_plan_sha256: str) -> dict:
        """Restore missing files from an approved, hash-verified plan; preserve all existing files and audit each write."""
        directory, digest, rows = _plan(root, evidence_directory)
        if digest != approved_plan_sha256:
            raise ValueError("Recovery plan changed after approval.")
        report = {
            "schema": "pkm.knowledge-recovery-result/v1", "knowledge_root": str(root),
            "plan_sha256": digest, "started_at": datetime.now(timezone.utc).isoformat(),
            "restored": [], "identical": [], "preserved_existing": [],
        }
        report_path = directory / ("result-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%f") + ".json")
        with report_path.open("x", encoding="utf-8") as audit:
            for entry, destination, content, status in rows:
                relative = entry["path"]
                _destination(root, relative)
                if status != "restore":
                    report["identical" if status == "identical" else "preserved_existing"].append(relative)
                    continue
                destination.parent.mkdir(parents=True, exist_ok=True)
                _destination(root, relative)
                try:
                    descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                except FileExistsError:
                    report["preserved_existing"].append(relative)
                    continue
                with os.fdopen(descriptor, "wb") as output:
                    output.write(content)
                    output.flush()
                    os.fsync(output.fileno())
                destination.chmod(0o755 if entry["mode"] == "100755" else 0o644)
                if _digest(destination.read_bytes()) != entry["sha256"]:
                    raise RuntimeError("Restored file failed byte verification: " + relative)
                report["restored"].append(relative)
                audit.seek(0)
                json.dump(report, audit, ensure_ascii=False, indent=2)
                audit.truncate()
                audit.flush()
                os.fsync(audit.fileno())
            report["completed_at"] = datetime.now(timezone.utc).isoformat()
            audit.seek(0)
            json.dump(report, audit, ensure_ascii=False, indent=2)
            audit.truncate()
            audit.flush()
            os.fsync(audit.fileno())
        return {"ok": True, "report": str(report_path),
                "restored": len(report["restored"]), "identical": len(report["identical"]),
                "preserved_existing": len(report["preserved_existing"])}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    arguments = parser.parse_args()
    from fastmcp import FastMCP
    server = FastMCP("pkm-knowledge-recovery")
    register_knowledge_recovery_tools(server, arguments.root)
    server.run(transport="stdio")

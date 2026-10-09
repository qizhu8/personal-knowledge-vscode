import argparse
import hashlib
import json
import sys
import uuid
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from pathlib import Path
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "resources"))
from action_runtime import ActionRuntime, cosmos_location
from recipe_runtime import _atomic_write


def inventory(source):
    if source.is_symlink() or not source.is_dir():
        raise ValueError("Source must be a non-symlink directory.")
    files, directories = {}, set()
    for path in sorted(source.rglob("*")):
        relative = path.relative_to(source).as_posix()
        if path.is_symlink():
            raise ValueError("Source contains a symlink: " + relative)
        if path.is_dir():
            directories.add(relative)
            if not any(path.iterdir()):
                raise ValueError("Empty directories require a separately qualified directory-create Action: " + relative)
        elif path.is_file():
            status = path.stat()
            files[relative] = {"size": status.st_size, "mtime_ns": status.st_mtime_ns, "inode": status.st_ino}
        else:
            raise ValueError("Source contains a special file: " + relative)
    if not files:
        raise ValueError("Source has no regular files.")
    return files, directories


def remote_inventory(runtime, destination, namespace):
    definition = runtime.definition("cosmos.directory.list")
    files, directories, pending = {}, set(), [""]
    while pending:
        relative = pending.pop()
        uri = destination + ("/" + quote(relative, safe="/") if relative else "")
        key = hashlib.sha256((namespace + ":list:" + relative).encode()).hexdigest()
        result = runtime.wait(runtime.call(definition["action_id"], {"uri": uri}, key, definition["content_hash"])["run_id"])
        if result["state"] != "succeeded" or not isinstance(result.get("output"), list):
            raise RuntimeError("Remote inventory incomplete; reconcile " + result["run_id"])
        for entry in result["output"]:
            suffix = entry.get("pathSuffix")
            if not isinstance(suffix, str) or suffix in {"", ".", ".."} or any(character in suffix for character in "/\\"):
                raise ValueError("Invalid remote directory entry.")
            child = relative + "/" + suffix if relative else suffix
            if entry.get("type") == "DIRECTORY":
                if child in directories:
                    raise ValueError("Duplicate remote directory.")
                directories.add(child)
                pending.append(child)
            elif entry.get("type") == "FILE" and type(entry.get("length")) is int and entry["length"] >= 0:
                if child in files:
                    raise ValueError("Duplicate remote file.")
                files[child] = entry["length"]
            else:
                raise ValueError("Unsupported remote entry type or size.")
    return files, directories


def execute(runtime, source, destination, *, transfer_timeout=7200, parallel_files=4, threads=8, dry_run=True):
    source = source.expanduser()
    local_files, local_directories = inventory(source)
    source = source.resolve()
    destination = destination.rstrip("/")
    cosmos_location(destination)
    for action in ["cosmos.artifact.upload", "cosmos.directory.list"]:
        if runtime.availability(action)["state"] != "ready":
            raise PermissionError("Action is not qualified: " + action)
    batch_id = "action_batch_" + uuid.uuid4().hex
    remote_files, remote_directories = remote_inventory(runtime, destination, batch_id + ":preflight")
    if remote_directories - local_directories:
        raise FileExistsError("Destination contains directories outside the source manifest.")
    validation = json.loads((runtime.root / "validations" / "cosmos.artifact.upload.json").read_text(encoding="utf-8"))
    proof = validation.get("proof", {})
    completed = {}
    for relative, size in remote_files.items():
        target = destination + "/" + quote(relative, safe="/")
        if (relative not in local_files or size != local_files[relative]["size"] or not proof.get("sha256")
                or proof.get("inputs", {}).get("uri") != target
                or proof.get("inputs", {}).get("local_path") != str(source / relative)
                or hashlib.sha256((source / relative).read_bytes()).hexdigest() != proof["sha256"]):
            raise FileExistsError("Existing destination is not the verified qualification artifact: " + relative)
        completed[relative] = {"state": "succeeded", "run_id": proof["run_id"], "verification": "sha256-readback"}
    definition = runtime.definition("cosmos.artifact.upload")
    receipt = {"schema": "pkm.action.upload-batch/v1", "batch_id": batch_id, "source": str(source), "destination": destination,
               "content_hash": definition["content_hash"], "files": local_files, "directories": sorted(local_directories),
               "total_bytes": sum(item["size"] for item in local_files.values()), "results": completed, "state": "planned"}
    print(json.dumps({"batch_id": batch_id, "files": len(local_files), "bytes": receipt["total_bytes"],
                      "already_verified": len(completed), "pending": len(local_files) - len(completed), "dry_run": dry_run}), flush=True)
    if dry_run:
        return receipt
    receipt_path = runtime.root / "batches" / (batch_id + ".json")
    receipt["state"] = "running"
    _atomic_write(receipt_path, receipt)

    def upload(relative):
        path = source / relative
        status = path.stat()
        expected = local_files[relative]
        if path.is_symlink() or {"size": status.st_size, "mtime_ns": status.st_mtime_ns, "inode": status.st_ino} != expected:
            raise RuntimeError("Source changed before invocation: " + relative)
        inputs = {"uri": destination + "/" + quote(relative, safe="/"), "local_path": str(path), "overwrite": False,
                  "timeout_seconds": transfer_timeout, "thread_count": threads}
        key = hashlib.sha256((batch_id + ":upload:" + relative).encode()).hexdigest()
        result = runtime.wait(runtime.call(definition["action_id"], inputs, key, definition["content_hash"])["run_id"])
        return {"state": result["state"], "run_id": result["run_id"]}

    remaining = iter(relative for relative in local_files if relative not in completed)
    stopped = False
    with ThreadPoolExecutor(max_workers=parallel_files) as executor:
        active = {}

        def submit():
            relative = next(remaining, None)
            if relative is not None:
                active[executor.submit(upload, relative)] = relative

        for index in range(parallel_files):
            submit()
        while active:
            finished, _ = wait(active, return_when=FIRST_COMPLETED)
            for future in finished:
                relative = active.pop(future)
                try:
                    outcome = future.result()
                except Exception as error:
                    outcome = {"state": "outcome_unknown", "error": str(error)}
                receipt["results"][relative] = outcome
                stopped = stopped or outcome["state"] != "succeeded"
                _atomic_write(receipt_path, receipt)
                print(json.dumps({"batch_id": batch_id, "file": relative, **outcome,
                                  "completed": sum(item["state"] == "succeeded" for item in receipt["results"].values()),
                                  "total": len(local_files)}), flush=True)
            if not stopped:
                for index in range(len(finished)):
                    submit()
    if stopped:
        receipt["state"] = "needs_reconciliation"
        _atomic_write(receipt_path, receipt)
        raise RuntimeError("A transfer failed or is unknown; no retry. Reconcile batch " + batch_id)
    current_files, current_directories = inventory(source)
    verified_files, verified_directories = remote_inventory(runtime, destination, batch_id + ":verification")
    sizes = {relative: metadata["size"] for relative, metadata in local_files.items()}
    verified = current_files == local_files and current_directories == local_directories and verified_files == sizes and verified_directories == local_directories
    receipt["state"] = "verified" if verified else "verification_failed"
    receipt["verification"] = {"kind": "complete-path-and-size-manifest", "files": len(verified_files),
                               "directories": len(verified_directories), "bytes": sum(verified_files.values()),
                               "full_remote_sha256": False}
    _atomic_write(receipt_path, receipt)
    if not verified:
        raise RuntimeError("Source changed or remote manifest mismatch; reconcile batch " + batch_id)
    print(json.dumps({"batch_id": batch_id, "state": receipt["state"], **receipt["verification"]}), flush=True)
    return receipt


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--store", required=True)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--destination", required=True)
    parser.add_argument("--execute", action="store_true")
    options = parser.parse_args()
    execute(ActionRuntime(options.store), options.source, options.destination, dry_run=not options.execute)
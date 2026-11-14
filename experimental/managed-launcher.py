"""Isolated experimental launcher. No production registry or mutable source imports."""
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import sys

SCHEMA = "pkm.mcp.lifecycle/v1"
COMPONENTS = {name: "0.1.0" for name in ("knowledge", "chat", "recipes", "agent_sessions")}


def fail(message):
    raise SystemExit("Isolated MCP generation rejected: " + message)


def digest(files):
    value = hashlib.sha256()
    for name in sorted(files):
        value.update((name + "\0" + files[name] + "\0").encode())
    return value.hexdigest()

def file_digest(filename):
    value = hashlib.sha256()
    with filename.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def verify(root, generation):
    if not isinstance(generation, str) or not re.fullmatch(r"[a-f0-9-]{36}", generation):
        fail("invalid generation")
    directory = root / "generations" / generation
    if directory.is_symlink() or directory.resolve() != directory:
        fail("linked generation")
    manifest_path = directory / "manifest.json"
    if manifest_path.is_symlink():
        fail("linked manifest")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if (manifest.get("schema") != SCHEMA or manifest.get("generation") != generation
            or manifest.get("managedRoot") != str(root) or manifest.get("version") != "0.1.0"
            or manifest.get("components") != COMPONENTS or manifest.get("enabledFeatureDomains") != []
            or manifest.get("experimental") is not True):
        fail("ownership or experimental claims")
    actual = {}
    for target in directory.rglob("*"):
        if target.is_symlink():
            fail("linked runtime entry")
        if target.is_file() and target != manifest_path:
            actual[target.relative_to(directory).as_posix()] = file_digest(target)
        elif not target.is_dir() and target != manifest_path:
            fail("unsupported runtime entry")
    if actual != manifest.get("files") or digest(actual) != manifest.get("runtimeBuild"):
        fail("exact dependency inventory or build mismatch")
    platform = json.loads((directory / "platform.json").read_text(encoding="utf-8"))
    if any(manifest.get(name) != platform.get(name) for name in (
            "interpreters", "launcherSha256", "pythonDistributions", "pythonDependencyProfile")):
        fail("platform dependency identity mismatch")
    dependencies = json.loads((directory / "python-dependencies.json").read_text(encoding="utf-8"))
    if (dependencies.get("profile") not in ("fastmcp", "local-model")
            or dependencies["profile"] != manifest.get("pythonDependencyProfile")
            or sorted(dependencies["distributions"]) != manifest["pythonDistributions"]):
        fail("Python dependency profile mismatch")
    for distribution in dependencies["distributions"].values():
        if not isinstance(distribution.get("version"), str) or not distribution["version"]:
            fail("Python dependency version missing")
        for name, expected in distribution["files"].items():
            if actual.get("runtime/site-packages/" + name) != expected:
                fail("Python distribution content mismatch")
    if dependencies["profile"] == "local-model" and dependencies["requirementsSha256"] != file_digest(
            directory / "runtime" / "resources" / "retrieval-model-requirements.txt"):
        fail("Declared model requirements mismatch")
    if hashlib.sha256((root / "launch.py").read_bytes()).hexdigest() != manifest["launcherSha256"]:
        fail("launcher integrity mismatch")
    for name in ("node", "python"):
        runtime = manifest["interpreters"][name]
        if file_digest(Path(runtime["path"])) != runtime["sha256"]:
            fail(name + " interpreter changed")
    if manifest.get("node") != manifest["interpreters"]["node"]["path"]:
        fail("Node interpreter ownership mismatch")
    if str(Path(sys.executable).resolve()) != manifest["interpreters"]["python"]["path"]:
        fail("wrong Python interpreter")
    return directory, manifest


def main():
    root = Path(__file__).resolve().parent
    if len(sys.argv) == 3 and sys.argv[1] == "--verify-generation":
        verify(root, sys.argv[2])
        return
    if len(sys.argv) != 1:
        fail("launcher accepts no workspace or executable overrides")
    if (root / "runtime-maintenance.json").exists():
        fail("maintenance requires explicit action")
    baseline = json.loads((root / "active-generation.json").read_text(encoding="utf-8"))
    pointer = root / "latest-generation.json"
    active = json.loads(pointer.read_text(encoding="utf-8")) if pointer.exists() else baseline
    if (baseline.get("schema") != SCHEMA or active.get("schema") != SCHEMA
            or baseline.get("generation") != active.get("generation")
            and baseline.get("compatibilityBaseline") is not True):
        fail("incomplete publication")
    directory, manifest = verify(root, active.get("generation"))
    # -I -S excludes user/site startup hooks; only the snapshotted dependencies are admitted.
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(directory / "runtime" / "site-packages"))
    options = json.loads((directory / "launch.json").read_text(encoding="utf-8"))
    data = Path(options["data"])
    if not data.is_absolute() or data.resolve() != data or type(options.get("allowWrites")) is not bool:
        fail("workspace must be absolute")
    marker = data / ".pkm-next-workspace"
    if marker.is_symlink():
        fail("linked isolated workspace marker")
    workspace = json.loads(marker.read_text(encoding="utf-8"))
    if workspace.get("schema") not in (
            "pkm.next-workspace/v1", "pkm.next-workspace/v2"):
        fail("initialized isolated workspace marker missing")
    script = directory / "runtime" / "next-server" / "compat" / "legacy-compact-mcp.py"
    sys.argv = [str(script), "--data", options["data"], "--node", manifest["node"],
                "--managed-generation", str(directory)]
    if options["allowWrites"]:
        sys.argv.append("--allow-writes")
    if "snapshotScheduler" in options:
        enrollment = options["snapshotScheduler"]
        if (not isinstance(enrollment, dict)
                or set(enrollment) != {"schema", "workspaceId", "actorId", "admissionSha256"}
                or enrollment["schema"] != "pkm.native-snapshot-scheduler/v1"
                or enrollment["actorId"] != "mcp:external"
                or not isinstance(enrollment["workspaceId"], str)
                or not re.fullmatch(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}",
                                    enrollment["workspaceId"])
                or enrollment["workspaceId"] != workspace.get("id")
                or not isinstance(enrollment["admissionSha256"], str)
                or not re.fullmatch(r"[a-f0-9]{64}", enrollment["admissionSha256"])
                or not options["allowWrites"]):
            fail("snapshot scheduler enrollment or write authority mismatch")
        sys.argv.extend(["--experimental-managed-snapshot-scheduler", enrollment["admissionSha256"]])
    os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
    os.environ.pop("PYTHONPATH", None)
    os.environ.pop("PYTHONHOME", None)
    os.environ.pop("NODE_PATH", None)
    os.environ.pop("NODE_OPTIONS", None)
    os.environ["PKM_ISOLATED_PYTHON_COMMAND"] = manifest["interpreters"]["python"]["path"]
    os.environ["PKM_ISOLATED_PYTHON_BOOTSTRAP"] = str(directory / "python-bootstrap.py")
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_DATASETS_OFFLINE"] = "1"
    runpy.run_path(str(script), run_name="__main__")


if __name__ == "__main__":
    main()

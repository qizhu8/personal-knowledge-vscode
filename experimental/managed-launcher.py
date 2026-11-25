"""Isolated experimental launcher. No production registry or mutable source imports."""
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import stat
import sys

SCHEMA = "pkm.mcp.lifecycle/v1"
COMPONENTS = {name: "0.1.0" for name in ("knowledge", "chat", "recipes", "agent_sessions")}
STAGED = "core-then-background-v2"
CORE_LIMIT = 2 * 1024 * 1024
CORE_CODE = (
    "cli", "native-public-mcp", "native-public-mcp-stdio", "native-public-mcp-lifecycle",
    "native-public-mcp-owner", "native-public-mcp-note-read", "native-public-mcp-contracts",
    "root-owner", "linux-root-writer-fence", "workspace-validation", "storage-startup-classification",
    "workspace-storage-paths", "storage-bootstrap-profile", "fresh-note-index-storage",
    "workspace-runtime-control", "workspace-git-protection", "shared-manager-control", "sync-storage-boundary",
    "browser-mutation-receipt", "mutation-receipt-contracts",
    "storage-owner-schema", "deployment-integrity", "deployment-integrity-worker",
)
CORE_CONTROLS = ("launch.json", "platform.json", "runtime/next-server/package.json",
                 "runtime/next-server/deployment-core.json")


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

def runtime_facade(directory):
    package = json.loads((directory / "runtime" / "next-server" / "package.json").read_text(encoding="utf-8"))
    facade = package.get("runtimeMcpFacade")
    if "runtimeMcpFacade" in package and facade != "native-v1":
        fail("unsupported MCP facade marker")
    return facade


def inventory(directory):
    files = {}
    pending = [(str(directory), "")]
    while pending:
        parent, prefix = pending.pop()
        with os.scandir(parent) as entries:
            for entry in entries:
                if entry.is_symlink():
                    fail("linked runtime entry")
                name = prefix + entry.name
                if entry.is_file(follow_symlinks=False):
                    if name != "manifest.json":
                        files[name] = file_digest(Path(entry.path))
                elif entry.is_dir(follow_symlinks=False):
                    pending.append((entry.path, name + "/"))
                elif name != "manifest.json":
                    fail("unsupported runtime entry")
    return files


def named_file(root, name):
    if (not isinstance(name, str) or "\\" in name or "\0" in name
            or any(part in ("", ".", "..") for part in name.split("/"))):
        fail("invalid deployment name")
    target = root
    for part in name.split("/"):
        target = target / part
        if target.is_symlink():
            fail("linked deployment control")
    return target


def small_json(root, name):
    target = named_file(root, name)
    with os.fdopen(os.open(target, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)), "rb") as stream:
        identity = os.fstat(stream.fileno())
        if not stat.S_ISREG(identity.st_mode) or identity.st_size > 65536:
            fail("deployment control byte budget")
        raw = stream.read(65537)
        if len(raw) > 65536:
            fail("deployment control changed size")
    value = json.loads(raw)
    if not isinstance(value, dict):
        fail("invalid deployment control")
    return value, hashlib.sha256(raw).hexdigest()


def validation_mode(root):
    marker = root / ".pkm-isolated-migration"
    if not marker.exists() and not marker.is_symlink():
        return None
    value, _ = small_json(root, ".pkm-isolated-migration")
    if value.get("schema") != "pkm.isolated-managed-migration/v1":
        fail("managed root marker")
    if "startupValidation" not in value:
        return None
    if value["startupValidation"] != STAGED:
        fail("unsupported startup validation mode")
    return STAGED


def startup_receipt(root, generation, pointer=None):
    if not isinstance(generation, str) or not re.fullmatch(r"[a-f0-9-]{36}", generation):
        fail("invalid generation")
    directory = root / "generations" / generation
    if directory.is_symlink() or directory.resolve() != directory:
        fail("linked generation")
    receipt, receipt_hash = small_json(root, f"startup-v2/{generation}.json")
    if pointer is not None and (pointer.get("startupValidation") != STAGED
                               or pointer.get("startupReceiptSha256") != receipt_hash):
        fail("startup publication receipt mismatch")
    manifest = receipt.get("manifest")
    if (receipt.get("schema") != "pkm.deployment-startup/v2" or receipt.get("mode") != STAGED
            or not isinstance(manifest, dict) or manifest.get("schema") != SCHEMA
            or manifest.get("generation") != generation or manifest.get("managedRoot") != str(root)
            or manifest.get("version") != "0.1.0" or manifest.get("experimental") is not True
            or manifest.get("components") != COMPONENTS or manifest.get("enabledFeatureDomains") != []
            or manifest.get("startupValidation") != STAGED
            or not isinstance(receipt.get("manifestSha256"), str)
            or not re.fullmatch(r"[a-f0-9]{64}", receipt["manifestSha256"])):
        fail("startup ownership or policy claims")
    expected = {"runtime/next-server/dist/" + name + ".js" for name in CORE_CODE} | set(CORE_CONTROLS)
    core = receipt.get("core")
    if (not isinstance(core, dict) or set(core) != expected or len(core) > 32
            or type(receipt.get("coreBytes")) is not int or not 0 <= receipt["coreBytes"] <= CORE_LIMIT
            or any(not isinstance(pin, str) or not re.fullmatch(r"[a-f0-9]{64}", pin) for pin in core.values())):
        fail("reviewed startup core membership or budget")
    return directory, manifest, receipt


def verify_core(root, generation, pointer):
    directory, manifest, receipt = startup_receipt(root, generation, pointer)
    if (manifest.get("backendKind", "native-public-mcp") != "native-public-mcp"
            or manifest.get("backendAbi", "pkm.mcp.api/1") != "pkm.mcp.api/1"
            or (directory / "core-host.json").exists()):
        fail("native startup cannot admit a standalone Core backend")
    total = 0
    read_bytes = 0
    for name, expected in receipt["core"].items():
        target = named_file(directory, name)
        with os.fdopen(os.open(target, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)), "rb") as stream:
            identity = os.fstat(stream.fileno())
            total += identity.st_size
            if not stat.S_ISREG(identity.st_mode) or total > CORE_LIMIT:
                fail("startup core byte budget")
            value = hashlib.sha256()
            for block in iter(lambda: stream.read(65536), b""):
                read_bytes += len(block)
                if read_bytes > CORE_LIMIT:
                    fail("startup core changed beyond byte budget")
                value.update(block)
            if value.hexdigest() != expected:
                fail("startup core content mismatch")
    if total != receipt["coreBytes"]:
        fail("startup core byte count")
    declaration, _ = small_json(directory, "runtime/next-server/deployment-core.json")
    code = {"dist/" + name + ".js": receipt["core"]["runtime/next-server/dist/" + name + ".js"] for name in CORE_CODE}
    if (declaration.get("schema") != "pkm.deployment-core/v2" or declaration.get("mode") != STAGED
            or declaration.get("core") != code):
        fail("build startup core mismatch")
    platform, _ = small_json(directory, "platform.json")
    if any(manifest.get(name) != platform.get(name) for name in (
            "interpreters", "launcherSha256", "pythonDistributions", "pythonDependencyProfile")):
        fail("platform dependency identity mismatch")
    if file_digest(named_file(root, "launch.py")) != manifest["launcherSha256"]:
        fail("launcher integrity mismatch")
    for name in ("node", "python"):
        runtime = manifest["interpreters"][name]
        path = Path(runtime["path"])
        if not path.is_absolute() or path.resolve() != path or file_digest(path) != runtime["sha256"]:
            fail(name + " interpreter changed")
    if (manifest.get("node") != manifest["interpreters"]["node"]["path"]
            or str(Path(sys.executable).resolve()) != manifest["interpreters"]["python"]["path"]):
        fail("interpreter ownership mismatch")
    if runtime_facade(directory) != "native-v1":
        fail("staged startup requires native facade")
    options, _ = small_json(directory, "launch.json")
    if "snapshotScheduler" in options:
        fail("autonomous enrollment requires full-foreground policy")
    return directory, manifest


def verify_backend(directory, manifest, actual):
    kind = manifest.get("backendKind", "native-public-mcp")
    abi = manifest.get("backendAbi", "pkm.mcp.api/1")
    if kind == "native-public-mcp":
        if (abi != "pkm.mcp.api/1" or "coreHostProfileSha256" in manifest
                or "core-host.json" in actual or "core-host-config.json" in actual):
            fail("native backend kind/profile mismatch")
        return
    if kind != "standalone-core" or abi != "pkm.shared-core-http/v1":
        fail("unsupported managed backend kind or ABI")
    if ("startupValidation" in manifest
            or manifest.get("compatibility", {}).get("protocol") != abi
            or actual.get("core-host.json") != manifest.get("coreHostProfileSha256")
            or "runtime/next-server/dist/shared-core-backend.js" not in actual):
        fail("standalone Core backend profile or entry mismatch")
    profile, _ = small_json(directory, "core-host.json")
    config, _ = small_json(directory, "core-host-config.json")
    launch, _ = small_json(directory, "launch.json")
    if ((directory / "core-host.json").stat().st_size > 32768
            or set(profile) != {"schema", "config", "policy", "secretEnvironment", "humanReview"}
            or profile.get("schema") != "pkm.shared-core-host/v1"
            or profile.get("humanReview") != "browser" or profile.get("config") != config
            or not isinstance(profile.get("policy"), dict)
            or not isinstance(profile.get("secretEnvironment"), dict)
            or set(launch) != {"data", "allowWrites"} or launch.get("allowWrites") is not True):
        fail("standalone Core profile/config mismatch")


def verify(root, generation):
    mode = validation_mode(root)
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
    actual = inventory(directory)
    if actual != manifest.get("files") or digest(actual) != manifest.get("runtimeBuild"):
        fail("exact dependency inventory or build mismatch")
    verify_backend(directory, manifest, actual)
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
            directory / "runtime" / "next-server" / "legacy" / "resources" / "retrieval-model-requirements.txt"):
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
    runtime_facade(directory)
    if "startupValidation" in manifest or mode is not None:
        if manifest.get("startupValidation") != STAGED or mode != STAGED:
            fail("unsupported startup validation mode")
        _, identity, receipt = startup_receipt(root, generation)
        expected_identity = dict(manifest)
        del expected_identity["files"]
        if (identity != expected_identity or file_digest(manifest_path) != receipt["manifestSha256"]
                or any(actual.get(name) != pin for name, pin in receipt["core"].items())
                or sum((directory / name).stat().st_size for name in receipt["core"]) != receipt["coreBytes"]):
            fail("full audit startup receipt mismatch")
        declaration, _ = small_json(directory, "runtime/next-server/deployment-core.json")
        code = {"dist/" + name + ".js": actual["runtime/next-server/dist/" + name + ".js"] for name in CORE_CODE}
        if (declaration.get("schema") != "pkm.deployment-core/v2" or declaration.get("mode") != STAGED
                or declaration.get("core") != code):
            fail("build startup core mismatch")
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
    if (root / ".migration-publication-lock").exists():
        fail("legacy publication lock requires explicit action")
    if sys.platform != "linux":
        fail("crash-recoverable managed publication requires Linux advisory locking")
    import fcntl
    lock = root / ".migration-publication-guard"
    try:
        lock_fd = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        if not stat.S_ISREG(os.fstat(lock_fd).st_mode):
            fail("invalid publication guard")
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        fail("publication or cleanup busy; retry launch")
    try:
        baseline = json.loads((root / "active-generation.json").read_text(encoding="utf-8"))
        pointer = root / "latest-generation.json"
        active = json.loads(pointer.read_text(encoding="utf-8")) if pointer.exists() else baseline
        if (baseline.get("schema") != SCHEMA or active.get("schema") != SCHEMA
                or baseline.get("generation") != active.get("generation")
                and baseline.get("compatibilityBaseline") is not True):
            fail("incomplete publication")
        mode = validation_mode(root)
        profile = os.environ.get("PKM_CAPABILITY_PROFILE", "compact")
        if mode == STAGED and profile != "legacy":
            directory, manifest = verify_core(root, active.get("generation"), active)
        else:
            directory, manifest = verify(root, active.get("generation"))
        if manifest.get("backendKind", "native-public-mcp") != "native-public-mcp":
            fail("standalone Core requires its verified shared-manager admission, not the native MCP launcher")
        leases = root / "leases"
        leases.mkdir(mode=0o700, exist_ok=True)
        if leases.is_symlink() or leases.resolve() != leases:
            fail("linked process lease directory")
        lease = leases / (str(os.getpid()) + ".json")
        with lease.open("x", encoding="utf-8") as output:
            json.dump({"schema": "pkm.managed-process-lease/v1", "pid": os.getpid(),
                       "generation": manifest["generation"]}, output)
            output.flush()
            os.fsync(output.fileno())
    finally:
        os.close(lock_fd)
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
    if runtime_facade(directory) == "native-v1":
        profile = os.environ.get("PKM_CAPABILITY_PROFILE", "compact")
        if profile not in ("compact", "legacy"):
            fail("unsupported capability profile")
        if profile == "compact":
            native = [manifest["node"], str(directory / "runtime" / "next-server" / "dist" / "cli.js"),
                      "mcp", "--data", options["data"], "--experimental-legacy-mcp",
                      "--native-public-mcp", "--managed-generation", str(directory)]
            if not options["allowWrites"]:
                native.append("--read-only")
            if "snapshotScheduler" in options:
                native.extend(["--experimental-managed-snapshot-scheduler",
                               options["snapshotScheduler"]["admissionSha256"]])
            os.execvpe(manifest["node"], native, os.environ)
    runpy.run_path(str(script), run_name="__main__")


if __name__ == "__main__":
    main()

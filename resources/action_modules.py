"""Persistent Action modules, qualified execution and nested invocation."""

import contextlib
import asyncio
import datetime
import hashlib
import importlib.metadata
import json
import math
import os
import platform
import re
import secrets
import shutil
import subprocess
import sys
import time
import uuid
import zipfile
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker
from recipe_runtime import _atomic_write, _background_process_options, _execute_command_worker
from action_components import VALUE_TYPES, component_definitions, execute_steps, validate_steps, referenced_actions, pending_choices, answer_choice
from action_run_store import ActionRunStore, action_contract


LAUNCHERS = {}
PLATFORM_KEYS = {"Linux": "linux", "Windows": "windows", "Darwin": "macos"}
TERMINAL = {"succeeded", "failed", "outcome_unknown"}


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def now():
    return datetime.datetime.now(datetime.timezone.utc)


def process_alive(pid):
    if platform.system() == "Windows":
        result = subprocess.run(["tasklist", "/FI", "PID eq " + str(pid), "/FO", "CSV", "/NH"],
                                capture_output=True, text=True, timeout=5)
        return ('"' + str(pid) + '"') in result.stdout
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def check(schema, value):
    errors = sorted(Draft202012Validator(schema, format_checker=FormatChecker()).iter_errors(value),
                    key=lambda error: str(list(error.path)))
    if errors:
        error = errors[0]
        raise ValueError("Contract violation at /" + "/".join(map(str, error.path)) + ": " + error.validator)
    digest(value)


def object_schema(properties, required=None):
    return {"type": "object", "properties": properties, "required": list(properties) if required is None else required, "additionalProperties": False}


INTEGER = {"type": "integer", "minimum": -(2 ** 63), "maximum": 2 ** 63 - 1}
ARTIFACT = object_schema({"artifact_id": {"type": "string", "pattern": "^artifact_[0-9a-f]{32}$"}})


def builtin_definitions():
    common = {"schema": "pkm.action.definition/v1", "version": 1, "dependencies": {}, "casts": {},
              "effects": ["pure"], "implementations": [{"id": "native", "kind": "builtin",
              "platforms": ["Linux", "Windows", "Darwin"]}]}
    result = {}
    for name, description, inputs, outputs, examples in [
        ("core.date.parse", "Validate an explicit calendar date", object_schema({"value": {"type": "string", "format": "date"}}),
         object_schema({"date": {"type": "string", "format": "date"}}), [{"inputs": {"value": "2026-10-07"}, "output": {"date": "2026-10-07"}}]),
        ("core.cast.integer-to-string", "Integer to String", object_schema({"value": INTEGER}),
         object_schema({"value": {"type": "string"}}), [{"inputs": {"value": 42}, "output": {"value": "42"}}]),
        ("core.cast.string-to-integer", "String to Integer", object_schema({"value": {"type": "string"}}),
         object_schema({"value": INTEGER}), [{"inputs": {"value": "42"}, "output": {"value": 42}}]),
        ("core.cast.string-to-float", "String to Float", object_schema({"value": {"type": "string"}, "trim": {"type": "boolean", "default": False}}, ["value"]),
         object_schema({"value": {"type": "number"}}), [{"inputs": {"value": "3.25"}, "output": {"value": 3.25}},
         {"inputs": {"value": " 1.5e2 ", "trim": True}, "output": {"value": 150.0}}]),
        ("core.artifact.write", "Write managed UTF-8 text", object_schema({"text": {"type": "string", "maxLength": 65536}}),
         ARTIFACT, [{"inputs": {"text": "non-private Action fixture"}}]),
        ("core.artifact.copy", "Copy a referenced artifact", object_schema({"source": ARTIFACT}), ARTIFACT, []),
    ]:
        result[name] = {**common, "action_id": name, "description": description,
                        "input_schema": inputs, "output_schema": outputs, "examples": examples,
                        "effects": ["local-read", "local-write"] if "artifact" in name else ["pure"]}
    return result


class ModuleRuntime:
    def __init__(self, store):
        self.store = Path(store).resolve()
        self.root = self.store / ".pkm" / "state" / "actions"
        self.registry = self.store / "actions"
        self.module_sets = self.store / "action-module-sets"
        self.runs = ActionRunStore(self.root)

    def module_set_path(self, module_set_id, version):
        if not isinstance(module_set_id, str) or not re.fullmatch(r"[a-z][a-z0-9_.-]{2,100}", module_set_id) or type(version) is not int or version < 1:
            raise ValueError("Invalid ModuleSet identity/version.")
        return self.module_sets / module_set_id / str(version)

    def module_set_list(self):
        enabled = self.settings().get("enabled_module_sets", {})
        result = []
        for path in sorted(self.module_sets.glob("*/*/manifest.json")):
            manifest = json.loads(path.read_text(encoding="utf-8"))
            result.append({key: manifest[key] for key in ["module_set_id", "version", "name", "actions", "package_hash", "provenance"]})
            result[-1]["enabled"] = enabled.get(manifest["module_set_id"]) == manifest["version"]
        return {"ok": True, "module_sets": result}

    def loaded_module_definitions(self):
        result = {}
        for module_set_id, version in self.settings().get("enabled_module_sets", {}).items():
            directory = self.module_set_path(module_set_id, version)
            manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
            for action_id in manifest["actions"]:
                if action_id in result or action_id in builtin_definitions() or (self.registry / (action_id + ".json")).exists():
                    raise ValueError("Ambiguous Action provider: " + action_id)
                result[action_id] = directory / "definitions" / (action_id + ".json")
        return result

    def module_set_load(self, module_set_id, version, enabled=True):
        if type(enabled) is not bool:
            raise ValueError("enabled must be a boolean.")
        directory = self.module_set_path(module_set_id, version)
        manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
        with self.lock():
            settings = self.settings()
            previous = dict(settings.get("enabled_module_sets", {}))
            selected = dict(previous)
            if previous.get(module_set_id) != (version if enabled else None):
                old_version = previous.get(module_set_id)
                old_actions = json.loads((self.module_set_path(module_set_id, old_version) / "manifest.json").read_text())["actions"] if old_version else []
                for path in (self.root / "runs").glob("*/run.json"):
                    run = json.loads(path.read_text(encoding="utf-8"))
                    if run.get("state") == "running" and run.get("action_id") in old_actions:
                        raise PermissionError("ModuleSet has running calls; wait or cancel before unloading/replacing.")
                for job in self.queue_read()["jobs"].values():
                    if job["state"] in {"queued", "running"} and job["action_id"] in old_actions:
                        raise PermissionError("ModuleSet has queued/running validation; cancel it before unloading.")
            if enabled:
                selected[module_set_id] = version
            elif selected.get(module_set_id) == version:
                selected.pop(module_set_id)
            settings["enabled_module_sets"] = selected
            _atomic_write(self.root / "settings.json", settings)
            try:
                definitions = list(self.loaded_module_definitions().values()) + list(self.registry.glob("*.json"))
                for path in definitions:
                    definition = json.loads(path.read_text(encoding="utf-8"))
                    self.dependency_closure(definition["action_id"], definition.get("dependencies", {}))
                    for implementation in definition["implementations"]:
                        if implementation["kind"] == "pipeline":
                            effects = validate_steps(implementation.get("steps"), definition.get("dependencies", {}))
                            if not effects.issubset(set(definition["effects"])):
                                raise ValueError("Basic component effects must be declared by the parent Action.")
                    for child, pin in definition.get("dependencies", {}).items():
                        if self.definition(child)["content_hash"] != pin:
                            raise ValueError("Missing or incompatible dependency: " + child)
            except Exception:
                settings["enabled_module_sets"] = previous
                _atomic_write(self.root / "settings.json", settings)
                raise
        return {"ok": True, "module_set_id": module_set_id, "version": version, "enabled": enabled}

    def module_set_remove(self, module_set_id, version):
        directory = self.module_set_path(module_set_id, version)
        self.module_set_load(module_set_id, version, False)
        with self.lock():
            if directory.is_symlink() or not directory.resolve().is_relative_to(self.module_sets.resolve()):
                raise PermissionError("Unsafe package directory.")
            if self.settings().get("enabled_module_sets", {}).get(module_set_id) == version:
                raise PermissionError("ModuleSet was re-enabled; removal denied.")
            shutil.rmtree(directory)
        return {"ok": True, "module_set_id": module_set_id, "version": version, "removed": True, "runs_deleted": False}

    def module_set_export(self, module_set_id, version, action_ids, destination, name="", provenance=None):
        self.module_set_path(module_set_id, version)
        target = Path(destination)
        if target.exists() or not target.resolve().is_relative_to(self.workspace()):
            raise PermissionError("Choose a new package file inside the configured workspace.")
        if not isinstance(action_ids, list) or not action_ids or len(action_ids) > 100:
            raise ValueError("Select 1-100 Actions; export is never the entire catalog by default.")
        assets = {}
        exported = {}

        def collect(action_id, ancestry):
            if action_id in ancestry:
                raise ValueError("Cyclic package dependencies.")
            if action_id in exported or action_id in builtin_definitions():
                return
            definition = self.definition(action_id)
            for child in definition["dependencies"]:
                collect(child, ancestry | {action_id})
            value = {key: item for key, item in definition.items() if key not in {"content_hash", "implementation_hash", "source_id"}}
            implementations = []
            for implementation in value["implementations"]:
                replacements = {}
                for file in implementation.get("files", []) + implementation.get("build", {}).get("source_files", []):
                    source = Path(file.replace("${module_assets}", str(self.loaded_module_definitions()[action_id].parent.parent / "assets"))) if "${module_assets}" in file else Path(file)
                    if source.is_symlink() or not source.is_file() or source.stat().st_size > 16 * 1024 * 1024:
                        raise PermissionError("Only declared bounded regular implementation files can be exported.")
                    content = source.read_bytes()
                    asset_name = hashlib.sha256(content).hexdigest() + "_" + source.name
                    assets["assets/" + asset_name] = content
                    replacements[file] = "${module_assets}/" + asset_name

                def relocate(item):
                    if isinstance(item, str):
                        return replacements.get(item, item)
                    if isinstance(item, list):
                        return [relocate(part) for part in item]
                    if isinstance(item, dict):
                        return {key: relocate(part) for key, part in item.items()}
                    return item

                implementations.append(relocate(implementation))
            value["implementations"] = implementations
            value["dependencies"] = {child: self.definition_value(exported[child])["content_hash"] if child in exported else pin for child, pin in value["dependencies"].items()}
            exported[action_id] = value

        for action_id in action_ids:
            collect(action_id, set())
        entries = {"definitions/" + action_id + ".json": json.dumps(value, sort_keys=True, allow_nan=False).encode() for action_id, value in exported.items()}
        entries.update(assets)
        if sum(len(content) for content in entries.values()) > 32 * 1024 * 1024:
            raise ValueError("Package exceeds 32 MiB; split the ModuleSet.")
        manifest = {"schema": "pkm.action.module-set/v1", "module_set_id": module_set_id, "version": version,
                    "name": name or module_set_id, "actions": sorted(exported), "provenance": provenance or {},
                    "files": {entry: hashlib.sha256(content).hexdigest() for entry, content in entries.items()}}
        manifest["package_hash"] = digest(manifest)
        with target.open("xb") as stream:
            with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                archive.writestr("manifest.json", json.dumps(manifest, sort_keys=True))
                for entry, content in entries.items():
                    archive.writestr(entry, content)
        return {"ok": True, "destination": str(target), "manifest": manifest, "host_state_exported": False}

    def module_set_import(self, local_path):
        source = Path(local_path)
        if source.is_symlink() or not source.is_file() or not source.resolve().is_relative_to(self.workspace()) or source.stat().st_size > 32 * 1024 * 1024:
            raise PermissionError("Import a bounded regular package inside the selected workspace.")
        with zipfile.ZipFile(source) as archive:
            infos = archive.infolist()
            if len(infos) > 500 or len({info.filename for info in infos}) != len(infos) or sum(info.file_size for info in infos) > 32 * 1024 * 1024:
                raise ValueError("Duplicate, oversized or excessive package entries.")
            for info in infos:
                if Path(info.filename).is_absolute() or ".." in Path(info.filename).parts or "\\" in info.filename or ":" in info.filename or (info.external_attr >> 16) & 0o170000 == 0o120000:
                    raise ValueError("Unsafe package path or symlink.")
            manifest = json.loads(archive.read("manifest.json"))
            if manifest.get("schema") != "pkm.action.module-set/v1" or manifest.get("package_hash") != digest({key: value for key, value in manifest.items() if key != "package_hash"}):
                raise ValueError("Invalid package manifest/hash.")
            directory = self.module_set_path(manifest["module_set_id"], manifest["version"])
            if set(archive.namelist()) != {"manifest.json"} | set(manifest["files"]):
                raise ValueError("Undeclared package files.")
            contents = {entry: archive.read(entry) for entry in manifest["files"]}
            for entry, content in contents.items():
                if hashlib.sha256(content).hexdigest() != manifest["files"][entry]:
                    raise ValueError("Package file hash mismatch.")
                if not entry.startswith(("assets/", "definitions/")):
                    raise ValueError("Host state is not portable package content.")
            for action_id in manifest["actions"]:
                if not isinstance(action_id, str) or not re.fullmatch(r"[a-z][a-z0-9_.-]{2,100}", action_id) or action_id in builtin_definitions():
                    raise ValueError("Invalid/reserved packaged Action ID.")
                value = json.loads(contents["definitions/" + action_id + ".json"])
                if value.get("action_id") != action_id or not value.get("knowledgeId") or value.get("schema") != "pkm.action.definition/v1":
                    raise ValueError("Invalid packaged Action identity.")
                for key in ["input_schema", "output_schema"]:
                    Draft202012Validator.check_schema(value[key])
            with self.lock():
                if directory.exists():
                    existing = json.loads((directory / "manifest.json").read_text())
                    if existing["package_hash"] != manifest["package_hash"]:
                        raise ValueError("Immutable ModuleSet version already exists with different content.")
                    return {"ok": True, "manifest": existing, "enabled": False, "already_installed": True}
                temporary = directory.with_name(".install-" + uuid.uuid4().hex)
                temporary.mkdir(parents=True)
                try:
                    for entry, content in contents.items():
                        path = temporary / entry
                        path.parent.mkdir(parents=True, exist_ok=True)
                        path.write_bytes(content)
                    _atomic_write(temporary / "manifest.json", manifest)
                    temporary.rename(directory)
                except Exception:
                    shutil.rmtree(temporary)
                    raise
        return {"ok": True, "manifest": manifest, "enabled": False, "qualified": False}

    @contextlib.contextmanager
    def lock(self, recover=False):
        self.root.mkdir(parents=True, exist_ok=True)
        with open(self.root / "mutation-lease", "a+b") as lease:
            if os.name == "nt":
                import msvcrt

                def acquire():
                    lease.seek(0)
                    msvcrt.locking(lease.fileno(), msvcrt.LK_NBLCK, 1)

                def release():
                    lease.seek(0)
                    msvcrt.locking(lease.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                def acquire():
                    fcntl.flock(lease.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)

                def release():
                    fcntl.flock(lease.fileno(), fcntl.LOCK_UN)
            deadline = time.monotonic() + 5
            while True:
                try:
                    acquire()
                    break
                except OSError as error:
                    import errno
                    if error.errno not in {errno.EACCES, errno.EAGAIN}:
                        raise
                    if time.monotonic() >= deadline:
                        raise RuntimeError("Action state is busy; retry the original launch key.") from error
                    time.sleep(0.01)
            try:
                with self._mutation_marker(recover):
                    yield
            finally:
                release()

    @contextlib.contextmanager
    def _mutation_marker(self, recover=False):
        self.root.mkdir(parents=True, exist_ok=True)
        lock_path = self.root / "mutation.lock"
        deadline = time.monotonic() + 5
        while True:
            try:
                descriptor = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                break
            except FileExistsError:
                try:
                    owner = json.loads(lock_path.read_text(encoding="utf-8"))
                except (FileNotFoundError, json.JSONDecodeError):
                    if time.monotonic() >= deadline:
                        if recover:
                            lock_path.unlink(missing_ok=True)
                            continue
                        raise RuntimeError("Action mutation lock is incomplete; explicit recovery is required.")
                    time.sleep(0.01)
                    continue
                if not process_alive(owner["pid"]):
                    lock_path.unlink(missing_ok=True)
                    continue
                if time.monotonic() >= deadline:
                    raise RuntimeError("Action state is busy or requires lock recovery; retry the same key, not a new invocation.")
                time.sleep(0.01)
        try:
            os.write(descriptor, json.dumps({"pid": os.getpid(), "started_at": now().isoformat()}).encode())
            os.fsync(descriptor)
            yield
        finally:
            os.close(descriptor)
            lock_path.unlink(missing_ok=True)

    def settings(self):
        path = self.root / "settings.json"
        return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"workspace_roots": {}}

    def catalog_layout(self):
        path = self.root / "catalog.json"
        return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"groups": [], "actions": {}}

    def category_path(self, category):
        if not isinstance(category, str) or len(category) > 500:
            raise ValueError("Invalid group path.")
        segments = category.split("/")
        if len(segments) > 12 or any(not part.strip() or part != part.strip() or part in {".", ".."}
                                   or len(part) > 80 or any(ord(char) < 32 or char == "\\" for char in part) for part in segments):
            raise ValueError("Use nonempty group names separated by '/'.")
        if segments[0].casefold() == "core":
            raise PermissionError("The system core group is read-only.")
        return category

    def group_create(self, name, parent=""):
        if not isinstance(name, str) or "/" in name:
            raise ValueError("A group name must be a single path segment.")
        category = self.category_path(parent + "/" + name if parent else name)
        with self.lock():
            layout = self.catalog_layout()
            if parent and parent not in self.catalog_groups(layout):
                raise ValueError("Create the parent group first.")
            if category in layout["groups"]:
                raise ValueError("This group already exists.")
            layout["groups"].append(category)
            _atomic_write(self.root / "catalog.json", layout)
        return {"ok": True, "category": category}

    def authoring_action(self, action_id):
        if action_id in builtin_definitions() or action_id in component_definitions():
            raise PermissionError("System core components are read-only.")
        return self.definition(action_id)

    def action_rename(self, action_id, name):
        self.authoring_action(action_id)
        if not isinstance(name, str) or not name.strip() or len(name) > 120 or any(ord(char) < 32 for char in name):
            raise ValueError("Choose a nonempty Action name of at most 120 characters.")
        with self.lock():
            layout = self.catalog_layout()
            layout["actions"].setdefault(action_id, {})["display_name"] = name.strip()
            _atomic_write(self.root / "catalog.json", layout)
        return {"ok": True, "action_id": action_id, "display_name": name.strip()}

    def action_move(self, action_id, category):
        self.authoring_action(action_id)
        self.category_path(category)
        with self.lock():
            layout = self.catalog_layout()
            if category not in self.catalog_groups(layout):
                raise ValueError("Choose an existing group.")
            layout["actions"].setdefault(action_id, {})["category"] = category
            _atomic_write(self.root / "catalog.json", layout)
        return {"ok": True, "action_id": action_id, "category": category}

    def catalog_groups(self, layout=None):
        layout = layout or self.catalog_layout()
        categories = set(layout["groups"]) | {"Actions", "core"}
        categories.update(item.get("category", "Actions") for item in layout["actions"].values())
        for package in self.module_set_list()["module_sets"]:
            if package["enabled"]:
                categories.add(package["name"])
        return sorted({"/".join(category.split("/")[:index]) for category in categories
                       for index in range(1, len(category.split("/")) + 1)})

    def editable_definition(self, action_id):
        definition = self.authoring_action(action_id)
        if not (self.registry / (action_id + ".json")).is_file():
            raise PermissionError("ModuleSet definitions are read-only; unload the package or create a local Action.")
        return definition

    def authoring_idle(self, action_id):
        for path in (self.root / "runs").glob("*/run.json"):
            record = json.loads(path.read_text(encoding="utf-8"))
            if record["state"] == "running" and (record["action_id"] == action_id
                    or action_id in record["definition"].get("dependencies", {})):
                raise PermissionError("The Action has an unresolved running call; wait or cancel before changing it.")
        for job in self.queue_read()["jobs"].values():
            if job["state"] in {"queued", "running"} and job["action_id"] == action_id:
                raise PermissionError("Cancel queued/running validation before changing the Action.")

    def action_delete(self, action_id, content_hash):
        with self.lock():
            definition = self.editable_definition(action_id)
            if definition["content_hash"] != content_hash:
                raise ValueError("Action changed; refresh before deleting.")
            self.authoring_idle(action_id)
            providers = list(self.registry.glob("*.json")) + list(self.module_sets.glob("*/*/definitions/*.json"))
            for path in providers:
                parent = json.loads(path.read_text(encoding="utf-8"))
                if parent["action_id"] != action_id and action_id in parent.get("dependencies", {}):
                    raise PermissionError("Action is referenced by " + parent["action_id"] + "; remove that dependency first.")
            (self.registry / (action_id + ".json")).unlink()
            layout = self.catalog_layout()
            layout["actions"].pop(action_id, None)
            _atomic_write(self.root / "catalog.json", layout)
        return {"ok": True, "action_id": action_id, "runs_deleted": False, "source_files_deleted": False}

    def definition_read(self, action_id):
        definition = self.editable_definition(action_id)
        value = {key: item for key, item in definition.items()
                 if key not in {"knowledgeId", "source_id", "content_hash", "implementation_hash"}}
        return {"ok": True, "definition": value, "content_hash": definition["content_hash"],
                "files": self.source_files(definition)}

    def definition_save(self, action_id, definition, content_hash):
        current = self.editable_definition(action_id)
        if current["content_hash"] != content_hash or definition.get("action_id") != action_id:
            raise ValueError("Action changed or its identity was modified; refresh before editing.")
        value = self.register(definition, expected_content_hash=content_hash)
        return {"ok": True, "definition": value}

    def source_files(self, definition):
        extensions = {".py", ".cs", ".rs", ".go", ".java", ".js", ".cjs", ".mjs", ".ts", ".sh"}
        candidates = set()
        for implementation in definition["implementations"]:
            for filename in implementation.get("files", []) + implementation.get("args", []) + implementation.get("build", {}).get("source_files", []):
                if Path(filename).suffix.lower() in extensions and "${" not in filename and Path(filename).is_absolute():
                    candidates.add(filename)
        return sorted(candidates)

    def source_path(self, action_id, filename):
        definition = self.editable_definition(action_id)
        if filename not in self.source_files(definition):
            raise PermissionError("Choose a declared implementation source file.")
        path = Path(filename)
        if path.is_symlink() or not path.is_file() or path.stat().st_size > 512 * 1024:
            raise PermissionError("Only bounded regular implementation source files can be edited.")
        return path

    def source_read(self, action_id, filename):
        path = self.source_path(action_id, filename)
        content = path.read_bytes()
        return {"ok": True, "filename": filename, "content": content.decode("utf-8"),
                "source_hash": hashlib.sha256(content).hexdigest()}

    def source_save(self, action_id, filename, content, source_hash):
        if not isinstance(content, str) or len(content.encode("utf-8")) > 512 * 1024:
            raise ValueError("Implementation source exceeds the editor limit.")
        with self.lock():
            path = self.source_path(action_id, filename)
            self.authoring_idle(action_id)
            if hashlib.sha256(path.read_bytes()).hexdigest() != source_hash:
                raise ValueError("Source changed; reopen it before saving.")
            temporary = path.with_name("." + path.name + "." + uuid.uuid4().hex + ".tmp")
            try:
                with temporary.open("xb") as stream:
                    stream.write(content.encode("utf-8"))
                temporary.chmod(path.stat().st_mode & 0o777)
                os.replace(temporary, path)
            finally:
                temporary.unlink(missing_ok=True)
            (self.root / "validations" / (action_id + ".json")).unlink(missing_ok=True)
        return {"ok": True, "source_hash": hashlib.sha256(content.encode("utf-8")).hexdigest()}

    def action_languages(self, definition, ancestry=()):
        if len(ancestry) > 16 or definition["action_id"] in ancestry:
            return {"Unknown"}
        extensions = {".py": "Python", ".cs": "C#", ".rs": "Rust", ".go": "Go", ".java": "Java",
                      ".js": "JavaScript", ".cjs": "JavaScript", ".mjs": "JavaScript", ".ts": "TypeScript", ".sh": "Shell"}
        languages = set()
        try:
            implementations = [self.implementation(definition)]
        except (PermissionError, OSError):
            implementations = definition["implementations"]
        for implementation in implementations:
            kind = implementation["kind"]
            if kind == "builtin":
                languages.add("Python")
            elif kind == "pipeline":
                if any(step.get("component") in component_definitions() for step in implementation.get("steps", [])):
                    languages.add("Python")
                for child in definition.get("dependencies", {}):
                    try:
                        languages.update(self.action_languages(self.definition(child), ancestry + (definition["action_id"],)))
                    except FileNotFoundError:
                        languages.add("Unknown")
            elif kind == "mcp":
                languages.add("MCP")
            else:
                files = implementation.get("files", []) + implementation.get("args", []) + implementation.get("build", {}).get("source_files", [])
                detected = {extensions[Path(filename).suffix.lower()] for filename in files if Path(filename).suffix.lower() in extensions}
                program = Path(implementation.get("program", "")).name.lower()
                if program.startswith("python"):
                    detected.add("Python")
                languages.update(detected or {"Unknown"})
        return languages or {"Graph"}

    def catalog(self):
        layout = self.catalog_layout()
        packages = self.module_set_list()["module_sets"]
        actions = [{**value, "execution_contract": action_contract(value), "read_only": True, "editable": False, "language": "Python", "languages": ["Python"]}
                   for value in self.components()]
        for definition in self.list():
            identifier = definition["action_id"]
            system = identifier in builtin_definitions()
            languages = sorted(self.action_languages(definition))
            try:
                self.implementation(definition)
                language = "Hybrid" if len(languages) > 1 else languages[0]
            except (PermissionError, OSError):
                language = " / ".join(languages)
            metadata = layout["actions"].get(identifier, {}) if not system else {}
            category = "core" if system else metadata.get("category") or next(
                (package["name"] for package in packages if package["enabled"] and identifier in package["actions"]), "Actions")
            actions.append({**definition, **metadata, "execution_contract": action_contract(definition), "category": category, "read_only": system,
                            "palette_hidden": identifier.startswith("core.cast."),
                            "editable": not system and (self.registry / (identifier + ".json")).is_file(),
                            "languages": languages, "language": language,
                            "availability": self.availability(identifier)})
        return {"ok": True, "actions": actions, "groups": self.catalog_groups(layout),
                "module_sets": packages, "queue": self.queue_status()}

    def workspace(self):
        value = self.settings().get("workspace_roots", {}).get(PLATFORM_KEYS.get(platform.system()))
        if not isinstance(value, str) or not value or not Path(value).is_dir():
            raise PermissionError("needs_workspace: configure personalKnowledge.actions.workspaceRoots for this OS.")
        return Path(value).resolve()

    def configure_workspace(self, directory):
        if not isinstance(directory, str) or not directory or not Path(directory).is_absolute():
            raise ValueError("An explicit absolute workspace directory is required.")
        path = Path(directory).resolve()
        path.mkdir(parents=True, exist_ok=True)
        with self.lock():
            settings = self.settings()
            settings.setdefault("workspace_roots", {})[PLATFORM_KEYS[platform.system()]] = str(path)
            _atomic_write(self.root / "settings.json", settings)
        return {"ok": True, "platform": PLATFORM_KEYS[platform.system()], "workspace": str(path)}

    def definition(self, action_id):
        if not isinstance(action_id, str) or not re.fullmatch(r"[a-z][a-z0-9_.-]{2,100}", action_id):
            raise ValueError("Invalid Action ID.")
        value = builtin_definitions().get(action_id)
        if value is None:
            path = self.registry / (action_id + ".json")
            if not path.exists():
                path = self.loaded_module_definitions().get(action_id)
                if path is None:
                    raise FileNotFoundError("Action is not registered or its ModuleSet is not loaded: " + action_id)
            value = json.loads(path.read_text(encoding="utf-8"))
        return self.definition_value(value)

    def definition_value(self, value):
        action_id = value["action_id"]
        value = {**value, "knowledgeId": value.get("knowledgeId", "action_" + digest(action_id)[:24])}
        value["source_id"] = "pkm://knowledge/" + value["knowledgeId"]
        value["implementation_hash"] = digest({"module": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                                             "run_store": hashlib.sha256(Path(__file__).with_name("action_run_store.py").read_bytes()).hexdigest(),
                                             "components": hashlib.sha256(Path(__file__).with_name("action_components.py").read_bytes()).hexdigest(),
                                             "worker": hashlib.sha256(Path(__file__).with_name("recipe_runtime.py").read_bytes()).hexdigest()})
        value["content_hash"] = digest(value)
        return value

    def list(self):
        names = set(builtin_definitions()) | {path.stem for path in self.registry.glob("*.json")} | set(self.loaded_module_definitions())
        return [self.definition(name) for name in sorted(names)]

    def components(self):
        engine = hashlib.sha256(Path(__file__).with_name("action_components.py").read_bytes()).hexdigest()
        return [{**value, "content_hash": digest({"definition": value, "engine": engine}),
                 "source_id": "pkm://components/" + name, "availability": {"state": "ready"}}
                for name, value in component_definitions().items()]

    def component(self, action_id, value_type=None):
        value = next(item for item in self.components() if item["action_id"] == action_id)
        if value_type is not None:
            if value_type not in VALUE_TYPES:
                raise ValueError("Choose an explicit supported component value type.")
            schema = INTEGER if value_type == "integer" else {"type": value_type}
            if "value" in value["output_schema"]["properties"]:
                value["output_schema"]["properties"]["value"] = schema
            if "values" in value["output_schema"]["properties"]:
                value["output_schema"]["properties"]["values"]["items"] = schema
            if action_id == "core.constant":
                value["input_schema"]["properties"]["value"] = schema
            if action_id == "core.cast":
                value["input_schema"]["properties"]["target_type"] = {"type": "string", "enum": [value_type], "default": value_type}
        return value

    def dependency_closure(self, action_id, dependencies):
        visited = set()
        def visit(name, pins, ancestry):
            if len(ancestry) > 16 or len(visited) > 500:
                raise ValueError("Nested Action dependency budget exceeded.")
            for child, pin in pins.items():
                if child in ancestry:
                    raise ValueError("Nested Action cycle: " + " -> ".join(ancestry + [child]))
                definition = self.definition(child)
                if definition["content_hash"] != pin:
                    raise ValueError("Dependency is not pinned to the current contract: " + child)
                if child not in visited:
                    visit(child, definition["dependencies"], ancestry + [child])
                    visited.add(child)
        visit(action_id, dependencies, [action_id])

    def completed_dependencies(self, action_id, dependencies):
        self.dependency_closure(action_id, dependencies)
        for child in dependencies:
            if self.availability(child)["state"] != "ready":
                raise ValueError("Nested Action must have completed validation for its pinned version: " + child)

    def register(self, definition, expected_content_hash=None):
        allowed = {"schema", "action_id", "version", "description", "input_schema", "output_schema",
                   "effects", "implementations", "dependencies", "casts", "examples", "display_name", "graph", "provenance"}
        if not isinstance(definition, dict) or set(definition) - allowed:
            raise ValueError("Unsupported Action definition fields.")
        name = definition.get("action_id")
        if not isinstance(name, str) or not re.fullmatch(r"[a-z][a-z0-9_.-]{2,100}", name) or name in builtin_definitions() or name in component_definitions():
            raise ValueError("Invalid or reserved Action ID.")
        if definition.get("schema") != "pkm.action.definition/v1" or type(definition.get("version")) is not int:
            raise ValueError("A versioned Action definition is required.")
        for key in ["input_schema", "output_schema"]:
            Draft202012Validator.check_schema(definition[key])
        if not definition.get("implementations") or not definition.get("effects"):
            raise ValueError("Declare implementations and effects.")
        for implementation in definition["implementations"]:
            if implementation.get("kind") not in {"program", "pipeline", "mcp"} or not implementation.get("platforms"):
                raise ValueError("Declare a supported implementation kind and platforms.")
            if implementation["kind"] == "program":
                if not isinstance(implementation.get("args", []), list) or any(not isinstance(arg, str) for arg in implementation.get("args", [])):
                    raise ValueError("Program args must be a string array, never a shell command.")
                build = implementation.get("build")
                if build is not None:
                    if not isinstance(build, dict) or not isinstance(build.get("program"), str) or not build.get("source_files") or not build.get("outputs"):
                        raise ValueError("Build requires a compiler, source_files and outputs.")
                    if not isinstance(build.get("args"), list) or any(not isinstance(arg, str) for arg in build["args"]):
                        raise ValueError("Build args must be an argv array.")
                    for output in build["outputs"]:
                        if not isinstance(output, str) or not output or Path(output).is_absolute() or ".." in Path(output).parts or "\\" in output or ":" in output:
                            raise ValueError("Build outputs must be safe relative paths.")
            if implementation["kind"] == "pipeline":
                effects = validate_steps(implementation.get("steps"), definition.get("dependencies", {}))
                if not effects.issubset(set(definition["effects"])):
                    raise ValueError("Basic component effects must be declared by the parent Action.")
        with self.lock():
            self.registry.mkdir(parents=True, exist_ok=True)
            path = self.registry / (name + ".json")
            previous = json.loads(path.read_text(encoding="utf-8")) if path.exists() else None
            if expected_content_hash is not None and (not previous or self.definition(name)["content_hash"] != expected_content_hash):
                raise ValueError("Action changed; refresh before editing.")
            if previous:
                self.authoring_idle(name)
            if previous and definition["version"] <= previous["version"]:
                raise ValueError("Updating an Action requires a larger version.")
            value = {"dependencies": {}, "casts": {}, "examples": [], **definition,
                     "knowledgeId": previous["knowledgeId"] if previous else "action_" + uuid.uuid4().hex}
            self.completed_dependencies(name, value["dependencies"])
            _atomic_write(path, value)
        return self.definition(name)

    def implementation(self, definition):
        selected = self.settings().get("implementation_bindings", {}).get(definition["action_id"])
        architecture = {"AMD64": "x86_64", "aarch64": "arm64"}.get(platform.machine(), platform.machine())
        matches = [item for item in definition["implementations"] if platform.system() in item["platforms"]
                   and (not item.get("architectures") or architecture in item["architectures"])
                   and (not selected or item.get("id") == selected)]
        if len(matches) != 1:
            raise PermissionError("unsupported: exactly one implementation must match the execution OS.")
        implementation = json.loads(json.dumps(matches[0]))
        if "${module_assets}" in json.dumps(implementation):
            path = self.loaded_module_definitions().get(definition["action_id"])
            if not path:
                raise PermissionError("Packaged implementation assets require an enabled ModuleSet.")

            def resolve(value):
                if isinstance(value, str):
                    return value.replace("${module_assets}", str(path.parent.parent / "assets"))
                if isinstance(value, list):
                    return [resolve(item) for item in value]
                if isinstance(value, dict):
                    return {key: resolve(item) for key, item in value.items()}
                return value

            implementation = resolve(implementation)
        return implementation

    def implementation_select(self, action_id, implementation_id):
        definition = self.definition(action_id)
        if not any(item.get("id") == implementation_id for item in definition["implementations"]):
            raise ValueError("Unknown implementation ID.")
        with self.lock():
            settings = self.settings()
            previous = dict(settings.get("implementation_bindings", {}))
            settings.setdefault("implementation_bindings", {})[action_id] = implementation_id
            _atomic_write(self.root / "settings.json", settings)
            try:
                self.implementation(definition)
            except Exception:
                settings["implementation_bindings"] = previous
                _atomic_write(self.root / "settings.json", settings)
                raise
        return {"ok": True, "action_id": action_id, "implementation_id": implementation_id}

    def graph_definition(self, graph):
        if not isinstance(graph, dict) or not isinstance(graph.get("nodes"), list) or not 1 <= len(graph["nodes"]) <= 100 or len(graph.get("edges", [])) > 500:
            raise ValueError("A graph needs 1-100 blocks and at most 500 connections.")
        nodes = {}
        dependencies = {}
        effects = set()
        for node in graph["nodes"]:
            identifier = node.get("id")
            if not isinstance(identifier, str) or not re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", identifier) or identifier in nodes:
                raise ValueError("Duplicate or invalid block ID.")
            basic = node["action_id"] in component_definitions()
            definition = self.component(node["action_id"], node.get("value_type")) if basic else self.definition(node["action_id"])
            if node.get("content_hash") != definition["content_hash"]:
                raise ValueError("Block contract changed: " + identifier)
            parameters = dict(node.get("parameters", {}))
            properties = definition["input_schema"].get("properties", {})
            if set(parameters) - set(properties):
                raise ValueError("Unknown block parameter: " + identifier)
            for field, value in parameters.items():
                check(properties[field], value)
            nodes[identifier] = {"definition": definition, "inputs": parameters, "predecessors": set(), "basic": basic}
            if not basic:
                dependencies[definition["action_id"]] = definition["content_hash"]
            else:
                for child in referenced_actions([{"id": identifier, "component": node["action_id"], "inputs": parameters}]):
                    child_definition = self.definition(child)
                    dependencies[child] = child_definition["content_hash"]
                    effects.update(child_definition["effects"])
            effects.update(definition["effects"])
        connected = set()
        for edge in graph.get("edges", []):
            source, target = nodes[edge["source"]], nodes[edge["target"]]
            source_schema = source["definition"]["output_schema"].get("properties", {}).get(edge["output"])
            target_schema = target["definition"]["input_schema"].get("properties", {}).get(edge["input"])
            if source_schema is None or target_schema is None or target_schema != {} and digest(source_schema) != digest(target_schema):
                raise ValueError("Incompatible typed ports; use an explicit conversion block.")
            key = (edge["target"], edge["input"])
            if key in connected:
                raise ValueError("An input port accepts only one source.")
            connected.add(key)
            target["inputs"][edge["input"]] = {"$step": edge["source"] + "." + edge["output"]}
            target["predecessors"].add(edge["source"])
        steps = []
        remaining = dict(nodes)
        while remaining:
            eligible = [identifier for identifier, node in remaining.items() if not node["predecessors"].intersection(remaining)]
            if not eligible:
                raise ValueError("Action graph has a cycle.")
            for identifier in eligible:
                node = remaining.pop(identifier)
                if set(node["definition"]["input_schema"].get("required", [])) - set(node["inputs"]):
                    raise ValueError("Missing required block inputs: " + identifier)
                steps.append({"id": identifier, "component" if node["basic"] else "action_id": node["definition"]["action_id"], "inputs": node["inputs"],
                              **({"output_schema": node["definition"]["output_schema"]} if node["basic"] else {})})
        output_node = graph.get("output_node", steps[-1]["id"])
        if output_node not in nodes:
            raise ValueError("Select a valid output block.")
        output_schema = nodes[output_node]["definition"]["output_schema"]
        if output_schema.get("type") != "object" or not output_schema.get("properties"):
            raise ValueError("Graph output requires named object ports.")
        self.completed_dependencies(graph["action_id"], dependencies)
        effects.update(validate_steps(steps, dependencies))
        return {"schema": "pkm.action.definition/v1", "action_id": graph["action_id"], "version": graph.get("version", 1),
                "display_name": graph.get("name", graph["action_id"]), "description": graph.get("name", "Graphical Action composition"),
                "graph": graph, "input_schema": object_schema({}), "output_schema": output_schema,
                "effects": sorted(effects), "dependencies": dependencies,
                "implementations": [{"kind": "pipeline", "platforms": ["Linux", "Windows", "Darwin"], "steps": steps,
                    "output": {field: {"$step": output_node + "." + field} for field in output_schema["properties"]}}], "examples": [{"inputs": {}}]}

    def graph_save(self, graph):
        return self.register(self.graph_definition(graph))

    def resolve_program(self, name):
        bindings = self.settings().get("toolchains", {}).get(PLATFORM_KEYS[platform.system()], {})
        if name in bindings:
            configured = bindings[name]
            if not isinstance(configured, str) or not Path(configured).is_absolute():
                raise PermissionError("Action toolchain binding must be an absolute executable path: " + name)
            executable = Path(configured).resolve()
            if not executable.is_file() or not os.access(executable, os.X_OK):
                raise PermissionError("Configured Action toolchain is unavailable on this execution host: " + name)
            return str(executable)
        executable = sys.executable if name == "python" else shutil.which(name) if name else None
        if name and not executable:
            raise PermissionError("Missing Action toolchain: " + name + ". Install it on the execution host and configure personalKnowledge.actions.toolchains; PKM does not install SDKs.")
        return executable

    def fingerprint(self, definition):
        implementation = self.implementation(definition)
        program = implementation.get("program") or implementation.get("server", {}).get("program")
        executable = self.resolve_program(program)
        if program and not executable:
            raise PermissionError("Missing runtime: " + program)
        files = [Path(executable)] if executable else []
        for file in implementation.get("files", []):
            files.append(Path(file).resolve())
        build = self.build_state(definition)
        if build["state"] not in {"not_required", "built"}:
            raise PermissionError("needs_build: " + build["state"])
        return digest({"platform": platform.system(), "architecture": platform.machine(), "python": sys.version,
                       "workspace": str(self.workspace()), "implementation": implementation,
                       "packages": {name: importlib.metadata.version(name) for name in ["jsonschema", "fastmcp"]},
                       "files": {str(file): hashlib.sha256(file.read_bytes()).hexdigest() for file in files}, "build": build,
                       "dependencies": {child: self.definition(child)["content_hash"] for child in definition["dependencies"]}})

    def build_key(self, definition):
        build = self.implementation(definition)["build"]
        program = self.resolve_program(build["program"])
        if not program:
            raise PermissionError("Missing compiler: " + build["program"])
        version = subprocess.run([program, "--version"], capture_output=True, text=True, timeout=5)
        if version.returncode != 0 or len(version.stdout.encode()) > 16384:
            raise PermissionError("Compiler version probe failed.")
        return digest({"definition": definition["content_hash"], "platform": platform.system(), "architecture": platform.machine(),
                       "compiler": str(Path(program).resolve()), "compiler_hash": hashlib.sha256(Path(program).read_bytes()).hexdigest(),
                       "compiler_version": version.stdout.strip(), "workspace": str(self.workspace()),
                       "sources": {str(Path(file).resolve()): hashlib.sha256(Path(file).read_bytes()).hexdigest() for file in build["source_files"]}})

    def build_state(self, definition):
        if not self.implementation(definition).get("build"):
            return {"state": "not_required"}
        key = self.build_key(definition)
        path = self.root / "builds" / (key + ".json")
        if not path.exists():
            return {"state": "missing", "key": key}
        record = json.loads(path.read_text(encoding="utf-8"))
        if record["state"] != "built":
            return {"state": record["state"], "key": key}
        directory = Path(record["directory"])
        if directory.is_symlink() or not directory.resolve().is_relative_to(self.workspace()):
            return {"state": "stale", "key": key}
        for output, expected in record["outputs"].items():
            artifact = directory / output
            if artifact.is_symlink() or not artifact.resolve().is_relative_to(directory.resolve()) or not artifact.is_file() or hashlib.sha256(artifact.read_bytes()).hexdigest() != expected:
                return {"state": "stale", "key": key}
        return {"state": "built", "key": key, "directory": str(directory), "outputs": record["outputs"]}

    def ensure_build(self, definition, cancel_path=None):
        self.authorize(definition)
        state = self.build_state(definition)
        if state["state"] in {"not_required", "built"}:
            return state
        build = self.implementation(definition)["build"]
        key = state["key"]
        directory = self.workspace() / ("action_build_" + uuid.uuid4().hex)
        directory.mkdir(mode=0o700)
        _atomic_write(directory / ".pkm-action-owner.json", {"build_key": key})
        args = [arg.replace("${build_dir}", str(directory)) for arg in build["args"]]
        spec = {"program": self.resolve_program(build["program"]), "args": args,
                "cwd": str(directory), "timeoutSeconds": min(300, max(1, build.get("timeout_seconds", 120))), "maxOutputBytes": 65536}
        if cancel_path:
            spec["cancelPath"] = str(cancel_path)
        _atomic_write(directory / "build-spec.json", spec)
        _execute_command_worker(directory / "build-spec.json", directory / "build-result.json")
        result = json.loads((directory / "build-result.json").read_text(encoding="utf-8"))
        record = {"state": "failed", "key": key, "directory": str(directory), "outputs": {}, "completed_at": now().isoformat()}
        if result["ok"] and not result.get("stdout_truncated") and self.build_key(definition) == key:
            for output in build["outputs"]:
                artifact = directory / output
                if artifact.is_symlink() or not artifact.resolve().is_relative_to(directory.resolve()) or not artifact.is_file():
                    break
                record["outputs"][output] = hashlib.sha256(artifact.read_bytes()).hexdigest()
            else:
                record["state"] = "built"
        _atomic_write(self.root / "builds" / (key + ".json"), record)
        if record["state"] != "built":
            raise RuntimeError("Build failed; see retained bounded build-result.json. Execution qualification was not granted.")
        return self.build_state(definition)

    def authorize(self, definition):
        implementation = self.implementation(definition)
        if implementation["kind"] == "builtin" or implementation["kind"] == "pipeline":
            return
        path = self.root / "policy.json"
        policy = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        if not any(grant.get("action_id") == definition["action_id"] and grant.get("content_hash") == definition["content_hash"]
                   and grant.get("trusted_host_execution") is True for grant in policy.get("grants", [])):
            raise PermissionError("Operator must grant this pinned implementation trusted host execution; this is not a sandbox.")

    def availability(self, action_id):
        definition = self.definition(action_id)
        try:
            self.dependency_closure(action_id, definition["dependencies"])
            for implementation in definition["implementations"]:
                if implementation["kind"] == "pipeline":
                    effects = validate_steps(implementation.get("steps"), definition["dependencies"])
                    if not effects.issubset(set(definition["effects"])):
                        raise ValueError("Basic component effects must be declared by the parent Action.")
            self.authorize(definition)
            build = self.build_state(definition)
            if build["state"] not in {"not_required", "built"}:
                return {"state": "build_failed" if build["state"] == "failed" else "needs_build", "build": build}
            fingerprint = self.fingerprint(definition)
            for child, pin in definition["dependencies"].items():
                if self.definition(child)["content_hash"] != pin:
                    return {"state": "stale", "reason": "Dependency changed: " + child}
                if self.availability(child)["state"] != "ready":
                    return {"state": "blocked", "reason": "Dependency is not ready: " + child}
        except (PermissionError, OSError, ValueError) as error:
            return {"state": "unsupported" if str(error).startswith("unsupported:") else "blocked", "reason": str(error)}
        path = self.root / "validations" / (action_id + ".json")
        if not path.exists():
            return {"state": "unverified"}
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
            if record["content_hash"] != definition["content_hash"] or record["environment_fingerprint"] != fingerprint or datetime.datetime.fromisoformat(record["expires_at"]) <= now():
                return {"state": "stale"}
            return {"state": "ready" if record["status"] == "passed" else "failed"}
        except (ValueError, TypeError, KeyError):
            return {"state": "stale"}

    def cast(self, definition, inputs):
        if not isinstance(inputs, dict):
            raise ValueError("Action inputs must be a JSON object.")
        value = dict(inputs)
        for field, target in definition["casts"].items():
            if field not in value:
                continue
            if target == "integer" and isinstance(value[field], str) and re.fullmatch(r"-?(0|[1-9][0-9]*)", value[field]):
                value[field] = int(value[field])
            elif target == "date" and isinstance(value[field], str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", value[field]):
                value[field] = datetime.date.fromisoformat(value[field]).isoformat()
            else:
                raise ValueError("Invalid explicit cast at /" + field)
        check(definition["input_schema"], value)
        return value

    def path(self, run_id):
        if not isinstance(run_id, str) or not re.fullmatch(r"action_run_[0-9a-f]{32}", run_id):
            raise ValueError("Invalid Action run ID.")
        return self.root / "runs" / run_id / "run.json"

    def get(self, run_id):
        path = self.path(run_id)
        if not path.exists():
            return {"ok": False, "run_id": run_id, "state": "outcome_unknown"}
        record = json.loads(path.read_text(encoding="utf-8"))
        process = LAUNCHERS.get(run_id)
        if process and process.poll() is not None:
            LAUNCHERS.pop(run_id, None)
        pid = record.get("execution", {}).get("workerPid") or record.get("launcher_pid")
        if record["state"] == "running" and (pid or record.get("execution")):
            if not pid or not process_alive(pid):
                record.update({"ok": False, "state": "outcome_unknown", "error": "Worker disappeared; reconcile before retry."})
                if record.get("execution"):
                    record["execution"].update({"reasonCode": "worker-unavailable",
                                                "resumeCondition": "Recover this Run and inspect its receipts; do not resubmit."})
        result = self.runs.public({key: value for key, value in record.items() if key != "capability_hash"})
        if record["state"] == "running":
            for child_path in (self.root / "runs").glob("*/run.json"):
                child = json.loads(child_path.read_text(encoding="utf-8"))
                if child.get("root_run_id") == record.get("root_run_id") and child.get("state") == "running" and child.get("execution", {}).get("phase") == "waiting":
                    result.update({"userState": "Waiting", "nextOwner": "user", "reasonCode": "user-choice",
                                   "resumeCondition": "Answer the pending choice in this Run."})
                    break
        return result

    def call(self, action_id, inputs, key, content_hash, parent_context=None, validation=False):
        definition = self.definition(action_id)
        if definition["content_hash"] != content_hash:
            raise ValueError("Action content hash changed.")
        self.authorize(definition)
        inputs = self.cast(definition, inputs)
        if not validation and self.availability(action_id)["state"] != "ready":
            raise PermissionError("Action is not ready for this environment.")
        if not isinstance(key, str) or not 1 <= len(key) <= 200:
            raise ValueError("An invocation key of 1-200 characters is required.")
        parent = None
        if parent_context:
            parent = json.loads(self.path(parent_context["run_id"]).read_text(encoding="utf-8"))
            if digest(parent_context.get("capability")) != parent["capability_hash"] or parent["state"] != "running":
                raise PermissionError("Invalid or expired parent capability.")
            if action_id not in parent["definition"]["dependencies"] or parent["definition"]["dependencies"][action_id] != content_hash:
                raise PermissionError("Child Action is outside the pinned parent dependency scope.")
            if not set(definition["effects"]).issubset(set(parent["definition"]["effects"])) or parent["depth"] >= 16:
                raise PermissionError("Child effect or nesting budget exceeds parent scope.")
            if action_id in parent["ancestry"]:
                raise PermissionError("Recursive Action cycle rejected.")
            if self.cancelled(parent):
                raise PermissionError("Parent was cancelled.")
            key = digest([parent["run_id"], key])
        fingerprint = digest({"action_id": action_id, "inputs": inputs, "hash": content_hash,
                              "parent": parent["run_id"] if parent else None})
        with self.lock():
            self.runs.recover_launches()
            for artifact_id in self.artifact_ids(inputs):
                artifact = self.artifact(artifact_id)
                if artifact.get("owner_root") is not None and not parent and not artifact.get("published"):
                    raise PermissionError("Unpublished artifact is outside the invocation scope.")
                if parent and artifact.get("owner_root") not in {None, parent["root_run_id"]} and not artifact.get("published"):
                    raise PermissionError("Artifact is outside the parent invocation scope.")
            key_path = self.root / "module-keys" / (digest(key) + ".json")
            if key_path.exists():
                previous = json.loads(key_path.read_text(encoding="utf-8"))
                if previous["fingerprint"] != fingerprint:
                    raise ValueError("Invocation key reused with different inputs.")
                return {**self.get(previous["run_id"]), "launch_reused": True}
            run_id = "action_run_" + uuid.uuid4().hex
            directory = (Path(parent["workspace"]) / run_id) if parent else self.workspace() / run_id
            directory.mkdir(mode=0o700)
            _atomic_write(directory / ".pkm-action-owner.json", {"run_id": run_id})
            token = secrets.token_hex(32)
            record = {"schema": "pkm.action.run/v1", "engine": "module", "run_id": run_id,
                      "action_id": action_id, "definition": definition, "content_hash": content_hash,
                      "inputs": inputs, "ok": True, "state": "running", "workspace": str(directory),
                      "workspace_base": parent["workspace_base"] if parent else str(self.workspace()),
                      "parent_run_id": parent["run_id"] if parent else None,
                      "root_run_id": parent["root_run_id"] if parent else run_id,
                      "depth": parent["depth"] + 1 if parent else 0,
                      "ancestry": parent["ancestry"] + [action_id] if parent else [action_id],
                      "deadline": min(parent["deadline"], time.time() + 300) if parent else time.time() + 300,
                      "environment_fingerprint": self.fingerprint(definition),
                      "started_at": now().isoformat(), "capability_hash": digest(token), "gc_state": "pending"}
            record["validation"] = validation or bool(parent and parent.get("validation"))
            self.runs.prepare(record, key_path, fingerprint, definition)
            self.retain_inputs(inputs, record["root_run_id"])
            try:
                self.runs.transition(record, "dispatched", "worker-launch")
                process = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--worker", str(self.store), run_id],
                                           env={**os.environ, "PKM_ACTION_TOKEN": token}, stdin=subprocess.DEVNULL,
                                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                           **_background_process_options())
                LAUNCHERS[run_id] = process
                record["launcher_pid"] = process.pid
            except OSError as error:
                record.update({"ok": False, "state": "failed", "error": type(error).__name__, "completed_at": now().isoformat()})
            if record["state"] == "failed":
                self.runs.transition(record, "completed", "dispatch-failed", "none")
            else:
                _atomic_write(self.path(run_id), record)
        return {**self.get(run_id), "launch_reused": False}

    def list_runs(self, limit=50):
        if type(limit) is not int or not 1 <= limit <= 200:
            raise ValueError("Run history limit must be between 1 and 200.")
        records = []
        for path in (self.root / "runs").glob("*/run.json"):
            record = json.loads(path.read_text(encoding="utf-8"))
            if record.get("engine") != "module" or record.get("parent_run_id") or record.get("validation"):
                continue
            records.append(record)
        records.sort(key=lambda record: record.get("started_at", ""), reverse=True)
        fields = ("run_id", "action_id", "state", "userState", "nextOwner", "reasonCode", "started_at", "completed_at", "error")
        return {"ok": True, "runs": [{key: value for key, value in self.get(record["run_id"]).items() if key in fields}
                                    for record in records[:limit]], "total": len(records)}

    def cancelled(self, record):
        current = record
        while current:
            if self.path(current["run_id"]).with_name("cancel.json").exists():
                return True
            current = json.loads(self.path(current["parent_run_id"]).read_text(encoding="utf-8")) if current.get("parent_run_id") else None
        return time.time() >= record["deadline"]

    def cancel(self, run_id):
        record = self.get(run_id)
        if record.get("state") == "running":
            descendants = {run_id}
            runs = [json.loads(path.read_text(encoding="utf-8")) for path in (self.root / "runs").glob("*/run.json")]
            while True:
                expanded = descendants | {item["run_id"] for item in runs if item.get("parent_run_id") in descendants}
                if expanded == descendants:
                    break
                descendants = expanded
            for child in descendants:
                _atomic_write(self.path(child).with_name("cancel.json"), {"requested": True})
        return {**record, "cancel_requested": record.get("state") == "running", "remote_rollback": False}

    def wait(self, run_id):
        while True:
            record = self.get(run_id)
            if record["state"] != "running":
                return record
            if time.time() > record["deadline"] + 5:
                self.cancel(run_id)
                raise TimeoutError("Action deadline exceeded; reconcile the existing run.")
            time.sleep(0.05)

    def validate(self, action_id, content_hash, progress=None, cancel_path=None):
        definition = self.definition(action_id)
        if content_hash != definition["content_hash"] or not definition["examples"]:
            raise ValueError("Pin a definition with controlled smoke examples.")
        self.authorize(definition)
        self.completed_dependencies(action_id, definition["dependencies"])
        if cancel_path and Path(cancel_path).exists():
            raise TimeoutError("Validation cancelled.")
        if progress:
            progress("build" if self.implementation(definition).get("build") else "preflight")
        self.ensure_build(definition, cancel_path)
        fingerprint = self.fingerprint(definition)
        if progress:
            progress("test")
        evidence = []
        for example in definition["examples"]:
            if cancel_path and Path(cancel_path).exists():
                raise TimeoutError("Validation cancelled.")
            result = self.call(action_id, example["inputs"], "validation-" + uuid.uuid4().hex, content_hash, validation=True)
            while result["state"] == "running":
                if cancel_path and Path(cancel_path).exists():
                    self.cancel(result["run_id"])
                if time.time() > result["deadline"] + 5:
                    self.cancel(result["run_id"])
                    raise TimeoutError("Validation worker deadline exceeded; reconcile before retry.")
                time.sleep(0.05)
                result = self.get(result["run_id"])
            passed = result["state"] == "succeeded" and ("output" not in example or result.get("output") == example["output"])
            evidence.append({"run_id": result["run_id"], "passed": passed})
            self.gc(result["run_id"], release_outputs=True)
            if result["state"] == "outcome_unknown" or (cancel_path and Path(cancel_path).exists()):
                raise TimeoutError("Validation outcome unknown or cancelled; readiness was not granted.")
        if self.fingerprint(definition) != fingerprint:
            raise ValueError("Environment changed during qualification.")
        record = {"schema": "pkm.action.validation/v1", "action_id": action_id, "content_hash": content_hash,
                  "environment_fingerprint": fingerprint, "status": "passed" if all(item["passed"] for item in evidence) else "failed",
                  "validated_at": now().isoformat(), "expires_at": (now() + datetime.timedelta(hours=24)).isoformat(), "evidence": evidence}
        _atomic_write(self.root / "validations" / (action_id + ".json"), record)
        return {"ok": record["status"] == "passed", **record}

    def queue_read(self):
        path = self.root / "validation-queue.json"
        return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"schema": "pkm.action.validation-queue/v1", "jobs": {}, "worker_pid": None}

    def queue_save(self, queue):
        _atomic_write(self.root / "validation-queue.json", queue)

    def queue_reconcile(self, queue):
        process = LAUNCHERS.get("validation-queue")
        if process and process.poll() is not None:
            LAUNCHERS.pop("validation-queue", None)
        if queue.get("worker_pid") and not process_alive(queue["worker_pid"]):
            for job in queue["jobs"].values():
                if job["state"] == "running":
                    job.update({"state": "outcome_unknown", "stage": "reconciliation_required", "completed_at": now().isoformat()})
                    _atomic_write(self.root / "validation-jobs" / job["job_id"] / "cancel.json", {"requested": True})
            queue["worker_pid"] = None

    def queue_enqueue(self, action_id, content_hash, priority="demand", allow_effects=False, launch=True):
        priorities = {"demand": 0, "graph": 1, "module_set": 2, "idle": 3}
        if priority not in priorities or type(allow_effects) is not bool:
            raise ValueError("Invalid validation priority or effect consent.")
        if self.definition(action_id)["content_hash"] != content_hash:
            raise ValueError("Action content hash changed.")
        definitions = []
        visited = set()

        def visit(name, ancestry):
            if name in ancestry:
                raise ValueError("Cyclic validation dependencies.")
            if name in visited:
                return
            definition = self.definition(name)
            if not allow_effects and set(definition["effects"]) != {"pure"}:
                raise PermissionError("Effectful smoke tests require explicit consent; enqueueing never grants permissions.")
            if not definition["examples"]:
                raise ValueError("Action has no controlled smoke examples: " + name)
            for child, pin in definition["dependencies"].items():
                if self.definition(child)["content_hash"] != pin:
                    raise ValueError("Dependency changed: " + child)
                visit(child, ancestry | {name})
            visited.add(name)
            definitions.append(definition)

        visit(action_id, set())
        with self.lock():
            queue = self.queue_read()
            self.queue_reconcile(queue)
            selected = {}
            for definition in definitions:
                name = definition["action_id"]
                key = digest({"action": name, "hash": definition["content_hash"], "platform": platform.system(),
                              "architecture": platform.machine(), "workspace": str(self.workspace())})
                active = next((job for job in queue["jobs"].values() if job["key"] == key and job["state"] in {"queued", "running"}), None)
                if active:
                    active["priority"] = min(active["priority"], priorities[priority])
                    selected[name] = active["job_id"]
                    continue
                if len(queue["jobs"]) >= 2048:
                    raise PermissionError("Validation queue history limit reached; archive reviewed diagnostics before adding jobs.")
                job_id = "validation_" + uuid.uuid4().hex
                ready = self.availability(name)["state"] == "ready"
                job = {"job_id": job_id, "key": key, "action_id": name, "content_hash": definition["content_hash"],
                       "priority": priorities[priority], "allow_effects": allow_effects, "queued_at": time.time(),
                       "state": "succeeded" if ready else "queued", "stage": "qualified" if ready else "queued",
                       "depends_on": [selected[child] for child in definition["dependencies"]]}
                queue["jobs"][job_id] = job
                selected[name] = job_id
            self.queue_save(queue)
        if launch:
            self.queue_start()
        return {"ok": True, "job_id": selected[action_id], "dependencies": list(selected.values()), "priority": priority}

    def queue_start(self):
        with self.lock():
            queue = self.queue_read()
            self.queue_reconcile(queue)
            if not queue.get("worker_pid") and any(job["state"] == "queued" for job in queue["jobs"].values()):
                process = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--validation-queue", str(self.store)],
                                           stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                           **_background_process_options())
                LAUNCHERS["validation-queue"] = process
                queue["worker_pid"] = process.pid
            self.queue_save(queue)
        return {"ok": True, "worker_pid": queue["worker_pid"], "max_concurrency": 1}

    def queue_status(self):
        with self.lock():
            queue = self.queue_read()
            self.queue_reconcile(queue)
            self.queue_save(queue)
        jobs = sorted(queue["jobs"].values(), key=lambda job: (job["state"] not in {"queued", "running"}, -job["queued_at"]))
        return {"ok": True, "worker_pid": queue["worker_pid"], "max_concurrency": 1,
                "counts": {state: sum(job["state"] == state for job in jobs) for state in {job["state"] for job in jobs}}, "jobs": jobs[:250]}

    def queue_cancel(self, job_id):
        if not isinstance(job_id, str) or not re.fullmatch(r"validation_[0-9a-f]{32}", job_id):
            raise ValueError("Invalid validation job ID.")
        with self.lock():
            queue = self.queue_read()
            job = queue["jobs"][job_id]
            if job["state"] == "queued":
                job.update({"state": "cancelled", "stage": "cancelled"})
            elif job["state"] == "running":
                _atomic_write(self.root / "validation-jobs" / job_id / "cancel.json", {"requested": True})
                job["cancel_requested"] = True
            self.queue_save(queue)
        return {"ok": True, "job": job, "remote_rollback": False}

    def queue_update(self, job_id, **fields):
        with self.lock():
            queue = self.queue_read()
            queue["jobs"][job_id].update(fields)
            self.queue_save(queue)

    def queue_worker(self):
        while True:
            with self.lock():
                queue = self.queue_read()
                if queue.get("worker_pid") != os.getpid():
                    return
                candidates = []
                for job in queue["jobs"].values():
                    if job["state"] != "queued":
                        continue
                    dependencies = [queue["jobs"][identifier]["state"] for identifier in job["depends_on"]]
                    if any(state not in {"queued", "running", "succeeded"} for state in dependencies):
                        job.update({"state": "blocked", "stage": "dependency_failed"})
                    elif all(state == "succeeded" for state in dependencies):
                        candidates.append(job)
                if not candidates:
                    queue["worker_pid"] = None
                    self.queue_save(queue)
                    return
                job = min(candidates, key=lambda item: (item["priority"] - (time.time() - item["queued_at"]) / 300, item["queued_at"]))
                job.update({"state": "running", "stage": "preflight", "started_at": now().isoformat()})
                self.queue_save(queue)
            cancel_path = self.root / "validation-jobs" / job["job_id"] / "cancel.json"
            try:
                definition = self.definition(job["action_id"])
                if not job["allow_effects"] and set(definition["effects"]) != {"pure"}:
                    raise PermissionError("Effect consent is required.")
                result = self.validate(job["action_id"], job["content_hash"],
                                       progress=lambda stage: self.queue_update(job["job_id"], stage=stage), cancel_path=cancel_path)
                self.queue_update(job["job_id"], state="succeeded" if result["ok"] else "failed", stage="qualified" if result["ok"] else "test_failed",
                                  completed_at=now().isoformat(), evidence=result["evidence"])
            except Exception as error:
                state = "outcome_unknown" if isinstance(error, TimeoutError) else "blocked" if isinstance(error, (PermissionError, FileNotFoundError)) else "failed"
                self.queue_update(job["job_id"], state=state, stage="cancelled" if cancel_path.exists() else "validation_failed",
                                  error=str(error), completed_at=now().isoformat())

    def artifact_path(self, artifact_id):
        if not isinstance(artifact_id, str) or not re.fullmatch(r"artifact_[0-9a-f]{32}", artifact_id):
            raise ValueError("Invalid artifact ID.")
        return self.root / "artifacts" / (artifact_id + ".json")

    def artifact(self, artifact_id):
        record = json.loads(self.artifact_path(artifact_id).read_text(encoding="utf-8"))
        path = Path(record["path"])
        if record.get("gc_state") == "deleted" or path.is_symlink() or not path.is_file():
            raise PermissionError("Artifact is unavailable or replaced by a symlink.")
        if hashlib.sha256(path.read_bytes()).hexdigest() != record["digest"]:
            raise ValueError("Artifact content digest changed.")
        return record

    def artifact_ids(self, value):
        if isinstance(value, dict):
            if set(value) == {"artifact_id"}:
                return {value["artifact_id"]}
            return set().union(*(self.artifact_ids(item) for item in value.values())) if value else set()
        if isinstance(value, list):
            return set().union(*(self.artifact_ids(item) for item in value)) if value else set()
        return set()

    def retain_inputs(self, inputs, root_run_id):
        for artifact_id in self.artifact_ids(inputs):
            record = self.artifact(artifact_id)
            if record.get("owner_root") not in {None, root_run_id} and not record.get("published"):
                raise PermissionError("Artifact is outside the parent run's scope.")
            record["references"] = sorted(set(record["references"]) | {root_run_id})
            _atomic_write(self.artifact_path(artifact_id), record)

    def import_artifact(self, local_path):
        path = Path(local_path)
        if path.is_symlink() or not path.resolve().is_relative_to(self.workspace()) or not path.is_file():
            raise PermissionError("Borrowed input must be a regular file inside the user-selected workspace root.")
        artifact_id = "artifact_" + uuid.uuid4().hex
        record = {"artifact_id": artifact_id, "path": str(path.resolve()), "digest": hashlib.sha256(path.read_bytes()).hexdigest(),
                  "ownership": "borrowed", "owner_root": None, "references": [], "published": True, "gc_state": "retained"}
        _atomic_write(self.artifact_path(artifact_id), record)
        return {"artifact_id": artifact_id}

    def create_artifact(self, record, content):
        if len(content) > 64 * 1024 * 1024:
            raise ValueError("Managed artifact exceeds the 64 MiB allocation limit.")
        artifact_id = "artifact_" + uuid.uuid4().hex
        path = Path(record["workspace"]) / artifact_id
        with path.open("xb") as handle:
            handle.write(content)
        with self.lock():
            _atomic_write(self.artifact_path(artifact_id), {"artifact_id": artifact_id, "path": str(path),
                "digest": hashlib.sha256(content).hexdigest(), "ownership": "managed", "owner_root": record["root_run_id"],
                "references": [record["root_run_id"]], "published": False, "gc_state": "retained"})
        return {"artifact_id": artifact_id}

    def export_artifact(self, artifact_id, destination):
        source = self.artifact(artifact_id)
        path = Path(destination)
        if path.is_symlink() or not path.resolve().is_relative_to(self.workspace()) or not path.parent.is_dir():
            raise PermissionError("Export destination must be inside the selected workspace root.")
        with path.open("xb") as handle:
            handle.write(Path(source["path"]).read_bytes())
        return {"ok": True, "path": str(path.resolve()), "digest": source["digest"], "ownership": "user-exported"}

    def gc(self, run_id, release_outputs=False):
        record = self.get(run_id)
        if record.get("engine") != "module" or record.get("parent_run_id"):
            return {"ok": False, "gc_state": "deferred", "reason": "Only the top-level owner can collect artifacts."}
        if record["state"] == "outcome_unknown":
            return {"ok": False, "gc_state": "deferred", "reason": "Reconcile uncertain effects before collecting their evidence."}
        runs = [self.get(path.parent.name) for path in (self.root / "runs").glob("*/run.json")]
        if any(item.get("root_run_id") == run_id and item["state"] == "running" for item in runs):
            return {"ok": False, "gc_state": "deferred", "reason": "An owning run is still active."}
        if record["state"] != "succeeded" and not release_outputs and now() - datetime.datetime.fromisoformat(record["completed_at"]) < datetime.timedelta(hours=1):
            return {"ok": True, "gc_state": "retained", "reason": "Failure diagnostics retained for one hour."}
        outputs = self.artifact_ids(record.get("output")) if not release_outputs else set()
        deleted = []
        with self.lock():
            manifests = list((self.root / "artifacts").glob("*.json"))
            retained = False
            for manifest in manifests:
                item = json.loads(manifest.read_text(encoding="utf-8"))
                if item["artifact_id"] in outputs:
                    item["published"] = True
                elif run_id in item["references"]:
                    item["references"].remove(run_id)
                if item["ownership"] == "managed" and not item["references"] and item.get("gc_state") != "deleted":
                    owner = self.get(item["owner_root"])
                    path = Path(item["path"])
                    owned_directory = Path(owner["workspace"])
                    marker = owned_directory / ".pkm-action-owner.json"
                    if owned_directory.is_symlink() or not owned_directory.resolve().is_relative_to(Path(owner["workspace_base"]).resolve()) or path.is_symlink() or not path.resolve().is_relative_to(owned_directory.resolve()) or not marker.is_file() or json.loads(marker.read_text())["run_id"] != owner["run_id"]:
                        raise PermissionError("Artifact ownership changed; GC refuses deletion.")
                    item["gc_state"] = "pending_delete"
                    _atomic_write(manifest, item)
                    path.unlink(missing_ok=True)
                    item["gc_state"] = "deleted"
                    deleted.append(item["artifact_id"])
                if item.get("owner_root") == run_id and item["references"]:
                    retained = True
                _atomic_write(manifest, item)
            directory = Path(record["workspace"])
            if not retained and directory.exists():
                marker = directory / ".pkm-action-owner.json"
                if directory.is_symlink() or not directory.resolve().is_relative_to(Path(record["workspace_base"]).resolve()) or not marker.is_file() or json.loads(marker.read_text())["run_id"] != run_id:
                    raise PermissionError("Workspace ownership changed; GC refuses deletion.")
                shutil.rmtree(directory)
            record["gc_state"] = "retained" if retained else "completed"
            _atomic_write(self.path(run_id), record)
        return {"ok": True, "gc_state": record["gc_state"], "deleted": deleted}

    def recover(self):
        reconciled = []
        with self.lock(recover=True):
            self.runs.recover_launches()
            for path in (self.root / "runs").glob("*/run.json"):
                record = json.loads(path.read_text(encoding="utf-8"))
                if record.get("engine") != "module":
                    continue
                pid = record.get("execution", {}).get("workerPid") or record.get("launcher_pid")
                if record["state"] == "running" and (not pid or not process_alive(pid)):
                    _atomic_write(path.with_name("cancel.json"), {"requested": True})
                    record.update({"state": "outcome_unknown", "ok": False, "completed_at": now().isoformat(),
                                   "error": "Worker unavailable after restart; backend reconciliation required, not resubmission."})
                    self.runs.transition(record, "reconciling", "worker-unavailable", "user")
                    if not record.get("execution"):
                        _atomic_write(path, record)
                    reconciled.append(record["run_id"])
        for path in (self.root / "runs").glob("*/run.json"):
            record = json.loads(path.read_text(encoding="utf-8"))
            if record.get("engine") == "module" and record.get("state") in {"succeeded", "failed", "cancelled"} and record.get("root_run_id") == record["run_id"]:
                self.gc(record["run_id"])
        return {"ok": True, "reconciled": reconciled}

    def execute(self, record, context):
        definition = record["definition"]
        if self.definition(record["action_id"])["content_hash"] != record["content_hash"]:
            raise ValueError("Action implementation changed before launch.")
        if self.fingerprint(definition) != record["environment_fingerprint"]:
            raise ValueError("Action execution environment changed before launch.")
        implementation = self.implementation(definition)
        inputs = record["inputs"]
        if self.cancelled(record):
            raise TimeoutError("Invocation cancelled or deadline exceeded.")
        if implementation["kind"] == "builtin":
            if record["action_id"] == "core.date.parse":
                return {"date": inputs["value"]}
            if record["action_id"] == "core.cast.integer-to-string":
                return {"value": str(inputs["value"])}
            if record["action_id"] == "core.cast.string-to-integer":
                if len(inputs["value"]) > 20 or not re.fullmatch(r"-?(?:0|[1-9][0-9]*)", inputs["value"]):
                    raise ValueError("Expected a signed decimal integer without whitespace or leading zeros.")
                return {"value": int(inputs["value"])}
            if record["action_id"] == "core.cast.string-to-float":
                value = inputs["value"].strip() if inputs.get("trim", False) else inputs["value"]
                if len(value) > 128 or not re.fullmatch(r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?", value):
                    raise ValueError("Expected a finite decimal/scientific number; whitespace requires trim=true.")
                number = float(value)
                if not math.isfinite(number):
                    raise ValueError("Float overflow is not permitted.")
                if number == 0.0:
                    from decimal import Decimal
                    if not Decimal(value).is_zero():
                        raise ValueError("Float underflow to zero is not permitted.")
                return {"value": number}
            if record["action_id"] == "core.artifact.write":
                return self.create_artifact(record, inputs["text"].encode("utf-8"))
            if record["action_id"] == "core.artifact.copy":
                source = self.artifact(inputs["source"]["artifact_id"])
                return self.create_artifact(record, Path(source["path"]).read_bytes())
            raise ValueError("Unknown builtin handler.")
        if implementation["kind"] == "pipeline":
            return execute_steps(self, record, context, implementation)
        if implementation["kind"] == "program":
            program = self.resolve_program(implementation["program"])
            directory = self.path(record["run_id"]).parent
            _atomic_write(directory / "input.json", inputs)
            build = self.build_state(definition)
            if build["state"] not in {"not_required", "built"}:
                raise PermissionError("Compiled implementation is no longer available.")
            args = [arg.replace("${build_dir}", build.get("directory", "")) for arg in implementation.get("args", [])]
            spec = {"program": program, "args": args, "cwd": record["workspace"],
                    "inputPath": str(directory / "input.json"), "environment": {"PKM_ACTION_CONTEXT": json.dumps(context)},
                    "timeoutSeconds": max(0.01, record["deadline"] - time.time()), "maxOutputBytes": 65536,
                    "cancelPath": str(directory / "cancel.json")}
            _atomic_write(directory / "program.json", spec)
            try:
                _execute_command_worker(directory / "program.json", directory / "program-result.json")
            finally:
                (directory / "program.json").unlink(missing_ok=True)
            result = json.loads((directory / "program-result.json").read_text(encoding="utf-8"))
            if result.get("cancelled") or result.get("timed_out"):
                raise TimeoutError("Program outcome unknown after cancellation/timeout.")
            if not result["ok"] or result["stdout_truncated"]:
                raise RuntimeError("Program failed or output exceeded its bound.")
            return json.loads(result["stdout"])
        if implementation["kind"] == "mcp":
            async def invoke():
                from fastmcp import Client
                from fastmcp.client.transports import StdioTransport
                server = implementation["server"]
                program = self.resolve_program(server["program"])
                transport = StdioTransport(program, server.get("args", []), cwd=record["workspace"])
                async with asyncio.timeout(max(0.01, record["deadline"] - time.time())):
                    async with Client(transport) as client:
                        tools = {tool.name: tool for tool in await client.list_tools()}
                        tool = tools.get(implementation["tool"])
                        if not tool or digest(tool.inputSchema) != implementation["input_schema_hash"] or digest(tool.outputSchema) != implementation["output_schema_hash"]:
                            raise ValueError("MCP tool contract changed or is missing.")
                        if implementation.get("read_only") and (not tool.annotations or tool.annotations.readOnlyHint is not True):
                            raise PermissionError("MCP tool does not declare the expected read-only effect.")
                        result = await client.call_tool(implementation["tool"], inputs)
                        if result.is_error:
                            raise RuntimeError("MCP tool returned isError.")
                        output = result.structured_content
                        if output is None:
                            output = json.loads("".join(item.text for item in result.content if hasattr(item, "text")))
                        if len(json.dumps(output).encode()) > 65536:
                            raise ValueError("MCP output exceeds the bound.")
                        return output
            return asyncio.run(invoke())
        raise PermissionError("Unsupported implementation.")

    def worker(self, run_id):
        deadline = time.monotonic() + 10
        while (self.root / "mutation.lock").exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        with self.lock():
            record = json.loads(self.path(run_id).read_text(encoding="utf-8"))
            if digest(os.environ.get("PKM_ACTION_TOKEN")) != record["capability_hash"]:
                raise PermissionError("Action worker capability does not match its dispatch.")
            record = self.runs.claim(run_id)
        context = {"store": str(self.store), "run_id": run_id, "capability": os.environ["PKM_ACTION_TOKEN"]}
        os.environ.pop("PKM_ACTION_TOKEN", None)
        try:
            output = self.execute(record, context)
            if self.artifact_ids(output):
                with self.lock():
                    self.retain_inputs(output, record["root_run_id"])
            check(record["definition"]["output_schema"], output)
            if self.cancelled(record):
                raise TimeoutError("Invocation cancelled or deadline exceeded.")
            record.update({"state": "succeeded", "output": output, "ok": True})
        except Exception as error:
            effects = action_contract(record["definition"])["effects"]
            record.update({"state": "outcome_unknown" if isinstance(error, TimeoutError) or effects != ["read"] else "failed", "ok": False, "error": str(error)})
        record["completed_at"] = now().isoformat()
        with self.lock():
            self.runs.finish(record)
        if not record.get("parent_run_id") and record["state"] != "outcome_unknown":
            try:
                self.gc(run_id)
            except Exception as error:
                record["gc_state"] = "failed"
                record["gc_error"] = type(error).__name__
                _atomic_write(self.path(run_id), record)


def invoke_from_environment(action_id, inputs, key):
    context = json.loads(os.environ["PKM_ACTION_CONTEXT"])
    runtime = ModuleRuntime(context["store"])
    parent = runtime.get(context["run_id"])
    pin = parent["definition"]["dependencies"].get(action_id)
    if not pin:
        raise PermissionError("Undeclared child Action.")
    result = runtime.wait(runtime.call(action_id, inputs, key, pin, context)["run_id"])
    if result["state"] != "succeeded":
        raise RuntimeError("Child Action did not succeed: " + result["run_id"])
    return result["output"]


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "--worker":
        ModuleRuntime(sys.argv[2]).worker(sys.argv[3])
    elif len(sys.argv) == 4 and sys.argv[1] == "--invoke":
        print(json.dumps(invoke_from_environment(sys.argv[2], json.load(sys.stdin), sys.argv[3])))
    elif len(sys.argv) == 4 and sys.argv[1] == "--configure-workspace":
        print(json.dumps(ModuleRuntime(sys.argv[2]).configure_workspace(sys.argv[3])))
    elif len(sys.argv) == 3 and sys.argv[1] == "--validation-queue":
        ModuleRuntime(sys.argv[2]).queue_worker()
    elif len(sys.argv) == 3 and sys.argv[1] == "--api":
        runtime = ModuleRuntime(sys.argv[2])
        request = json.load(sys.stdin)
        methods = {"module_sets": runtime.module_set_list, "load": runtime.module_set_load, "remove": runtime.module_set_remove,
                   "import": runtime.module_set_import, "export": runtime.module_set_export, "validate": runtime.queue_enqueue,
                   "queue": runtime.queue_status, "cancel_validation": runtime.queue_cancel, "resume_validation": runtime.queue_start,
                   "select_implementation": runtime.implementation_select, "save_graph": runtime.graph_save,
                   "check_graph": runtime.graph_definition, "call": runtime.call, "run": runtime.get, "cancel_run": runtime.cancel,
                   "runs": runtime.list_runs,
                   "recover_runs": runtime.recover,
                   "group_create": runtime.group_create, "action_rename": runtime.action_rename,
                   "action_move": runtime.action_move, "action_delete": runtime.action_delete,
                   "definition_read": runtime.definition_read, "definition_save": runtime.definition_save,
                   "source_read": runtime.source_read, "source_save": runtime.source_save,
                   "choices": lambda run_id: pending_choices(runtime, run_id),
                   "answer_choice": lambda run_id, request_id, index: answer_choice(runtime, run_id, request_id, index)}
        try:
            if request["method"] == "catalog":
                result = runtime.catalog()
            else:
                result = methods[request["method"]](**request.get("params", {}))
                if request["method"] in {"call", "run", "cancel_run"}:
                    result = {**result, "execution_ok": result.get("ok"), "ok": True}
            print(json.dumps(result, allow_nan=False))
        except Exception as error:
            print(json.dumps({"ok": False, "error": str(error)}))
    else:
        raise SystemExit("Use the managed --worker or --invoke entry.")
"""Inventory the installed importable dependency closure without installing anything."""
import importlib.metadata
import argparse
import hashlib
import json
from pathlib import Path
import sys

from packaging.requirements import Requirement
from packaging.utils import canonicalize_name

parser = argparse.ArgumentParser()
parser.add_argument("--model-requirements", type=Path)
parser.add_argument("--hash-files", action="store_true")
options = parser.parse_args()
requirements = [Requirement("fastmcp")]
requirements_sha256 = None
if options.model_requirements:
    raw = options.model_requirements.read_bytes()
    requirements_sha256 = hashlib.sha256(raw).hexdigest()
    requirements.extend(Requirement(line.strip()) for line in raw.decode("utf-8").splitlines()
                        if line.strip() and not line.lstrip().startswith("#"))
pending = [(dependency.name, frozenset(dependency.extras)) for dependency in requirements]
seen = set()
contexts = set()
files = {}
issues = []
distributions = {}
file_sizes = {}
file_hashes = {}
for requirement in requirements:
    try:
        version = importlib.metadata.version(requirement.name)
        if requirement.specifier and version not in requirement.specifier:
            issues.append("Unsupported declared dependency: " + str(requirement) + " (installed " + version + ")")
    except importlib.metadata.PackageNotFoundError:
        issues.append("Missing declared dependency: " + str(requirement))
while pending:
    requested, extras = pending.pop()
    name = canonicalize_name(requested)
    if (name, extras) in contexts:
        continue
    contexts.add((name, extras))
    seen.add(name)
    try:
        distribution = importlib.metadata.distribution(name)
    except importlib.metadata.PackageNotFoundError:
        issues.append("Missing Python dependency: " + name)
        continue
    distributions[name] = {"version": distribution.version, "files": {}}
    base = Path(distribution.locate_file("")).resolve()
    for requirement in distribution.requires or []:
        dependency = Requirement(requirement)
        if dependency.marker is None or any(dependency.marker.evaluate({"extra": extra}) for extra in ("", *extras)):
            try:
                installed = importlib.metadata.version(dependency.name)
                if dependency.specifier and installed not in dependency.specifier:
                    issues.append("Unsatisfied Python dependency: " + str(dependency) + " (installed " + installed + ")")
            except importlib.metadata.PackageNotFoundError:
                issues.append("Missing Python dependency: " + str(dependency))
            pending.append((dependency.name, frozenset(dependency.extras)))
    if distribution.files is None:
        raise RuntimeError("Uninventoryable Python dependency: " + name)
    for entry in distribution.files:
        relative = str(entry).replace("\\", "/")
        if ".." in Path(relative).parts or "__pycache__" in Path(relative).parts or relative.endswith(".pyc"):
            continue
        source = base / entry
        if source.is_symlink() or not source.is_file():
            raise RuntimeError("Unsupported Python dependency entry: " + str(source))
        if relative in files and files[relative] != str(source):
            raise RuntimeError("Conflicting Python dependency: " + relative)
        files[relative] = str(source)
        file_sizes[relative] = source.stat().st_size
        if options.hash_files and not issues:
            digest = hashlib.sha256()
            with source.open("rb") as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(block)
            file_hashes[relative] = digest.hexdigest()
        distributions[name]["files"][relative] = file_sizes[relative]
print(json.dumps({"schema": "pkm.isolated-python-dependencies/v1", "ready": not issues,
                  "profile": "local-model" if options.model_requirements else "fastmcp",
                  "requirementsSha256": requirements_sha256,
                  "issues": sorted(set(issues)), "python": str(Path(sys.executable).resolve()),
                  "files": files, "fileSizes": file_sizes, "fileHashes": file_hashes,
                  "totalBytes": sum(file_sizes.values()), "distributions": sorted(distributions),
                  "distributionPins": distributions}))

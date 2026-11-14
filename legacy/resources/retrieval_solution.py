"""PKM's offline solution import entry point; no model dependencies are loaded."""

import argparse
import json
from pathlib import Path
import sys
import zipfile
import shutil
import tempfile

from retrieval_runtime import activate_engine

def import_default_directory(source, state):
    from adaptive_skill_retrieval.solution_package import (
        validate_manifest, validate_model, package_id, load_installed, canonical,
    )
    manifest = json.loads((Path(__file__).parent / "retrieval-default-model.json").read_text())["manifest"]
    validate_manifest(manifest)
    source = Path(source)
    if source.is_symlink() or not source.is_dir():
        raise ValueError("Choose a real local model directory, not a symbolic link")
    for name in manifest["files"]:
        if any(parent.is_symlink() for parent in (source / name).parents if parent != source.parent):
            raise ValueError("Model directory must not contain symbolic links")
    validate_model(source, manifest)
    packages = state / "solutions"
    packages.mkdir(parents=True, exist_ok=True)
    identity = package_id(manifest)
    destination = packages / identity
    if destination.exists():
        load_installed(packages, identity)
    else:
        with tempfile.TemporaryDirectory(prefix=".local-import-", dir=packages) as temporary:
            stage = Path(temporary)
            for name in manifest["files"]:
                target = stage / "model" / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source / name, target)
            validate_model(stage / "model", manifest)
            (stage / "manifest.json").write_bytes(canonical(manifest))
            stage.rename(destination)
    return {"package_id": identity, "manifest": manifest}

def main():
    parser = argparse.ArgumentParser()
    sources = parser.add_mutually_exclusive_group(required=True)
    sources.add_argument("--archive", type=Path)
    sources.add_argument("--model-directory", type=Path)
    parser.add_argument("--state", required=True, type=Path)
    args = parser.parse_args()
    try:
        activate_engine()
        from adaptive_skill_retrieval.solution_package import import_package
        result = (import_default_directory(args.model_directory, args.state) if args.model_directory
                  else import_package(args.archive, args.state / "solutions"))
        print(json.dumps({"ok": True, "package_id": result["package_id"],
                          "name": result["manifest"]["name"]}))
        return 0
    except (ImportError, OSError, RuntimeError, ValueError, KeyError, TypeError, zipfile.BadZipFile) as error:
        print(json.dumps({"ok": False, "error": str(error)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

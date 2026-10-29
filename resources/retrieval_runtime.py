"""Pinned engine bootstrap and explicit, offline model-runtime validation."""

import hashlib
from importlib import metadata
import importlib
import json
import os
from pathlib import Path
import sys
import tempfile
import zipfile

ENGINE_VERSION = "0.3.0.dev2026100504"
ENGINE_WHEEL = f"adaptive_skill_retrieval-{ENGINE_VERSION}-py3-none-any.whl"
ENGINE_SHA256 = "332e434272a3cc88410eb50c7e4bfc3e3f69c5bf1e13f7f9a799087c37124f89"
_engine_directory = None


def activate_engine():
    global _engine_directory
    wheel = Path(__file__).resolve().parent / "vendor" / ENGINE_WHEEL
    if wheel.exists():
        if hashlib.sha256(wheel.read_bytes()).hexdigest() != ENGINE_SHA256:
            raise RuntimeError("Bundled retrieval engine failed integrity verification")
        if _engine_directory is None:
            # Implementation fingerprints read real source files, so zipimport is insufficient.
            _engine_directory = tempfile.TemporaryDirectory(prefix="pkm-retrieval-engine-")
            with zipfile.ZipFile(wheel) as archive:
                archive.extractall(_engine_directory.name)
            sys.path.insert(0, _engine_directory.name)
    elif metadata.version("adaptive-skill-retrieval") != ENGINE_VERSION:
        raise RuntimeError("Pinned retrieval engine is unavailable; repair the PKM installation")
    from adaptive_skill_retrieval import __file__ as engine_file
    return {"python": sys.executable, "engine_version": ENGINE_VERSION, "engine_file": engine_file,
            "cpu_threads": int(os.environ.get("OMP_NUM_THREADS", "1"))}


def probe_model_runtime():
    result = activate_engine()
    for name in ("adaptive_skill_retrieval.architecture_retriever",
                 "adaptive_skill_retrieval.solution_package", "torch", "sentence_transformers", "sklearn", "numpy"):
        importlib.import_module(name)
    return result


if __name__ == "__main__":
    try:
        print(json.dumps({"ok": True, **probe_model_runtime()}))
    except (ImportError, OSError, RuntimeError, metadata.PackageNotFoundError) as error:
        print(json.dumps({"ok": False, "error": f"{type(error).__name__}: {error}"}), file=sys.stderr)
        raise SystemExit(1)

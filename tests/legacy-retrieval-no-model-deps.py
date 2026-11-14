"""Test-only missing model dependency injection, retaining the actual original worker."""
import builtins
from pathlib import Path
import runpy
import sys

original = builtins.__import__
def unavailable(name, *args, **kwargs):
    if name == "sentence_transformers" or name.startswith("sentence_transformers."):
        raise ModuleNotFoundError("test injected missing sentence_transformers distribution")
    return original(name, *args, **kwargs)
builtins.__import__ = unavailable
script = Path(__file__).resolve().parents[1] / "compat/legacy-knowledge-mcp.py"
sys.argv = [str(script), "--persistent"]
runpy.run_path(str(script), run_name="__main__")

#!/usr/bin/env python3
"""Compatibility entrypoint for the shared UID-preserving test isolation."""
from pathlib import Path
import runpy

runpy.run_path(str(Path(__file__).resolve().parents[1] / "tests/framework/isolate.py"), run_name="__main__")

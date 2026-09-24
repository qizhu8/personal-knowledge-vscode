#!/usr/bin/env python3
import importlib.util
import json
import os
import pathlib
import statistics
import subprocess
import tempfile
import time


ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("recipe_runtime", ROOT / "resources" / "recipe_runtime.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class FakeMcp:
    def __init__(self):
        self.tools = {}

    def tool(self):
        def decorate(function):
            self.tools[function.__name__] = function
            return function
        return decorate


with tempfile.TemporaryDirectory(prefix="pkm-recipe-retrieval-") as temporary:
    knowledge_root = pathlib.Path(temporary)
    state_dir = knowledge_root / ".pkm" / "state"
    state_dir.mkdir(parents=True)
    subprocess.run([
        "node", "-e",
        "const { ProjectStore } = require('./dist/workflows/project-store.js'); new ProjectStore(process.argv[1]).list();",
        str(state_dir),
    ], cwd=ROOT, check=True)

    mcp = FakeMcp()
    tools = MODULE.register_recipe_tools(mcp, knowledge_root)
    task_contract = json.dumps({
        "outcome": "Release the tested extension package to Marketplace",
        "artifact": "VSIX",
        "channel": "pre-release or stable",
        "safety": "require explicit approval immediately before publication",
    })
    queries = [
        "publish extension marketplace",
        "release vsix marketplace",
        "pre-release extension marketplace",
    ]

    durations = []
    for index in range(50):
        query = queries[index % len(queries)]
        started = time.perf_counter()
        response = json.loads(tools["recipe_search"](
            query=query,
            category="Release",
            task_contract_json=task_contract,
        ))
        durations.append((time.perf_counter() - started) * 1000)
        assert response["outcome"] == "candidates", response
        candidate = response["candidates"][0]
        assert candidate["name"] == "Publish Personal Knowledge VSIX", response
        assert candidate["revision"] == 1, candidate
        assert len(candidate["executable_digest"]) == 64, candidate
        assert response["next_action"]["kind"] == "qualify_recipe", response

    average_ms = statistics.mean(durations)
    maximum_ms = max(durations)
    assert average_ms < 25, f"average Recipe retrieval took {average_ms:.2f}ms"
    assert maximum_ms < 100, f"maximum Recipe retrieval took {maximum_ms:.2f}ms"
    print(
        "recipe library retrieval test: semantic task queries ranked "
        f"Publish Personal Knowledge VSIX first; average={average_ms:.2f}ms max={maximum_ms:.2f}ms"
    )

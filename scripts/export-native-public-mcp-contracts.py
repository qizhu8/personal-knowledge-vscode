"""Regenerate immutable public contracts from the active compatibility facade."""

import argparse
import asyncio
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from types import SimpleNamespace
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / "src" / "native-public-mcp-contracts.ts"


def source_pins():
    return json.loads(subprocess.check_output(
        ["node", str(ROOT / "scripts" / "verify-native-public-mcp-contracts.mjs"), "--source-pins"],
        text=True))


async def export(pins):
    fixture = ROOT / ".native-public-contract-fixture"
    if fixture.exists():
        raise RuntimeError("Owned contract fixture already exists; refusing to reuse it")
    fixture.mkdir(mode=0o700)
    generation = fixture / "generations" / "contracts"
    generation.mkdir(parents=True)
    manifest = {
        "schema": "pkm.mcp.lifecycle/v1", "managedRoot": str(fixture),
        "generation": "contracts", "version": "0.1.0", "enabledFeatureDomains": [],
        "components": {"knowledge": "0.1.0", "chat": "0.1.0",
                       "recipes": "0.1.0", "agent_sessions": "0.1.0"},
    }
    (generation / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    data = fixture / "workspace"
    data.mkdir()
    (data / ".pkm-next-workspace").write_text('{"id":"contracts"}', encoding="utf-8")
    scheduler = "a" * 64
    (generation / "launch.json").write_text(json.dumps({
        "data": str(data), "allowWrites": True,
        "snapshotScheduler": {"schema": "pkm.native-snapshot-scheduler/v1",
                              "workspaceId": "contracts", "actorId": "mcp:external",
                              "admissionSha256": scheduler},
    }), encoding="utf-8")

    class Backend:
        def __init__(self, *_args, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            pass

        async def call_tool(self, name, _arguments):
            if name != "legacy_capability_read":
                raise RuntimeError("Metadata export attempted backend execution")
            return SimpleNamespace(structured_content={"operations": [], "nextOffset": None,
                                                       "revision": "contracts"})

    result = {"schema": "pkm.native-public-mcp-contracts/v1", "sourcePins": pins, "variants": {}}
    try:
        for writable, assets, scheduled in [(False, False, False), (True, False, False),
                                            (True, True, False), (True, False, True),
                                            (True, True, True)]:
            spec = importlib.util.spec_from_file_location(
                "native_contract_facade", ROOT / "compat" / "legacy-compact-mcp.py")
            facade = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(facade)
            original_contract = facade.capability_api._contract

            async def capture(mcp, _lifecycle):
                leaves = await facade.capability_api._catalog(mcp)
                contracts = [facade.capability_api._contract(tool) for tool in leaves]
                definitions = [tool.to_mcp_tool().model_dump(mode="json")
                               for tool in await mcp.list_tools()]
                flags = {name: contract for name, contract in facade.knowledge.captured.TOOLS.items()}
                encoded = json.dumps(contracts, sort_keys=True, ensure_ascii=False).encode("utf-8")
                result["variants"][f"{int(writable)}{int(assets)}{int(scheduled)}"] = {
                    "names": [tool.name for tool in leaves],
                    "revision": hashlib.sha256(encoded).hexdigest(),
                }
                if writable and assets and scheduled:
                    float_paths = []

                    def collect_floats(value, path):
                        if isinstance(value, dict):
                            for key, entry in value.items():
                                collect_floats(entry, [*path, key])
                        elif isinstance(value, list):
                            for index, entry in enumerate(value):
                                collect_floats(entry, [*path, index])
                        elif isinstance(value, float):
                            float_paths.append(path)

                    for contract in contracts:
                        collect_floats(contract, [contract["id"]])
                    result.update(definitions=definitions,
                                  wireDefinitions=[tool.to_mcp_tool().model_dump(
                                      mode="json", by_alias=True, exclude_none=True)
                                                   for tool in await mcp.list_tools()],
                                  contracts=contracts, routing=flags, floatPaths=float_paths,
                                  contractBytes={item["id"]: len(json.dumps(item, ensure_ascii=False).encode("utf-8"))
                                                 for item in contracts})

            arguments = ["contracts", "--data", str(data), "--managed-generation", str(generation)]
            if writable:
                arguments.append("--allow-writes")
            if assets:
                arguments.append("--allow-asset-classification")
            if scheduled:
                arguments.extend(["--experimental-managed-snapshot-scheduler", scheduler])
            with patch.object(facade, "Client", Backend), \
                    patch.object(facade, "run_managed_stdio", capture), \
                    patch.object(sys, "argv", arguments), \
                    patch.dict(os.environ, {"PKM_CAPABILITY_PROFILE": "compact"}):
                await facade.main()
            facade.capability_api._contract = original_contract
        return json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    finally:
        shutil.rmtree(fixture)


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--check", action="store_true")
options = parser.parse_args()
pins = source_pins()
exported = asyncio.run(export(pins))
if source_pins() != pins:
    raise SystemExit("Native public MCP defining sources changed during export; retry the explicit export.")
content = ("// Generated by python scripts/export-native-public-mcp-contracts.py; do not edit.\n"
           "const contracts: unknown = JSON.parse("
           + json.dumps(exported, ensure_ascii=False) + ");\nexport default contracts;\n")
if options.check:
    if TARGET.read_text(encoding="utf-8") != content:
        raise SystemExit("Native public MCP contracts are stale; run this exporter without --check")
else:
    TARGET.write_text(content, encoding="utf-8")
print("Native public MCP contracts source-matched.")

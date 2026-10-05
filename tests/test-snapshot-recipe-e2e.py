#!/usr/bin/env python3
import argparse
import asyncio
import hashlib
import importlib.util
import json
import pathlib
import secrets
import subprocess
import tempfile

from fastmcp import Client, FastMCP


ROOT = pathlib.Path(__file__).resolve().parents[1]


def load_module(name, source):
    spec = importlib.util.spec_from_file_location(name, source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def response_json(result):
    return json.loads(result.content[0].text)


def snapshot_yaml_experiment(store, snapshot_path, record, runtime, encodings):
    import yaml

    payload = runtime._snapshot_decrypt_payload(record)
    assert runtime._snapshot_payload_is_canonical(payload)
    original = snapshot_path.read_bytes()
    node_command = [
        "node", "-e",
        "const snapshots=require(process.argv[1]);process.stdout.write(JSON.stringify(snapshots.readAgentSnapshotContents(process.argv[2],process.argv[3])));",
        str(ROOT / "dist" / "agent-snapshots.js"), str(store), record["snapshotId"],
    ]

    def verify_node():
        result = subprocess.run(node_command, check=True, capture_output=True, text=True)
        captured = json.loads(result.stdout)
        assert captured["snapshotId"] == record["snapshotId"]
        assert captured["session"] == payload["session"]
        assert captured["recipeRuns"] == payload["recipeRuns"]

    verify_node()
    measurements = []
    for name, value in (("encrypted-record", record), ("decrypted-capture", payload)):
        formats = {
            "compact-json": canonical(value),
            "pretty-json": json.dumps(value, ensure_ascii=False, indent=2),
            "yaml": yaml.safe_dump(value, allow_unicode=True, sort_keys=False),
        }
        assert yaml.safe_load(formats["yaml"]) == value
        measurements.append({"case": name, "formats": {
            format: {"bytes": len(text.encode("utf-8")),
                     "estimated_text_tokens": {
                         tokenizer: len(encoding.encode(text, disallowed_special=()))
                         for tokenizer, encoding in encodings.items()}}
            for format, text in formats.items()
        }})

    outer_yaml = yaml.safe_dump(record, allow_unicode=True, sort_keys=False)
    try:
        snapshot_path.write_text(outer_yaml, encoding="utf-8")
        try:
            runtime._load_snapshot_by_magic(store, record["magicCode"])
        except ValueError:
            pass
        else:
            raise AssertionError("Current runtime unexpectedly accepted a raw YAML Snapshot record")
        assert subprocess.run(node_command, capture_output=True).returncode != 0
    finally:
        snapshot_path.write_bytes(original)

    payload_yaml = yaml.safe_dump(payload, allow_unicode=True, sort_keys=False)
    iv = secrets.token_bytes(12)
    encrypted = runtime.AESGCM(runtime.SNAPSHOT_PAYLOAD_KEY).encrypt(
        iv, payload_yaml.encode("utf-8"), runtime._snapshot_aad(record["snapshotId"], record["magicCode"]))
    incompatible = json.loads(canonical(record))
    incompatible["payload"].update({"iv": runtime._snapshot_b64encode(iv),
                                    "ciphertext": runtime._snapshot_b64encode(encrypted[:-16]),
                                    "tag": runtime._snapshot_b64encode(encrypted[-16:])})
    try:
        runtime._snapshot_decrypt_payload(incompatible)
    except json.JSONDecodeError:
        pass
    else:
        raise AssertionError("Current payload decoder unexpectedly accepted YAML plaintext")
    try:
        snapshot_path.write_text(canonical(incompatible), encoding="utf-8")
        assert subprocess.run(node_command, capture_output=True).returncode != 0
    finally:
        snapshot_path.write_bytes(original)

    roundtripped = yaml.safe_load(outer_yaml)
    roundtripped["payload"] = runtime._snapshot_encrypt_payload(
        yaml.safe_load(payload_yaml), record["snapshotId"], record["magicCode"])
    assert roundtripped["snapshotId"] == record["snapshotId"]
    assert roundtripped["magicCode"] == record["magicCode"]
    assert runtime._snapshot_decrypt_payload(roundtripped) == payload
    snapshot_path.write_text(canonical(roundtripped), encoding="utf-8")
    verify_node()
    return measurements


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--yaml-experiment", action="store_true")
    parser.add_argument("--tokens", action="store_true")
    args = parser.parse_args()
    encodings = {}
    if args.tokens:
        import tiktoken
        encodings = {name: tiktoken.get_encoding(name) for name in ("cl100k_base", "o200k_base")}
    measurements = []
    agent_runtime = load_module("snapshot_recipe_agent_runtime", ROOT / "resources" / "agent_session_runtime.py")
    recipe_runtime = load_module("snapshot_recipe_runtime", ROOT / "resources" / "recipe_runtime.py")
    with tempfile.TemporaryDirectory(prefix="pkm-snapshot-recipe-e2e-") as temporary:
        store = pathlib.Path(temporary)
        state_dir = store / ".pkm" / "state"
        state_dir.mkdir(parents=True)
        definition = {
            "schema": "pkm.workflow.definition/v1",
            "spec": {
                "inputs": {
                    "reason": {"type": "string", "required": False, "nullable": False,
                               "schema": {}, "default": "manual"},
                    "stateJson": {"type": "string", "required": False, "nullable": False,
                                  "schema": {}, "default": ""},
                },
                "nodes": [{
                    "nodeId": "create-snapshot",
                    "kind": "pkm.step.native/v1",
                    "config": {
                        "operation": "agent_session_snapshot_create",
                        "arguments": {
                            "reason": "${inputs.reason}",
                            "state_json": "${inputs.stateJson}",
                        },
                    },
                    "dependsOn": [],
                }],
                "outputs": {},
                "completion": {"requiredNodes": ["create-snapshot"]},
            },
        }
        recipe_id = "recipe_" + hashlib.sha256(
            b"pkm/built-in-recipe/v1\0create-agent-snapshot").hexdigest()[:32]
        executable_digest = hashlib.sha256(canonical(definition).encode("utf-8")).hexdigest()
        recipe = {
            "recipeId": recipe_id,
            "scope": "global",
            "category": "System/PKM/Agent Sessions",
            "systemKind": "built-in",
            "name": "Create Agent Snapshot",
            "description": "Create an immutable recovery point for the active Agent Session.",
            "metadata": {
                "applicableFunctions": ["Create Agent Snapshot", "Generate Agent Snapshot"],
                "solution": "Create a Snapshot without model-executed steps.",
                "requiredInputs": [],
                "expectedOutputs": [{"name": "recoveryPrompt",
                                     "description": "Reusable Magic Code prompt"}],
            },
            "definition": definition,
            "executableDigest": executable_digest,
            "revision": 2,
        }
        payload = {
            "state": {
                "schema": 1,
                "rootId": "root_snapshot_e2e",
                "projects": [],
                "threads": [],
                "recipes": [recipe],
                "migrations": [],
                "audit": [],
            },
            "receipts": [],
        }
        envelope = {
            "schema": 1,
            "storeVersion": 1,
            "payload": payload,
            "digest": hashlib.sha256(canonical(payload).encode("utf-8")).hexdigest(),
        }
        (state_dir / "projects.json").write_text(canonical(envelope), encoding="utf-8")

        mcp = FastMCP("snapshot-recipe-e2e")
        agent_tools = agent_runtime.register_agent_session_tools(mcp, store)
        recipe_runtime.register_recipe_tools(
            mcp,
            store,
            store / "subscription-cache",
            store / "environments" / "registry.json",
            {
                "agent_session_snapshot_create": {
                    "handler": agent_tools["agent_session_snapshot_create"],
                    "recipe_id": recipe_id,
                    "revision": 2,
                    "executable_digest": executable_digest,
                    "ephemeral_fields": [],
                },
            },
        )

        async with Client(mcp) as client:
            await client.call_tool("agent_session_start", {
                "task": "Create a Snapshot through the System Recipe",
                "command_id": "snapshot-e2e-session-start",
                "host_session_id": "snapshot-e2e-host",
            })
            if args.yaml_experiment:
                await client.call_tool("agent_session_todo_append", {
                    "todos_json": json.dumps([{"title": "Captured task {}".format(index),
                                               "details": "Preserve Session commitments and verify recovery evidence."}
                                              for index in range(100)]),
                    "command_id": "snapshot-yaml-todos",
                })
            started = response_json(await client.call_tool("recipe_run_start", {
                "recipe_id": recipe_id,
                "command_id": "snapshot-e2e-recipe-start",
                "expected_revision": 2,
                "expected_digest": executable_digest,
                "inputs_json": json.dumps({
                    "reason": "e2e validation",
                    "stateJson": json.dumps({"summary": "Native System Recipe E2E"}),
                }),
            }))
            result = response_json(await client.call_tool("recipe_run_next", {
                "run_id": started["run_id"],
                "command_id": "snapshot-e2e-recipe-next",
                "detail": "full",
            }))
            assert result["status"] == "completed"
            assert result["usage"]["measured_total_tokens"] == 0
            assert result["usage"]["unknown_model_calls"] == 0
            result_text = json.dumps(result)
            assert "ephemeral_output" not in result
            assert "recovery_passphrase" not in result_text
            snapshot_files = list((state_dir / "agent-snapshots").glob("agent_snapshot_*.json"))
            assert len(snapshot_files) == 1
            snapshot_record = json.loads(snapshot_files[0].read_text(encoding="utf-8"))
            expected_prompt = (
                "Call the PKM MCP function agent_session_snapshot_recover with "
                f'{{"magic_code":"{snapshot_record["magicCode"]}"}}.'
            )
            encoded_prompt = json.dumps(expected_prompt)
            assert encoded_prompt in result_text

            run_path = state_dir / "recipe-runs" / f"{started['run_id']}.json"
            persisted_run = run_path.read_text(encoding="utf-8")
            assert "recovery_passphrase" not in persisted_run
            assert encoded_prompt in persisted_run
            assert snapshot_record["payload"]["algorithm"] == "A256GCM-PKM-LOCAL-OBFUSCATION/v1"
            assert "recovery" not in snapshot_record

            replay = response_json(await client.call_tool("recipe_run_next", {
                "run_id": started["run_id"],
                "command_id": "snapshot-e2e-recipe-next",
                "detail": "full",
            }))
            assert replay["replayed"] is True
            assert "ephemeral_output" not in replay
            assert encoded_prompt in json.dumps(replay)
            listed = response_json(await client.call_tool("agent_session_snapshot_list", {}))
            assert len(listed["snapshots"]) == 1
            magic_code = listed["snapshots"][0]["magicCode"]
            if args.yaml_experiment:
                measurements = snapshot_yaml_experiment(
                    store, snapshot_files[0], snapshot_record, agent_runtime, encodings)

        async with Client(mcp) as successor:
            recovered = response_json(await successor.call_tool("agent_session_snapshot_recover", {
                "magic_code": magic_code,
                "host_session_id": "snapshot-e2e-successor",
            }))
            assert recovered["snapshot_id"] == snapshot_record["snapshotId"]
            assert recovered["next_action"]["kind"] == "call_agent_session_todo_next"
            if args.yaml_experiment:
                restored = response_json(await successor.call_tool("agent_session_status", {"detail": "full"}))
                assert [todo["title"] for todo in restored["session"]["todos"]] == [
                    "Captured task {}".format(index) for index in range(100)]

    print("Snapshot System Recipe E2E: native creation, zero model tokens, and password-free recovery OK")
    if args.yaml_experiment:
        print(json.dumps({"status": "passed", "yaml_roundtrip_and_json_recovery": True,
                          "direct_yaml_storage_supported": False,
                          "tokenizers_are_billing_proxies": True,
                          "measurements": measurements}, indent=2))


if __name__ == "__main__":
    asyncio.run(main())

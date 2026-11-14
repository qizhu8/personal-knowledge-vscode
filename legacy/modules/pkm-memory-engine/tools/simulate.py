"""Replay a conversation scenario through the memory policy with a real model, outside PKM.

Usage:
  python tools/simulate.py scenario.json --endpoint https://host/v1 --model NAME [--memory-model NAME]
  python tools/simulate.py scenario.json --command "my-llm-cli"   # reads JSON request on stdin, prints text

Scenario: {"turns": [{"user": "...", "assistant": "optional fixed reply"}], "budget_chars": 24000,
           "expect": [{"turn": 2, "context_contains": "..."}]}
API keys come from OPENAI_API_KEY; nothing is written outside the temporary or given --database.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from pkm_memory_engine import Engine, Memory  # noqa: E402


def openai_caller(endpoint: str, model: str):
    def call(messages: list[dict], max_tokens: int) -> str:
        body = json.dumps({"model": model, "messages": messages, "max_tokens": max_tokens}).encode()
        request = urllib.request.Request(endpoint.rstrip("/") + "/chat/completions", body, {
            "content-type": "application/json", "authorization": f"Bearer {os.environ.get('OPENAI_API_KEY', '')}"})
        with urllib.request.urlopen(request, timeout=120) as response:
            return json.load(response)["choices"][0]["message"]["content"] or ""
    return call


def command_caller(command: str):
    def call(messages: list[dict], max_tokens: int) -> str:
        result = subprocess.run(command, shell=True, input=json.dumps({"messages": messages, "max_tokens": max_tokens}),
                                capture_output=True, text=True, timeout=300, check=True)
        return result.stdout
    return call


def drive(memory: Memory, step: dict, call) -> dict:
    while step["status"] == "model":
        try:
            step = memory.turn_continue(step["turn"], output=call(step["request"]["messages"], step["request"]["max_tokens"]))
        except Exception as error:  # report model failure to the policy; it records a visible fallback
            step = memory.turn_continue(step["turn"], error=str(error))
    return step


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("scenario")
    parser.add_argument("--endpoint")
    parser.add_argument("--model")
    parser.add_argument("--memory-model")
    parser.add_argument("--command")
    parser.add_argument("--database")
    args = parser.parse_args()
    scenario = json.loads(Path(args.scenario).read_text(encoding="utf-8"))
    if args.command:
        chat = memory_call = command_caller(args.command)
    elif args.endpoint and args.model:
        chat = openai_caller(args.endpoint, args.model)
        memory_call = openai_caller(args.endpoint, args.memory_model or args.model)
    else:
        parser.error("Provide --command, or --endpoint with --model.")
    with tempfile.TemporaryDirectory() as directory:
        engine = Engine(args.database or Path(directory) / "memory.sqlite", "simulation")
        memory, history, failures = Memory(engine), [], 0
        for index, turn in enumerate(scenario["turns"], 1):
            user = {"id": f"u{index}", "text": turn["user"]}
            ready = drive(memory, memory.turn_begin("simulation", f"turn-{index}", user, history[-6:], scenario.get("budget_chars", 24000)), memory_call)
            context = "\n\n".join(block["text"] for block in ready["context"]["blocks"])
            reply = turn.get("assistant") or chat(
                [{"role": "system", "content": "Memory (reference):\n" + context}]
                + [{"role": m["role"], "content": m["text"]} for m in history[-6:]] + [{"role": "user", "content": user["text"]}], 1500)
            done = drive(memory, memory.turn_commit(f"turn-{index}", user, {"id": f"a{index}", "text": reply}), memory_call)
            history += [{"id": user["id"], "role": "user", "text": user["text"]}, {"id": f"a{index}", "role": "assistant", "text": reply}]
            print(json.dumps({"turn": index, "intent": ready["receipt"]["intent"], "summaries": ready["receipt"]["summaries"],
                              "blocks": [(b["kind"], len(b["text"])) for b in ready["context"]["blocks"]],
                              "extract": done["receipt"]["extract"]}, ensure_ascii=False))
            for expectation in scenario.get("expect", []):
                if expectation["turn"] == index and expectation["context_contains"] not in context:
                    failures += 1
                    print(f"EXPECTATION FAILED turn {index}: {expectation['context_contains']!r}", file=sys.stderr)
        print(json.dumps(memory.overview("simulation"), ensure_ascii=False, indent=1))
        engine.close()
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())

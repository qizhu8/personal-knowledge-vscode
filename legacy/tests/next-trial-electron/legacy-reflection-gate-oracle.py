import ast
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import time
import urllib.parse
import uuid
from typing import List, Optional

os.umask(0o077)
extension, fixture = (Path(value).resolve() for value in sys.argv[1:3])
assert (fixture / "native-ui-fixture-token").is_file()
root = fixture / "knowledge"
evidence = json.loads((fixture / "reflection-gate-source.json").read_text())
sys.path.insert(0, str(extension / "resources"))
spec = importlib.util.spec_from_file_location("original_reflection_gate_runtime", extension / "resources/recipe_runtime.py")
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class Registration:
    def __init__(self):
        self.tools = {}

    def tool(self, **_options):
        def register(function):
            self.tools[function.__name__] = function
            return function
        return register


registration = Registration()
runtime.register_recipe_tools(registration, root)


def call(name, **args):
    value = registration.tools["recipe_run_" + name](**args)
    return json.loads(value) if isinstance(value, str) else value


# Execute original local Skill ranking and feedback functions, not server startup.
# Retrieval/telemetry stay explicitly unavailable in this private offline oracle.
tree = ast.parse((fixture / "original-installed-knowledge-server.py").read_text())
body = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))]
for node in body:
    node.decorator_list = []
namespace = dict(globals(), STORE=root, SKILLS=root / "skills", NOTES=root / "notes",
                 SUBSCRIPTIONS=root / "subscriptions/cache", RETRIEVAL_STATE=fixture / "retrieval",
                 related_recipes=runtime.related_recipes)
for node in tree.body:
    if isinstance(node, ast.Assign) and all(isinstance(target, ast.Name) for target in node.targets):
        if [target.id for target in node.targets] == ["_SKILL_STOP_WORDS"]:
            exec(compile(ast.Module(body=[node], type_ignores=[]), "<original-skill-stop-words>", "exec"), namespace)
            continue
        try:
            literal = ast.literal_eval(node.value)
        except (ValueError, TypeError):
            continue
        for target in node.targets:
            namespace[target.id] = literal
exec(compile(ast.Module(body=body, type_ignores=[]), "<original-installed-knowledge-functions>", "exec"), namespace)
boundary_calls = []


def offline_boundary(*args, **kwargs):
    boundary_calls.append({"args": args, "kwargs": kwargs})
    return {"ok": False, "error": "private-offline-boundary-unavailable"}


namespace["_retrieval_request"] = offline_boundary
namespace["_collector_post"] = lambda *_args, **_kwargs: None
namespace["_collect_search_invocation"] = lambda *_args, **_kwargs: None

inputs = {"task": "Reflection validation evidence synthetic fixture", "reflection": "global-original-reflection",
          "skills": ["global-original-skill"], "task-result": "synthetic validation passed"}
start_args = {"recipe_id": evidence["reflection"]["recipeId"], "command_id": "original-real-reflection",
              "inputs_json": json.dumps(inputs)}
started = call("start", **start_args)
assert started["ok"], started
current = call("next", run_id=started["run_id"], command_id="original-reflection-claim")
trace = {"inputs": inputs, "start_args": start_args, "start": started, "initial_next": current,
         "steps": [], "skill_calls": []}
for expected in ("reflect-on-outcome", "find-related-skills", "maintain-skills"):
    assert current["ok"], current
    action = current["next_action"]
    assert action["node_id"] == expected, action
    assert action["inputs"] == inputs, action
    if expected == "reflect-on-outcome":
        result = {"reflection": {"evidence": "synthetic validation passed", "reusable": True}}
    elif expected == "find-related-skills":
        args = {"task": inputs["task"], "workspace": "private-fixture", "files": ["fixture.py"],
                "diagnostics": "synthetic validation passed"}
        skill_context = json.loads(namespace["skill_context"](**args))
        assert skill_context.get("skills"), skill_context
        trace["skill_calls"].append({"name": "skill_context", "args": args, "result": skill_context})
        result = {"related-skills": skill_context}
    else:
        rows = skill_context["skills"]
        args = {"task": inputs["task"], "used_skills": [row["skill_id"] for row in rows],
                "outcome": "success", "observations": ["Retain only verified evidence."],
                "evidence": ["synthetic validation passed"], "interaction_id": skill_context.get("interaction_id", "")}
        feedback = json.loads(namespace["skill_feedback"](**args))
        assert feedback["ok"], feedback
        trace["skill_calls"].append({"name": "skill_feedback", "args": args, "result": feedback})
        result = {"maintenance-result": feedback}
    report_args = {"run_id": started["run_id"], "node_id": expected, "outcome": "succeeded",
                   "command_id": "reflection-report-" + expected, "result_json": json.dumps(result), "detail": "full"}
    current = call("report", **report_args)
    trace["steps"].append({"action": action, "args": report_args, "response": current})
trace["final"] = call("get", run_id=started["run_id"])
assert trace["final"]["status"] == "completed", trace["final"]
trace["feedback_rows"] = [json.loads(line) for line in (root / "_feedback/skill-usage.jsonl").read_text().splitlines()]
assert len(trace["feedback_rows"]) == 1
trace["offline_retrieval_attempts"] = len(boundary_calls)
release_start = {"recipe_id": evidence["release"]["recipeId"], "command_id": "original-release-definition-check"}
trace["release"] = {"start_args": release_start, "start": call("start", **release_start)}
# Never execute release instructions or rewrite the original invalid dependency.
trace["gates"] = []
for approved in (True, False):
    gate_start_args = {"recipe_id": evidence["gate"]["recipeId"],
                       "command_id": "original-gate-" + str(approved).lower(),
                       "inputs_json": '{"approval":"original-global-approval"}'}
    gate_start = call("start", **gate_start_args)
    assert gate_start["ok"], gate_start
    gate_next_args = {"run_id": gate_start["run_id"], "command_id": "claim-" + str(approved).lower()}
    gate_next = call("next", **gate_next_args)
    action = gate_next["next_action"]
    assert action["kind"] == "request_user_input", action
    forged = {"run_id": gate_start["run_id"], "node_id": action["node_id"], "outcome": "approved",
              "command_id": "forged-" + str(approved), "result_json": '{"approved":true}'}
    bad_report = call("report", **forged)
    assert not bad_report["ok"], bad_report
    # Register a fresh runtime against the same private durable store.
    registration = Registration()
    runtime.register_recipe_tools(registration, root)
    restarted = call("get", run_id=gate_start["run_id"])
    assert restarted["next_action"] == action, restarted
    submit_args = {"run_id": gate_start["run_id"], "node_id": action["node_id"],
                   "challenge_id": action["challenge_id"],
                   "response_json": json.dumps({"approved": approved, "evidence": {"origin": "synthetic-human"}}),
                   "command_id": "synthetic-user-" + str(approved), "detail": "full"}
    submitted = call("submit_input", **submit_args)
    assert submitted["ok"], submitted
    next_report = None
    if approved:
        assert submitted["next_action"]["node_id"] == "record-approved", submitted
        assert submitted["next_action"]["inputs"] == {"approval": "original-global-approval"}
        next_report = {"run_id": gate_start["run_id"], "node_id": "record-approved", "outcome": "succeeded",
                       "command_id": "record-approved-evidence", "result_json": '{"evidence":"synthetic-only"}', "detail": "full"}
        final = call("report", **next_report)
        assert final["status"] == "completed", final
    else:
        final = call("get", run_id=gate_start["run_id"])
        assert final["status"] == "failed", final
    trace["gates"].append({"start_args": gate_start_args, "start": gate_start, "next_args": gate_next_args,
                           "next": gate_next, "restart_get": restarted, "forged_args": forged,
                           "forged_report": bad_report, "submit_args": submit_args, "submitted": submitted,
                           "report_args": next_report, "final": final})
print(json.dumps(trace, sort_keys=True))

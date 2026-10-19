"""Structured, bounded basic components compiled inside an Action invocation."""

import ast
import builtins
import json
import math
import re
import time
import uuid
from pathlib import Path

from jsonschema import Draft202012Validator
from recipe_runtime import _atomic_write
from action_recovery import ActionSuspended


VALUE_TYPES = ["string", "integer", "number", "boolean", "object", "array", "null"]
MATH_FUNCTIONS = {name: getattr(math, name) for name in
                  ["log", "log10", "log2", "log1p", "sqrt", "exp", "expm1", "sin", "cos", "tan",
                   "asin", "acos", "atan", "atan2", "sinh", "cosh", "tanh", "degrees", "radians",
                   "ceil", "floor", "trunc", "fabs", "hypot", "fmod", "copysign"]}
MATH_FUNCTIONS.update({name: getattr(builtins, name) for name in ["abs", "min", "max", "round"]})
MATH_SOURCES = {name: ("builtins." if name in {"abs", "min", "max", "round"} else "math.") + name
                for name in MATH_FUNCTIONS}
MATH_EXAMPLE = "{0} x {1} + {2} * log {3}"


def math_expression(expression, inputs):
    if not isinstance(expression, str) or not expression.strip() or len(expression) > 1024:
        raise ValueError("Math expression requires 1 to 1,024 characters.")
    if not isinstance(inputs, dict):
        raise ValueError("Math inputs must be numbered numeric values.")

    def number(value):
        if type(value) not in {int, float} or not math.isfinite(value) or abs(value) > 1e100:
            raise ValueError("Math values must be finite numbers with magnitude at most 1e100.")
        return value

    def placeholder(match):
        index = int(match[1])
        if index >= 32 or "input_" + str(index) not in inputs:
            raise ValueError("Missing math input: " + match[0])
        return "_v" + str(index)

    source = re.sub(r"\{([0-9]+)\}", placeholder, expression)
    source = re.sub(r"\bx\b", "*", source).replace("^", "**")
    names = "|".join(MATH_FUNCTIONS)
    source = re.sub(r"\b(" + names + r")\s+(_v[0-9]+|[0-9]+(?:\.[0-9]+)?)\b", r"\1(\2)", source)
    try:
        tree = ast.parse(source.strip(), mode="eval")
        if sum(1 for _ in ast.walk(tree)) > 128:
            raise ValueError("Math expression is too complex.")

        def visit(node, depth=0):
            if depth > 32:
                raise ValueError("Math nesting exceeds 32 levels.")
            if isinstance(node, ast.Constant):
                return number(node.value)
            if isinstance(node, ast.Name):
                if re.fullmatch(r"_v[0-9]+", node.id):
                    return number(inputs["input_" + node.id[2:]])
                if node.id in {"pi", "e", "tau"}:
                    return getattr(math, node.id)
            if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
                value = visit(node.operand, depth + 1)
                return number(value if isinstance(node.op, ast.UAdd) else -value)
            if isinstance(node, ast.BinOp):
                left, right = visit(node.left, depth + 1), visit(node.right, depth + 1)
                if isinstance(node.op, ast.Pow) and abs(right) > 100:
                    raise ValueError("Math exponent magnitude must not exceed 100.")
                operations = {ast.Add: lambda: left + right, ast.Sub: lambda: left - right,
                              ast.Mult: lambda: left * right, ast.Div: lambda: left / right,
                              ast.FloorDiv: lambda: left // right, ast.Mod: lambda: left % right,
                              ast.Pow: lambda: left ** right}
                operation = operations.get(type(node.op))
                if operation:
                    return number(operation())
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in MATH_FUNCTIONS:
                if node.keywords or not 1 <= len(node.args) <= 32:
                    raise ValueError("Math functions require 1 to 32 positional arguments.")
                return number(MATH_FUNCTIONS[node.func.id](*(visit(item, depth + 1) for item in node.args)))
            raise ValueError("Unsupported math syntax or function.")

        return visit(tree.body)
    except (SyntaxError, TypeError, KeyError, ZeroDivisionError, OverflowError) as error:
        raise ValueError("Invalid math expression: " + str(error)) from error


def cast_value(value, target_type, trim=False):
    if target_type not in VALUE_TYPES or type(trim) is not bool:
        raise ValueError("Choose a supported Cast target type and boolean trim option.")
    source = value.strip() if trim and isinstance(value, str) else value
    if target_type == "string":
        return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, allow_nan=False)
    if target_type in {"integer", "number"}:
        if isinstance(source, str):
            pattern = r"-?(?:0|[1-9][0-9]*)" if target_type == "integer" else r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?"
            if len(source) > (20 if target_type == "integer" else 128) or not re.fullmatch(pattern, source):
                raise ValueError("Expected a decimal number; whitespace requires trim=true.")
            number = int(source) if target_type == "integer" else float(source)
            if target_type == "number" and number == 0:
                from decimal import Decimal
                if not Decimal(source).is_zero():
                    raise ValueError("Float underflow to zero is not permitted.")
        elif type(source) in {int, float}:
            number = source
        else:
            raise ValueError("Numeric Cast requires a number or decimal string, not a boolean.")
        if not math.isfinite(number):
            raise ValueError("Cast requires a finite number.")
        if target_type == "integer":
            if number != int(number) or not -(2 ** 63) <= number <= 2 ** 63 - 1:
                raise ValueError("Integer Cast requires an exact signed 64-bit integer; no truncation.")
            return int(number)
        return number
    if target_type == "boolean":
        if type(source) is bool:
            return source
        if source == "true" or source == "false":
            return source == "true"
        raise ValueError("Boolean Cast requires true/false or their exact lowercase strings.")
    if isinstance(source, str):
        if len(source) > 65536:
            raise ValueError("JSON Cast input exceeds 64 KiB.")
        source = json.loads(source)
    expected = {"object": dict, "array": list, "null": type(None)}[target_type]
    if type(source) is not expected:
        raise ValueError("Cast JSON must match the selected target type: " + target_type)
    json.dumps(source, allow_nan=False)
    return source


def component_definitions():
    steps = {"type": "array", "items": {"type": "object"}, "maxItems": 100, "default": []}
    limit = {"type": "integer", "minimum": 1, "maximum": 1000, "default": 100}
    specs = [
        ("constant", "Constant", {"value": {}}, ["value"], {"value": {}}, ["pure"]),
        ("cast", "Cast", {"value": {}, "target_type": {"type": "string", "enum": VALUE_TYPES, "default": "string"}, "trim": {"type": "boolean", "default": False}}, ["value", "target_type"], {"value": {}}, ["pure"]),
        ("lookup", "Dictionary Lookup", {"dictionary": {"type": "object", "default": {}}, "key": {"type": "string"}, "default": {}}, ["dictionary", "key"], {"value": {}}, ["pure"]),
        ("file-path", "File Path", {"path": {"type": "string"}, "must_exist": {"type": "boolean", "default": False}}, ["path"], {"path": {"type": "string"}}, ["local-read"]),
        ("sleep", "Sleep", {"seconds": {"type": "number", "minimum": 0, "maximum": 300, "default": 1}}, ["seconds"], {"seconds": {"type": "number"}}, ["pure"]),
        ("poll", "Poll until / timeout", {"body": steps, "condition": {}, "value": {},
            "interval_seconds": {"type": "number", "exclusiveMinimum": 0, "maximum": 300},
            "timeout_seconds": {"type": "number", "exclusiveMinimum": 0, "maximum": 604800},
            "max_iterations": limit}, ["body", "condition", "value", "interval_seconds", "timeout_seconds", "max_iterations"],
            {"status": {"enum": ["completed", "timed_out"]}, "attempts": {"type": "integer"}, "value": {}}, ["pure"]),
        ("if-else", "If / Else", {"condition": {}, "then_steps": steps, "else_steps": steps, "then_value": {}, "else_value": {}}, ["condition", "then_value", "else_value"], {"value": {}}, ["pure"]),
        ("switch", "Switch", {"selector": {}, "cases": {"type": "array", "items": {"type": "object"}, "default": [], "maxItems": 100}, "default_steps": steps, "default_value": {}}, ["selector", "cases", "default_value"], {"value": {}}, ["pure"]),
        ("math-expression", "Math Expression", {"expression": {"type": "string", "minLength": 1, "maxLength": 1024, "default": MATH_EXAMPLE},
            **{"input_" + str(index): {"type": "number"} for index in range(32)}}, ["expression"], {"value": {"type": "number"}}, ["pure"]),
        ("for", "For", {"items": {"type": "array", "maxItems": 1000, "default": []}, "body": steps, "value": {}, "max_iterations": limit}, ["items", "body", "value", "max_iterations"], {"values": {"type": "array"}}, ["pure"]),
        ("while", "While", {"condition": {}, "body": steps, "value": {}, "max_iterations": limit}, ["condition", "body", "value", "max_iterations"], {"value": {}}, ["pure"]),
        ("user-action", "User Choice", {"prompt": {"type": "string", "minLength": 1, "maxLength": 500},
            "options": {"type": "array", "minItems": 1, "maxItems": 24, "items": {"type": "object", "properties": {"label": {"type": "string", "minLength": 1, "maxLength": 120}, "value": {}}, "required": ["label", "value"], "additionalProperties": False}},
            "test_choice": {"type": "integer", "minimum": 0, "maximum": 23, "default": 0}}, ["prompt", "options", "test_choice"], {"value": {}}, ["human-input"]),
        ("checkpoint", "Human Checkpoint", {
            "kind": {"type": "string", "enum": ["input", "approval", "artifact-review", "decision", "exception"], "default": "approval"},
            "proposal": {}, "evidence": {"type": "array", "default": []},
            "owner": {"type": "string", "minLength": 1, "default": "user"},
            "deadline": {"type": ["number", "null"], "default": None},
            "timeout_behavior": {"type": "string", "enum": ["review", "cancel"], "default": "review"},
            "answer_schema": {"type": "object", "default": {"type": "object"}},
            "test_answer": {"type": "object", "default": {}}},
            ["kind", "proposal"], {"value": {}}, ["human-input"]),
        ("wait", "Durable Wait", {"trigger": {"type": "object"},
            "deadline": {"type": ["number", "null"], "default": None},
            "timeout_behavior": {"type": "string", "enum": ["review", "cancel"], "default": "review"}},
            ["trigger"], {"value": {}}, ["pure"]),
    ]
    return {"core." + name: {"action_id": "core." + name, "display_name": label, "description": label,
            "category": "core/" + ("logic" if name in {"if-else", "switch", "for", "while"} else
                "interaction" if name in {"user-action", "checkpoint"} else
                "timing" if name in {"sleep", "wait", "poll"} else
                "filesystem" if name == "file-path" else "values"),
            "component": True, "version": 1, "effects": effects,
            **({"math_functions": MATH_SOURCES, "examples": [{"inputs": {"expression": MATH_EXAMPLE, "input_0": 2, "input_1": 3, "input_2": 4, "input_3": math.e}, "output": {"value": 10.0}}]} if name == "math-expression" else {}),
            "input_schema": {"type": "object", "properties": properties, "required": required, "additionalProperties": False},
            "output_schema": {"type": "object", "properties": outputs, "required": list(outputs), "additionalProperties": False}}
            for name, label, properties, required, outputs, effects in specs}


def referenced_actions(steps, depth=0):
    if not isinstance(steps, list) or depth > 12:
        raise ValueError("Invalid or excessive component nesting.")
    result = set()
    for step in steps:
        if not isinstance(step, dict):
            raise ValueError("Each body step must be an object.")
        if "action_id" in step:
            result.add(step["action_id"])
            continue
        inputs = step.get("inputs", {})
        if not isinstance(inputs, dict):
            raise ValueError("Step inputs must be an object.")
        for field in ["then_steps", "else_steps", "default_steps", "body"]:
            if field in inputs:
                result.update(referenced_actions(inputs[field], depth + 1))
        if "cases" in inputs:
            if not isinstance(inputs["cases"], list):
                raise ValueError("Switch cases must be a list.")
            for case in inputs["cases"]:
                if not isinstance(case, dict):
                    raise ValueError("Switch cases must be objects.")
                result.update(referenced_actions(case.get("steps", []), depth + 1))
    return result


def validate_steps(steps, dependencies, depth=0, budget=None):
    budget = [0] if budget is None else budget
    if not isinstance(steps, list) or depth > 12:
        raise ValueError("Basic component body must be a list with nesting depth at most 12.")
    identifiers = set()
    effects = set()
    for step in steps:
        budget[0] += 1
        if budget[0] > 500 or not isinstance(step, dict) or set(step) - {"id", "action_id", "content_hash", "component", "inputs", "output_schema"}:
            raise ValueError("Invalid component step or structural budget exceeded.")
        identifier = step.get("id")
        if not isinstance(identifier, str) or not re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", identifier) or identifier in identifiers:
            raise ValueError("Invalid or duplicate component step ID.")
        identifiers.add(identifier)
        if "output_schema" in step:
            Draft202012Validator.check_schema(step["output_schema"])
        if ("action_id" in step) == ("component" in step) or not isinstance(step.get("inputs"), dict):
            raise ValueError("Each step must declare exactly one Action or basic component and its inputs.")
        if "action_id" in step:
            if step["action_id"] not in dependencies or step.get("content_hash", dependencies.get(step["action_id"])) != dependencies[step["action_id"]]:
                raise ValueError("Body Action is not declared and pinned: " + step["action_id"])
            continue
        definition = component_definitions().get(step["component"])
        if not definition:
            raise ValueError("Unknown basic component.")
        inputs = step["inputs"]
        if set(inputs) - set(definition["input_schema"]["properties"]) or set(definition["input_schema"]["required"]) - set(inputs):
            raise ValueError("Missing or unknown basic component inputs: " + identifier)
        effects.update(definition["effects"])
        if step["component"] == "core.sleep" and not isinstance(inputs["seconds"], dict):
            seconds = inputs["seconds"]
            if type(seconds) not in {int, float} or not 0 <= seconds <= 300:
                raise ValueError("Sleep seconds must be a finite number between 0 and 300.")
        if step["component"] in {"core.for", "core.while", "core.poll"}:
            limit = inputs["max_iterations"]
            if type(limit) is not int or not 1 <= limit <= 1000:
                raise ValueError("Loops require an explicit integer max_iterations between 1 and 1000.")
        for field in ["then_steps", "else_steps", "default_steps", "body"]:
            if field in inputs:
                effects.update(validate_steps(inputs[field], dependencies, depth + 1, budget))
        if "cases" in inputs:
            cases = inputs["cases"]
            if not isinstance(cases, list) or len(cases) > 100:
                raise ValueError("Switch requires at most 100 cases.")
            matches = set()
            for case in cases:
                if not isinstance(case, dict) or set(case) - {"match", "steps", "value"} or not {"match", "value"}.issubset(case):
                    raise ValueError("Switch cases require explicit match and value.")
                marker = json.dumps(case["match"], sort_keys=True, allow_nan=False)
                if marker in matches:
                    raise ValueError("Duplicate switch case.")
                matches.add(marker)
                effects.update(validate_steps(case.get("steps", []), dependencies, depth + 1, budget))
    return effects


def pending_choices(runtime, run_id):
    root = runtime.get(run_id)
    requests = []
    if root.get("state") not in {"running", "waiting"} or runtime.cancelled(root):
        return {"ok": True, "requests": requests}
    for run_path in (runtime.root / "runs").glob("*/run.json"):
        child = json.loads(run_path.read_text(encoding="utf-8"))
        if child.get("engine") != "module" or child.get("root_run_id") != root["root_run_id"] or child.get("state") not in {"running", "waiting"} or runtime.cancelled(child):
            continue
        checkpoint = child.get("checkpoint", {})
        if checkpoint.get("state") == "waiting" and checkpoint.get("presentation") == "choice":
            requests.append({"request_id": checkpoint["checkpoint_id"].replace("checkpoint_", "choice_", 1),
                             "run_id": child["run_id"], **checkpoint["proposal"],
                             "resume_token": checkpoint["resume_token"], "proposal_digest": checkpoint["proposal_digest"]})
        for path in sorted(run_path.parent.glob("choices/choice_*.json")):
            if not path.with_suffix(".answer").exists():
                requests.append(json.loads(path.read_text(encoding="utf-8")))
    return {"ok": True, "requests": requests}


def answer_choice(runtime, run_id, request_id, index):
    if not isinstance(request_id, str) or not re.fullmatch(r"choice_[0-9a-f]{32}", request_id):
        raise ValueError("Invalid user choice identity.")
    if type(index) is not int:
        raise ValueError("Choose one declared integer option.")
    record = runtime.recovery.read(run_id)
    checkpoint = record.get("checkpoint", {})
    if checkpoint.get("checkpoint_id", "").replace("checkpoint_", "choice_", 1) == request_id:
        return runtime.recovery.respond_checkpoint(run_id, checkpoint["checkpoint_id"],
            checkpoint["resume_token"], checkpoint["proposal_digest"], {"index": index}, "choice:" + request_id)
    with runtime.lock():
        record = runtime.get(run_id)
        if record.get("state") != "running" or runtime.cancelled(record):
            raise ValueError("The choice expired or its Action was cancelled.")
        path = runtime.path(run_id).parent / "choices" / (request_id + ".json")
        request = json.loads(path.read_text(encoding="utf-8"))
        if type(index) is not int or not 0 <= index < len(request["options"]):
            raise ValueError("Choose one declared option.")
        answer = path.with_suffix(".answer")
        if answer.exists():
            if json.loads(answer.read_text())["index"] != index:
                raise ValueError("This user choice has already been answered.")
        else:
            _atomic_write(answer, {"index": index})
    return {"ok": True, "run_id": run_id, "request_id": request_id}


def execute_steps(runtime, record, context, implementation):
    outputs, variables = {}, {}
    budget = [10000]
    poll_deadlines = []

    class PollDeadline(Exception):
        pass

    def resolve(value, depth=0):
        if depth > 32:
            raise ValueError("Expression depth exceeded.")
        if isinstance(value, list):
            return [resolve(item, depth + 1) for item in value]
        if isinstance(value, dict):
            if set(value) == {"$literal"}:
                return value["$literal"]
            if set(value) == {"$input"}:
                return record["inputs"][value["$input"]]
            if set(value) == {"$var"}:
                return variables[value["$var"]]
            if set(value) == {"$step"}:
                name, field = value["$step"].split(".", 1)
                return outputs[name][field]
            if "$op" in value:
                if set(value) != {"$op", "args"} or not isinstance(value["args"], list) or len(value["args"]) != 2:
                    raise ValueError("An expression requires an operator and exactly two arguments.")
                left, right = resolve(value["args"], depth + 1)
                operator = value["$op"]
                if operator in {"add", "subtract", "multiply"}:
                    if type(left) not in {int, float} or type(right) not in {int, float}:
                        raise ValueError("Arithmetic requires explicit numeric values.")
                    return {"add": lambda: left + right, "subtract": lambda: left - right, "multiply": lambda: left * right}[operator]()
                if operator in {"and", "or"}:
                    if type(left) is not bool or type(right) is not bool:
                        raise ValueError("Boolean operators require booleans.")
                    return left and right if operator == "and" else left or right
                if operator in {"eq", "ne"}:
                    equal = type(left) is type(right) and left == right
                    return equal if operator == "eq" else not equal
                if operator in {"lt", "le", "gt", "ge"}:
                    if type(left) not in {int, float, str} or type(right) is not type(left):
                        raise ValueError("Ordered comparisons require compatible explicit types.")
                    return {"lt": lambda: left < right, "le": lambda: left <= right, "gt": lambda: left > right, "ge": lambda: left >= right}[operator]()
                raise ValueError("Unsupported expression operator.")
            return {key: resolve(item, depth + 1) for key, item in value.items()}
        return value

    def ignored(steps, prefix, reason):
        for step in steps:
            key = prefix + step["id"]
            runtime.recovery.step_event(record, key, step, "ignored", reason)
            inputs = step.get("inputs", {})
            for field in ["then_steps", "else_steps", "body", "default_steps"]:
                if isinstance(inputs.get(field), list):
                    ignored(inputs[field], key + "/" + field + "/", reason)
            for index, case in enumerate(inputs.get("cases", [])):
                ignored(case.get("steps", []), key + "/case-" + str(index) + "/", reason)

    def run(steps, prefix=""):
        for step in steps:
            key = prefix + step["id"]
            if runtime.recovery.step_result(record, key, step):
                run_unobserved([step], prefix)
                continue
            runtime.recovery.step_event(record, key, step, "running")
            try:
                run_unobserved([step], prefix)
            except ActionSuspended:
                raise
            except Exception as error:
                runtime.recovery.step_event(record, key, step, "failed", type(error).__name__ + ": " + str(error))
                raise

    def run_unobserved(steps, prefix=""):
        for step in steps:
            budget[0] -= 1
            if budget[0] < 0 or runtime.cancelled(record):
                raise TimeoutError("Component execution budget, cancellation or deadline reached.")
            identifier = step["id"]
            key = prefix + identifier
            receipt = runtime.recovery.step_result(record, key, step)
            if receipt:
                outputs.update(receipt.get("scope_outputs", {}))
                outputs[identifier] = receipt["output"]
                continue
            if "action_id" in step:
                child = step["action_id"]
                if poll_deadlines and time.time() >= min(poll_deadlines):
                    checkpoint = record.get("checkpoint", {})
                    dependency = checkpoint.get("proposal", {}).get("dependency_run_id")
                    if checkpoint.get("step") == key and dependency:
                        runtime.cancel(dependency)
                    raise PollDeadline()
                result = runtime.call(child, resolve(step["inputs"]), key, record["definition"]["dependencies"][child], context)
                if result["state"] in {"running", "waiting"}:
                    if poll_deadlines:
                        runtime.recovery.suspend(record, key, "decision",
                            {"dependency_run_id": result["run_id"]}, owner="scheduler",
                            trigger={"kind": "timer", "at": min(min(poll_deadlines), time.time() + 0.25)})
                    runtime.recovery.suspend(record, key, "decision",
                        {"dependency_run_id": result["run_id"]}, owner="scheduler",
                        trigger={"kind": "dependency", "run_id": result["run_id"],
                                 "expected_version": result["execution"]["version"]})
                if result["state"] != "succeeded":
                    raise RuntimeError("Required child did not succeed: " + result["run_id"])
                if poll_deadlines and time.time() >= min(poll_deadlines):
                    raise PollDeadline()
                outputs[identifier] = result["output"]
                runtime.recovery.step_commit(record, key, step, result["output"], outputs)
                continue
            name = step["component"]
            spec = component_definitions()[name]
            values = {field: schema["default"] for field, schema in spec["input_schema"]["properties"].items() if "default" in schema}
            values.update(step["inputs"])
            if name == "core.if-else":
                condition = resolve(values["condition"])
                if type(condition) is not bool:
                    raise ValueError("If condition must evaluate to a boolean.")
                branch = "then" if condition else "else"
                skipped = "else" if condition else "then"
                ignored(values[skipped + "_steps"], key + "/" + skipped + "/",
                        "Recorded branch condition selected " + branch + "; this branch was not executed.")
                run(values[branch + "_steps"], key + "/" + branch + "/")
                output = {"value": resolve(values[branch + "_value"])}
            elif name == "core.switch":
                selector = resolve(values["selector"])
                matched = next((case for case in values["cases"] if type(case["match"]) is type(selector) and case["match"] == selector), None)
                for index, case in enumerate(values["cases"]):
                    if case is not matched:
                        ignored(case.get("steps", []), key + "/ignored-case-" + str(index) + "/",
                                "Recorded switch selector did not choose this case.")
                if matched:
                    ignored(values["default_steps"], key + "/default/",
                            "Recorded switch selector chose a case; default was not executed.")
                run(matched.get("steps", []) if matched else values["default_steps"], key + "/case/")
                output = {"value": resolve(matched["value"] if matched else values["default_value"])}
            elif name in {"core.for", "core.while"}:
                limit = values["max_iterations"]
                if type(limit) is not int or not 1 <= limit <= 1000:
                    raise ValueError("Invalid loop iteration budget.")
                previous = dict(variables)
                results = []
                try:
                    items = resolve(values["items"]) if name == "core.for" else None
                    if name == "core.for" and (not isinstance(items, list) or len(items) > limit):
                        raise ValueError("For items exceed the declared iteration limit.")
                    if items == []:
                        ignored(values["body"], key + "/not-entered/", "For loop input was empty; body was not executed.")
                    for index in range(len(items) if items is not None else limit):
                        if runtime.cancelled(record):
                            raise TimeoutError("Loop cancelled or deadline reached.")
                        if items is None:
                            condition = resolve(values["condition"])
                            if type(condition) is not bool:
                                raise ValueError("While condition must evaluate to a boolean.")
                            if not condition:
                                if index == 0:
                                    ignored(values["body"], key + "/not-entered/", "While condition was false before entry; body was not executed.")
                                break
                        variables.update({"index": index, "item": items[index] if items is not None else None})
                        run(values["body"], key + "/" + str(index) + "/")
                        results.append(resolve(values["value"]))
                    if items is None and resolve(values["condition"]) is not False:
                        raise ValueError("While reached max_iterations while its condition remained true.")
                    output = {"values": results} if items is not None else {"value": resolve(values["value"])}
                finally:
                    variables.clear()
                    variables.update(previous)
            elif name == "core.poll":
                settings = {field: resolve(values[field]) for field in
                            ["interval_seconds", "timeout_seconds", "max_iterations"]}
                Draft202012Validator(spec["input_schema"]).validate({
                    **settings, "body": [], "condition": False, "value": None})
                body_effects = validate_steps(values["body"], record["definition"]["dependencies"])
                for child in referenced_actions(values["body"]):
                    body_effects.update(runtime.definition(child)["effects"])
                if not body_effects.issubset({"pure", "read", "local-read", "remote-read"}):
                    raise PermissionError("Polling may repeat only read-only Actions; mutations and human input are forbidden.")
                clock_key, clock_definition = key + "/clock", {"component": "core.poll", "role": "clock"}
                clock = runtime.recovery.step_result(record, clock_key, clock_definition)
                if not clock:
                    runtime.recovery.step_commit(record, clock_key, clock_definition, {"at": time.time()})
                    clock = runtime.recovery.step_result(record, clock_key, clock_definition)
                deadline = clock["output"]["at"] + settings["timeout_seconds"]
                output = {"status": "timed_out", "attempts": 0, "value": None}
                for index in range(settings["max_iterations"]):
                    iteration_key = key + "/iteration-" + str(index)
                    iteration_definition = {"component": "core.poll", "role": "iteration", "index": index}
                    receipt = runtime.recovery.step_result(record, iteration_key, iteration_definition)
                    if receipt:
                        observation = receipt["output"]
                    else:
                        started_key = iteration_key + "/started"
                        started_definition = {"component": "core.poll", "role": "attempt"}
                        started = runtime.recovery.step_result(record, started_key, started_definition)
                        if not started and time.time() >= deadline:
                            break
                        if not started:
                            runtime.recovery.step_commit(record, started_key, started_definition, {})
                        output["attempts"] = index + 1
                        poll_deadlines.append(deadline)
                        try:
                            run(values["body"], iteration_key + "/")
                        except PollDeadline:
                            break
                        finally:
                            poll_deadlines.pop()
                        if time.time() >= deadline:
                            break
                        condition = resolve(values["condition"])
                        if type(condition) is not bool:
                            raise ValueError("Poll condition must evaluate to a boolean.")
                        observation = {"condition": condition, "value": resolve(values["value"])}
                        runtime.recovery.step_commit(record, iteration_key, iteration_definition, observation)
                    output.update({"attempts": index + 1, "value": observation["value"]})
                    if observation["condition"]:
                        output["status"] = "completed"
                        break
                    if index + 1 == settings["max_iterations"] or time.time() >= deadline:
                        break
                    timer_key = iteration_key + "/interval"
                    timer_definition = {"component": "core.poll", "role": "interval"}
                    if not runtime.recovery.step_result(record, timer_key, timer_definition):
                        if not runtime.recovery.resolved(record, timer_key):
                            runtime.recovery.suspend(record, timer_key, "decision",
                                {"poll_step": key, "attempts": index + 1}, owner="scheduler",
                                trigger={"kind": "timer", "at": min(deadline, time.time() + settings["interval_seconds"])})
                        runtime.recovery.step_commit(record, timer_key, timer_definition, {})
            else:
                values = resolve(values)
                Draft202012Validator(spec["input_schema"]).validate(values)
                if name == "core.constant":
                    output = {"value": values["value"]}
                elif name == "core.math-expression":
                    output = {"value": math_expression(values["expression"], values)}
                elif name == "core.cast":
                    output = {"value": cast_value(values["value"], values["target_type"], values.get("trim", False))}
                elif name == "core.lookup":
                    dictionary, field = values["dictionary"], values["key"]
                    if field not in dictionary and "default" not in values:
                        raise KeyError("Dictionary key is missing: " + field)
                    output = {"value": dictionary[field] if field in dictionary else values["default"]}
                elif name == "core.file-path":
                    reference = values["path"]
                    path = (runtime.resource_path(record["definition"], reference, "steps." + key + ".path")
                            if reference.startswith(("pkm://", "${module_assets}/")) else Path(reference).expanduser())
                    path = (runtime.workspace() / path).resolve() if not path.is_absolute() else path.resolve()
                    if not path.is_relative_to(runtime.workspace()) or values["must_exist"] and not path.exists():
                        raise PermissionError("File path is outside the Action workspace or does not exist.")
                    output = {"path": str(path)}
                elif name == "core.sleep":
                    seconds = values["seconds"]
                    if type(seconds) not in {int, float} or not 0 <= seconds <= 300:
                        raise ValueError("Sleep seconds must be a finite number between 0 and 300.")
                    if seconds and not runtime.recovery.resolved(record, key):
                        runtime.recovery.suspend(record, key, "decision", {"seconds": seconds},
                                                 owner="scheduler", trigger={"kind": "timer", "at": time.time() + seconds})
                    output = {"seconds": seconds}
                elif name == "core.user-action":
                    if record.get("validation"):
                        index = values["test_choice"]
                        if index >= len(values["options"]):
                            raise ValueError("Validation choice is outside the declared options.")
                    else:
                        checkpoint = runtime.recovery.resolved(record, key)
                        if not checkpoint:
                            runtime.recovery.suspend(record, key, "input", {"prompt": values["prompt"], "options": values["options"]},
                                answer_schema={"type": "object", "properties": {"index": {"type": "integer", "minimum": 0,
                                    "maximum": len(values["options"]) - 1}}, "required": ["index"], "additionalProperties": False},
                                presentation="choice")
                        index = checkpoint["answer"]["index"]
                    output = {"value": values["options"][index]["value"]}
                elif name == "core.checkpoint":
                    schema = values["answer_schema"]
                    if record.get("validation"):
                        Draft202012Validator.check_schema(schema)
                        Draft202012Validator(schema).validate(values["test_answer"])
                        answer = values["test_answer"]
                    else:
                        checkpoint = runtime.recovery.resolved(record, key)
                        if not checkpoint:
                            runtime.recovery.suspend(record, key, values["kind"], values["proposal"],
                                values["evidence"], values["owner"], values["deadline"],
                                values["timeout_behavior"], answer_schema=schema)
                        answer = checkpoint["answer"]
                    output = {"value": answer}
                elif name == "core.wait":
                    trigger = runtime.recovery.validate_trigger(values["trigger"])
                    checkpoint = runtime.recovery.resolved(record, key)
                    if not record.get("validation") and not checkpoint:
                        runtime.recovery.suspend(record, key, "decision", {"trigger": trigger}, owner="scheduler",
                            deadline=values["deadline"], timeout_behavior=values["timeout_behavior"], trigger=trigger)
                    output = {"value": checkpoint["answer"] if checkpoint else {}}
                else:
                    raise ValueError("Unknown basic component handler.")
            if len(json.dumps(output, allow_nan=False).encode()) > 65536:
                raise ValueError("Component output exceeded 64 KiB.")
            if "output_schema" in step:
                Draft202012Validator(step["output_schema"]).validate(output)
            outputs[identifier] = output
            runtime.recovery.step_commit(record, key, step, output, outputs)

    run(implementation["steps"])
    return resolve(implementation["output"])
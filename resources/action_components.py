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
        ("if-else", "If / Else", {"condition": {}, "then_steps": steps, "else_steps": steps, "then_value": {}, "else_value": {}}, ["condition", "then_value", "else_value"], {"value": {}}, ["pure"]),
        ("switch", "Switch", {"selector": {}, "cases": {"type": "array", "items": {"type": "object"}, "default": [], "maxItems": 100}, "default_steps": steps, "default_value": {}}, ["selector", "cases", "default_value"], {"value": {}}, ["pure"]),
        ("math-expression", "Math Expression", {"expression": {"type": "string", "minLength": 1, "maxLength": 1024, "default": MATH_EXAMPLE},
            **{"input_" + str(index): {"type": "number"} for index in range(32)}}, ["expression"], {"value": {"type": "number"}}, ["pure"]),
        ("for", "For", {"items": {"type": "array", "maxItems": 1000, "default": []}, "body": steps, "value": {}, "max_iterations": limit}, ["items", "body", "value", "max_iterations"], {"values": {"type": "array"}}, ["pure"]),
        ("while", "While", {"condition": {}, "body": steps, "value": {}, "max_iterations": limit}, ["condition", "body", "value", "max_iterations"], {"value": {}}, ["pure"]),
        ("user-action", "User Choice", {"prompt": {"type": "string", "minLength": 1, "maxLength": 500},
            "options": {"type": "array", "minItems": 1, "maxItems": 24, "items": {"type": "object", "properties": {"label": {"type": "string", "minLength": 1, "maxLength": 120}, "value": {}}, "required": ["label", "value"], "additionalProperties": False}},
            "test_choice": {"type": "integer", "minimum": 0, "maximum": 23, "default": 0}}, ["prompt", "options", "test_choice"], {"value": {}}, ["human-input"]),
    ]
    return {"core." + name: {"action_id": "core." + name, "display_name": label, "description": label,
            "category": "core/logic" if name in {"if-else", "switch", "for", "while", "user-action"} else "core", "component": True, "version": 1, "effects": effects,
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
        if step["component"] in {"core.for", "core.while"}:
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
    if root.get("state") != "running" or runtime.cancelled(root):
        return {"ok": True, "requests": requests}
    for run_path in (runtime.root / "runs").glob("*/run.json"):
        child = json.loads(run_path.read_text(encoding="utf-8"))
        if child.get("engine") != "module" or child.get("root_run_id") != root["root_run_id"] or child.get("state") != "running" or runtime.cancelled(child):
            continue
        for path in sorted(run_path.parent.glob("choices/choice_*.json")):
            if not path.with_suffix(".answer").exists():
                requests.append(json.loads(path.read_text(encoding="utf-8")))
    return {"ok": True, "requests": requests}


def answer_choice(runtime, run_id, request_id, index):
    if not isinstance(request_id, str) or not re.fullmatch(r"choice_[0-9a-f]{32}", request_id):
        raise ValueError("Invalid user choice identity.")
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

    def run(steps, prefix=""):
        for step in steps:
            budget[0] -= 1
            if budget[0] < 0 or runtime.cancelled(record):
                raise TimeoutError("Component execution budget, cancellation or deadline reached.")
            identifier = step["id"]
            key = prefix + identifier
            if "action_id" in step:
                child = step["action_id"]
                result = runtime.wait(runtime.call(child, resolve(step["inputs"]), key, record["definition"]["dependencies"][child], context)["run_id"])
                if result["state"] != "succeeded":
                    raise RuntimeError("Required child did not succeed: " + result["run_id"])
                outputs[identifier] = result["output"]
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
                run(values[branch + "_steps"], key + "/" + branch + "/")
                output = {"value": resolve(values[branch + "_value"])}
            elif name == "core.switch":
                selector = resolve(values["selector"])
                matched = next((case for case in values["cases"] if type(case["match"]) is type(selector) and case["match"] == selector), None)
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
                    for index in range(len(items) if items is not None else limit):
                        if runtime.cancelled(record):
                            raise TimeoutError("Loop cancelled or deadline reached.")
                        if items is None:
                            condition = resolve(values["condition"])
                            if type(condition) is not bool:
                                raise ValueError("While condition must evaluate to a boolean.")
                            if not condition:
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
                    path = Path(values["path"]).expanduser()
                    path = (runtime.workspace() / path).resolve() if not path.is_absolute() else path.resolve()
                    if not path.is_relative_to(runtime.workspace()) or values["must_exist"] and not path.exists():
                        raise PermissionError("File path is outside the Action workspace or does not exist.")
                    output = {"path": str(path)}
                elif name == "core.sleep":
                    seconds = values["seconds"]
                    if type(seconds) not in {int, float} or not 0 <= seconds <= 300:
                        raise ValueError("Sleep seconds must be a finite number between 0 and 300.")
                    finish = time.monotonic() + seconds
                    while True:
                        if runtime.cancelled(record):
                            raise TimeoutError("Sleep cancelled or deadline reached.")
                        remaining = finish - time.monotonic()
                        if remaining <= 0:
                            break
                        time.sleep(min(0.05, remaining))
                    output = {"seconds": seconds}
                elif name == "core.user-action":
                    if record.get("validation"):
                        index = values["test_choice"]
                        if index >= len(values["options"]):
                            raise ValueError("Validation choice is outside the declared options.")
                    else:
                        request_id = "choice_" + uuid.uuid4().hex
                        path = runtime.path(record["run_id"]).parent / "choices" / (request_id + ".json")
                        _atomic_write(path, {"request_id": request_id, "run_id": record["run_id"], "step": key, "prompt": values["prompt"], "options": values["options"]})
                        record["current_step"] = key
                        with runtime.lock():
                            runtime.runs.checkpoint(record, "waiting", "user-choice", "user")
                        while not path.with_suffix(".answer").exists():
                            if runtime.cancelled(record):
                                raise TimeoutError("User choice cancelled or expired.")
                            time.sleep(0.05)
                        index = json.loads(path.with_suffix(".answer").read_text())["index"]
                        with runtime.lock():
                            runtime.runs.checkpoint(record, "started", "choice-answered")
                    output = {"value": values["options"][index]["value"]}
                else:
                    raise ValueError("Unknown basic component handler.")
            if len(json.dumps(output, allow_nan=False).encode()) > 65536:
                raise ValueError("Component output exceeded 64 KiB.")
            if "output_schema" in step:
                Draft202012Validator(step["output_schema"]).validate(output)
            outputs[identifier] = output

    run(implementation["steps"])
    return resolve(implementation["output"])
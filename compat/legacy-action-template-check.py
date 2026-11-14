import json
import sys

from jsonschema import Draft202012Validator, FormatChecker


def assert_local_references(value):
    if isinstance(value, dict):
        for key, child in value.items():
            if key in ("$ref", "$dynamicRef", "$recursiveRef") and (
                not isinstance(child, str) or not child.startswith("#")
            ):
                raise ValueError("External schema references are unavailable.")
            assert_local_references(child)
    elif isinstance(value, list):
        for child in value:
            assert_local_references(child)


request = json.load(sys.stdin)
for item in request["checks"]:
    assert_local_references(item["schema"])
    Draft202012Validator.check_schema(item["schema"])
    validator = Draft202012Validator(item["schema"], format_checker=FormatChecker())
    if next(validator.iter_errors(item["value"]), None) is not None:
        raise ValueError("Input violates the original Action template schema.")
print(json.dumps({"ok": True}))

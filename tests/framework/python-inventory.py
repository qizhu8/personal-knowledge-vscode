"""Read Python test structure without importing or executing test modules."""
import ast
import json
from pathlib import Path
import sys


def inspect(filename):
    text = Path(filename).read_text(encoding="utf-8")
    tree = ast.parse(text, filename)
    imports, environments = set(), set()
    augmented = {node.target for node in ast.walk(tree) if isinstance(node, ast.AugAssign)}
    assertions = 0
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imports.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            imports.add(node.module)
        elif isinstance(node, ast.Assert):
            assertions += 1
        elif isinstance(node, ast.Subscript) and isinstance(node.value, ast.Attribute):
            if (node.value.attr == "environ" and isinstance(node.slice, ast.Constant)
                    and isinstance(node.slice.value, str)
                    and (isinstance(node.ctx, ast.Load) or node in augmented)):
                environments.add(node.slice.value)
        elif isinstance(node, ast.Call):
            function = node.func
            if isinstance(function, ast.Attribute):
                assertions += int(function.attr.startswith("assert"))
                if function.attr == "get" and isinstance(function.value, ast.Attribute) and function.value.attr == "environ":
                    if node.args and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str):
                        environments.add(node.args[0].value)
    return {
        "imports": sorted(imports), "environments": sorted(environments), "assertions": assertions,
        "native": bool(imports.intersection({"pyautogui", "pywinauto"})) or
        ("subprocess" in imports and any(flag in text for flag in
                                       ("--user-data-dir", "--extensionTestsPath", "--installed-vsix"))),
        "external": False,
    }


if __name__ == "__main__":
    print(json.dumps({filename: inspect(filename) for filename in sys.argv[1:]}))

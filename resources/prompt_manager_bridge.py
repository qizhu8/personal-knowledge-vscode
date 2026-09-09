#!/usr/bin/env python3
import json
import io
import sys
from contextlib import redirect_stdout
from pathlib import Path

from jinja2 import meta, nodes
from jinja2.sandbox import SandboxedEnvironment
from prompt_manager import PromptGeneratorLight, PromptMode


def prompt_style(file_path: Path) -> str:
    suffix = file_path.suffix.lower()
    if suffix in {".jinja", ".jinja2"}:
        return "jinja2"
    if suffix in {".json", ".yaml", ".yml"}:
        return "langchain"
    return "cdex"


def prompt_inheritance(file_path: Path) -> tuple[list[dict], list[str], list[str]]:
    environment = SandboxedEnvironment(autoescape=False)
    files = {candidate.name: candidate for candidate in file_path.parent.glob("*.jinja*")}
    base_by_child = {}
    local_variables = {}
    for name, candidate in files.items():
        try:
            syntax_tree = environment.parse(candidate.read_text(encoding="utf-8"))
            local_variables[name] = set(meta.find_undeclared_variables(syntax_tree))
            extends_node = next(syntax_tree.find_all(nodes.Extends), None)
            template_node = extends_node.template if extends_node is not None else None
            if isinstance(template_node, nodes.Const) and isinstance(template_node.value, str):
                base_by_child[name] = Path(template_node.value).name
        except Exception:
            local_variables[name] = set()

    adjacency = {}
    children = {}
    for child, base in base_by_child.items():
        adjacency.setdefault(child, set()).add(base)
        adjacency.setdefault(base, set()).add(child)
        children.setdefault(base, []).append(child)

    selected = file_path.name
    component = {selected}
    pending = [selected]
    while pending:
        current = pending.pop()
        for neighbor in adjacency.get(current, set()):
            if neighbor not in component:
                component.add(neighbor)
                pending.append(neighbor)

    roots = sorted(name for name in component if base_by_child.get(name) not in component) or [selected]

    def build(name: str, inherited: set[str], visited: set[str]) -> dict:
        local = local_variables.get(name, set())
        effective = inherited | local
        if name in visited:
            return {"file": name, "exists": name in files, "selected": name == selected, "cycle": True, "extends": base_by_child.get(name), "inheritedPlaceholders": sorted(inherited), "introducedVariables": [], "effectiveVariables": sorted(effective), "children": []}
        return {
            "file": name,
            "exists": name in files,
            "selected": name == selected,
            "cycle": False,
            "extends": base_by_child.get(name),
            "inheritedPlaceholders": sorted(inherited),
            "introducedVariables": sorted(local - inherited),
            "effectiveVariables": sorted(effective),
            "children": [build(child, effective, visited | {name}) for child in sorted(children.get(name, [])) if child in component],
        }

    missing = sorted(name for name in component if name not in files)
    return [build(root, set(), set()) for root in roots], sorted(component - {selected}), missing


def selected_variables(template_tree: list[dict]) -> list[str]:
    for item in template_tree:
        if item.get("selected"):
            return item.get("effectiveVariables", [])
        found = selected_variables(item.get("children", []))
        if found:
            return found
    return []


def inspect_prompt(file_path: Path) -> dict:
    content = file_path.read_text(encoding="utf-8")
    style = prompt_style(file_path)
    template_tree, related_files, missing_templates = [], [], []
    if style == "jinja2":
        template_tree, related_files, missing_templates = prompt_inheritance(file_path)
    graph_variables = selected_variables(template_tree)
    try:
        if missing_templates:
            raise ValueError(f"Missing base template: {', '.join(missing_templates)}")
        with redirect_stdout(io.StringIO()):
            generator = PromptGeneratorLight(str(file_path), prompt_style=style)
            variables = graph_variables if style == "jinja2" else list(generator.placeholder_name_list)
            rendered_shape = generator.generate_prompt(
                data={variable: "" for variable in variables},
                vars_in_data=variables,
                vars_in_prompt=variables,
                prompt_mode=PromptMode.COMPLETION,
            )
        return {
            "available": True,
            "format": style,
            "syntaxValid": True,
            "syntaxError": "",
            "variables": variables,
            "lineCount": len(content.splitlines()) if content else 0,
            "charCount": len(content),
            "chatTemplate": "<|im_start|>" in rendered_shape,
            "relatedFiles": related_files,
            "templateTree": template_tree,
            "missingTemplates": missing_templates,
        }
    except Exception as error:
        return {
            "available": True,
            "format": style,
            "syntaxValid": False,
            "syntaxError": str(error),
            "variables": graph_variables,
            "lineCount": len(content.splitlines()) if content else 0,
            "charCount": len(content),
            "chatTemplate": "<|im_start|>" in content,
            "relatedFiles": related_files,
            "templateTree": template_tree,
            "missingTemplates": missing_templates,
        }


def render_prompt(file_path: Path, context: dict, mode: str) -> dict:
    style = prompt_style(file_path)
    with redirect_stdout(io.StringIO()):
        generator = PromptGeneratorLight(str(file_path), prompt_style=style)
        template_tree, _, missing_templates = prompt_inheritance(file_path) if style == "jinja2" else ([], [], [])
        if missing_templates:
            raise ValueError(f"Missing base template: {', '.join(missing_templates)}")
        variables = selected_variables(template_tree) if style == "jinja2" else list(generator.placeholder_name_list)
        result = generator.generate_prompt(
            data=context,
            vars_in_data=variables,
            vars_in_prompt=variables,
            prompt_mode=PromptMode.CHAT if mode == "chat" else PromptMode.COMPLETION,
        )
    return {"format": style, "mode": mode, "variables": variables, "result": result}


def main() -> None:
    request = json.load(sys.stdin)
    file_path = Path(str(request.get("path", ""))).resolve()
    if not file_path.is_file():
        raise ValueError("Prompt file was not found")
    action = request.get("action")
    if action == "inspect":
        response = inspect_prompt(file_path)
    elif action == "render":
        context = request.get("context", {})
        if not isinstance(context, dict):
            raise ValueError("context must be a JSON object")
        response = render_prompt(file_path, context, str(request.get("mode", "completion")))
    else:
        raise ValueError("Unsupported prompt manager action")
    json.dump({"ok": True, "data": response}, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        json.dump({"ok": False, "error": str(error)}, sys.stdout, ensure_ascii=False)
        sys.exit(1)
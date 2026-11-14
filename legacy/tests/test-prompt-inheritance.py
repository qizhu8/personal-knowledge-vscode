#!/usr/bin/env python3
import importlib.util
import tempfile
from pathlib import Path


BRIDGE = Path(__file__).resolve().parents[1] / "resources" / "prompt_manager_bridge.py"
SPEC = importlib.util.spec_from_file_location("prompt_manager_bridge", BRIDGE)
bridge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bridge)


with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    (root / "base.jinja2").write_text(
        "Brand {{ brand }} for {{ Language }}\n"
        "{% for rule in guardrails %}- {{ loop.index }}: {{ rule | upper }}\n{% endfor %}"
        "{% block body %}{% endblock %}",
        encoding="utf-8",
    )
    (root / "policy.jinja2").write_text(
        '{% extends "base.jinja2" %}{% block body %}'
        '{% if policy %}Policy {{ policy }} for {{ Year }}'
        '{% elif fallback_policy %}Fallback {{ fallback_policy }}'
        '{% else %}No policy{% endif %}'
        '{% block task %}{% endblock %}{% endblock %}',
        encoding="utf-8",
    )
    leaf = root / "leaf.jinja2"
    leaf.write_text(
        '{% extends "policy.jinja2" %}{% block task %}'
        '{% for asset in assets %}{% if asset.enabled %}{{ asset.title | trim }}{% endif %}{% endfor %}'
        '{{ Src }}{% endblock %}',
        encoding="utf-8",
    )

    tree, related, missing = bridge.prompt_inheritance(leaf)
    base = tree[0]
    policy = base["children"][0]
    selected = policy["children"][0]
    assert base["file"] == "base.jinja2"
    assert base["introducedVariables"] == ["Language", "brand", "guardrails"]
    assert policy["extends"] == "base.jinja2"
    assert policy["inheritedPlaceholders"] == ["Language", "brand", "guardrails"]
    assert policy["introducedVariables"] == ["Year", "fallback_policy", "policy"]
    assert selected["selected"] is True
    assert selected["inheritedPlaceholders"] == ["Language", "Year", "brand", "fallback_policy", "guardrails", "policy"]
    assert selected["introducedVariables"] == ["Src", "assets"]
    assert all(local not in selected["effectiveVariables"] for local in ["asset", "rule", "loop"])
    assert related == ["base.jinja2", "policy.jinja2"]
    assert missing == []

    rendered = bridge.render_prompt(leaf, {
        "brand": "Contoso", "Language": "English", "guardrails": ["safe", "clear"],
        "policy": "strict", "fallback_policy": "balanced", "Year": 2026,
        "assets": [{"enabled": True, "title": " Headline "}, {"enabled": False, "title": "Hidden"}],
        "Src": "Landing page",
    }, "completion")
    assert "1: SAFE" in rendered["result"]
    assert "2: CLEAR" in rendered["result"]
    assert "Policy strict for 2026" in rendered["result"]
    assert "Headline" in rendered["result"]
    assert "Hidden" not in rendered["result"]

    broken = root / "broken.jinja2"
    broken.write_text('{% extends "missing.jinja2" %}{{ value }}', encoding="utf-8")
    broken_tree, _, broken_missing = bridge.prompt_inheritance(broken)
    assert broken_missing == ["missing.jinja2"]
    assert broken_tree[0]["exists"] is False
    assert broken_tree[0]["children"][0]["selected"] is True

    inspected = bridge.inspect_prompt(broken)
    assert inspected["syntaxValid"] is False
    assert inspected["syntaxError"] == "Missing base template: missing.jinja2"
    assert inspected["variables"] == ["value"]
    assert inspected["templateTree"] == broken_tree

print("Prompt inheritance test: recursive placeholders, introduced variables, related files, and missing bases OK")
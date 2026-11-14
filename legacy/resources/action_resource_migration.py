"""Explicit, read-only migration plans for schema-owned resource fields."""

import copy
import hashlib
import json
import re
from pathlib import Path, PureWindowsPath


def migration_preview(runtime, document, kind="action"):
    """Return a candidate plus rollback evidence; never write a user's document."""
    if kind not in {"action", "graph", "recipe"} or not isinstance(document, dict):
        raise ValueError("Choose an Action, graph or Recipe document.")
    candidate = copy.deepcopy(document)
    identity = document.get("action_id") or document.get("recipeId") or "unregistered"
    name = document.get("display_name") or document.get("name") or document.get("title") or identity
    context = {"action_id": identity, "display_name": name}
    changes, diagnostics = [], []

    def verified(reference, field):
        if not isinstance(reference, str) or reference.startswith(("pkm://", "${module_assets}/")):
            return None
        # Relative argv values may be application data. Only absolute argv paths
        # enter this function; declared files are explicitly allowed separately.
        try:
            if PureWindowsPath(reference).is_absolute() and not Path(reference).is_absolute():
                raise ValueError("Foreign Windows path requires verification on its owning host.")
            path = runtime.resource_path(context, reference, field)
            if not path.is_relative_to(runtime.store):
                raise ValueError("Outside knowledge store; retain as an explicit local binding.")
            relative = path.relative_to(runtime.store)
            area = relative.parts[0]
            if area == "scripts":
                metadata = path.with_name("." + path.name + ".pkm.json")
                if metadata.is_symlink():
                    raise ValueError("Symlink identity metadata is not verifiable.")
                value = json.loads(metadata.read_text(encoding="utf-8"))
                if not isinstance(value, dict):
                    raise ValueError("Script identity metadata must be an object.")
                stable = "pkm://script/" + str(value.get("knowledgeId", ""))
            elif area in {"notes", "skills", "papers", "recipes", "actions"}:
                if path.suffix == ".json":
                    value = json.loads(path.read_text(encoding="utf-8"))
                    if not isinstance(value, dict):
                        raise ValueError("Knowledge identity metadata must be an object.")
                    knowledge_id = value.get("knowledgeId", "")
                else:
                    header = re.match(r"^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)", path.read_text(encoding="utf-8"))
                    match = re.search(r"^knowledgeId:\s*[\"']?([A-Za-z0-9_]+)[\"']?\s*$",
                                      header[1], re.MULTILINE) if header else None
                    knowledge_id = match[1] if match else ""
                stable = "pkm://knowledge/" + str(knowledge_id)
            else:
                raise ValueError("No stable identity contract for this local resource.")
            if runtime.resource_path(context, stable, field) != path:
                raise ValueError("Stable identity does not resolve to the original resource.")
            evidence = {"field": field, "before": reference, "after": stable,
                        "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
            changes.append(evidence)
            return stable
        except (OSError, ValueError, PermissionError) as error:
            diagnostics.append({"name": name, "id": identity, "field": field, "reference": reference,
                                "reason": str(error), "state": "unverified-local-binding"})
            return None

    def migrate_owner(owner, field):
        if not isinstance(owner, dict):
            raise ValueError(f"{name} ({identity}) {field}: expected a structured resource owner.")
        replacements = {}
        for key in ("files", "source_files", "args"):
            values = owner.get(key, [])
            if not isinstance(values, list) or any(not isinstance(value, str) or "\0" in value for value in values):
                raise ValueError(f"{name} ({identity}) {field}.{key}: expected a string array.")
        for key in ("files", "source_files"):
            for index, reference in enumerate(owner.get(key, [])):
                stable = verified(reference, f"{field}.{key}[{index}]")
                if stable:
                    replacements[reference] = stable
            if key in owner:
                owner[key] = [replacements.get(value, value) for value in owner[key]]
        program = owner.get("program")
        if isinstance(program, str) and (Path(program).is_absolute() or PureWindowsPath(program).is_absolute()):
            stable = verified(program, field + ".program")
            if stable:
                owner["program"] = stable
        arguments = owner.get("args", [])
        for index, argument in enumerate(arguments):
            flag, sep, value = argument.partition("=")
            reference = value if sep and flag.startswith("-") else argument
            if reference not in replacements and (Path(reference).is_absolute() or PureWindowsPath(reference).is_absolute()):
                stable = verified(reference, f"{field}.args[{index}]")
                if stable:
                    replacements[reference] = stable
                    # Preserve the declaration that tells consumers this is a file,
                    # rather than an arbitrary PKM URL passed as logical data.
                    owner.setdefault("files", []).append(stable)
        if "args" in owner:
            owner["args"] = runtime.resource_arguments(arguments, replacements)

    if kind == "action":
        for index, implementation in enumerate(candidate.get("implementations", [])):
            prefix = f"implementations[{index}]"
            migrate_owner(implementation, prefix)
            for key in ("build", "server"):
                if key in implementation:
                    migrate_owner(implementation[key], prefix + "." + key)
            for owner, key, field in runtime.typed_path_slots(implementation):
                owner[key] = verified(owner[key], prefix + "." + field) or owner[key]
        for owner, key, field in runtime.typed_path_slots(candidate):
            owner[key] = verified(owner[key], field) or owner[key]
    elif kind == "graph":
        for owner, key, field in runtime.typed_path_slots({"graph": candidate}):
            owner[key] = verified(owner[key], field) or owner[key]
    else:
        groups = [("nodes", candidate.get("nodes", [])),
                  ("spec.nodes", candidate.get("spec", {}).get("nodes", [])),
                  ("definition.spec.nodes", candidate.get("definition", {}).get("spec", {}).get("nodes", []))]
        for prefix, nodes in groups:
            for index, node in enumerate(nodes):
                node_kind = node.get("kind")
                config = node.get("config", {})
                if (node_kind in {"pkm.step.command/v1", "pkm.step.script/v1"}
                        or node_kind == "pkm.step.pipeline/v1" and config.get("executor") in {"command", "script"}):
                    migrate_owner(config, f"{prefix}[{index}].config")
    return {"ok": True, "name": name, "id": identity, "kind": kind, "candidate": candidate,
            "changes": changes, "diagnostics": diagnostics, "applied": False,
            "original_sha256": hashlib.sha256(json.dumps(document, sort_keys=True).encode()).hexdigest(),
            "original": copy.deepcopy(document)}

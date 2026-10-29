"""Portable authoring contracts; inspecting these never probes or executes a host."""

from jsonschema import Draft202012Validator


KINDS = ["program", "pipeline", "mcp"]
PLATFORMS = ["Linux", "Windows", "Darwin"]


def definition_schema():
    strings = {"type": "array", "items": {"type": "string"}}
    executable = {"type": "object", "required": ["program"], "properties": {
        "program": {"type": "string", "minLength": 1}, "args": strings, "files": strings}}
    build = {"type": "object", "required": ["program", "args", "source_files", "outputs"], "properties": {
        **executable["properties"], "source_files": {**strings, "minItems": 1},
        "outputs": {**strings, "minItems": 1}, "timeout_seconds": {"type": "number"}}}
    common = {"id": {"type": "string"},
              "platforms": {"type": "array", "minItems": 1, "items": {"enum": PLATFORMS}},
              "architectures": strings, "files": strings, "build": build}
    variants = []
    for kind, fields, required in [
        ("program", {**executable["properties"], "result_protocol": {"const": "pkm.action.result/v1"}}, ["program"]),
        ("pipeline", {"steps": {"type": "array", "items": {"type": "object"}},
                      "output": {"type": "object"}, "observation_monitor": {"type": "boolean"}}, ["steps"]),
        ("mcp", {"server": executable, "tool": {"type": "string", "minLength": 1},
                 "input_schema_hash": {"type": "string", "pattern": "^[a-f0-9]{64}$"},
                 "output_schema_hash": {"type": "string", "pattern": "^[a-f0-9]{64}$"},
                 "read_only": {"type": "boolean"}},
         ["server", "tool", "input_schema_hash", "output_schema_hash"]),
    ]:
        variants.append({"type": "object", "required": ["kind", "platforms", *required],
                         "properties": {**common, **fields, "kind": {"const": kind}}})
    json_schema = {"$ref": "https://json-schema.org/draft/2020-12/schema"}
    return {"$schema": "https://json-schema.org/draft/2020-12/schema",
            "title": "PKM Action registration definition", "type": "object",
            "required": ["schema", "action_id", "version", "input_schema", "output_schema",
                         "effects", "implementations"],
            "additionalProperties": False,
            "properties": {
                "schema": {"const": "pkm.action.definition/v1"},
                "action_id": {"type": "string", "pattern": "^[a-z][a-z0-9_.-]{2,100}$"},
                "version": {"type": "integer"},
                "description": {"type": "string"}, "display_name": {"type": "string"},
                "input_schema": json_schema, "output_schema": json_schema,
                "effects": {"type": "array", "minItems": 1, "items": {"type": "string"}},
                "implementations": {"type": "array", "minItems": 1, "items": {"oneOf": variants}},
                "dependencies": {"type": "object", "additionalProperties": {
                    "type": "string", "pattern": "^[a-f0-9]{64}$"}},
                "casts": {"type": "object"},
                "examples": {"type": "array", "items": {"type": "object", "required": ["inputs"],
                    "properties": {"inputs": {"type": "object"}, "output": {}}}},
                "graph": {"type": "object"}, "provenance": {"type": "object"},
                "reconciler": {"type": "object"}}}


def definition_diagnostics(definition):
    def pointer(parts):
        return "/" + "/".join(str(part).replace("~", "~0").replace("/", "~1") for part in parts)

    def diagnostic(error, prefix=()):
        parts = [*prefix, *error.path]
        if error.validator == "oneOf" and isinstance(error.instance, dict):
            kind = error.instance.get("kind")
            if kind not in KINDS:
                return [{"path": pointer([*parts, "kind"]), "code": "enum",
                         "message": "Choose a supported implementation kind.", "allowed_values": KINDS}]
            branch = error.schema["oneOf"][KINDS.index(kind)]
            return [item for child in Draft202012Validator(branch).iter_errors(error.instance)
                    for item in diagnostic(child, parts)]
        if error.validator == "required":
            return [{"path": pointer([*parts, field]), "code": "required",
                     "message": "Required field is missing.", "missing_field": field}
                    for field in error.validator_value if field not in error.instance]
        item = {"path": pointer(parts), "code": str(error.validator), "message": error.message}
        if error.validator == "enum":
            item["allowed_values"] = error.validator_value
        return [item]

    return [item for error in Draft202012Validator(definition_schema()).iter_errors(definition)
            for item in diagnostic(error)]


def authoring_contract():
    echo = "import json,sys; value=json.load(sys.stdin); print(json.dumps({'value':value['value']}))"
    http = (
        "import json,sys,urllib.request\n"
        "from urllib.parse import urlsplit\n"
        "value=json.load(sys.stdin)\n"
        "url=value['url']; parsed=urlsplit(url)\n"
        "if parsed.scheme not in ('http','https') or parsed.username or parsed.password:\n"
        "    raise ValueError('Use an HTTP(S) URL without embedded credentials')\n"
        "class NoRedirect(urllib.request.HTTPRedirectHandler):\n"
        "    def redirect_request(self,*args,**kwargs):\n"
        "        raise ValueError('Redirects require an explicitly reviewed adapter')\n"
        "with urllib.request.build_opener(NoRedirect).open(url,timeout=5) as response:\n"
        "    data=response.read(65537)\n"
        "if len(data)>65536: raise ValueError('Response exceeds 65536 bytes')\n"
        "print(json.dumps({'response':json.loads(data)}))\n"
    )
    def example(identifier, description, properties, output, code, effects):
        return {"schema": "pkm.action.definition/v1", "action_id": identifier, "version": 1,
                "description": description,
                "input_schema": {"type": "object", "properties": properties,
                                 "required": list(properties), "additionalProperties": False},
                "output_schema": {"type": "object", "properties": output,
                                  "required": list(output), "additionalProperties": False},
                "effects": effects, "implementations": [
                    {"id": "python", "kind": "program", "platforms": PLATFORMS,
                     "program": "python", "args": ["-c", code]}],
                "examples": []}
    cli = example("example.cli.echo", "Bounded stdin/stdout JSON program, not a shell.",
                  {"value": {"type": "string"}}, {"value": {"type": "string"}}, echo, ["pure"])
    cli["examples"] = [{"inputs": {"value": "hello"}, "output": {"value": "hello"}}]
    return {
        "schema": "pkm.action.authoring/v1", "definition_schema": definition_schema(),
        "implementation_kinds": KINDS,
        "unsupported_kinds": ["command", "python", "http"],
        "io": {"program_input": "One JSON object on stdin; args are fixed literal argv, not input interpolation.",
               "program_output": "One JSON value on stdout, validated against output_schema; no extra stdout logs.",
               "stderr": "Use bounded stderr for diagnostics; never print tokens or credentials.",
               "failure": "Nonzero exit, invalid/truncated JSON or output schema failure cannot yield successful output.",
               "timeout": "The Run deadline bounds execution; timeout/cancel can mean outcome_unknown, not remote failure.",
               "http": "Use a reviewed program/MCP adapter. No native HTTP request implementation kind.",
               "files": "Declare external source files in files for fingerprinting; pin dependencies by content_hash."},
        "lifecycle": [
            {"tool": "action_definition_check", "effect": "No persistence, execution, qualification or grant."},
            {"tool": "action_register", "effect": "Submit a pending proposal only; registered=false and callable=false. Retain proposal_id, action_id and content_hash. Existing approved versions stay unchanged.",
             "note": "action_template_create, action_graph_save and definition edits also submit proposals. action_proposals lists pending reviews."},
            {"operator": "Open Automation > Action Library > Pending operator review > Review in canvas > Validate. No separate manual grant/admission approval. Choose a callable VS Code review model; a passing Agent code review starts consented smoke tests, and only successful tests admit the exact version. Review failure/unavailability blocks execution.",
             "effect": "Validate authorizes this review/test attempt, not production calls. Programs/MCP servers execute trusted host code, not in a sandbox. Pipelines use the same admission gate. Never self-edit policy/admissions."},
            {"tool": "action_validation_enqueue", "effect": "Direct non-builtin MCP validation returns ACTION_CODE_REVIEW_REQUIRED; hand off to the native Workbench Validate flow.",
             "note": "Agent model selection and test-effect consent belong to the operator. Do not qualify live endpoints without approval."},
            {"tool": "action_get", "effect": "Inspect availability; qualification pins definition and host environment."},
            {"tool": "action_call", "effect": "Use returned content_hash, validated inputs and a stable idempotency_key."},
            {"tool": "action_run_wait", "effect": "Attach to the original Run; wait_expired is not completion."}],
        "examples": {"cli": cli, "http_get_json": example(
            "example.http.get-json", "Read-only HTTP GET adapter; no authentication, retries or redirects. Use a local fixture first.",
            {"url": {"type": "string", "format": "uri"}},
            {"response": {}}, http, ["remote-read"])},
        "limitations": [
            "Examples are returned as definitions, not installed, granted, qualified or invoked.",
            "The HTTP example has no smoke URL: add an explicitly authorized local fixture example before qualification.",
            "Existing CLI identity is that of the execution host account, not necessarily the caller. Never serialize credentials.",
            "Host selection is operator-managed; no per-call remote host routing is provided.",
            "Updates need a higher version and new operator approval. Save changed implementation files at a new versioned path; do not overwrite approved source files.",
            "The monitor template requires a pinned read-only query with remote_id, terminal and result output fields.",
            "poll timed_out is an observation result, not remote cancellation or success.",
            "Query failure remains a failed/unknown child Run; the template does not supply domain-specific error mapping.",
            "action_run_events and action_run_wait(after_sequence=...) deliver/replay monitor events; no unsolicited wakeup of disconnected agents is promised.",
            "Azure DevOps read-only status is an explicit template using host Azure CLI; no automatic install, login, qualification or live query.",
            "Remote submission/reconcile and OJS-specific HTTP/auth adapters are not supplied by these examples."]}

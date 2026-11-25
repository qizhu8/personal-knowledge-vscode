import importlib.util
from contextlib import redirect_stdout
import inspect
import json
from pathlib import Path, PurePosixPath
import sys
from types import SimpleNamespace
import io
import time


spec = importlib.util.spec_from_file_location(
    "legacy_knowledge_captured", Path(__file__).with_name("legacy-knowledge-captured.py"))
captured = importlib.util.module_from_spec(spec)
spec.loader.exec_module(captured)
recipe_spec = importlib.util.spec_from_file_location(
    "legacy_recipe_run_read", Path(__file__).with_name("legacy-recipe-run-read.py"))
recipe_runs = importlib.util.module_from_spec(recipe_spec)
recipe_spec.loader.exec_module(recipe_runs)
captured.recipe_run_get = recipe_runs.recipe_run_get
captured.TOOLS["recipe_run_get"] = {"readOnly": True, "typed": True}
ORIGINAL_TOOLS = {name: getattr(captured, name) for name in captured.TOOLS if hasattr(captured, name)}
agent_spec = importlib.util.spec_from_file_location(
    "legacy_agent_captured", Path(__file__).with_name("legacy-agent-captured.py"))
agent = importlib.util.module_from_spec(agent_spec)
agent_spec.loader.exec_module(agent)

ROOT = PurePosixPath("/__pkm_immutable_snapshot__")
_retrieval_module = None


class SnapshotPath:
    files = {}
    directories = set()
    writes = []

    def __init__(self, path):
        self.path = PurePosixPath(str(path))
        if not self.path.is_relative_to(ROOT) or ".." in self.path.parts or "\\" in str(path):
            raise ValueError("Knowledge reads require an exact safe relative slug.")

    def __str__(self):
        return str(self.path)

    def __fspath__(self):
        return str(self)

    def __eq__(self, other):
        return isinstance(other, SnapshotPath) and self.path == other.path

    def __hash__(self):
        return hash(self.path)

    def __truediv__(self, path):
        if not str(path) or str(path).startswith("/") or "\\" in str(path) or any(
                part in {"", ".", ".."} for part in str(path).split("/")):
            raise ValueError("Knowledge reads require an exact safe relative slug.")
        return SnapshotPath(self.path / str(path))

    def exists(self):
        return str(self.path) in self.files or self.is_dir()

    def is_dir(self):
        return str(self.path) in self.directories

    def is_file(self):
        row = self.files.get(str(self.path))
        return row is not None and not row.get("directory")

    def is_symlink(self):
        return False

    def relative_to(self, root):
        return self.path.relative_to(root.path)

    def read_text(self, encoding):
        if encoding != "utf-8":
            raise ValueError("Snapshot reads require UTF-8.")
        value = self.files[str(self.path)].get("raw")
        if value is None:
            raise ValueError("Snapshot resource is not UTF-8 text.")
        return value

    def mkdir(self, parents=False, exist_ok=False):
        if not parents or not exist_ok:
            raise ValueError("Unsupported advisory artifact directory operation.")

    def write_text(self, value, encoding):
        if encoding != "utf-8":
            raise ValueError("Advisory artifacts require UTF-8.")
        self.writes.append({"path": self.path.relative_to(ROOT).as_posix(), "raw": value, "append": False})
        return len(value)

    def open(self, mode, encoding):
        if mode != "a" or encoding != "utf-8":
            raise ValueError("Only captured append-only advisory artifacts are supported.")
        owner = self
        class Append(io.StringIO):
            def close(self):
                if not self.closed:
                    owner.writes.append({"path": owner.path.relative_to(ROOT).as_posix(),
                                         "raw": self.getvalue(), "append": True})
                super().close()
        return Append()

    def stat(self):
        row = self.files[str(self.path)]
        seconds, nanos = divmod(int(row["mtimeNs"]), 1_000_000_000)
        return SimpleNamespace(st_mtime=seconds + nanos * 1e-9, st_size=row.get("size", 0))

    def resolve(self):
        return self

    def absolute(self):
        return self

    def as_posix(self):
        return self.path.as_posix()

    @property
    def parents(self):
        return [SnapshotPath(path) for path in self.path.parents if path.is_relative_to(ROOT)]

    @property
    def parent(self):
        return SnapshotPath(self.path.parent)

    @property
    def name(self):
        return self.path.name

    @property
    def stem(self):
        return self.path.stem

    @property
    def suffix(self):
        return self.path.suffix

    def with_name(self, name):
        return SnapshotPath(self.path.with_name(name))

    def iterdir(self):
        seen = set()
        for name in self.files:
            path = PurePosixPath(name)
            if path.is_relative_to(self.path) and path != self.path:
                child = self.path / path.relative_to(self.path).parts[0]
                if child not in seen:
                    seen.add(child)
                    yield SnapshotPath(child)

    def rglob(self, pattern):
        if pattern not in {"*.md", "*.json", "*"}:
            raise ValueError("Unsupported snapshot discovery.")
        return [SnapshotPath(name) for name, row in self.files.items()
                if PurePosixPath(name).is_relative_to(self.path) and name != str(self.path)
                and (pattern == "*" or (not row.get("directory") and name.endswith(pattern[1:])))]

    def glob(self, pattern):
        return [path for path in self.rglob("*")
                if path.path.match(pattern) and len(path.relative_to(self).parts) == len(pattern.split("/"))]


def unavailable_knowledge(*_args, **_kwargs):
    raise ValueError("NOT_AVAILABLE: Stable indexed retrieval requires its original pinned retrieval adapter.")


def execute(request):
    global _retrieval_module
    tool = request["tool"]
    if tool not in captured.TOOLS:
        raise ValueError("NOT_AVAILABLE: Unknown captured Knowledge tool.")
    for name, function in ORIGINAL_TOOLS.items():
        setattr(captured, name, function)
    SnapshotPath.files = {
        str(ROOT / file["area"] / file["path"]): file for file in request["files"]}
    SnapshotPath.directories = {
        str(parent) for name in SnapshotPath.files for parent in PurePosixPath(name).parents}
    SnapshotPath.directories.update(
        name for name, row in SnapshotPath.files.items() if row.get("directory"))
    SnapshotPath.writes = []
    if tool == "get_note" and request.get("noteReadDependencies") is True:
        metadata, _body = captured._parse(request["files"][0]["raw"])
        return {"todoBoard": metadata.get("documentKind") == "todo-board"}
    if tool == "recipe_run_get":
        recipe_runs.store = SnapshotPath(ROOT / "recipe-usage-reads")
        inspect.signature(recipe_runs.recipe_run_get).bind(**request["arguments"])
        text = recipe_runs.recipe_run_get(**request["arguments"])
        return {"value": json.loads(text), "text": text}
    if tool.startswith("agent_session_"):
        agent.Path = SnapshotPath
        def refuse_migration(*_args):
            raise ValueError("NOT_AVAILABLE: Snapshot requires original encryption migration; immutable reads never rewrite it.")
        agent._atomic_write = refuse_migration
        tools = {}
        class Collector:
            def tool(self, **_kwargs):
                def register(function):
                    tools[function.__name__] = function
                    return function
                return register
        agent.register_agent_session_tools(Collector(), SnapshotPath(ROOT / "agent-snapshot-reads"))
        function = tools[tool]
        inspect.signature(function).bind(**request["arguments"])
        value = function(**request["arguments"])
        return {"value": value, "text": json.dumps(value, ensure_ascii=False)}
    captured.Path = SnapshotPath
    captured.STORE = SnapshotPath(ROOT)
    for area in ["papers", "notes", "skills"]:
        setattr(captured, area.upper(), SnapshotPath(ROOT / area))
    captured.SUBSCRIPTIONS = SnapshotPath(ROOT / "subscriptions" / "cache")
    captured.RETRIEVAL_STATE = SnapshotPath(ROOT / "knowledge-read-config" / "retrieval")
    original_get = captured.get_knowledge
    original_search = captured.search_knowledge
    captured.get_knowledge = unavailable_knowledge
    captured._project_recipes = lambda _store: request["recipes"]
    captured._collector_post = lambda *_args, **_kwargs: None
    captured._collect_search_invocation = lambda *_args, **_kwargs: None

    def search_unavailable(*_args, **_kwargs):
        if _kwargs.get("route", "lexical") != "lexical" or not _kwargs.get("debug"):
            raise ValueError("NOT_AVAILABLE: Original indexed retrieval adapter is not wired.")
        return json.dumps({"ok": False})

    captured.search_knowledge = search_unavailable
    captured._retrieval_request = lambda *_args, **_kwargs: {"ok": False}
    if "retrievalSnapshot" in request:
        if _retrieval_module is None:
            retrieval_spec = importlib.util.spec_from_file_location(
                "legacy_retrieval_index", Path(__file__).with_name("legacy-retrieval-index.py"))
            _retrieval_module = importlib.util.module_from_spec(retrieval_spec)
            retrieval_spec.loader.exec_module(_retrieval_module)
        engine_request = _retrieval_module.engine(request["retrievalSnapshot"], request.get("persistentRuntime", False), request.get("retrievalModel"))
        learning_state = None
        learning_changed = False
        def native_retrieval_request(route, payload=None):
            nonlocal learning_state, learning_changed
            if route == "/retrieval-feedback":
                learning_spec = importlib.util.spec_from_file_location(
                    "native_learning", Path(__file__).with_name("legacy-retrieval-learning.py"))
                learning = importlib.util.module_from_spec(learning_spec)
                learning_spec.loader.exec_module(learning)
                def feedback(learner):
                    return learner.feedback(payload.get("retrieval_id"), payload.get("relevant_source_ids"),
                                            payload.get("complete"), payload.get("provenance", "model"))
                try:
                    result, learning_state = learning.execute(request.get("learningState"), feedback)
                    learning_changed = True
                    return result
                except ValueError as error:
                    return {"ok": False, "error": str(error)}
            started = time.perf_counter()
            result = engine_request(route, payload)
            pool = result.pop("_learning_candidates", None)
            limit = result.pop("_learning_output_limit", None)
            if result.get("model_invoked"):
                learning_spec = importlib.util.spec_from_file_location(
                    "native_learning", Path(__file__).with_name("legacy-retrieval-learning.py"))
                learning = importlib.util.module_from_spec(learning_spec)
                learning_spec.loader.exec_module(learning)
                def observe(learner):
                    learner.configure(bool(request.get("retrievalModel", {}).get("learningEnabled", False)))
                    if pool is not None:
                        result["hits"] = pool
                    learner.observe(result, round((time.perf_counter() - started) * 1000, 3), payload.get("query"), limit)
                    return result
                result, learning_state = learning.execute(request.get("learningState"), observe)
                learning_changed = True
            return result
        captured._retrieval_request = native_retrieval_request
        captured.get_knowledge = original_get
        captured.search_knowledge = original_search
    mutations = []
    def plan_trash(_store, area, relative, _node, _extension, expected_sha256=None):
        mutations.append({"area": area, "path": relative, "expectedSha256": expected_sha256})
        return request.get("trashResult", {"ok": True})
    captured.trash_file = plan_trash
    captured._KNOWLEDGE_NODE = captured.node = None
    captured._KNOWLEDGE_EXTENSION = captured.extension_root = None
    captured.store = SnapshotPath(ROOT / "recipe-usage-reads") if tool == "recipe_usage_summary" else captured.STORE
    captured.subscription_cache = captured.SUBSCRIPTIONS
    if request.get("subscriptionsPresent") and not captured.SUBSCRIPTIONS.exists():
        raise ValueError("NOT_AVAILABLE: Subscription Skill snapshots require their native identity and cache adapter.")
    function = getattr(captured, tool)
    inspect.signature(function).bind(**request["arguments"])
    result = function(**request["arguments"])
    text = result if isinstance(result, str) else json.dumps(result, ensure_ascii=False)
    if isinstance(result, str):
        try:
            result = json.loads(result)
        except json.JSONDecodeError:
            pass
    return {"value": result, "text": text,
            **({"learningState": learning_state} if "retrievalSnapshot" in request and learning_changed else {}),
            **({"artifacts": SnapshotPath.writes} if tool in {"skill_feedback", "propose_skill_update"} else {}),
            **({"mutations": mutations} if captured.TOOLS[tool].get("trash") else {})}


if __name__ == "__main__":
    if sys.argv[1:] == ["--persistent"]:
        for line in sys.stdin:
            try:
                request = json.loads(line)
                request["persistentRuntime"] = True
                with redirect_stdout(sys.stderr):
                    result = {"result": execute(request)}
            except Exception as error:
                result = {"error": str(error)}
            print(json.dumps(result, ensure_ascii=False), flush=True)
    elif len(sys.argv) == 1:
        with redirect_stdout(sys.stderr):
            result = execute(json.load(sys.stdin))
        json.dump(result, sys.stdout, ensure_ascii=False)
    else:
        raise ValueError("Unsupported isolated Knowledge executor arguments.")

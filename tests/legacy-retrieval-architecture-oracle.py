"""Independent direct original wheel operator oracle, without native runtime adapters."""
import ast
import hashlib
import json
from pathlib import Path
import sys

root = Path(__file__).resolve().parents[2]
wheel = root / "resources/vendor/adaptive_skill_retrieval-0.3.0.dev2026100504-py3-none-any.whl"
assert hashlib.sha256(wheel.read_bytes()).hexdigest() == "332e434272a3cc88410eb50c7e4bfc3e3f69c5bf1e13f7f9a799087c37124f89"
sys.path.insert(0, str(wheel))
sys.path.insert(0, str(root / "resources"))
from adaptive_skill_retrieval import SkillDocument, ContentType
from adaptive_skill_retrieval.architecture_retriever import ArchitectureRetriever
from adaptive_skill_retrieval.retrieval_architectures import architecture_by_id
from adaptive_skill_retrieval.solution_package import ARCHITECTURES, load_installed
from retrieval_solution_index import scoped_index

request = json.load(sys.stdin)
namespace = dict(SkillDocument=SkillDocument, ContentType=ContentType)
tree = ast.parse((root / "resources/retrieval_worker.py").read_text())
nodes = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in ("make_document", "source_content_type")]
assert len(nodes) == 2
exec(compile(ast.Module(body=nodes, type_ignores=[]), "<independent-original-make-document>", "exec"), namespace)
documents = [namespace["make_document"](value) for value in request["snapshot"]["documents"]]
documents.sort(key=lambda document: str(document.version))
package = Path(request["model"]["root"])
manifest = load_installed(package.parent, package.name)
retriever = ArchitectureRetriever(architecture_by_id(manifest["architecture"]), {
    **manifest["parameters"], "model": str(package / "model"), "device": "cpu", "embedding_enabled": True,
})
retriever.index(documents)
if request.get("scope"):
    admitted = {value["skill_id"] for value in request["snapshot"]["documents"] if value["source_id"] in request["scope"]}
    retriever = scoped_index(retriever, {document.version for document in documents if document.version.skill_id in admitted})
mapping = {value["skill_id"]: value["source_id"] for value in request["snapshot"]["documents"]}
hits = [{"source_id": mapping[hit.skill_version.skill_id], "score": hit.score, "rank": hit.rank}
        for hit in retriever.search(request["query"], 20)]
print(json.dumps({"architectures": sorted(ARCHITECTURES), "hits": hits,
                  "pcaComponents": retriever._pca.n_components_ if retriever._pca is not None else None,
                  "tokenVectors": len(retriever._token_vectors)}, ensure_ascii=False))

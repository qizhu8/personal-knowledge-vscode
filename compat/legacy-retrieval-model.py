import hashlib
import json
import os
from pathlib import Path
import sys

os.environ.update({"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "HF_DATASETS_OFFLINE": "1",
                   "TOKENIZERS_PARALLELISM": "false"})


def validate(root, identity):
    wheel = Path(__file__).resolve().parents[2] / "resources/vendor/adaptive_skill_retrieval-0.3.0.dev2026100504-py3-none-any.whl"
    if hashlib.sha256(wheel.read_bytes()).hexdigest() != "332e434272a3cc88410eb50c7e4bfc3e3f69c5bf1e13f7f9a799087c37124f89":
        raise ValueError("Original model validator wheel changed.")
    sys.path.insert(0, str(wheel))
    from adaptive_skill_retrieval.solution_package import load_installed
    root = Path(root)
    if root.name != identity:
        raise ValueError("Original installed model directory must equal its exact package ID.")
    manifest = load_installed(root.parent, identity)
    if {path.relative_to(root / "model").as_posix() for path in (root / "model").rglob("*") if path.is_file()} != set(manifest["files"]):
        raise ValueError("Model package contains an unlisted artifact outside its exact original manifest.")
    for path in (root / "model").rglob("*.json"):
        value = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(value, dict) and (value.get("auto_map") or value.get("trust_remote_code")):
            raise ValueError("Model executable remote-code mappings are not admitted.")
    modules = json.loads((root / "model/modules.json").read_text(encoding="utf-8"))
    allowed = {"sentence_transformers.models.Transformer", "sentence_transformers.models.Pooling",
               "sentence_transformers.models.Normalize"}
    if not isinstance(modules, list) or not modules or any(
            item.get("type") not in allowed or item.get("path") not in ("", "1_Pooling", "2_Normalize")
            for item in modules):
        raise ValueError("Model modules must use admitted built-in offline Transformer/Pooling/Normalize operators.")
    return manifest


def frozen(root, identity, envelope_json, snapshot=None):
    manifest = validate(root, identity)
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "resources"))
    from retrieval_serving import FrozenSkillPath
    envelope = json.loads(envelope_json)
    config = envelope["release"]["config"]
    if config.get("model") != str(Path(root) / "model"):
        raise ValueError("Frozen model config must reference its exact explicitly authorized package model directory")
    if config.get("retrieval_architecture_id") != manifest["architecture"]:
        raise ValueError("Frozen model architecture differs from its admitted original package")
    class Envelope:
        def read_text(self):
            return envelope_json
    serving = FrozenSkillPath(Envelope())
    if snapshot is not None and not serving.compatible(snapshot["documents"]):
        raise ValueError("Frozen release Skill corpus differs from the current native source corpus")
    return {"release_id": serving.release_id}


if __name__ == "__main__":
    request = json.load(sys.stdin)
    result = frozen(request["root"], request["packageId"], request["envelopeJson"], request.get("snapshot")) if "envelopeJson" in request else validate(request["root"], request["packageId"])
    print(json.dumps(result, ensure_ascii=False))

"""Random offline model fixture: execution/integrity proof only, never quality evidence."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys

os.environ.update({"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "HF_DATASETS_OFFLINE": "1",
                   "TOKENIZERS_PARALLELISM": "false"})
import torch
from transformers import BertConfig, BertModel, BertTokenizerFast
from sentence_transformers import SentenceTransformer, models

root = Path(sys.argv[1])
base = root / "random-bert-source"
base.mkdir(parents=True)
torch.manual_seed(7)
vocabulary = ["[PAD]", "[UNK]", "[CLS]", "[SEP]", "[MASK]", "evidence", "model", "query", "note",
              "script", "skill", "shared", "remote", "reliable", "proof", "alpha", "beta", "gamma", "."]
(base / "vocab.txt").write_text("\n".join(vocabulary) + "\n", encoding="utf-8")
tokenizer = BertTokenizerFast(vocab_file=str(base / "vocab.txt"), do_lower_case=True)
tokenizer.save_pretrained(base)
model = BertModel(BertConfig(vocab_size=len(vocabulary), hidden_size=12, num_hidden_layers=1,
                            num_attention_heads=3, intermediate_size=24, max_position_embeddings=64))
model.save_pretrained(base, safe_serialization=True)
transformer = models.Transformer(str(base), max_seq_length=48,
                                 model_args={"local_files_only": True}, tokenizer_args={"local_files_only": True})
encoder = SentenceTransformer(modules=[transformer, models.Pooling(12), models.Normalize()], device="cpu")
package = root / "package-stage"
encoder.save(str(package / "model"), safe_serialization=True, create_model_card=False)
# Serialize the original portable built-in module contract, rather than modern import aliases.
modules_path = package / "model/modules.json"
descriptors = json.loads(modules_path.read_text())
for descriptor, name in zip(descriptors, ("Transformer", "Pooling", "Normalize"), strict=True):
    assert descriptor["type"].endswith("." + name)
    descriptor["type"] = "sentence_transformers.models." + name
    assert set(descriptor) == {"idx", "name", "path", "type"}
modules_path.write_text(json.dumps(descriptors), encoding="utf-8")
tokenizer_config = package / "model/tokenizer_config.json"
settings = json.loads(tokenizer_config.read_text())
backend = settings.pop("backend", None)
assert backend in (None, "tokenizers")
tokenizer_config.write_text(json.dumps(settings), encoding="utf-8")
files = {path.relative_to(package / "model").as_posix(): {
    "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "bytes": path.stat().st_size,
} for path in sorted((package / "model").rglob("*")) if path.is_file()}
manifest = {"schema": "pkm.retrieval-solution/v1", "name": "Random tiny offline execution fixture",
            "architecture": "dense-section", "parameters": {"query_prompt": "", "document_prompt": ""},
            "files": files, "license": "Synthetic random fixture, no pretrained weights",
            "validation": {"validation_query_count": 0}}
identity = hashlib.sha256(json.dumps(manifest, sort_keys=True, ensure_ascii=False, allow_nan=False).encode()).hexdigest()
(package / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
target = root / identity
package.rename(target)
shutil.rmtree(base)
print(json.dumps({"packageId": identity, "root": str(target), "qualityEvidence": False}))

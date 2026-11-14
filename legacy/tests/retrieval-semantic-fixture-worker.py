"""Launch the real retrieval worker with an offline deterministic encoder."""
import hashlib
import json
import os
from pathlib import Path
import runpy
import stat
import sys

root = Path(__file__).resolve().parent
sys.path.insert(0, str(root))
from retrieval_runtime import activate_engine

activate_engine()
from adaptive_skill_retrieval import architecture_retriever


class FixtureEncoder:
    dimensions = 4

    def __init__(self, *_args, **_kwargs):
        pass

    def encode_documents(self, texts):
        state = Path(sys.argv[1])
        if (state / "fail-embedding").exists():
            raise RuntimeError("fixture embedding provider failure")
        with (state / "encoded.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(list(texts)) + "\n")
        return [tuple((value + 1) / 256 for value in hashlib.sha256(text.encode()).digest()[:4]) for text in texts]

    encode_queries = encode_documents

    def encode_tokens(self, texts):
        return [self.encode_documents(text.split()) for text in texts]


architecture_retriever.SentenceTransformerArchitectureEncoder = FixtureEncoder
real_fsync = os.fsync


def fixture_fsync(descriptor):
    if stat.S_ISDIR(os.fstat(descriptor).st_mode) and (Path(sys.argv[1]) / "fail-dir-fsync").exists():
        raise OSError("fixture directory fsync failure")
    return real_fsync(descriptor)


os.fsync = fixture_fsync
runpy.run_path(str(root / "retrieval_actual_worker.py"), run_name="__main__")

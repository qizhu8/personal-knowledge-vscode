"""Heuristic budgets and process-wide observations; never quality metrics."""

import json
import os
from pathlib import Path
import shutil
import time


def process_sample():
    rss = available = None
    try:
        rss = int(Path("/proc/self/statm").read_text().split()[1]) * os.sysconf("SC_PAGE_SIZE")
        for line in Path("/proc/meminfo").read_text().splitlines():
            if line.startswith("MemAvailable:"):
                available = int(line.split()[1]) * 1024
    except (OSError, ValueError, IndexError):
        pass  # Unsupported platforms report null, not an invented measurement.
    cores = len(os.sched_getaffinity(0)) if hasattr(os, "sched_getaffinity") else os.cpu_count()
    return {"rss_bytes": rss, "host_available_memory_bytes": available, "logical_cpus": cores,
            "cpu_seconds": time.process_time(), "wall_seconds": time.monotonic(),
            "scope": "whole-worker-process; includes concurrent retrieval; host memory may exceed container limit"}


def resource_plan(root, manifest, documents):
    from adaptive_skill_retrieval.architecture_retriever import _sections
    from adaptive_skill_retrieval.retrieval_architectures import architecture_by_id
    documents = list(documents)
    counts = {}
    for document in documents:
        name = document.content_type.value
        counts[name] = counts.get(name, 0) + 1
    architecture = architecture_by_id(manifest["architecture"])
    config = json.loads((root / "model" / "config.json").read_text())
    dimension = config.get("hidden_size", config.get("d_model"))
    if not isinstance(dimension, int) or dimension <= 0:
        dimension = None
    units = sum(len(_sections(doc)) for doc in documents) if architecture.output_granularity == "markdown_section" else len(documents)
    sequence = config.get("max_position_embeddings", 512)
    sequence = sequence if isinstance(sequence, int) and sequence > 0 else 512
    token_mode = "token_encoder" in architecture.operators
    vectors = len(documents) + units * (sequence if token_mode else 1)
    model = sum(item["bytes"] for item in manifest["files"].values())
    raw = vectors * dimension * 8 if dimension else None
    # Python float/tuple overhead and simultaneous encoder/PCA arrays matter.
    resident = vectors * dimension * 32 if dimension else None
    estimate = (model * 4 + resident * 3 + 512 * 1024 ** 2) if resident is not None else None
    disk = (raw * 2 + (dimension * dimension * 8 if "pca_projection" in architecture.operators else 0)
            + 1024 * 1024) if raw is not None else None
    return {"kind": "heuristic-not-a-reservation", "document_count": len(documents), "content_type_counts": counts, "unit_count": units,
            "dimensions": dimension, "model_bytes": model, "index_bytes_estimate": raw,
            "additional_disk_peak_bytes_estimate": disk, "build_ram_bytes_estimate": estimate,
            "disk_free_bytes": shutil.disk_usage(root).free,
            "cpu_demand": "CPU inference may use all available cores. No CPU/RAM cap is enforced; utilization depends on model, thread pools and workload.",
            "caveat": "No hard upper bound. Includes Python vectors, temporary arrays and model-loading allowance. Token paths assume maximum sequence length; PCA and tokenizer workspace can exceed this estimate."}

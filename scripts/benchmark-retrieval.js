#!/usr/bin/env node
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { performance } = require("perf_hooks");
const { RetrievalWorkerManager } = require("../dist/retrieval-worker.js");

function argument(name, fallback) {
  const prefix = `--${name}=`;
  const value = process.argv.find(item => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

function percentile(values, fraction) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * fraction) - 1))] || 0;
}

function knowledgeUri(index) {
  return `pkm://knowledge/knowledge_${index.toString(16).padStart(24, "0")}`;
}

function corpus(size) {
  const labels = {
    english: { index: 10, text: "bounded retrieval update protocol" },
    chinese: { index: 20, text: "个人知识检索 图谱 排名" },
    mixed: { index: 30, text: "PKM 检索 generation cutover" },
    "exact-id": { index: 40, text: "PKM-EXACT-0040" },
    "code-symbol": { index: 50, text: "RetrievalWorkerManager" },
    relation: { index: 60, text: "citation relation traversal" },
  };
  const documents = Array.from({ length: size }, (_, index) => {
    const label = Object.entries(labels).find(([, value]) => value.index === index);
    return {
      skill_id: `note:synthetic-${index}`,
      source_id: knowledgeUri(index),
      source_revision: "1",
      title: label ? label[1].text : `Synthetic knowledge ${index}`,
      description: label ? `${label[0]} labeled relevance document` : "bounded synthetic benchmark document",
      body: label ? `${label[1].text} target-${index}` : `common corpus token shard-${index % 97}`,
      content_type: index === 20 ? "research" : "note",
      source_uri: knowledgeUri(index),
      metadata: { benchmark_label: label ? label[0] : "negative" },
      provenance: { provider: "benchmark" },
      read_only: false,
      visibility: "available",
      links: index === 60 ? [{
        relation: "cites",
        target: knowledgeUri(61),
        mode: "floating",
        required: false,
      }] : [],
    };
  });
  return {
    snapshot: { corpus_revision: `synthetic-${size}-v1`, documents },
    labels,
  };
}

async function waitUntil(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out after ${timeoutMs}ms.`);
}

function rssMiB(pid) {
  if (process.platform !== "linux") return null;
  try {
    const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(fs.readFileSync(`/proc/${pid}/status`, "utf8"));
    return match ? Number((Number(match[1]) / 1024).toFixed(1)) : null;
  } catch {
    return null;
  }
}

async function runTier(size, python, script, repetitions) {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), `pkm-retrieval-benchmark-${size}-`));
  const manager = new RetrievalWorkerManager(state, script, python, "0.3.0.dev2026091601", "retrieval-benchmark-v2");
  const generated = corpus(size);
  let endpoint;
  try {
    const startupStarted = performance.now();
    await manager.status();
    const startupMs = performance.now() - startupStarted;
    const submitStarted = performance.now();
    const sync = await manager.sync(generated.snapshot);
    const submitAckMs = performance.now() - submitStarted;
    const readyStarted = performance.now();
    const status = await waitUntil(async () => {
      const current = await manager.status();
      return current.corpus_revision === generated.snapshot.corpus_revision ? current : undefined;
    }, 180_000);
    const readyMs = performance.now() - readyStarted;
    endpoint = JSON.parse(fs.readFileSync(path.join(state, "worker.json"), "utf8"));
    const queryResults = {};
    for (const [label, target] of Object.entries(generated.labels)) {
      const latencies = [];
      let relevant = false;
      for (let iteration = 0; iteration < repetitions; iteration++) {
        const started = performance.now();
        const result = await manager.query({
          schema: "pkm.retrieval.query/v1",
          requestId: `${size}-${label}-${iteration}`,
          text: target.text,
          contentTypeFilter: label === "chinese" ? ["research"] : undefined,
          scope: { capabilityId: "benchmark" },
          topK: 10,
          route: label === "relation" ? "hybrid" : "lexical",
          generation: { mode: "exact", generation: status.ready_generation },
          graph: { maxDepth: 2, maxNodes: 50, maxEdges: 100, relations: label === "relation" ? ["cites"] : undefined, direction: "both" },
          deadlineMs: 10_000,
          diagnostics: "summary",
        });
        latencies.push(performance.now() - started);
        relevant ||= result.hits.some(hit => hit.sourceId === knowledgeUri(target.index));
      }
      queryResults[label] = {
        relevantAt10: relevant,
        p50Ms: Number(percentile(latencies, 0.50).toFixed(3)),
        p95Ms: Number(percentile(latencies, 0.95).toFixed(3)),
        p99Ms: Number(percentile(latencies, 0.99).toFixed(3)),
      };
    }
    const allLatencies = Object.values(queryResults).flatMap(result => [result.p50Ms, result.p95Ms, result.p99Ms]);
    const deltaSnapshot = {
      corpus_revision: `synthetic-${size}-v2`,
      documents: generated.snapshot.documents.map((document, index) => index === 0
        ? { ...document, source_revision: "2", body: `${document.body} one-upsert-delta` }
        : document),
    };
    const deltaSubmitStarted = performance.now();
    const deltaSync = await manager.sync(deltaSnapshot);
    const deltaSubmitAckMs = performance.now() - deltaSubmitStarted;
    const deltaReadyStarted = performance.now();
    const deltaStatus = await waitUntil(async () => {
      const current = await manager.status();
      return current.corpus_revision === deltaSnapshot.corpus_revision ? current : undefined;
    }, 180_000);
    const deltaReadyMs = performance.now() - deltaReadyStarted;
    return {
      tier: size,
      status: "measured",
      repetitionsPerLabel: repetitions,
      startupMs: Number(startupMs.toFixed(1)),
      submitAckMs: Number(submitAckMs.toFixed(1)),
      readyAfterAckMs: Number(readyMs.toFixed(1)),
      updateMode: status.update_mode,
      documentCount: status.document_count,
      edgeCount: status.edge_count,
      rssMiB: rssMiB(deltaStatus.pid),
      persistedSnapshotMiB: Number((fs.statSync(path.join(state, "snapshot.json")).size / 1024 / 1024).toFixed(3)),
      inputSnapshotMiB: Number((Buffer.byteLength(JSON.stringify(generated.snapshot)) / 1024 / 1024).toFixed(3)),
      aggregateQueryMs: {
        p50: Number(percentile(allLatencies, 0.50).toFixed(3)),
        p95: Number(percentile(allLatencies, 0.95).toFixed(3)),
        p99: Number(percentile(allLatencies, 0.99).toFixed(3)),
      },
      labels: queryResults,
      sync,
      oneUpsertDelta: {
        sync: deltaSync,
        submitAckMs: Number(deltaSubmitAckMs.toFixed(1)),
        readyAfterAckMs: Number(deltaReadyMs.toFixed(1)),
        readyGeneration: deltaStatus.ready_generation,
      },
    };
  } finally {
    if (endpoint) {
      try {
        await fetch(`http://127.0.0.1:${endpoint.port}/shutdown`, {
          method: "POST",
          headers: { "X-PKM-Retrieval-Token": endpoint.token },
        });
      } catch { /* cleanup after a failed benchmark */ }
    }
    await new Promise(resolve => setTimeout(resolve, 100));
    fs.rmSync(state, { recursive: true, force: true });
  }
}

async function main() {
  const tiers = argument("tiers", "1000,10000").split(",").map(Number).filter(value => Number.isSafeInteger(value) && value > 0);
  const repetitions = Math.max(1, Math.min(Number(argument("repetitions", "5")), 50));
  let python = process.env.PKM_RETRIEVAL_TEST_PYTHON;
  let runtime;
  if (!python) {
    runtime = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-retrieval-benchmark-runtime-"));
    execFileSync(process.env.PYTHON || "python3", ["-m", "venv", "--system-site-packages", runtime]);
    python = process.platform === "win32" ? path.join(runtime, "Scripts", "python.exe") : path.join(runtime, "bin", "python");
    const wheel = path.join(__dirname, "..", "resources", "vendor", "adaptive_skill_retrieval-0.3.0.dev2026091601-py3-none-any.whl");
    execFileSync(python, ["-m", "pip", "install", "--no-deps", wheel], { stdio: "ignore" });
  }
  try {
    const measured = [];
    for (const tier of tiers) measured.push(await runTier(tier, python, path.join(__dirname, "..", "resources", "retrieval_worker.py"), repetitions));
    const result = {
      schema: "pkm.retrieval.benchmark/v1",
      generatedAt: new Date().toISOString(),
      platform: { os: process.platform, arch: process.arch, node: process.version },
      labels: ["english", "chinese", "mixed", "exact-id", "code-symbol", "relation"],
      measured,
      planned: [50_000, 100_000].filter(tier => !tiers.includes(tier)).map(tier => ({
        tier,
        status: "planned-not-run",
        reason: "Requires an explicit extended benchmark run and resource budget.",
      })),
      rustCandidate: process.env.PKM_RUST_RETRIEVAL_COMMAND
        ? { status: "candidate-command-provided-but-not-executed", command: process.env.PKM_RUST_RETRIEVAL_COMMAND }
        : { status: "not-measured", reason: "No reproducible Rust/Tantivy candidate artifact was provided." },
      packaging: {
        python: {
          linux: "measured-current-platform",
          windows: "supported-via-existing-no-console-launcher; not measured in this run",
          macos: "supported-via-managed Python runtime; not measured in this run",
        },
        rust: { linux: "not measured", windows: "not measured", macos: "not measured" },
      },
      decision: "Protocol boundary ready; Tantivy/Rust candidate recommended but rewrite deferred until a labeled benchmark and candidate artifacts exist. Python remains optional for embeddings/ML.",
    };
    const output = argument("output", "");
    if (output) fs.writeFileSync(path.resolve(output), `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (runtime) fs.rmSync(runtime, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

"""Privacy-safe Recipe Run Health receipts and conditional evolution requests."""

import contextlib
import datetime
import hashlib
import json
import os
import re
import time
import uuid
from pathlib import Path


HEALTH_SCHEMA = "pkm.recipe.run-health/v1"
CANDIDATE_SCHEMA = "pkm.recipe.candidate-request/v1"
STORE_SCHEMA = "pkm.recipe.run-health-store/v1"
TAXONOMY = (
    "healthy",
    "environment-failure",
    "input-failure",
    "implementation-failure",
    "recipe-friction",
    "recipe-failure",
)
TERMINAL_STATES = {"succeeded", "failed", "skipped"}
RECEIPT_RETENTION = 200
CANDIDATE_RETENTION = 100
AGGREGATE_RETENTION = 500
ROLLING_RUNS = 20
DEFAULT_MINIMUM_EVIDENCE = 3
DEFAULT_COOLDOWN_SECONDS = 24 * 60 * 60
MAX_NODE_FACTS = 100
MAX_CODES = 20

IMMEDIATE_CODES = {
    "recipe-safety-violation",
    "incorrect-success",
    "validation-escape",
    "required-step-missing",
    "required-step-impossible",
    "deterministic-recipe-defect",
    "human-recipe-correction",
}
ENVIRONMENT_CODES = {
    "dependency-unavailable", "environment-unavailable", "machine-unavailable",
    "network-unavailable", "provider-unavailable", "rate-limited", "service-unavailable",
}
INPUT_CODES = {
    "contradictory-input", "invalid-input", "missing-input", "stale-input", "unsupported-input",
}
IMPLEMENTATION_CODES = {
    "adapter-defect", "cancelled", "executor-defect", "module-defect",
    "partial-runtime-state", "runtime-defect", "tool-defect",
}
FRICTION_CODES = {
    "ambiguous-instruction", "excessive-cost", "human-intervention", "manual-recovery",
    "repeated-retry", "stale-node", "timeout", "weak-validation",
}


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _digest(value):
    return hashlib.sha256(_json(value).encode("utf-8")).hexdigest()


def _bounded_code(value, fallback="unknown"):
    text = str(value or "").strip().lower().replace("_", "-")
    if re.fullmatch(r"[a-z][a-z0-9-]{0,63}", text):
        return text
    return fallback


def _bounded_id(value, fallback):
    text = str(value or "").strip()
    if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}", text):
        return text
    return "{}-{}".format(fallback, hashlib.sha256(text.encode("utf-8")).hexdigest()[:16])


def _parse_time(value):
    try:
        parsed = datetime.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=datetime.timezone.utc)
        return parsed.astimezone(datetime.timezone.utc)
    except (TypeError, ValueError):
        return None


def _duration_ms(started, ended):
    start = _parse_time(started)
    end = _parse_time(ended)
    if not start or not end:
        return None
    return max(0, min(int((end - start).total_seconds() * 1000), 31_536_000_000))


def _signal_facts(run):
    facts = []
    for record in (run.get("nodes") or {}).values():
        for signal in record.get("healthSignals") or []:
            if not isinstance(signal, dict):
                continue
            facts.append({
                "code": _bounded_code(signal.get("code")),
                "owner": _bounded_code(signal.get("owner")),
                "ambiguous": signal.get("confidence") == "unknown",
            })
    return facts[:MAX_CODES]


def _infer_error_code(record):
    if record.get("cancelled"):
        return "cancelled"
    result = record.get("result") if isinstance(record.get("result"), dict) else {}
    if result.get("timed_out"):
        return "timeout"
    human_text = " ".join(
        str(result.get(key) or "") for key in ("comment", "reason", "correction"))
    if "recipe" in human_text.lower() and any(
            word in human_text.lower() for word in ("design", "incorrect", "missing", "correction")):
        return "human-recipe-correction"
    text = str(record.get("error") or "").lower()
    patterns = (
        ("safety", "recipe-safety-violation"),
        ("incorrect success", "incorrect-success"),
        ("validation escape", "validation-escape"),
        ("required step", "required-step-impossible"),
        ("not registered", "environment-unavailable"),
        ("not found", "dependency-unavailable"),
        ("network", "network-unavailable"),
        ("provider", "provider-unavailable"),
        ("invalid input", "invalid-input"),
    )
    for fragment, code in patterns:
        if fragment in text:
            return code
    return "execution-failed" if record.get("state") == "failed" else ""


def _node_facts(run, terminal_at):
    facts = []
    definitions = {
        item.get("nodeId"): item
        for item in ((run.get("definition") or {}).get("spec") or {}).get("nodes") or []
        if isinstance(item, dict)
    }
    for node_id, record in list((run.get("nodes") or {}).items())[:MAX_NODE_FACTS]:
        attempt = max(1, min(int(record.get("attempt", 1)), 10000))
        progress = record.get("progress") if isinstance(record.get("progress"), dict) else {}
        validation = progress.get("currentValidation")
        definition = definitions.get(node_id) or {}
        config = definition.get("config") if isinstance(definition.get("config"), dict) else {}
        result = record.get("result") if isinstance(record.get("result"), dict) else {}
        validation_observed = bool(validation) or isinstance(result.get("validationPassed"), bool)
        validation_passed = (
            validation in {"passed", "succeeded", "valid", "approved"}
            or result.get("validationPassed") is True)
        validation_failed = (
            validation in {"failed", "invalid", "rejected"}
            or result.get("validationPassed") is False)
        declared_reads = config.get("reads") if isinstance(config.get("reads"), list) else []
        declared_writes = config.get("writes") if isinstance(config.get("writes"), list) else []
        observed_reads = result.get("observedReads") if isinstance(result.get("observedReads"), list) else []
        observed_writes = result.get("observedWrites") if isinstance(result.get("observedWrites"), list) else []
        digest_values = result.get("artifactDigests") if isinstance(result.get("artifactDigests"), list) else []
        artifact_digests = [
            value.lower() for value in digest_values
            if isinstance(value, str) and re.fullmatch(r"[a-fA-F0-9]{64}", value)
        ][:8]
        typed_immediate = next((
            code for field, code in (
                ("safetyViolation", "recipe-safety-violation"),
                ("incorrectSuccess", "incorrect-success"),
                ("requiredStepMissing", "required-step-missing"),
                ("requiredStepImpossible", "required-step-impossible"),
                ("recipeDesignCorrection", "human-recipe-correction"),
            )
            if result.get(field) is True
        ), None)
        error_code = (
            typed_immediate
            or ("validation-escape"
                if validation_failed and record.get("state") == "succeeded" else None)
            or _bounded_code(
                next((signal.get("code") for signal in record.get("healthSignals") or []
                      if isinstance(signal, dict) and signal.get("code")), None)
                or _infer_error_code(record), "none"))
        fact = {
            "nodeId": _bounded_id(node_id, "node"),
            "outcome": _bounded_code(record.get("outcome") or record.get("state"), "unknown"),
            "attemptCount": attempt,
            "retryCount": max(0, attempt - 1),
            "durationMs": _duration_ms(
                record.get("startedAt"),
                record.get("completedAt") or terminal_at),
            "errorCode": error_code,
            "cancelled": bool(record.get("cancelled")),
            "timedOut": bool((record.get("result") or {}).get("timed_out"))
            if isinstance(record.get("result"), dict) else False,
            "skipped": record.get("state") == "skipped",
            "humanIntervention": bool(record.get("humanIntervention")),
            "validation": {
                "observed": validation_observed,
                "passed": validation_passed,
                "failed": validation_failed,
            },
            "io": {
                "declaredReadCount": min(len(declared_reads), 10000),
                "declaredWriteCount": min(len(declared_writes), 10000),
                "observedReadCount": min(len(observed_reads), 10000),
                "observedWriteCount": min(len(observed_writes), 10000),
                "artifactDigests": artifact_digests,
            },
        }
        facts.append(fact)
    return facts


def classify_health_facts(status, complete, signal_facts, node_facts):
    """Return one and only one taxonomy value from bounded typed facts."""
    if not complete:
        return "implementation-failure"
    owners = [item["owner"] for item in signal_facts if item["owner"] in TAXONOMY]
    if "recipe-failure" in owners:
        return "recipe-failure"
    if "recipe-friction" in owners:
        return "recipe-friction"
    if "implementation-failure" in owners:
        return "implementation-failure"
    if "input-failure" in owners:
        return "input-failure"
    if "environment-failure" in owners:
        return "environment-failure"
    if owners and all(owner == "healthy" for owner in owners) and status == "completed":
        return "healthy"

    codes = {fact["errorCode"] for fact in node_facts}
    if codes & IMMEDIATE_CODES:
        return "recipe-failure"
    if codes & INPUT_CODES:
        return "input-failure"
    if codes & ENVIRONMENT_CODES:
        return "environment-failure"
    if codes & FRICTION_CODES or any(fact["retryCount"] for fact in node_facts):
        return "recipe-friction"
    if codes & IMPLEMENTATION_CODES:
        return "implementation-failure"
    return "healthy" if status == "completed" else "recipe-failure"


def _usage_facts(run):
    usage = run.get("usage") if isinstance(run.get("usage"), dict) else {}
    measured = {
        _bounded_code(key): max(0, int(value))
        for key, value in sorted((usage.get("measuredTokens") or {}).items())[:16]
        if isinstance(value, int) and not isinstance(value, bool)
    }
    derived = {
        _bounded_code(currency): max(0, int(value))
        for currency, value in sorted((usage.get("derivedCosts") or {}).items())[:16]
        if isinstance(value, int) and not isinstance(value, bool)
    }
    attempts = []
    for record in (usage.get("records") or [])[-100:]:
        if not isinstance(record, dict):
            continue
        attempts.append({
            "runId": _bounded_id(record.get("recipeRunId") or run.get("runId"), "run"),
            "nodeId": _bounded_id(record.get("nodeId"), "node"),
            "attempt": max(1, min(int(record.get("attempt", 1)), 10000)),
            "measured": {
                _bounded_code(key): max(0, int(value))
                for key, value in sorted((record.get("measuredTokens") or {}).items())[:16]
                if isinstance(value, int) and not isinstance(value, bool)
            },
            "estimated": max(0, int(record.get("estimatedTokens", 0))),
            "unknownModelCalls": max(0, int(record.get("unknownModelCalls", 0))),
            "derived": {
                _bounded_code((record.get("derivedCost") or {}).get("currency")):
                    max(0, int((record.get("derivedCost") or {}).get("amount_micros", 0)))
            } if isinstance(record.get("derivedCost"), dict) else {},
        })
    return {
        "measured": measured,
        "estimated": {
            "tokens": max(0, int(usage.get("estimatedTokens", 0))),
            "protocolTokens": max(
                0, int((usage.get("protocolPayloadEstimate") or {}).get("estimatedTokens", 0))),
        } if usage.get("estimatedTokens") or usage.get("protocolPayloadEstimate") else {},
        "unknown": {"modelCalls": max(0, int(usage.get("unknownModelCalls", 0)))},
        "derived": derived,
        "attribution": {
            "runId": _bounded_id(run.get("runId"), "run"),
            "recordsRetained": min(len(usage.get("records") or []), 200),
            "recordsTruncated": max(0, int(usage.get("recordsTruncated", 0))),
            "attempts": attempts,
        },
    }


def compile_health_receipt(run):
    """Compile a deterministic, bounded receipt without copying private run payloads."""
    terminal_at = run.get("terminalAt") or run.get("updatedAt")
    node_facts = _node_facts(run, terminal_at)
    required = set(((run.get("definition") or {}).get("spec") or {})
                   .get("completion", {}).get("requiredNodes") or [])
    complete = bool(terminal_at) and all(
        node_id in (run.get("nodes") or {})
        and run["nodes"][node_id].get("state") in TERMINAL_STATES
        for node_id in required)
    signals = _signal_facts(run)
    classification = classify_health_facts(run.get("status"), complete, signals, node_facts)
    codes = sorted({
        item["code"] for item in signals if item["code"] != "unknown"
    } | {
        fact["errorCode"] for fact in node_facts if fact["errorCode"] != "none"
    })[:MAX_CODES]
    context_kind = _bounded_code((run.get("healthContext") or {}).get("kind"), "normal")
    receipt = {
        "schema": HEALTH_SCHEMA,
        "runId": _bounded_id(run.get("runId"), "run"),
        "recipe": {
            "recipeId": _bounded_id(run.get("recipeId"), "recipe"),
            "revision": run.get("recipeRevision") if isinstance(run.get("recipeRevision"), int) else None,
            "executableDigest": _bounded_id(run.get("executableDigest"), "digest"),
        },
        "startedAt": str(run.get("createdAt") or ""),
        "terminalAt": str(terminal_at or ""),
        "terminalOutcome": "succeeded" if run.get("status") == "completed" else "failed",
        "durationMs": _duration_ms(run.get("createdAt"), terminal_at),
        "classification": classification,
        "ambiguous": (not complete or any(item["ambiguous"] for item in signals)),
        "complete": complete,
        "codes": codes,
        "nodeFacts": node_facts,
        "counts": {
            "nodes": len(run.get("nodes") or {}),
            "nodesRetained": len(node_facts),
            "retries": sum(item["retryCount"] for item in node_facts),
            "cancelled": sum(item["cancelled"] for item in node_facts),
            "timedOut": sum(item["timedOut"] for item in node_facts),
            "skipped": sum(item["skipped"] for item in node_facts),
            "humanInterventions": sum(item["humanIntervention"] for item in node_facts),
        },
        "cost": _usage_facts(run),
        "evolution": {
            "excluded": context_kind in {"recipe-evolution", "candidate-validation"},
            "context": context_kind,
        },
        "validation": {
            "observed": any(item["validation"]["observed"] for item in node_facts),
            "allPassed": bool(node_facts) and all(
                not item["validation"]["observed"] or item["validation"]["passed"]
                for item in node_facts),
            "anyFailed": any(item["validation"]["failed"] for item in node_facts),
        },
        "inputRevisionFacts": [
            {"inputId": _bounded_id(key, "input"), "revision": value}
            for key, value in sorted((run.get("inputRevisions") or {}).items())[:100]
            if isinstance(value, int) and not isinstance(value, bool) and value >= 0
        ],
        "truncated": len(run.get("nodes") or {}) > MAX_NODE_FACTS,
    }
    receipt["receiptDigest"] = _digest(receipt)
    receipt["evidenceRef"] = "pkm://recipe-health/" + receipt["receiptDigest"]
    return receipt


def _empty_store():
    return {
        "schema": STORE_SCHEMA,
        "receipts": [],
        "aggregates": [],
        "candidateRequests": [],
    }


def _load_store(path):
    if not path.exists():
        return _empty_store()
    value = json.loads(path.read_text(encoding="utf-8"))
    if value.get("schema") != STORE_SCHEMA:
        raise ValueError("Recipe health store schema is unsupported.")
    return value


def _atomic_write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + str(os.getpid()) + "." + uuid.uuid4().hex + ".tmp")
    try:
        with open(temporary, "x", encoding="utf-8") as handle:
            handle.write(_json(value))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        with contextlib.suppress(FileNotFoundError):
            temporary.unlink()


@contextlib.contextmanager
def _file_lock(path, timeout=10):
    path.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + timeout
    descriptor = None
    while descriptor is None:
        try:
            descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            if time.monotonic() >= deadline:
                raise TimeoutError("Timed out waiting for Recipe health store lock.")
            time.sleep(0.01)
    try:
        yield
    finally:
        os.close(descriptor)
        with contextlib.suppress(FileNotFoundError):
            path.unlink()


def _aggregate_key(receipt):
    recipe = receipt["recipe"]
    return "{}:{}:{}".format(
        recipe["recipeId"], recipe["revision"], recipe["executableDigest"])


def _duration_bucket(value):
    if value is None:
        return "unknown"
    if value < 1000:
        return "lt-1s"
    if value < 10_000:
        return "1s-10s"
    if value < 60_000:
        return "10s-1m"
    if value < 600_000:
        return "1m-10m"
    return "gte-10m"


def _update_aggregate(store, receipt):
    key = _aggregate_key(receipt)
    aggregate = next((item for item in store["aggregates"] if item["key"] == key), None)
    if aggregate is None:
        aggregate = {
            "key": key,
            "recipe": receipt["recipe"],
            "counts": {name: 0 for name in TAXONOMY},
            "durationDistribution": {},
            "recentEvidence": [],
        }
        store["aggregates"].append(aggregate)
        store["aggregates"] = store["aggregates"][-AGGREGATE_RETENTION:]
    aggregate["counts"][receipt["classification"]] += 1
    bucket = _duration_bucket(receipt.get("durationMs"))
    aggregate["durationDistribution"][bucket] = aggregate["durationDistribution"].get(bucket, 0) + 1
    aggregate["recentEvidence"].append({
        "runId": receipt["runId"],
        "evidenceRef": receipt["evidenceRef"],
        "classification": receipt["classification"],
        "codes": receipt["codes"][:MAX_CODES],
        "terminalAt": receipt["terminalAt"],
    })
    aggregate["recentEvidence"] = aggregate["recentEvidence"][-ROLLING_RUNS:]
    aggregate["lastTerminalAt"] = receipt["terminalAt"]
    return aggregate


def _candidate_for(store, receipt, aggregate, now, minimum_evidence, cooldown_seconds):
    if receipt["evolution"]["excluded"]:
        return None, "recursion-prevention"
    if receipt["ambiguous"]:
        return None, "ambiguous"
    if receipt["classification"] in {"healthy", "environment-failure", "input-failure"}:
        return None, "not-eligible"
    recipe = receipt["recipe"]
    existing = [
        item for item in store["candidateRequests"]
        if item["baseRecipe"]["recipeId"] == recipe["recipeId"]
        and item["baseRecipe"]["revision"] == recipe["revision"]
        and item["status"] in {"queued", "validating"}
    ]
    if existing:
        return None, "active-candidate"
    immediate = sorted(set(receipt["codes"]) & IMMEDIATE_CODES)
    evidence = aggregate["recentEvidence"]
    matching = [
        item for item in evidence
        if item["classification"] == receipt["classification"]
        and set(item["codes"]) & set(receipt["codes"])
    ]
    if not immediate and len(matching) < minimum_evidence:
        return None, "insufficient-evidence"
    previous = [
        item for item in store["candidateRequests"]
        if item["baseRecipe"]["recipeId"] == recipe["recipeId"]
        and item["baseRecipe"]["revision"] == recipe["revision"]
    ]
    now_value = _parse_time(now)
    if previous and now_value:
        latest = _parse_time(previous[-1].get("createdAt"))
        if latest and (now_value - latest).total_seconds() < cooldown_seconds:
            return None, "cooldown"
    trigger_codes = immediate or sorted({
        code for item in matching for code in item["codes"]
    })[:MAX_CODES]
    evidence_refs = [
        item["evidenceRef"] for item in (matching if not immediate else [evidence[-1]])
    ][-ROLLING_RUNS:]
    identity = _digest({
        "baseRecipe": recipe,
        "triggerCodes": trigger_codes,
        "firstEvidenceRef": evidence_refs[0],
    })[:24]
    return {
        "schema": CANDIDATE_SCHEMA,
        "candidateRequestId": "recipe_candidate_request_" + identity,
        "baseRecipe": recipe,
        "trigger": "immediate" if immediate else "aggregated",
        "triggerCodes": trigger_codes,
        "evidenceRefs": evidence_refs,
        "status": "queued",
        "createdAt": now,
        "validationComparison": {"baseline": None, "candidate": None, "verdict": None},
        "promotion": {"required": True, "automatic": False},
        "requestedAction": "run-non-recursive-recipe-evolution",
    }, None


def record_health_receipt(path, receipt, policy=None, now=None):
    """Persist once, update bounded aggregates, and queue at most one candidate."""
    if receipt.get("schema") != HEALTH_SCHEMA:
        raise ValueError("Recipe health receipt schema is unsupported.")
    if receipt.get("classification") not in TAXONOMY:
        raise ValueError("Recipe health classification is unsupported.")
    path = Path(path)
    lock_path = path.with_suffix(path.suffix + ".lock")
    policy = policy if isinstance(policy, dict) else {}
    minimum_evidence = max(1, min(int(policy.get(
        "minimumEvidence", DEFAULT_MINIMUM_EVIDENCE)), ROLLING_RUNS))
    cooldown_seconds = max(0, min(int(policy.get(
        "cooldownSeconds", DEFAULT_COOLDOWN_SECONDS)), 31_536_000))
    now = now or datetime.datetime.now(datetime.timezone.utc).isoformat()
    with _file_lock(lock_path):
        store = _load_store(path)
        if any(item["runId"] == receipt["runId"] for item in store["receipts"]):
            candidate = next((
                item for item in reversed(store["candidateRequests"])
                if receipt["evidenceRef"] in item.get("evidenceRefs", [])
            ), None)
            return {
                "duplicate": True, "proposal_created": False,
                "candidate_request_id": candidate["candidateRequestId"] if candidate else None,
                "agent_requests": 0, "model_requests": 0, "reflection_requests": 0,
                "optimization_requests": 0, "redesign_requests": 0,
            }
        store["receipts"].append(receipt)
        store["receipts"] = store["receipts"][-RECEIPT_RETENTION:]
        aggregate = _update_aggregate(store, receipt)
        candidate, suppressed = _candidate_for(
            store, receipt, aggregate, now, minimum_evidence, cooldown_seconds)
        if candidate:
            store["candidateRequests"].append(candidate)
            store["candidateRequests"] = store["candidateRequests"][-CANDIDATE_RETENTION:]
        _atomic_write(path, store)
        return {
            "duplicate": False,
            "proposal_created": candidate is not None,
            "candidate_request_id": candidate["candidateRequestId"] if candidate else None,
            "suppressed_by": suppressed,
            "agent_requests": 0,
            "model_requests": 0,
            "reflection_requests": 0,
            "optimization_requests": 0,
            "redesign_requests": 0,
        }


def finalize_run_health(store, run):
    """Shared terminal hook used by every Recipe Runtime completion adapter."""
    if run.get("status") not in {"completed", "failed"}:
        return None
    if not run.get("terminalAt"):
        run["terminalAt"] = run.get("updatedAt") or datetime.datetime.now(datetime.timezone.utc).isoformat()
    receipt = compile_health_receipt(run)
    result = record_health_receipt(
        Path(store) / ".pkm" / "state" / "recipe-health.json",
        receipt,
        policy=run.get("healthPolicy"))
    run["healthReceipt"] = {
        "schema": receipt["schema"],
        "receiptDigest": receipt["receiptDigest"],
        "evidenceRef": receipt["evidenceRef"],
        "classification": receipt["classification"],
        "candidateRequestId": result.get("candidate_request_id"),
    }
    return run["healthReceipt"]

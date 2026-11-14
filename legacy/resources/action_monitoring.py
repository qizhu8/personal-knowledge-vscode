"""Observation envelopes and replayable delivery on the existing durable Run."""

import time


class ActionFailure(RuntimeError):
    def __init__(self, failure, run_id=None):
        super().__init__(failure["message"])
        self.failure = failure
        self.run_id = run_id


def append_event(record, kind, payload):
    sequence = record.get("event_sequence", 0) + 1
    record["event_sequence"] = sequence
    record["notifications"] = [*record.get("notifications", []), {
        "sequence": sequence, "run_id": record["run_id"], "kind": kind,
        "at": time.time(), "payload": payload}][-256:]


def event_page(record, after_sequence=0):
    if type(after_sequence) is not int or after_sequence < 0:
        raise ValueError("after_sequence must be a nonnegative integer.")
    events = record.get("notifications", [])
    first = events[0]["sequence"] if events else record.get("event_sequence", 0) + 1
    return {"events": [event for event in events if event["sequence"] > after_sequence],
            "next_sequence": record.get("event_sequence", 0),
            "gap": after_sequence < first - 1,
            "delivery": "Replayable pull/active-wait delivery, not unsolicited agent wakeup.",
            "retention": 256}


def monitor_schema():
    properties = {
        "schema": {"const": "pkm.action.observation/v1"},
        "pkm_run_id": {"type": "string"}, "remote_id": {"type": "string"},
        "stop_reason": {"enum": ["observing", "remote_completed", "observation_timed_out", "cancelled", "query_failed"]},
        "remote_result": {"type": ["string", "null"]},
        "attempts": {"type": "integer"}, "last_observation": {"type": ["object", "null"]},
        "last_observed_at": {"type": ["number", "null"]},
        "next_check_at": {"type": ["number", "null"]}, "observation_deadline": {"type": "number"},
        "remote_may_still_be_active": {"type": "boolean"},
        "failure": {"type": ["object", "null"]}, "resume_run_id": {"type": "string"}}
    return {"type": "object", "properties": properties, "required": list(properties), "additionalProperties": False}


def observation(record, deadline, attempts, value=None, reason="observing", failure=None, next_check=None):
    prior = record.get("monitor", {})
    last = value if value is not None else prior.get("last_observation")
    return {"schema": "pkm.action.observation/v1", "pkm_run_id": record["run_id"],
            "remote_id": str((last or {}).get("remote_id", prior.get("remote_id", ""))),
            "stop_reason": reason, "remote_result": (last or {}).get("result"),
            "attempts": attempts, "last_observation": last,
            "last_observed_at": time.time() if value is not None else prior.get("last_observed_at"),
            "next_check_at": next_check, "observation_deadline": deadline,
            "remote_may_still_be_active": not bool((last or {}).get("terminal")),
            "failure": failure, "resume_run_id": record["run_id"]}

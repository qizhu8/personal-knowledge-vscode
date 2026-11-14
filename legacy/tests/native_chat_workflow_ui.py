import json
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import expect


def run(page, frame, descriptor, stage, send, durable_answer):
    fixture = Path(descriptor["root"]).parent
    identity = {"namespace": descriptor["namespace"], "chatId": descriptor["workerManager"]}

    def history():
        grant = json.loads((fixture / "u/User/globalStorage/uone.personal-knowledge/next-chat-ui-experiment.json").read_text())
        assert grant["root"] == descriptor["root"] and Path(grant["fixture"]) == fixture
        request = urllib.request.Request(grant["endpoint"] + "/rpc",
            data=json.dumps({"method": "history", **identity}).encode(), method="POST",
            headers={"Authorization": "Bearer " + grant["bearer"], "X-Pkm-Native-Actor": grant["actorId"],
                     "Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=15) as response:
            return json.load(response)["value"]

    def observed(name):
        deadline = time.monotonic() + 20
        while not (fixture / name).exists() and time.monotonic() < deadline:
            page.wait_for_timeout(50)
        assert (fixture / name).exists(), name

    def published_turn():
        turn = history()["nativeTurns"][-1]
        expect(frame.locator(f'[data-message-id="native-response:{turn["id"]}"]')).to_have_count(1, timeout=15000)
        return turn

    def queued(text):
        return frame.locator(".queued-input-row").filter(has_text=text)

    def pending(snapshot):
        return [item for item in snapshot["queueControl"]["items"] if item["status"] == "queued"]

    if stage == "native-workflow-queue":
        send(frame, "NATIVE_WORKFLOW_STEER: read native-input.txt once and await same-attempt steering.", keyboard=True)
        observed("native-workflow-steer-observed.json")
        turn = published_turn()
        frame.locator("#steer-mode").click()
        send(frame, "NATIVE_WORKFLOW_STEER_NEXT: keep this exact attempt and report the actual file digest.", keyboard=True)
        expect(queued("NATIVE_WORKFLOW_STEER_NEXT:")).to_have_count(1, timeout=15000)
        steering = pending(history())
        assert len(steering) == 1 and steering[0]["mode"] == "steer" and steering[0]["attemptId"] == turn["id"]
        (fixture / "native-workflow-steer-release").write_text("release after actual queued steering")
        durable_answer(frame, "NATIVE_WORKFLOW_STEER_RESULT sha256:" + descriptor["nativeManagedSha256"])
        snapshot = history()
        assert snapshot["nativeTurns"][-1]["id"] == turn["id"]
        assert snapshot["queueControl"]["items"][-1]["status"] == "applied"
        send(frame, "NATIVE_WORKFLOW_QUEUE_HOLD: hold the real model until Stop.", keyboard=True)
        observed("native-workflow-model-observed.json")
        published_turn()
        frame.locator("#task-mode").click()
        for text in ["NATIVE_WORKFLOW_FIFO_A_ORIGINAL", "NATIVE_WORKFLOW_FIFO_B", "NATIVE_WORKFLOW_REMOVE"]:
            send(frame, text, keyboard=True)
            expect(queued(text)).to_have_count(1, timeout=15000)
        queued("NATIVE_WORKFLOW_FIFO_A_ORIGINAL").get_by_role("button", name="Edit queued message", exact=True).click()
        editor = frame.get_by_role("textbox", name="Edit queued message", exact=True)
        expect(editor).to_be_visible(timeout=15000)
        editor.fill("NATIVE_WORKFLOW_FIFO_A_EDITED")
        frame.get_by_role("button", name="Save queued message", exact=True).click()
        expect(queued("NATIVE_WORKFLOW_FIFO_A_EDITED")).to_have_count(1, timeout=15000)
        queued("NATIVE_WORKFLOW_REMOVE").get_by_role("button", name="Remove queued input", exact=True).click()
        expect(queued("NATIVE_WORKFLOW_REMOVE")).to_have_count(0, timeout=15000)
        frame.locator("#stop").click()
        expect(frame.locator("#send")).to_have_attribute("aria-label", "Resume Chat", timeout=15000)
        snapshot = history()
        assert snapshot["nativeTurns"][-1]["status"] == "cancelled" and not snapshot["nativeTurns"][-1]["uncertain"]
        assert [item["text"] for item in pending(snapshot)] == ["NATIVE_WORKFLOW_FIFO_A_EDITED", "NATIVE_WORKFLOW_FIFO_B"]
        (fixture / "native-workflow-queue-ui-evidence.json").write_text(json.dumps({
            "steeredTurnId": turn["id"], "queue": snapshot["queueControl"], "cancelledTurn": snapshot["nativeTurns"][-1]}))
        print("PASS actual installed same-attempt steer; actual UI queue/edit/remove/Stop retain FIFO.", flush=True)
        return

    if stage == "native-workflow-resume":
        snapshot = history()
        assert snapshot["queueControl"]["needsReview"] and len(pending(snapshot)) == 2
        count = len(snapshot["nativeTurns"])
        expect(frame.locator("#send")).to_have_attribute("aria-label", "Resume Chat", timeout=15000)
        frame.locator("#send").click()
        expect(frame.locator("#send")).to_have_attribute("aria-label", "Send", timeout=15000)
        snapshot = history()
        assert len(snapshot["nativeTurns"]) == count and snapshot["queueControl"]["needsReview"]
        frame.get_by_role("button", name="Run queued inputs", exact=True).click()
        durable_answer(frame, "NATIVE_WORKFLOW_FIFO_A_EDITED_RESULT")
        durable_answer(frame, "NATIVE_WORKFLOW_FIFO_B_RESULT")
        snapshot = history()
        assert not pending(snapshot)
        assert [turn["text"] for turn in snapshot["nativeTurns"][-2:]] == ["NATIVE_WORKFLOW_FIFO_A_EDITED", "NATIVE_WORKFLOW_FIFO_B"]
        send(frame, "NATIVE_MANAGED_UNKNOWN: Read native-input.txt, then delegate one worker to read native-crash.txt once; never retry an unacknowledged effect.", keyboard=True)
        observed("native-workflow-crash-observed.json")
        published_turn()
        send(frame, "NATIVE_WORKFLOW_AFTER_REVIEW: read native-input.txt as a distinct fresh intent, never the unknown file.", keyboard=True)
        expect(queued("NATIVE_WORKFLOW_AFTER_REVIEW:")).to_have_count(1, timeout=15000)
        print("PASS full Code/broker restart retains queue; Resume does not run; explicit Run drains edited FIFO before real unknown child effect.", flush=True)
        return

    if stage == "native-workflow-review":
        snapshot = history()
        unknown = snapshot["nativeTurns"][-1]
        assert unknown["status"] == "unknown" and unknown["replay"] == "never"
        assert len(pending(snapshot)) == 1 and snapshot["queueControl"]["needsReview"]
        count = len(snapshot["nativeTurns"])
        frame.get_by_role("button", name="Review unknown outcomes", exact=True).click()
        page.get_by_role("button", name="Keep unknown; never replay", exact=True).click(timeout=15000)
        field = page.locator(".quick-input-widget input")
        expect(field).to_be_visible(timeout=15000)
        field.fill("Actual read happened before broker SIGKILL; explicitly abandon without replay, not successful execution.")
        field.press("Enter")
        expect(frame.locator("#native-workflow-controls")).to_contain_text("Effect remains UNKNOWN", timeout=15000)
        snapshot = history()
        assert len(snapshot["nativeTurns"]) == count and len(pending(snapshot)) == 1
        reviewed = snapshot["nativeTurns"][-1]
        assert reviewed["id"] == unknown["id"] and reviewed["status"] == "unknown" and reviewed["uncertain"]
        assert reviewed["userReview"]["decision"] == "abandon-without-replay"
        assert snapshot["queueControl"]["needsReview"]
        run_button = frame.get_by_role("button", name="Run queued inputs", exact=True)
        expect(run_button).to_be_enabled(timeout=15000)
        run_button.focus()
        run_button.press("Enter")
        durable_answer(frame, "NATIVE_WORKFLOW_AFTER_REVIEW_RESULT sha256:" + descriptor["nativeManagedSha256"])
        snapshot = history()
        assert snapshot["nativeTurns"][-1]["status"] == "completed" and not pending(snapshot)
        assert snapshot["nativeTurns"][-2]["id"] == unknown["id"] and snapshot["nativeTurns"][-2]["status"] == "unknown"
        (fixture / "native-workflow-review-ui-evidence.json").write_text(json.dumps({
            "unknownTurnId": unknown["id"], "unknownWorkerId": snapshot["nativeWorkers"][-1]["id"],
            "reviewedUnknown": snapshot["nativeTurns"][-2], "freshTurn": snapshot["nativeTurns"][-1],
            "queue": snapshot["queueControl"]}))
        print("PASS real unknown-outcome warning/reason, separate user-required decision, preserved UNKNOWN/never-replay and explicit Run of distinct fresh work.", flush=True)
        send(frame, "NATIVE_WORKFLOW_KNOWN_FAILURE: request the fixture-denied path once; never retry.", keyboard=True)
        observed("native-workflow-denial-observed.json")
        published_turn()
        frame.locator("#task-mode").click()
        send(frame, "NATIVE_WORKFLOW_AFTER_KNOWN_FAILURE", keyboard=True)
        expect(queued("NATIVE_WORKFLOW_AFTER_KNOWN_FAILURE")).to_have_count(1, timeout=15000)
        (fixture / "native-workflow-denial-release").write_text("Deny without opening any file")
        deadline = time.monotonic() + 15
        snapshot = history()
        while (snapshot["nativeTurns"][-1]["status"] != "failed" or not snapshot["queueControl"]["needsReview"]) and time.monotonic() < deadline:
            page.wait_for_timeout(50)
            snapshot = history()
        failed = snapshot["nativeTurns"][-1]
        assert failed["status"] == "failed" and not failed["uncertain"]
        assert snapshot["queueControl"]["needsReview"] and len(pending(snapshot)) == 1
        expect(frame.locator("#messages")).to_have_attribute("aria-busy", "false", timeout=15000)
        run_button = frame.get_by_role("button", name="Run queued inputs", exact=True)
        expect(run_button).to_be_enabled(timeout=15000)
        run_button.focus()
        run_button.press("Enter")
        durable_answer(frame, "NATIVE_WORKFLOW_AFTER_KNOWN_FAILURE_RESULT")
        snapshot = history()
        assert snapshot["nativeTurns"][-2]["id"] == failed["id"] and snapshot["nativeTurns"][-2]["status"] == "failed"
        assert snapshot["nativeTurns"][-1]["status"] == "completed" and not pending(snapshot)
        (fixture / "native-workflow-known-failure-ui-evidence.json").write_text(json.dumps({
            "failedTurn": failed, "distinctNextTurn": snapshot["nativeTurns"][-1], "queue": snapshot["queueControl"]}))
        print("PASS actual not-committed tool denial halts automatic queue drain; explicit Run continues only distinct remaining work, never retries the denied intent.", flush=True)
        return

    assert stage == "native-workflow-reviewed-reopen"
    snapshot = history()
    reviewed = json.loads((fixture / "native-workflow-review-ui-evidence.json").read_text())
    unknown = next(turn for turn in snapshot["nativeTurns"] if turn["id"] == reviewed["unknownTurnId"])
    assert unknown["status"] == "unknown" and unknown["replay"] == "never" and unknown["userReview"] == reviewed["reviewedUnknown"]["userReview"]
    assert not pending(snapshot)
    assert snapshot["nativeTurns"][-2]["status"] == "failed" and not snapshot["nativeTurns"][-2]["uncertain"]
    durable_answer(frame, "NATIVE_WORKFLOW_AFTER_REVIEW_RESULT sha256:" + descriptor["nativeManagedSha256"])
    print("PASS another full Code/broker restart preserves user review audit and original UNKNOWN without any replay.", flush=True)

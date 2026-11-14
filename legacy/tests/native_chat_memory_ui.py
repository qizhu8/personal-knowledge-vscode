import time
from pathlib import Path

from playwright.sync_api import expect


def run(page, frame, descriptor, stage, choose, send, durable_answer):
    choose(frame, descriptor["workerManager"])

    def adopt():
        frame.locator("#prompt").fill("SATURN draft remains local until fresh Memory admission")
        expect(frame.locator("#send")).to_be_disabled()
        frame.get_by_role("button", name="Adopt original Memory scope", exact=True).click()
        page.get_by_role("button", name="Adopt exact Memory scope", exact=True).click(timeout=15000)
        expect(frame.locator("#native-workflow-controls")).to_contain_text("fresh profile-local scope active", timeout=15000)
        expect(frame.locator("#prompt")).to_have_value("SATURN draft remains local until fresh Memory admission")
        frame.locator("#prompt").fill("")

    def answer(text):
        durable_answer(frame, text)
        expect(frame.locator("#messages")).to_have_attribute("aria-busy", "false", timeout=15000)

    def review(action, approve=True):
        frame.get_by_role("button", name=f"Review Memory {action}", exact=True).click(timeout=15000)
        expect(page.get_by_text("Approve this exact Memory lifecycle change?", exact=True)).to_be_visible(timeout=15000)
        expect(page.locator(".dialog-message-detail")).to_contain_text(descriptor["workerManager"])
        if approve:
            page.get_by_role("button", name="Approve exact Memory change", exact=True).click()
        else:
            page.get_by_role("button", name="Cancel", exact=True).click()

    if stage == "native-memory-start":
        adopt()
        send(frame, "NATIVE_MEMORY_RECALL_OLD SATURN", keyboard=True)
        answer("NATIVE_MEMORY_OLD_RECALLED")
        send(frame, "NATIVE_MEMORY_UPDATE SATURN", keyboard=True)
        review("revise")
        answer("NATIVE_MEMORY_UPDATE_PENDING")
        send(frame, "NATIVE_MEMORY_RECALL_NONE SATURN pending must not recall", keyboard=True)
        answer("NATIVE_MEMORY_NO_ACTIVE_RECORD")
        send(frame, "NATIVE_MEMORY_CONFIRM SATURN", keyboard=True)
        review("confirm")
        answer("NATIVE_MEMORY_CONFIRM_COMPLETE")
        print("PASS actual Memory UI: fresh exact scope; old recall; exact-human revision returns pending; explicit confirmation activates new recall.", flush=True)
    elif stage == "native-memory-reopen":
        adopt()
        send(frame, "NATIVE_MEMORY_RECALL_COBALT SATURN", keyboard=True)
        answer("NATIVE_MEMORY_COBALT_RECALLED")
        send(frame, "NATIVE_MEMORY_REVOKE_DENIED SATURN", keyboard=True)
        review("revoke", approve=False)
        expect(frame.locator('#messages [data-message-id^="native-response:"]').last).to_contain_text("failed", timeout=15000)
        expect(frame.locator("#messages")).to_have_attribute("aria-busy", "false", timeout=15000)
        send(frame, "NATIVE_MEMORY_REVOKE_APPROVED SATURN", keyboard=True)
        review("revoke")
        answer("NATIVE_MEMORY_REVOKED")
        send(frame, "NATIVE_MEMORY_RECALL_NONE SATURN revoked must not recall", keyboard=True)
        # A previous identical result remains; wait for its distinct new persisted message.
        expect(frame.locator("#messages [data-message-id]").filter(has_text="NATIVE_MEMORY_NO_ACTIVE_RECORD")).to_have_count(2, timeout=45000)
        expect(frame.locator("#messages")).to_have_attribute("aria-busy", "false", timeout=15000)
        send(frame, "NATIVE_MEMORY_UNKNOWN SATURN propose then confirm once; never retry an unacknowledged mutation", keyboard=True)
        review("confirm")
        marker = Path(descriptor["root"]).parent / "native-memory-committed-unack.json"
        deadline = time.monotonic() + 20
        while not marker.exists() and time.monotonic() < deadline:
            page.wait_for_timeout(50)
        assert marker.exists(), "Actual native Memory commit must precede broker SIGKILL."
        print("PASS actual full restart requires fresh Memory scope; exact revoke Cancel leaves state unchanged; approved revoke excludes recall; actual new confirmation committed before withheld ack.", flush=True)
    elif stage == "native-memory-unknown-reopen":
        adopt()
        frame.get_by_role("button", name="Review unknown outcomes", exact=True).click()
        page.get_by_role("button", name="Keep unknown; never replay", exact=True).click(timeout=15000)
        field = page.locator(".quick-input-widget input")
        expect(field).to_be_visible(timeout=15000)
        field.fill("Native Memory commit was observed before broker SIGKILL; abandon the execution intent, preserve UNKNOWN and never retry it.")
        field.press("Enter")
        expect(frame.locator("#native-workflow-controls")).to_contain_text("Effect remains UNKNOWN", timeout=15000)
        send(frame, "NATIVE_MEMORY_FRESH_AFTER_UNKNOWN SATURN read current confirmed evidence only", keyboard=True)
        answer("NATIVE_MEMORY_FRESH_RECORD_RECALLED_NO_REPLAY")
        print("PASS real unknown warning/reason and separate user-required abandonment; distinct fresh Memory recall, no replay of committed mutation.", flush=True)
    elif stage == "native-memory-final-reopen":
        expect(frame.get_by_role("button", name="Adopt original Memory scope", exact=True)).to_be_visible()
        expect(frame.locator("#native-workflow-controls")).to_contain_text("Effect remains UNKNOWN", timeout=15000)
        expect(frame.locator("#messages")).to_contain_text("NATIVE_MEMORY_FRESH_RECORD_RECALLED_NO_REPLAY", timeout=15000)
        expect(frame.locator("#messages")).to_contain_text("NATIVE_MEMORY_REVOKED")
        print("PASS final full Code/broker restart retains original/native Memory evidence and UNKNOWN audit; no scope/model/tool grant inherited.", flush=True)
    else:
        raise AssertionError(stage)

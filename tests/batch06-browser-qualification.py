import json
import pathlib
import signal
import sys

from playwright.sync_api import expect, sync_playwright


settings = json.loads(sys.stdin.readline())
def terminate(_signal, _frame):
    raise SystemExit(143)


signal.signal(signal.SIGTERM, terminate)
url = settings["url"]
root = pathlib.Path(settings["root"])


def qualify_chat(page):
    def connect_and_select():
        page.get_by_label("Access token").fill(settings["token"])
        page.get_by_role("button", name="Connect", exact=True).click()
        page.get_by_role("button", name="Chat a", exact=True).click()
        expect(page.locator(".chat-panel .composer button", has_text="Reconnect updates")).to_be_enabled()

    connect_and_select()
    page.get_by_label("Message", exact=True).fill("First browser input")
    page.get_by_role("button", name="Send", exact=True).click()
    expect(page.locator(".messages pre", has_text="Partial")).to_have_count(1)
    expect(page.get_by_role("button", name="Send", exact=True)).to_be_disabled()
    page.reload(wait_until="networkidle")
    connect_and_select()
    expect(page.locator(".messages pre", has_text="First browser input")).to_have_count(1)
    expect(page.locator(".messages pre", has_text="Partial")).to_have_count(1)
    expect(page.get_by_role("button", name="Send", exact=True)).to_be_disabled()
    print("CHAT_ACTIVE_REATTACHED", flush=True)
    expect(page.locator(".messages pre", has_text="Durable answer")).to_have_count(1)
    expect(page.locator(".messages .message")).to_have_count(2)
    expect(page.locator(".messages [data-live-turn]")).to_have_count(0)
    expect(page.get_by_role("button", name="Send", exact=True)).to_be_enabled()
    page.get_by_label("Message", exact=True).fill("Second browser input")
    page.get_by_role("button", name="Send", exact=True).click()
    expect(page.locator(".messages pre", has_text="Partial")).to_have_count(1)
    page.get_by_role("button", name="Cancel turn", exact=True).click()
    expect(page.locator(".chat-panel [role=status]")).to_contain_text("Turn cancelled")
    expect(page.get_by_role("button", name="Cancel turn", exact=True)).to_be_disabled()
    expect(page.locator(".messages .message")).to_have_count(4)
    page.locator(".chat-panel").get_by_role("button", name="Reconnect updates", exact=True).click()
    expect(page.locator(".messages .message")).to_have_count(4)
    page.reload(wait_until="networkidle")
    connect_and_select()
    expect(page.locator(".messages .message")).to_have_count(4)
    expect(page.locator(".messages pre", has_text="First browser input")).to_have_count(1)
    expect(page.locator(".messages pre", has_text="Durable answer")).to_have_count(1)
    expect(page.locator(".messages pre", has_text="Second browser input")).to_have_count(1)
    expect(page.locator(".messages pre", has_text="Partial")).to_have_count(1)
    assert page.evaluate("() => Object.keys(localStorage).length + Object.keys(sessionStorage).length") == 0
    print("CHAT_CONTINUITY_VERIFIED", flush=True)


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    try:
        page = browser.new_page(viewport={"width": 1440, "height": 1000})
        errors = []
        requests = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("request", lambda request: requests.append(request.url))
        response = page.goto(url, wait_until="networkidle")
        assert response.status == 200
        if settings.get("chat"):
            qualify_chat(page)
            assert not errors, errors
            assert all(request.startswith(url + "/") or request == url for request in requests), requests
            raise SystemExit(0)
        assert page.get_by_role("heading", name="Knowledge, in motion.").is_visible()
        page.screenshot(path=str(root / "browser-disconnected.png"), full_page=True)
        page.get_by_label("Access token").fill(settings["token"])
        page.get_by_role("button", name="Connect", exact=True).click()
        expect(page.locator(".connection-status")).to_contain_text("Connected")
        assert page.get_by_label("Access token").input_value() == ""
        page.get_by_role("button", name="Inert source", exact=True).click()
        page.locator(".source-preview pre").wait_for()
        assert "<script>" in page.locator(".source-preview pre").inner_text()
        assert page.evaluate("() => window.pkmInjected === undefined")
        assert page.locator(".source-preview script, .source-preview img").count() == 0
        page.get_by_label("Project ID").fill("project-feature")
        page.get_by_label("Run ID", exact=True).fill("browser-live")
        page.get_by_role("button", name="Open run", exact=True).click()
        page.locator(".run-phase").filter(has_text="state: active").wait_for()
        result = page.locator(".result-card").filter(has_text="worker-1").first
        result.wait_for()
        assert "delivery" in result.inner_text()
        assert "pending" in result.inner_text()
        assert "state: active" in page.locator(".run-phase").inner_text()
        assert page.get_by_text("Freshness: fresh", exact=False).is_visible()
        for region in ["Manager", "Chats"]:
            assert not page.get_by_role("region", name=region, exact=True).locator("button").filter(has_text="Approve").count()
        page.screenshot(path=str(root / "browser-active-intermediate.png"), full_page=True)
        result.get_by_role("button", name="Discuss this result").click()
        assert page.get_by_label("Worker task ID (optional)").input_value() == "worker-1"
        page.get_by_label("Feedback to Manager").fill("Revise this result only; other workers must continue.")
        page.get_by_role("button", name="Send feedback", exact=True).click()
        page.get_by_text("Native feedback receipt", exact=False).wait_for()
        assert "pending checkpoint is not applied success" in page.locator(".feedback-form").inner_text()
        print("FEEDBACK_QUEUED", flush=True)
        page.locator(".run-phase").filter(has_text="state: succeeded").wait_for(timeout=15000)
        assert not page.get_by_role("button", name="Cancel this run", exact=True).is_enabled()
        page.screenshot(path=str(root / "browser-e2e-accepted.png"), full_page=True)
        assert page.evaluate("() => Object.keys(localStorage).length") == 0
        assert page.evaluate("() => Object.keys(sessionStorage).length") == 0
        assert page.context.cookies() == []
        assert settings["token"] not in page.content()
        assert all(request.startswith(url + "/") or request == url for request in requests), requests
        assert not any("/manage/" in request or "/human-review/" in request for request in requests), requests
        assert not errors, errors
        page.get_by_role("button", name="Disconnect", exact=True).click()
        expect(page.locator(".connection-status")).to_contain_text("Disconnected")
        assert not page.get_by_role("button", name="Send feedback", exact=True).is_enabled()
        print(json.dumps({"browser": "chromium", "screenshots": 3, "errors": errors, "sameOrigin": True}), flush=True)
    finally:
        browser.close()

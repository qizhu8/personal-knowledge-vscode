import json
import pathlib
import sys
import time
from playwright.sync_api import expect, sync_playwright

settings = json.loads(sys.stdin.readline())
root = pathlib.Path(settings["root"])
url = settings["url"]
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    try:
        page = browser.new_page(viewport={"width": 1440, "height": 1000})
        errors, requests = [], []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("request", lambda request: requests.append(request.url))
        page.goto(url + "/human-review", wait_until="networkidle")
        assert page.get_by_role("button", name="Approve exact record").count() == 0
        page.get_by_label("One-use native enrollment code").fill(settings["code"])
        page.get_by_role("button", name="Bind human session").click()
        expect(page.locator("#bind")).to_have_count(0)
        cookies = page.context.cookies()
        assert len(cookies) == 1 and cookies[0]["httpOnly"] and cookies[0]["sameSite"] == "Strict"
        assert cookies[0]["path"] == "/human-review"
        assert page.evaluate("() => document.cookie") == ""
        for input_, decision, label in zip(settings["turns"], ["approve", "reject", "cancel"],
                                           ["Approve exact record", "Reject", "Cancel review"]):
            response = page.request.post(url + "/v1/capability_call",
                headers={"Authorization": "Bearer " + settings["token"], "Origin": url},
                data={"operation": "chat.turn.start", "version": 1, "arguments": input_})
            assert response.status == 200, response.text()
            entry = None
            for _ in range(1000):
                payload = page.evaluate("""async () => {
                  const response = await fetch('/human-review/read', {method:'POST',
                    headers:{'Content-Type':'application/json'},body:'{}'});
                  return response.json();
                }""")
                if payload.get("entries"):
                    entry = payload["entries"][0]
                    break
                time.sleep(0.01)
            assert entry is not None
            page.get_by_role("button", name="Refresh queue").click()
            expect(page.get_by_role("button", name=label, exact=True)).to_be_visible()
            expect(page.get_by_role("dialog")).to_be_visible()
            assert entry["workspaceId"] == settings["workspaceId"]
            assert entry["actorId"] == "local:owner"
            assert "<img src=x onerror=evil()>" in page.locator(".human-review-detail").inner_text()
            assert page.locator(".human-review-detail img, .human-review-detail script").count() == 0
            assert page.evaluate("() => window.evil === undefined")
            if decision == "approve":
                page.screenshot(path=str(root / "native-human-modal.png"), full_page=True)
                status = page.evaluate("""async pin => (await fetch('/human-review/decide', {
                  method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(pin)})).status""",
                    {"id": entry["id"], "expectedRevision": entry["revision"],
                     "intentDigest": "0" * 64, "decision": "approve"})
                assert status == 403
                assert page.get_by_role("button", name=label, exact=True).is_enabled()
            machine = page.request.post(url + "/human-review/decide",
                headers={"Authorization": "Bearer " + settings["token"], "Origin": url},
                data={"id": entry["id"], "expectedRevision": entry["revision"],
                      "intentDigest": entry["intentDigest"], "decision": "approve"})
            assert machine.status == 403, "Machine bearer must not inherit the native cookie's capability"
            page.get_by_role("button", name=label, exact=True).click()
            for _ in range(1000):
                response = page.request.post(url + "/v1/capability_read",
                    headers={"Authorization": "Bearer " + settings["token"], "Origin": url},
                    data={"operation": "chat.turn.get", "version": 1, "arguments": {"id": input_["id"]}})
                record = response.json()["result"]
                if record["status"] in ["completed", "failed", "cancelled", "unknown"]:
                    break
                time.sleep(0.01)
            assert record["status"] in ["completed", "failed", "cancelled", "unknown"]
            if decision == "approve":
                assert record["status"] == "completed" and record["output"] == "Local socket answer."
            document = page.request.post(url + "/v1/capability_read",
                headers={"Authorization": "Bearer " + settings["token"], "Origin": url},
                data={"operation": "knowledge.document.get", "version": 1,
                      "arguments": {"id": "document-browser-" + decision}})
            if decision == "approve":
                assert document.json()["result"]["content"] == "Local socket content browser-approve."
            else:
                assert document.status != 200 or "error" in document.json()
        assert page.evaluate("() => Object.keys(localStorage).length + Object.keys(sessionStorage).length") == 0
        assert settings["token"] not in page.content() and settings["code"] not in page.content()
        assert all(request.startswith(url + "/") for request in requests), requests
        assert not errors, errors
        print(json.dumps({"browser": "chromium", "nativeModal": True, "decisions": 3,
                          "machineDenied": True, "sameOrigin": True, "errors": errors}), flush=True)
    finally:
        browser.close()

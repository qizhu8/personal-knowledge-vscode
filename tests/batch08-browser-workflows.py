import json
import hashlib
import sys

from playwright.sync_api import expect, sync_playwright


settings = json.loads(sys.stdin.readline())
state = {"interrupted": False, "resuming": False, "requests": [], "uploadId": None}
upload_bytes = bytes(index % 251 for index in range(70_003))
upload_digest = "sha256:" + hashlib.sha256(upload_bytes).hexdigest()


def interrupt_second_chunk(route):
    request = route.request
    try:
        body = json.loads(request.post_data or "{}")
    except json.JSONDecodeError:
        body = {}
    args = body.get("arguments", {})
    state["requests"].append((body.get("operation"), args.get("offset"), request.url))
    if (body.get("operation") == "knowledge.upload.append"
            and args.get("offset", 0) >= 65_536 and not state["resuming"]):
        applied = route.fetch()
        state["serverAccepted"] = applied.status == 200
        route.fulfill(status=503, content_type="application/json", body=json.dumps({
            "schema": "pkm.next-result/v1",
            "error": {"code": "BUSY", "message": "synthetic interrupted upload", "effect": "unknown"},
        }))
        state["interrupted"] = True
    else:
        route.continue_()


def capture_upload_id(response):
    try:
        body = response.request.post_data_json
        if body.get("operation") == "knowledge.upload.begin":
            state["uploadId"] = response.json()["result"]["uploadId"]
    except Exception:
        pass


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    try:
        page = browser.new_page(viewport={"width": 1440, "height": 1000})
        page.set_default_timeout(8000)
        page.set_default_navigation_timeout(10000)
        page.on("dialog", lambda dialog: dialog.accept())
        page_errors = []
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        response = page.goto(settings["url"], wait_until="networkidle")
        assert response.status == 200
        page.get_by_label("Access token").fill(settings["token"])
        page.get_by_role("button", name="Connect", exact=True).click()
        expect(page.locator(".connection-status")).to_contain_text("Connected")
        assert page.get_by_label("Access token").input_value() == ""
        page.get_by_role("button", name="Refresh documents", exact=True).click()
        page.get_by_role("button", name="Browser workflow note", exact=True).wait_for()
        page.get_by_role("button", name="Browser workflow note", exact=True).click()
        page.get_by_text("Original text", exact=True).wait_for()

        page.get_by_label("Document title").fill("Local draft title")
        page.get_by_label("Markdown source (literal text; no HTML preview)").fill("Local draft must not overwrite")
        server_update = page.request.post(
            settings["url"] + "/v1/capability_call",
            headers={"authorization": "Bearer " + settings["token"], "content-type": "application/json"},
            data=json.dumps({
                "operation": "knowledge.document.update",
                "version": 1,
                "arguments": {
                    "operationId": settings["concurrentOperationId"],
                    "id": settings["documentId"],
                    "expectedRevision": settings["documentRevision"],
                    "expectedSha256": settings["documentSha256"],
                    "title": "Server version",
                    "content": "Concurrent server version",
                },
            }),
        )
        assert server_update.status == 200, server_update.text()
        page.get_by_role("button", name="Save document", exact=True).click()
        conflict = page.locator(".surface-conflict")
        conflict.wait_for()
        assert "no draft was written" in conflict.inner_text().lower()
        assert "Concurrent server version" in conflict.inner_text()
        assert "Local draft must not overwrite" in conflict.inner_text()
        stale_file_input = page.get_by_label("Choose file to attach").element_handle()
        page.get_by_role("button", name="Reload server version (discard draft)", exact=True).click()
        page.wait_for_function("(input) => !input.isConnected", arg=stale_file_input)
        assert page.get_by_label("Markdown source (literal text; no HTML preview)").input_value() == "Concurrent server version"

        page.route("**/v1/capability_call", interrupt_second_chunk)
        page.on("response", capture_upload_id)
        page.get_by_label("Choose file to attach").set_input_files({
            "name": "resume-diagram.bin", "mimeType": "application/octet-stream", "buffer": upload_bytes,
        })
        page.get_by_role("button", name="Upload selected file", exact=True).click()
        for _ in range(100):
            if state["interrupted"]:
                break
            page.wait_for_timeout(50)
        assert state["interrupted"], f"upload append was not interrupted: {state['requests']}\\n{page.locator('body').inner_text()}"
        assert state["serverAccepted"], "the server committed the chunk before the response was lost"
        state["resuming"] = True
        page.get_by_role("button", name="Retry identical pending operation", exact=True).click()
        page.get_by_role("button", name="Retry identical pending operation", exact=True).wait_for(state="detached")
        page.get_by_role("button", name="Resume matching active upload", exact=True).click()
        page.locator('[data-surface="knowledge"] .surface-status').filter(has_text="Attachment committed:").wait_for()
        assert state["uploadId"], "real upload begin response should provide the durable upload identity"
        committed = False
        for _ in range(100):
            response = page.request.post(
                settings["url"] + "/v1/capability_read",
                headers={"authorization": "Bearer " + settings["token"], "content-type": "application/json"},
                data=json.dumps({
                    "operation": "knowledge.asset.list", "version": 1,
                    "arguments": {"id": settings["documentId"]},
                }),
            )
            assert response.status == 200, response.text()
            items = response.json()["result"].get("items", [])
            if any(item.get("digest") == upload_digest for item in items):
                committed = True
                break
            page.wait_for_timeout(50)
        assert committed, (
            "the rendered Resume action must finish the exact interrupted upload: "
            + json.dumps({"requests": state["requests"], "uploadId": state["uploadId"],
                          "body": page.locator("body").inner_text()})
        )

        page.get_by_label("Board slug").fill(settings["boardSlug"])
        page.get_by_role("button", name="Load Boards", exact=True).click()
        page.get_by_role("button", name=settings["boardSlug"], exact=False).wait_for()
        page.get_by_role("button", name=settings["boardSlug"], exact=False).click()
        page.get_by_role("button", name="List tasks", exact=True).click()
        page.get_by_role("button", name="Browser delegated review", exact=False).wait_for()
        page.get_by_role("button", name="Browser delegated review", exact=False).click()
        page.get_by_role("button", name="Accept completed task", exact=False).wait_for()
        page.get_by_label("Reviewer reason for accept").fill("Attempt without delegated reviewer authority")
        page.get_by_role("button", name="Accept completed task", exact=False).click()
        page.locator('[data-surface="todo"] .surface-status').get_by_text("delegated reviewer", exact=False).wait_for()

        page.get_by_label("Action run ID").fill(settings["actionRunId"])
        page.get_by_role("button", name="Load Action status and events", exact=True).click()
        action_panel = page.locator('[data-surface="action"]')
        action_panel.get_by_role("button", name="Cancel Action run", exact=True).wait_for()
        action_panel.get_by_role("button", name="Cancel Action run", exact=True).click()
        action_panel.locator(".surface-status").filter(has_text="unknown").wait_for()

        page.locator("body").wait_for()
        screenshot = page.screenshot(full_page=True)
        assert len(screenshot) > 10_000
        print(json.dumps({
            "body": page.locator("body").inner_text(),
            "buttons": [button.inner_text() for button in page.get_by_role("button").all()],
            "labels": [label.inner_text() for label in page.locator("label").all()],
            "errors": page_errors,
            "screenshotBytes": len(screenshot),
            "uploadDigest": upload_digest,
            "uploadInterrupted": state["interrupted"],
        }), flush=True)
        assert not page_errors, page_errors
    finally:
        browser.close()

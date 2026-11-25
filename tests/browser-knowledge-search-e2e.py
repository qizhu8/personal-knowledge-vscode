import json
import re
import sys

from playwright.sync_api import expect, sync_playwright


settings = json.loads(sys.stdin.readline())
calls = []


def record_request(request):
    if "/v1/capability_read" not in request.url and "/v1/capability_call" not in request.url:
        return
    try:
        body = request.post_data_json
        calls.append({"method": request.url.rsplit("/", 1)[-1],
                      "operation": body.get("operation"), "arguments": body.get("arguments", {})})
    except Exception:
        calls.append({"method": request.url.rsplit("/", 1)[-1], "operation": None, "arguments": {}})


def checkpoint(name, **details):
    print(json.dumps({"checkpoint": name, **details}), flush=True)
    response = json.loads(sys.stdin.readline())
    assert response["ready"]
    return response


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    try:
        page = browser.new_page(viewport={"width": 1200, "height": 900})
        page.set_default_timeout(8_000)
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("request", record_request)
        response = page.goto(settings["url"], wait_until="networkidle")
        assert response and response.status == 200
        page.get_by_label("Access token").fill(settings["token"])
        page.get_by_role("button", name="Connect", exact=True).click()
        expect(page.locator(".connection-status")).to_contain_text("Connected")
        if settings.get("mode") == "receipt-reconcile":
            def lose_update_response(route):
                assert route.request.post_data_json["operation"] == "knowledge.document.update"
                assert route.fetch().status == 200
                route.abort("failed")

            page.route("**/v1/capability_call", lose_update_response)
            editing = page.get_by_role("region", name="Knowledge editing", exact=True)
            markdown = editing.get_by_label("Markdown source (literal text; no HTML preview)", exact=True)
            markdown.fill(settings["content"])
            editing.get_by_role("button", name="Save document", exact=True).click()
            expect(editing.get_by_role("alert")).to_contain_text("outcome unknown")
            page.reload(wait_until="networkidle")
            page.get_by_label("Access token").fill(settings["token"])
            page.get_by_role("button", name="Connect", exact=True).click()
            expect(page.locator(".connection-status")).to_contain_text("Connected")
            editing = page.get_by_role("region", name="Knowledge editing", exact=True)
            expect(editing.get_by_label("Markdown source (literal text; no HTML preview)", exact=True)).to_have_value(
                settings["content"])
            page.get_by_role("button", name="Check durable write receipts", exact=True).click()
            expect(page.locator(".connection-status")).to_contain_text("1 matching committed receipt(s) reconciled")
            expect(page.locator(".connection-status")).to_contain_text("0 unresolved pin(s)")
            stored = page.evaluate("""() => Object.keys(localStorage)
                .filter(key => key.startsWith('pkm.pending-write.v1:'))""")
            assert stored == []
            assert len([call for call in calls if call["operation"] == "knowledge.document.update"]) == 1
            assert len([call for call in calls if call["operation"] == "operation.receipt.get"]) == 1
            print(json.dumps({"errors": errors, "calls": calls, "reconciled": True}), flush=True)
            sys.exit(0)
        if settings.get("mode") == "pending-write":
            def lose_write_response(route):
                body = route.request.post_data_json
                assert body["operation"] == "knowledge.note.create"
                committed = route.fetch()
                assert committed.status == 200
                route.abort("failed")

            page.route("**/v1/capability_call", lose_write_response)
            lifecycle = page.get_by_role("region", name="Knowledge lifecycle", exact=True)
            lifecycle.get_by_label("Title or Skill name", exact=True).fill(settings["title"])
            lifecycle.get_by_label("Markdown content", exact=True).fill(settings["content"])
            lifecycle.get_by_role("button", name="Create", exact=True).click()
            expect(lifecycle.get_by_role("alert")).to_contain_text("outcome unknown")
            stored = page.evaluate("""() => Object.keys(localStorage)
                .filter(key => key.startsWith('pkm.pending-write.v1:'))
                .map(key => JSON.parse(localStorage.getItem(key)))""")
            assert len(stored) == 1
            assert stored[0]["operation"] == "knowledge.note.create"
            serialized = json.dumps(stored)
            for sensitive in [settings["token"], settings["title"], settings["content"], '"arguments"']:
                assert sensitive not in serialized
            page.reload(wait_until="networkidle")
            page.get_by_label("Access token").fill(settings["token"])
            page.get_by_role("button", name="Connect", exact=True).click()
            expect(page.locator(".connection-status")).to_contain_text("Connected")
            expect(page.get_by_role("alert").filter(has_text="Unresolved write pins")).to_contain_text(
                stored[0]["operationId"])
            page.get_by_role("button", name="Check durable write receipts", exact=True).click()
            expect(page.locator(".connection-status")).to_contain_text("0 matching committed receipt(s) reconciled")
            expect(page.locator(".connection-status")).to_contain_text("1 unresolved pin(s)")
            lifecycle = page.get_by_role("region", name="Knowledge lifecycle", exact=True)
            lifecycle.get_by_label("Title or Skill name", exact=True).fill("Replacement must not dispatch")
            lifecycle.get_by_role("button", name="Create", exact=True).click()
            expect(lifecycle.get_by_role("alert")).to_contain_text("PENDING_OUTCOME_UNKNOWN")
            assert len([call for call in calls if call["operation"] == "knowledge.note.create"]) == 1
            print(json.dumps({"errors": errors, "calls": calls, "markers": stored, "blocked": True}), flush=True)
            sys.exit(0)
        if settings.get("mode") == "managed-chat":
            chat = page.get_by_role("region", name="Chats", exact=True)
            chat.get_by_role("button", name="New Chat", exact=True).click()
            chat.get_by_label("Message", exact=True).fill(settings["input"])
            chat.get_by_role("button", name="Send", exact=True).click()
            expect(chat.get_by_role("status")).to_contain_text("Turn model")
            checkpoint("managed-chat-running")
            expect(chat.get_by_role("status")).to_contain_text("Turn completed")
            expect(chat.locator(".message pre")).to_have_text([settings["input"], settings["answer"]])
            chat.get_by_text("Context, permissions & execution evidence", exact=True).click()
            expect(chat).to_contain_text("pkm.chat.session-context/v1")
            expect(chat).to_contain_text("native-host-only")
            saved = chat.locator(".message pre").all_text_contents()
            checkpoint("managed-chat-completed")
            management = page.locator(".shared-management")
            management.get_by_text("Local service management (separate authority)", exact=True).click()
            management.get_by_label("Management service UUID", exact=True).fill(settings["serviceId"])
            management.get_by_label("Management credential", exact=True).fill(settings["managementToken"])
            management.get_by_role("button", name="Connect management", exact=True).click()
            expect(management.get_by_role("status")).to_contain_text("Observed native service phase: accepting")
            expect(management.get_by_label("Management credential", exact=True)).to_have_value("")
            management.get_by_role("button", name="List verified staged candidates", exact=True).click()
            management.get_by_label("Verified staged generation", exact=True).select_option(settings["nextGeneration"])
            management.get_by_role("checkbox").check()
            management.get_by_role("button", name="Request exact management approval", exact=True).click()
            expect(management.get_by_role("status")).to_contain_text("No management action has been executed")
            checkpoint("managed-ui-approved")
            management.get_by_role("button", name="Execute approved management action", exact=True).click()
            expect(management.get_by_role("button", name="Refresh service status", exact=True)).to_be_enabled()
            management.get_by_role("button", name="Refresh service status", exact=True).click()
            expect(management.get_by_role("status")).to_contain_text("Native switch completed", timeout=30_000)
            expect(management.locator("pre").first).to_contain_text(settings["nextGeneration"])
            stored = page.evaluate("JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)])")
            assert settings["managementToken"] not in stored
            assert settings["token"] not in stored
            assert "approvalId" not in stored
            checkpoint("managed-ui-switched")
            def lose_reset_response(route):
                assert route.fetch().status == 200
                route.abort("failed")

            page.route("**/manage/reset-index", lose_reset_response)
            management.get_by_label("Management action", exact=True).select_option("reset-index")
            management.get_by_role("checkbox").check()
            management.get_by_role("button", name="Request exact management approval", exact=True).click()
            expect(management.get_by_role("status")).to_contain_text("No management action has been executed")
            management.get_by_role("button", name="Execute approved management action", exact=True).click()
            expect(management.get_by_role("status")).to_contain_text("observation is unresolved", timeout=30_000)
            expect(management.get_by_role("button", name="Request exact management approval", exact=True)).to_be_disabled()
            managed_pins = page.evaluate("""() => Object.keys(localStorage)
                .filter(key => key.startsWith('pkm.shared-management.pending.v1:'))
                .map(key => JSON.parse(localStorage.getItem(key)))""")
            assert len(managed_pins) == 1
            assert managed_pins[0]["action"] == "reset-index"
            assert re.fullmatch("[a-f0-9]{64}", managed_pins[0]["bodySha256"])
            serialized = json.dumps(managed_pins)
            for sensitive in [settings["token"], settings["managementToken"], "approvalId", '"arguments"']:
                assert sensitive not in serialized
            checkpoint("managed-ui-reset-unknown", pin=managed_pins[0])
            page.reload(wait_until="networkidle")
            page.get_by_label("Access token").fill(settings["token"])
            page.get_by_role("button", name="Connect", exact=True).click()
            expect(page.locator(".connection-status")).to_contain_text("Connected")
            chat = page.get_by_role("region", name="Chats", exact=True)
            chat.locator(".chat-list").get_by_role("button", name="New Chat", exact=True).click()
            expect(chat.get_by_role("status")).to_contain_text("Turn completed")
            expect(chat.locator(".message pre")).to_have_text(saved)
            management = page.locator(".shared-management")
            management.get_by_text("Local service management (separate authority)", exact=True).click()
            management.get_by_label("Management service UUID", exact=True).fill(settings["serviceId"])
            management.get_by_label("Management credential", exact=True).fill(settings["managementToken"])
            management.get_by_role("button", name="Connect management", exact=True).click()
            expect(management.get_by_role("status")).to_contain_text("Observed native service phase: accepting")
            expect(management.get_by_role("button", name="Request exact management approval", exact=True)).to_be_disabled()
            management.get_by_role("button", name="Check durable management observations", exact=True).click()
            expect(management.get_by_label("Durable management observations", exact=True)).to_contain_text('"status": "terminal"')
            expect(management.get_by_label("Durable management observations", exact=True)).to_contain_text(managed_pins[0]["operationId"])
            management.get_by_role("checkbox").check()
            management.get_by_role("button", name="Acknowledge matching terminal management observation", exact=True).click()
            expect(management.get_by_role("status")).to_contain_text("1 matching terminal management observation(s) reviewed")
            assert page.evaluate("""() => Object.keys(localStorage)
                .filter(key => key.startsWith('pkm.shared-management.pending.v1:'))""") == []
            checkpoint("managed-chat-reloaded")
            print(json.dumps({"errors": errors, "calls": calls, "complete": True, "messages": saved}), flush=True)
            sys.exit(0)
        if settings.get("mode") == "chat":
            chat = page.get_by_role("region", name="Chats", exact=True)
            chat.get_by_role("button", name="New Chat", exact=True).click()
            message = chat.get_by_label("Message", exact=True)
            expect(message).to_be_enabled()
            message.fill("Durable browser input")
            chat.get_by_role("button", name="Send", exact=True).click()
            expect(chat.get_by_role("status")).to_contain_text("Turn model")
            checkpoint("chat-running")
            page.reload(wait_until="networkidle")
            page.get_by_label("Access token").fill(settings["token"])
            page.get_by_role("button", name="Connect", exact=True).click()
            expect(page.locator(".connection-status")).to_contain_text("Connected")
            chat = page.get_by_role("region", name="Chats", exact=True)
            chat.locator(".chat-list").get_by_role("button", name="New Chat", exact=True).click()
            expect(chat.get_by_role("status")).to_contain_text("Turn model")
            expect(chat.locator(".message").filter(has_text="Durable browser input")).to_have_count(1)
            chat.get_by_role("button", name="Reconnect updates", exact=True).click()
            expect(chat.get_by_role("status")).to_contain_text("Turn model")
            chat.get_by_role("button", name="Cancel turn", exact=True).click()
            expect(chat.get_by_role("status")).to_contain_text("Turn cancelled")
            expect(chat.locator(".message").filter(has_text="assistant")).to_have_count(1)
            expect(chat.locator(".message").filter(has_text="Durable browser input")).to_have_count(1)
            checkpoint("chat-cancelled")
            chat.get_by_role("button", name="Archive Chat", exact=True).click()
            expect(chat.get_by_role("status")).to_contain_text("archived")
            expect(chat.get_by_role("button", name="Send", exact=True)).to_be_disabled()
            expect(chat.locator(".message").filter(has_text="Durable browser input")).to_have_count(1)
            chat.get_by_role("button", name="Show archived", exact=True).click()
            chat.locator(".chat-list").get_by_role("button", name="New Chat", exact=True).click()
            expect(chat.get_by_role("status")).to_contain_text("archived")
            expect(chat.locator(".message").filter(has_text="Durable browser input")).to_have_count(1)
            print(json.dumps({"errors": errors, "calls": calls, "cancelled": True}), flush=True)
            sys.exit(0)
        lifecycle = page.get_by_role("region", name="Knowledge lifecycle", exact=True)
        page.get_by_role("link", name="Lifecycle", exact=True).click()
        search_kind = lifecycle.get_by_label("Search Knowledge kind", exact=True)
        search_kind.select_option("note")
        search_form = lifecycle.locator("form").filter(
            has=page.get_by_role("heading", name="Literal search", exact=True))
        query = search_form.get_by_label("Search terms", exact=True)
        query.fill("Pinned Browser Fixture")
        search_form.get_by_role("button", name="Search", exact=True).click()
        results = lifecycle.get_by_role("region", name="Literal search results", exact=True)
        source_button = results.get_by_role(
            "button", name=re.compile(re.escape(settings["title"])))
        source_button.wait_for()
        checkpoint("search-ready")

        source_button.click()
        alert = lifecycle.get_by_role("alert")
        expect(alert).to_contain_text(re.compile("changed|snapshot|conflict", re.I))
        assert "OLD pinned source" not in lifecycle.inner_text()

        search_form.get_by_role("button", name="Search", exact=True).click()
        refreshed_button = results.get_by_role(
            "button", name=re.compile(re.escape(settings["title"])))
        refreshed_button.wait_for()
        refreshed_button.click()
        expect(lifecycle.locator("pre").last).to_contain_text("CURRENT pinned source")
        rendered = lifecycle.locator("pre").last.inner_text()
        assert "<script>window.pkmInjected = true</script>" in rendered
        assert "OLD pinned source" not in rendered
        assert lifecycle.locator("script, img").count() == 0
        assert page.evaluate("window.pkmInjected === true") is False
        expect(lifecycle.get_by_text(
            "Opened the exact source selected from this pinned search snapshot; no write was attempted.",
            exact=True)).to_be_visible()
        assert lifecycle.get_by_role("button", name="Save specialized fields", exact=True).count() == 0
        print(json.dumps({"errors": errors, "calls": calls, "injected": page.evaluate("!!window.pkmInjected"),
                          "readOnly": lifecycle.get_by_role("button", name="Save specialized fields", exact=True).count() == 0}),
              flush=True)
    finally:
        browser.close()

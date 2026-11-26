import json
import sys

from playwright.sync_api import expect, sync_playwright


fixture = json.load(sys.stdin)
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    context = browser.new_context(ignore_https_errors=True)
    page = context.new_page()
    page.set_default_timeout(7000)
    failures = []
    page.on("pageerror", lambda error: failures.append(str(error)))
    page.goto(fixture["origin"] + "/webview/")
    page.wait_for_load_state("networkidle")
    page.get_by_label("Server token").fill(fixture["token"])
    page.get_by_role("button", name="Sign in").click()
    page.wait_for_load_state("networkidle")
    expect(page.locator("#workspace-rail")).to_be_visible()
    if fixture["mode"] == "write":
        expect(page.locator("#btn-add-knowledge")).to_be_enabled()
        page.locator("#btn-add-knowledge").click()
        page.locator("#note-title").fill("UI Note")
        page.locator("#note-content").fill("Created in the actual Original Webview")
        with page.expect_response(lambda response: response.url.endswith("/webview/message")
                                  and response.request.post_data_json.get("command") == "saveNote") as created:
            page.locator("#note-form .form-actions button:last-child").click()
        assert created.value.ok, created.value.text()
    else:
        expect(page.locator("#btn-add-knowledge")).to_be_disabled()
    page.reload(wait_until="networkidle")
    with page.expect_response(lambda response: response.url.endswith("/webview/message")
                              and response.request.post_data_json.get("q") == "UI Note"):
        page.get_by_role("searchbox", name="Search Notes").fill("UI Note")
    with page.expect_response(lambda response: response.url.endswith("/webview/message")
                              and response.request.post_data_json.get("command") == "detail") as opened:
        page.get_by_role("button", name="UI Note File").click()
    assert opened.value.ok, opened.value.text()
    edit = page.locator('#detail button[onclick^="openMarkdownItem("]')
    if fixture["mode"] == "write":
        expect(edit).to_be_enabled()
        edit.click()
        expect(page.locator("#note-title")).to_be_disabled()
        page.locator("#note-content").fill("Edited in the actual Original Webview")
        with page.expect_response(lambda response: response.url.endswith("/webview/message")
                                  and response.request.post_data_json.get("command") == "updateNote") as saved:
            page.locator("#note-form .form-actions button:last-child").click()
        assert saved.value.ok, saved.value.text()
        expect(page.locator("#detail")).to_contain_text("Edited in the actual Original Webview")
    else:
        expect(edit).to_be_disabled()
        assert opened.value.json()["editPin"] is None
    assert not failures, failures
    browser.close()

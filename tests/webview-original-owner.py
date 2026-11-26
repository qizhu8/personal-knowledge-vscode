import json
import sys
import uuid
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


fixture = json.load(sys.stdin)
url = fixture["url"]
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page()
    page.goto(url)
    page.wait_for_load_state("networkidle")
    page.get_by_label("Server token").fill(fixture["token"])
    page.get_by_label("Remember this browser").check()
    with page.expect_response(url + "panel.js") as bundle_request:
        page.get_by_role("button", name="Sign in").click()
    assert bundle_request.value.body() == (Path(fixture["bundle"]) / "panel.js").read_bytes()
    page.wait_for_load_state("networkidle")
    expect(page.locator("#btn-add-knowledge")).to_be_disabled()
    page.get_by_role("button", name="(uncategorized) Folder", exact=False).click()
    expect(page.get_by_text("Predecessor Note", exact=True)).to_be_visible()
    with page.expect_response(lambda response: response.url == url + "message"
                              and response.request.post_data_json.get("q") == "originalbrowserreadmarker") as searched:
        page.get_by_role("searchbox", name="Search Notes").fill("originalbrowserreadmarker")
    assert searched.value.ok, searched.value.text()
    assert [item["title"] for item in searched.value.json()["items"]] == ["Predecessor Note"]
    with page.expect_response(lambda response: response.url == url + "message"
                              and response.request.post_data_json.get("command") == "detail") as opened:
        page.get_by_role("button", name="Predecessor Note File").click()
    assert opened.value.ok, opened.value.text()
    expect(page.locator("#detail")).to_contain_text("originalbrowserreadmarker")

    def post(command, **args):
        return page.evaluate("""async body => (await fetch("/webview/message", {
            method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)
        })).status""", {"command": command, **args})

    assert post("updateNote", id="PredecessorNote", expectedRevision=1, expectedSha256="a" * 64,
                content="This must not replace the Original Note", operationId=str(uuid.uuid4())) == 409
    page.get_by_role("button", name="PKM Chat").click()
    page.locator(f'button[data-id="{fixture["chatId"]}"]').click()
    if fixture["nativeTranscript"]:
        request = page.get_by_role("button", name="Request transcript")
        expect(request).to_be_enabled()
        expect(page.locator("#chat-transcript")).to_be_empty()
        assert post("chatGet", id=fixture["chatId"]) == 409
        request.click()
        expect(page.locator("#chat-state")).to_contain_text("did not share")
        expect(page.locator("#chat-transcript")).to_be_empty()
        request.click()
        expect(page.locator("#chat-transcript")).to_contain_text("Earlier saved fixture message 1")
        expect(page.locator("#chat-transcript")).not_to_contain_text("GATEWAY_BROWSER_ACCEPTED")
        page.get_by_role("button", name="Show more messages").click()
        expect(page.locator("#chat-transcript")).to_contain_text("GATEWAY_BROWSER_ACCEPTED")
        expect(page.locator("#chat-transcript")).to_contain_text("assistant · cancelled")
        page.reload()
        expect(request).to_be_enabled()
        expect(page.locator("#chat-transcript")).to_be_empty()
        request.click()
        expect(page.locator("#chat-state")).to_contain_text("did not share")
    else:
        expect(page.locator("#chat-state")).to_contain_text("latest saved reply only")
        expect(page.locator("#chat-transcript")).to_contain_text("assistant · cancelled")
        page.reload()
        expect(page.locator("#chat-transcript")).to_contain_text("assistant · cancelled")
    if fixture["nativeTurns"]:
        input_box = page.get_by_label("Message")
        input_box.fill("Decline this send")
        page.get_by_role("button", name="Send", exact=True).click()
        expect(page.locator("#chat-turn-state")).to_contain_text("did not send")
        input_box.fill("Browser turn stale revision")
        page.get_by_role("button", name="Send", exact=True).click()
        expect(page.locator("#chat-turn-state")).to_contain_text("did not send")
        input_box.fill("Browser turn finish normally")
        page.get_by_role("button", name="Send", exact=True).click()
        expect(page.locator("#chat-turn-state")).to_contain_text("Turn completed")
        input_box.fill("Browser turn held until exact Stop")
        page.get_by_role("button", name="Send", exact=True).click()
        stop = page.get_by_role("button", name="Stop", exact=True)
        expect(stop).to_be_enabled()
        page.reload(wait_until="domcontentloaded")
        expect(stop).to_be_enabled()
        assert post("originalChatStop", chatId=fixture["chatId"], turnId=str(uuid.uuid4())) == 500
        stop.click()
        expect(page.locator("#chat-turn-state")).to_contain_text("upstream cancellation is not confirmed")
    else:
        expect(page.locator("#chat-send")).to_be_disabled()
    expect(page.locator("#chat-stop")).to_be_disabled()
    expect(page.locator("#chat-review")).to_contain_text("unavailable")
    assert post("chatStart", sessionId=fixture["chatId"], id=str(uuid.uuid4()),
                operationId=str(uuid.uuid4()), expectedSessionRevision=1, content="Do not dispatch") == 409
    assert post("approval", id=str(uuid.uuid4()), value="approve") == 400
    browser.close()

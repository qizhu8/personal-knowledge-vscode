import json
import sys
import urllib.request

from playwright.sync_api import expect, sync_playwright

settings = json.loads(sys.stdin.readline())


def channel(message):
    request = urllib.request.Request(settings["url"] + "/channel",
                                     data=json.dumps(message).encode(),
                                     headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)


def checkpoint(name):
    print(json.dumps({"checkpoint": name}), flush=True)
    assert json.loads(sys.stdin.readline())["ready"]


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    try:
        page = browser.new_page()
        page.set_default_timeout(8_000)
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.expose_function("hostPost", channel)
        page.add_init_script("""
        window.acquireVsCodeApi = () => ({
          getState: () => JSON.parse(localStorage.getItem('panel-state') || 'null'),
          setState: value => localStorage.setItem('panel-state', JSON.stringify(value)),
          postMessage: value => window.hostPost(value).then(reply =>
            window.dispatchEvent(new MessageEvent('message', { data: reply })))
        });
        """)
        page.goto(settings["url"], wait_until="networkidle")
        chat = page.get_by_role("region", name="Chats", exact=True)
        chat.get_by_label("New Chat title").fill("Experimental native Chat")
        chat.get_by_role("button", name="New Chat", exact=True).click()
        expect(chat.get_by_role("status")).to_contain_text("Ready")
        selected = chat.get_by_label("Saved Chat").input_value()
        chat.get_by_label("Message", exact=True).fill("One experimental extension input")
        chat.get_by_role("button", name="Send", exact=True).click()
        expect(chat.get_by_role("status")).to_contain_text("Turn model")
        checkpoint("running")
        chat.get_by_label("Saved Chat").select_option("")
        chat.get_by_label("Saved Chat").select_option(selected)
        expect(chat.get_by_role("status")).to_contain_text("Turn model")
        page.reload(wait_until="networkidle")
        expect(chat.get_by_role("status")).to_contain_text("Turn model")
        chat.get_by_role("button", name="Refresh Chats", exact=True).click()
        expect(chat.get_by_role("status")).to_contain_text("Turn model")
        chat.get_by_role("button", name="Cancel active turn", exact=True).click()
        expect(page.locator("#turn-status")).to_contain_text("Turn cancelled")
        checkpoint("cancelled")
        chat.get_by_role("button", name="Refresh Chats", exact=True).click()
        expect(chat.get_by_role("log")).to_contain_text("One experimental extension input")
        expect(chat.get_by_role("log")).to_contain_text("cancelled")
        page.get_by_text("Read-only turn evidence", exact=True).click()
        chat.get_by_role("button", name="Refresh evidence", exact=True).click()
        expect(page.locator("#turn-evidence")).to_contain_text("pkm.chat.session-context/v1")
        expect(page.locator("#turn-evidence")).to_contain_text("not-injected")
        expect(page.locator("#turn-evidence")).to_contain_text("NOT proof")
        chat.get_by_role("button", name="Archive Chat", exact=True).click()
        expect(chat.get_by_label("Saved Chat")).to_have_value("")
        assert not errors, errors
        print(json.dumps({"errors": errors}), flush=True)
    finally:
        browser.close()

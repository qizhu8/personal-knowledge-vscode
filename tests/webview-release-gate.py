import hashlib
import json
import re
import sys
import uuid

from playwright.sync_api import expect, sync_playwright


fixture = json.load(sys.stdin)
origin = fixture["url"]
url = origin + "/webview/"
message = url + "message"
query = "needle-" + uuid.uuid4().hex
edited = "changed-" + uuid.uuid4().hex

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    context = browser.new_context()
    page = context.new_page()
    page.set_default_timeout(7000)
    failures = []
    requests = []
    page.on("pageerror", lambda error: failures.append(str(error)))
    page.on("request", lambda req: requests.append(req.url))
    page.goto(url)
    page.wait_for_load_state("networkidle")
    page.get_by_label("Server token").fill("invalid isolated token")
    page.get_by_role("button", name="Sign in").click()
    expect(page.get_by_role("alert")).to_have_text("Token was not accepted.")
    page.get_by_label("Server token").fill(fixture["token"])
    page.get_by_label("Remember this browser").check()
    with page.expect_response(url + "panel.js") as bundle_request:
        page.get_by_role("button", name="Sign in").click()
    bundle = bundle_request.value
    assert bundle.ok
    assert "script-src-attr 'none'" in bundle.headers["content-security-policy"]
    assert "unsafe-eval" not in bundle.headers["content-security-policy"]
    assert bundle.body() == open(fixture["bundle"] + "/panel.js", "rb").read()
    page.wait_for_load_state("networkidle")
    expect(page.locator("#workspace-rail")).to_be_visible()
    expect(page.get_by_role("tab", name="Notes")).to_have_attribute("aria-selected", "true")
    expect(page.get_by_role("button", name="PKM Chat")).to_be_enabled()
    cookies = [cookie for cookie in context.cookies() if cookie["path"] == "/webview/"]
    assert len(cookies) == 1 and cookies[0]["httpOnly"] and cookies[0]["secure"]
    assert cookies[0]["sameSite"] == "Strict" and cookies[0]["expires"] > 0
    assert fixture["token"] not in json.dumps(cookies)

    def post(path, value):
        return page.evaluate("""async ([url, body]) => (await fetch(url, {
            method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)
        })).status""", [path, value])

    cross = context.request.post(message, data={}, headers={"Origin": "https://outside.invalid"})
    assert cross.status == 403
    assert post(message, {"command": "executeCommand", "name": "anything"}) == 400
    assert post(origin + "/v1/server_info", {}) == 401
    page.locator("#btn-add-knowledge").click()
    expect(page.locator("#note-form-title")).to_have_text("Quick Note")
    page.locator("#note-title").fill("Browser-created Note")
    page.locator("#note-category").fill("Gate/Qualification")
    page.locator("#note-content").fill(
        "**Persisted Markdown** " + query
        + '\n\n<img src="https://outside.invalid/x" onerror="window.pkmInjected=true">'
        + '\n\n[external](https://outside.invalid/)'
    )
    expect(page.locator("#note-preview strong")).to_have_text("Persisted Markdown")
    with page.expect_response(lambda response: response.url == message and
                              response.request.post_data_json["command"] == "saveNote") as saved:
        page.get_by_role("button", name="Save Note").click()
    assert saved.value.ok, saved.value.text()
    expect(page.locator("#note-form")).to_be_hidden()

    # Reload so search cannot be a render of the just-submitted draft or an in-memory cache.
    page.reload(wait_until="networkidle")
    search = page.locator("#searchbox")
    with page.expect_response(lambda response: response.url == message and
                              response.request.post_data_json.get("q") == query) as found:
        search.fill(query)
    hits = found.value.json()["items"]
    assert len(hits) == 1 and hits[0]["title"] == "Browser-created Note"
    page.get_by_role("button", name="Browser-created Note File").click()
    expect(page.locator("#note-markdown strong")).to_have_text("Persisted Markdown")
    expect(page.locator("#note-markdown")).to_contain_text(query)
    assert page.locator("#note-markdown img, #note-markdown a").count() == 0
    assert not page.evaluate("window.pkmInjected")
    page.get_by_role("button", name="Edit Content").click()
    expect(page.locator("#note-form-title")).to_have_text("Edit Note")
    expect(page.locator("#note-content")).to_have_value(re.compile(query))
    page.locator("#note-content").fill("**Edited Markdown** " + edited)
    with page.expect_response(lambda response: response.url == message and
                              response.request.post_data_json["command"] == "updateNote") as updated:
        page.get_by_role("button", name="Save Note").click()
    assert updated.value.ok, updated.value.status
    edit_request = updated.value.request.post_data_json
    assert edit_request["expectedRevision"] == 1 and len(edit_request["expectedSha256"]) == 64
    edit_request["operationId"] = str(uuid.uuid4())
    edit_request["content"] = "Stale edit must not persist"
    assert post(message, edit_request) == 409
    page.reload(wait_until="networkidle")
    search.fill(edited)
    page.get_by_role("button", name="Browser-created Note File").click()
    expect(page.locator("#note-markdown strong")).to_have_text("Edited Markdown")
    expect(page.locator("#note-markdown")).to_contain_text(edited)
    search.fill(query)
    expect(page.get_by_role("button", name="Browser-created Note File")).to_have_count(0)

    page.get_by_role("button", name="PKM Chat").click()
    expect(page).to_have_url(url + "chat")
    if fixture.get("thread"):
        page.get_by_role("button", name="Existing shared conversation").click()
        expect(page.get_by_role("heading", name="Existing shared conversation")).to_be_visible()
        page.get_by_label("Message").fill("Reply through the actual provider")
        page.get_by_role("button", name="Send").click()
        expect(page.locator("#chat-state")).to_have_text("Turn completed", timeout=20000)
        expect(page.locator("#chat-transcript")).to_contain_text("Answer from the local model")
        page.reload(wait_until="networkidle")
        expect(page.locator("#chat-transcript")).to_contain_text("Answer from the local model")
        page.get_by_label("Message").fill("Hold this real turn")
        page.get_by_role("button", name="Send").click()
        expect(page.locator("#chat-state")).to_have_text("Turn model", timeout=20000)
        # Reload with an active native turn; no new generation should be submitted.
        page.reload(wait_until="networkidle")
        expect(page.get_by_role("button", name="Stop")).to_be_enabled()
        page.get_by_role("button", name="Stop").click()
        expect(page.locator("#chat-state")).to_contain_text("Turn cancelled", timeout=20000)
        page.reload(wait_until="networkidle")
        expect(page.locator("#chat-state")).to_contain_text("Turn cancelled")
        expect(page.locator("#chat-transcript")).to_contain_text("Hold this real turn")
        expect(page.locator("#chat-transcript")).to_contain_text("Answer from the local model")
        assert post(origin + "/human-review/read", {}) == 403
        page.get_by_role("link", name="Open review desk").click()
        expect(page.get_by_label("One-use native enrollment code")).to_be_visible()
        page.get_by_label("One-use native enrollment code").fill(fixture["enrollment"])
        page.get_by_role("button", name="Bind human session").click()
        expect(page.get_by_role("dialog")).to_be_visible()
        expect(page.get_by_role("button", name="Refresh queue")).to_be_visible()
        page.goto(url)
    else:
        expect(page.locator("#chat-review")).to_have_text("Human review unavailable on this service.")
        expect(page.locator("#chat-state")).to_have_text("Generation unavailable; history is read-only.")
        expect(page.get_by_role("button", name="Send")).to_be_disabled()
        page.get_by_role("link", name="Personal Knowledge").click()
    assert all(req.startswith(origin) and fixture["token"] not in req for req in requests)
    assert not failures, failures

    page.get_by_role("button", name="Sign out").click()
    expect(page.get_by_label("Server token")).to_be_visible()
    assert post(message, {"command": "list", "q": "", "caseSensitive": False}) == 401
    page.get_by_label("Server token").fill(fixture["token"])
    page.get_by_role("button", name="Sign in").click()
    expect(page.locator("#workspace-rail")).to_be_visible()
    assert next(cookie for cookie in context.cookies() if cookie["path"] == "/webview/")["expires"] == -1
    print(json.dumps({"id": hits[0]["documentId"], "hash": hashlib.sha256(bundle.body()).hexdigest(), "query": edited}))
    browser.close()

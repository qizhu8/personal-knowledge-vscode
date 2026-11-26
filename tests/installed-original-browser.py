"""Verify the unchanged installed Browser route; native consent is driven in private Electron."""
import json
import sys
import time
import uuid
from pathlib import Path

from playwright.sync_api import Error, expect, sync_playwright


fixture = json.loads(Path(sys.argv[1]).read_text())
base = Path(fixture["base"])
with sync_playwright() as playwright:
    deadline = time.monotonic() + 100
    editor = None
    while time.monotonic() < deadline:
        try:
            cdp = playwright.chromium.connect_over_cdp(f"http://127.0.0.1:{fixture['port']}", timeout=500)
            editor = next((p for c in cdp.contexts for p in c.pages if "workbench" in p.url), None)
            if editor:
                editor.get_by_text("Copy sign-in token and open", exact=True).click(timeout=500)
                break
        except Error:
            time.sleep(0.1)
    else:
        raise AssertionError("Installed browser launcher did not present its opt-in picker")
    enrollment = base / "browser-enrollment.json"
    while not enrollment.exists() and time.monotonic() < deadline:
        time.sleep(0.1)
    assert enrollment.exists(), "Installed extension did not return a local browser binding"
    grant = json.loads(enrollment.read_text())
    enrollment.unlink()
    url = grant["url"]
    browser = playwright.chromium.launch(headless=True)
    try:
        page = browser.new_page()
        assert not page.request.get(url + "panel.js").ok
        page.goto(url)
        page.wait_for_load_state("networkidle")
        # Do not let Playwright report the fixture token in an action error.
        assert page.get_by_label("Server token").is_visible()
        page.locator("input[type=password]").evaluate("(el, token) => { el.value = token; }", grant.pop("token"))
        page.get_by_label("Remember this browser").check()
        with page.expect_response(url + "panel.js") as bundle:
            page.get_by_role("button", name="Sign in").click()
        assert bundle.value.body() == Path(grant["bundle"]).read_bytes()
        page.wait_for_load_state("networkidle")
        expect(page.locator("#btn-add-knowledge")).to_be_disabled()
        page.get_by_role("button", name="(uncategorized) Folder", exact=False).click()
        page.get_by_role("button", name="InstalledGatewayNote File").click()
        expect(page.locator("#detail")).to_contain_text("Created by genuine installed 4.0.27 PKM Chat")
        (base / "browser-note-read").touch()
        search = page.get_by_role("searchbox", name="Search Notes")
        with page.expect_response(lambda r: r.url == url + "message" and
                                  (r.request.post_data_json or {}).get("q") == "genuine") as hits:
            search.fill("genuine")
        searched = hits.value.ok and any(item["path"] == "InstalledGatewayNote.md" for item in hits.value.json()["items"])
        if not searched:
            print("Installed Original Note search did not return the predecessor hit:", hits.value.status, flush=True)
        page.reload(wait_until="networkidle")
        expect(search).to_be_visible()
        assert page.evaluate("""async body => (await fetch("/webview/message", {
            method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)
        })).status""", {
            "command": "updateNote", "id": "InstalledGatewayNote", "expectedRevision": 1, "expectedSha256": "a" * 64,
            "content": "must not modify the predecessor Note", "operationId": str(uuid.uuid4()),
        }) == 409
        page.get_by_role("button", name="PKM Chat").click()
        page.locator(f'button[data-id="{grant["chatId"]}"]').click()
        request = page.get_by_role("button", name="Request transcript")
        expect(request).to_be_enabled()
        expect(page.locator("#chat-transcript")).to_be_empty()
        request.click()
        dialog = editor.locator(".monaco-dialog-box")
        share = dialog.get_by_role("button", name="Share transcript", exact=True)
        expect(dialog).to_contain_text("Read-only")
        dialog.get_by_role("button", name="Cancel", exact=True).click()
        expect(page.locator("#chat-state")).to_contain_text("did not share")
        expect(page.locator("#chat-transcript")).to_be_empty()
        request.click()
        share.click()
        expect(page.locator("#chat-transcript")).to_contain_text("INSTALLED_GATEWAY_ACCEPTED")
        (base / "browser-transcript-shared").touch()
        page.reload(wait_until="networkidle")
        expect(page.locator("#chat-transcript")).to_be_empty()
        expect(page.locator("#chat-review")).to_contain_text("unavailable")

        (base / "browser-focus-request").touch()
        until = time.monotonic() + 20
        desktop_chat = None
        while desktop_chat is None and time.monotonic() < until:
            desktop_chat = next((frame for frame in editor.frames if frame.locator("#permissions").is_visible()), None)
            if desktop_chat is None:
                time.sleep(0.1)
        sent_and_stopped = False
        if desktop_chat is None:
            target_status = page.evaluate("""async chatId => (await fetch("/webview/message", {
                method: "POST", headers: {"Content-Type": "application/json"},
                body: JSON.stringify({command: "originalChatTarget", chatId})
            })).status""", grant["chatId"])
            assert target_status == 409, f"Ineligible owner must not issue a Send ticket (HTTP {target_status})"
        else:
            desktop_chat.locator("#permissions").click()
            desktop_chat.locator("#permission-mode").select_option("read-only")
            desktop_chat.locator("#permissions").click()
            draft = page.get_by_label("Message")
            send = page.get_by_role("button", name="Send", exact=True)
            stop = page.get_by_role("button", name="Stop", exact=True)
            draft.fill("INSTALLED_BROWSER_COMPLETE")
            send.click()
            expect(dialog).to_contain_text("INSTALLED_BROWSER_COMPLETE")
            dialog.get_by_role("button", name="Send once", exact=True).click()
            expect(page.locator("#chat-turn-state")).to_contain_text("Turn completed", timeout=25000)
            assert (base / "browser-provider-completed").exists()
            draft.fill("CANCEL_INSTALLED_BROWSER")
            send.click()
            expect(dialog).to_contain_text("CANCEL_INSTALLED_BROWSER")
            dialog.get_by_role("button", name="Send once", exact=True).click()
            expect(stop).to_be_enabled(timeout=20000)
            page.reload(wait_until="domcontentloaded")
            expect(stop).to_be_enabled(timeout=15000)
            stop.click()
            expect(page.locator("#chat-turn-state")).to_contain_text("upstream cancellation is not confirmed")
            until = time.monotonic() + 10
            while not (base / "browser-provider-closed").exists() and time.monotonic() < until:
                time.sleep(0.1)
            assert (base / "browser-provider-closed").exists()
            sent_and_stopped = True

        if not searched:
            page.goto(url, wait_until="networkidle")
            with page.expect_response(lambda r: r.url == url + "message" and
                                      (r.request.post_data_json or {}).get("q") == "InstalledGatewayNote") as hits:
                page.get_by_role("searchbox", name="Search Notes").fill("InstalledGatewayNote")
            searched = hits.value.ok and any(item["path"] == "InstalledGatewayNote.md" for item in hits.value.json()["items"])

        (base / "browser-revoke-request").touch()
        editor.get_by_text("Revoke browser access", exact=True).click(timeout=10000)
        # Poll through Chromium, which owns the Secure loopback cookie.
        until = time.monotonic() + 10
        while time.monotonic() < until:
            if not page.evaluate("""async () => {
                try { return (await fetch("/webview/panel.js", {cache: "no-store"})).ok; }
                catch { return false; }
            }"""):
                break
            time.sleep(0.1)
        else:
            raise AssertionError("Revoked session still serves the installed bundle")
        (base / "upgrade-browser.json").write_text(json.dumps({
            "installedActivation": True, "exactBundle": True, "rememberedReload": True,
            "predecessorNoteSearchReadOnly": searched, "nativeTranscriptDenialAndConsent": True, "revoked": True,
            "nativeSendAndStopAfterReload": sent_and_stopped, "fixtureProviderAborted": sent_and_stopped,
        }))
    finally:
        browser.close()

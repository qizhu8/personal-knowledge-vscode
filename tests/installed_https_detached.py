"""Verify the native-provisioned HTTPS service after the actual Workbench exits."""
import json
import sys
import time
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


enrollment = Path(sys.argv[1])
issued = json.loads(enrollment.read_text())
enrollment.unlink()
base = Path(issued["base"])
origin = issued["origin"]
provision = Path(issued["provisionPath"])
assert provision.is_relative_to(base / "u/User/globalStorage/uone.personal-knowledge/pkm-service")
assert not provision.is_symlink()
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    try:
        page = browser.new_page(ignore_https_errors=True)
        assert not page.request.get(origin + "/webview/panel.js").ok
        page.goto(origin + "/webview/")
        page.wait_for_load_state("networkidle")
        page.locator("input[type=password]").evaluate("(el, token) => { el.value = token; }", issued.pop("token"))
        with page.expect_response(origin + "/webview/panel.js") as asset:
            page.get_by_role("button", name="Sign in", exact=True).click()
        assert asset.value.body() == Path(issued["bundle"]).read_bytes()
        page.wait_for_load_state("networkidle")
        search = page.get_by_role("searchbox", name="Search Notes")
        search.fill("HTTPSInstalledNote")
        page.get_by_role("button", name="HTTPSInstalledNote File", exact=True).click()
        expect(page.locator("#detail")).to_contain_text("Edited through the Original body CAS.")
        page.locator('#detail button[onclick^="openMarkdownItem("]').click()
        page.locator("#note-content").fill("Still writable after the actual native host exited.")
        page.locator("#note-form .form-actions button:last-child").click()
        note = base / "library/notes/HTTPSInstalledNote.md"
        until = time.monotonic() + 10
        while "Still writable after the actual native host exited." not in note.read_text() and time.monotonic() < until:
            time.sleep(0.1)
        assert "Still writable after the actual native host exited." in note.read_text()
        page.get_by_role("button", name="PKM Chat", exact=True).click()
        page.locator(f'button[data-id="{issued["chatId"]}"]').click()
        page.get_by_role("button", name="Request transcript", exact=True).click()
        page.get_by_label("Message").fill("INSTALLED_BROWSER_COMPLETE")
        page.get_by_role("button", name="Send", exact=True).click()
        expect(page.locator("#chat-turn-state")).to_contain_text("Turn completed", timeout=25000)
        page.get_by_label("Message").fill("CANCEL_INSTALLED_BROWSER")
        closed = base / "browser-provider-closed"
        waiting = base / "provider-waiting.json"
        closed.unlink(missing_ok=True)
        waiting.unlink(missing_ok=True)
        page.get_by_role("button", name="Send", exact=True).click()
        stop = page.get_by_role("button", name="Stop", exact=True)
        expect(stop).to_be_enabled()
        until = time.monotonic() + 10
        while not waiting.exists() and time.monotonic() < until:
            time.sleep(0.1)
        assert waiting.exists(), "Detached Send did not open the held provider stream"
        page.reload(wait_until="networkidle")
        expect(stop).to_be_enabled()
        stop.click()
        until = time.monotonic() + 10
        while not closed.exists() and time.monotonic() < until:
            time.sleep(0.1)
        assert closed.exists(), "Detached Stop did not close the actual provider stream"
        provision.unlink()
        assert not page.evaluate("""async () => {
            try { return (await fetch("/webview/panel.js", {cache: "no-store"})).ok; }
            catch { return false; }
        }""")
        (base / "https-detached.json").write_text(json.dumps({
            "actualNativeHostExited": True, "exactTlsBundle": True, "sameOriginalNoteReadAndCas": True,
            "sendAfterNativeExit": True, "stopAfterBrowserReload": True, "ownerRevocation": True,
        }))
    finally:
        browser.close()

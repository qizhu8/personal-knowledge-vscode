"""Exercise the shipped native HTTPS setup command inside the private installed fixture."""
import json
import socket
import subprocess
import time

from playwright.sync_api import expect


def verify_https_setup(editor, browser, base, chat_id, bundle):
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    origin = f"https://localhost:{port}"
    cert, key = base / "https-cert.pem", base / "https-key.pem"
    subprocess.run([
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
        "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost",
        "-keyout", str(key), "-out", str(cert),
    ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    key.chmod(0o600)

    def command():
        editor.keyboard.press("Control+Shift+P")
        quick = editor.locator(".quick-input-widget")
        quick.locator("input").fill(">PKM: Configure Independent HTTPS Browser Access")
        quick.locator(".monaco-list-row").filter(has_text="Configure Independent HTTPS Browser Access").first.click()

    dialog = editor.locator(".monaco-dialog-box")
    def authorize():
        command()
        editor.get_by_text("Configure independent HTTPS Chat", exact=True).click()
        quick = editor.locator(".quick-input-widget")
        for title, value in [
            ("PKM HTTPS address", origin), ("PKM HTTPS server interface", "127.0.0.1"),
            ("Select the HTTPS certificate on the PKM server", str(cert)),
            ("Select the owner-only HTTPS private key on the PKM server", str(key)),
        ]:
            expect(quick.get_by_text(title, exact=True)).to_be_visible(timeout=20000)
            quick.locator("input").fill(value)
            editor.keyboard.press("Enter")
        quick.locator(".monaco-list-row").filter(has_text=chat_id).click(timeout=30000)
        dialog.get_by_role("button", name="Authorize conversation", exact=True).click(timeout=20000)
        dialog.get_by_role("button", name="Share saved transcript", exact=True).click()
        dialog.get_by_role("button", name="Read and edit Notes", exact=True).click()
        expect(editor.get_by_text("PKM HTTPS: configured", exact=True)).to_be_visible(timeout=30000)
        request = base / "https-enrollment-request"
        request.touch()
        enrollment = base / "https-enrollment.json"
        until = time.monotonic() + 15
        while not enrollment.exists() and time.monotonic() < until:
            time.sleep(0.1)
        assert enrollment.exists(), "Native HTTPS setup did not publish its clipboard sign-in token"
        issued = json.loads(enrollment.read_text())
        request.unlink()
        enrollment.unlink()
        return issued

    issued = authorize()
    context = browser.new_context(ignore_https_errors=True)
    diagnostics = []
    try:
        page = context.new_page()
        page.on("pageerror", lambda error: diagnostics.append(str(error)))
        page.on("requestfailed", lambda request: diagnostics.append(f"{request.method} {request.url}: {request.failure}"))
        page.on("response", lambda response: diagnostics.append(
            f"{response.status} {response.url}: {response.text()[:2000]}"
        ) if response.status >= 400 or response.url.endswith("/webview/message") else None)
        assert not page.request.get(origin + "/webview/panel.js").ok
        page.goto(origin + "/webview/")
        page.wait_for_load_state("networkidle")
        page.locator("input[type=password]").evaluate("(el, token) => { el.value = token; }", issued.pop("token"))
        with page.expect_response(origin + "/webview/panel.js") as asset:
            page.get_by_role("button", name="Sign in", exact=True).click()
        assert asset.value.body() == bundle.read_bytes()
        page.wait_for_load_state("networkidle")
        expect(page.locator("#btn-add-knowledge")).to_be_enabled()
        search = page.get_by_role("searchbox", name="Search Notes")
        search.fill("InstalledGatewayNote")
        page.locator('.li[data-note-slug="InstalledGatewayNote"]').click()
        expect(page.locator("#detail")).to_contain_text("Created by genuine installed 4.0.27 PKM Chat")
        page.locator("#btn-add-knowledge").click()
        page.locator("#note-title").fill("HTTPSInstalledNote")
        page.locator("#note-content").fill("Created through the real installed HTTPS setup.")
        page.locator("#note-form .form-actions button:last-child").click()
        created = base / "library/notes/HTTPSInstalledNote.md"
        until = time.monotonic() + 10
        while not created.exists() and time.monotonic() < until:
            time.sleep(0.1)
        assert created.exists(), "Browser creation did not reach the unchanged Original library"
        search.fill("HTTPSInstalledNote")
        page.locator('.li[data-note-slug="HTTPSInstalledNote"]').click()
        page.locator('#detail button[onclick^="openMarkdownItem("]').click()
        expect(page.locator("#note-title")).to_be_disabled()
        page.locator("#note-content").fill("Edited through the Original body CAS.")
        page.locator("#note-form .form-actions button:last-child").click()
        until = time.monotonic() + 10
        while "Edited through the Original body CAS." not in created.read_text() and time.monotonic() < until:
            time.sleep(0.1)
        assert "Edited through the Original body CAS." in created.read_text()
        page.wait_for_timeout(21000)
        expect(page.locator("#pkm-host-warning")).not_to_be_visible()
        expect(page.locator("#browser-release-status")).not_to_contain_text("not available")

        page.get_by_role("button", name="PKM Chat", exact=True).click()
        page.locator(f'button[data-id="{chat_id}"]').click()
        page.get_by_role("button", name="Request transcript", exact=True).click()
        expect(page.locator("#chat-transcript")).to_contain_text("INSTALLED_GATEWAY_ACCEPTED")
        admitted = set()
        for _ in range(2):
            page.get_by_label("Message").fill("INSTALLED_BROWSER_COMPLETE")
            with page.expect_response(lambda response: response.url == origin + "/webview/message" and
                                      (response.request.post_data_json or {}).get("command") == "originalChatSend") as turn:
                page.get_by_role("button", name="Send", exact=True).click()
            assert turn.value.ok
            turn_id = turn.value.json()["turnId"]
            assert turn_id not in admitted, "A new browser message must not replay the previous attempt"
            admitted.add(turn_id)
            expect(page.locator("#chat-turn-state")).to_contain_text("Turn completed", timeout=25000)
            expect(dialog).not_to_be_visible()
        page.reload(wait_until="networkidle")
        page.get_by_role("button", name="Request transcript", exact=True).click()
        expect(page.locator("#chat-transcript")).to_contain_text("Installed browser turn completed")
        command()
        editor.get_by_text("Revoke HTTPS access", exact=True).click()
        expect(editor.get_by_text("PKM HTTPS: off", exact=True)).to_be_visible()
        assert not page.evaluate("""async () => {
            try { return (await fetch("/webview/panel.js", {cache: "no-store"})).ok; }
            catch { return false; }
        }""")
        detached = authorize()
        detached.update({"origin": origin, "chatId": chat_id, "bundle": str(bundle), "base": str(base)})
        retained = base / "https-detached-enrollment.json"
        with retained.open("x", encoding="utf8") as file:
            json.dump(detached, file)
        retained.chmod(0o600)
        return {"nativeSetup": True, "exactTlsBundle": True, "sameOriginalNotesCreateAndEdit": True,
                "multiRoundChatWithoutNativePrompts": True, "reopenedSavedReply": True, "nativeRevoke": True}
    except Exception:
        (base / "installed-https-browser.txt").write_text(page.locator("body").inner_text())
        (base / "installed-https-network.txt").write_text("\n".join(diagnostics))
        page.screenshot(path=str(base / "installed-https-browser.png"), full_page=True)
        raise
    finally:
        context.close()

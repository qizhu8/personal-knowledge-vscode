import json
import os
import sys
import time
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

fixture = json.loads(Path(sys.argv[1]).read_text())
root = Path(fixture["root"])
checkpoints = []


def receipt(name, value):
    (root / name).write_text(json.dumps(value))


def stage(name):
    deadline = time.monotonic() + 100
    while time.monotonic() < deadline:
        try:
            value = json.loads((root / "progress.json").read_text())
            assert value["stage"] != "failed", value.get("error")
            if value["stage"] == name:
                return
        except (FileNotFoundError, json.JSONDecodeError):
            pass
        time.sleep(0.05)
    raise AssertionError(f"Installed extension did not reach {name}")


with sync_playwright() as playwright:
    browser = None
    page = None
    try:
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            try:
                browser = playwright.chromium.connect_over_cdp(f"http://127.0.0.1:{fixture['port']}", timeout=1000)
                if browser.contexts and browser.contexts[0].pages:
                    page = browser.contexts[0].pages[0]
                    break
            except Exception:
                time.sleep(0.1)
        assert page is not None, "Real installed VS Code Electron CDP unavailable"
        page.set_default_timeout(30000)
        page.locator(".monaco-workbench").wait_for()
        args = Path(f"/proc/{fixture['editorPid']}/cmdline").read_bytes().decode().split("\0")
        assert f"--user-data-dir={root}/u" in args
        assert f"--extensions-dir={root}/x" in args
        namespaces = {owner: {name: os.readlink(f"/proc/{pid}/ns/{name}") for name in ["user", "net"]}
                      for owner, pid in [("ui", os.getpid()), ("editor", fixture["editorPid"])]}
        assert namespaces["ui"] == namespaces["editor"]

        for phase, key, prompt in [
                ("business-token", "business", "Token for the externally started pkm-v5 server"),
                ("shared-token", "business", "Independently provisioned shared server business token"),
                ("management-token", "management", "Independently provisioned shared server management token")]:
            stage(phase)
            widget = page.locator(".quick-input-widget")
            widget.wait_for(state="visible")
            expect(widget).to_contain_text(prompt)
            field = widget.locator("input").first
            expect(field).to_have_attribute("type", "password")
            field.fill(fixture[key])
            field.press("Enter")
            checkpoints.append({"stage": phase, "nativePasswordInput": True})

        def panel():
            deadline = time.monotonic() + 45
            while time.monotonic() < deadline:
                for candidate in page.frames:
                    try:
                        if candidate.locator("#chat-title").count():
                            assert candidate.url.startswith("vscode-webview://"), candidate.url
                            return candidate
                    except Exception:
                        pass
                page.wait_for_timeout(100)
            raise AssertionError("Installed extension's actual vscode-webview Chat was not found")

        stage("chat-open")
        frame = panel()
        chat = frame.get_by_role("region", name="Chats", exact=True)
        chat.get_by_label("New Chat title").fill("Installed Electron durable Chat")
        chat.get_by_role("button", name="New Chat", exact=True).click()
        expect(chat.get_by_role("status")).to_contain_text("Ready")
        session_id = chat.get_by_label("Saved Chat").input_value()
        assert session_id
        chat.get_by_label("Message", exact=True).fill(fixture["input"])
        chat.get_by_role("button", name="Send", exact=True).click()
        expect(chat.get_by_role("status")).to_contain_text("Turn model")
        frame.locator("#turn-status").click()
        expect(frame.locator("#turn-output")).to_be_visible()
        expect(frame.locator("#turn-output")).to_contain_text(fixture["partial"])
        checkpoints.append({"stage": "running-stream", "sessionId": session_id,
                            "status": chat.get_by_role("status").inner_text(),
                            "stream": frame.locator("#turn-output").inner_text(), "webviewUrl": frame.url})
        chat.get_by_role("button", name="Cancel active turn", exact=True).click()
        expect(frame.locator("#turn-status")).to_contain_text("Turn cancelled")
        chat.get_by_role("button", name="Refresh Chats", exact=True).click()
        expect(chat.get_by_role("log")).to_contain_text(fixture["input"])
        expect(chat.get_by_role("log")).to_contain_text("assistant · cancelled")
        transcript = chat.get_by_role("log").inner_text()
        def saved_messages():
            return chat.get_by_role("log").locator("article").evaluate_all(
                "items => items.map(item => ({label: item.querySelector('strong').textContent,"
                "content: item.querySelector('pre').textContent}))")

        articles = saved_messages()
        assert len(articles) == 2, articles
        assert articles[0] == {"label": "user · complete", "content": fixture["input"]}, articles
        assert articles[1] == {"label": "assistant · cancelled", "content": fixture["partial"]}, articles
        frame.get_by_text("Read-only turn evidence", exact=True).click()
        chat.get_by_role("button", name="Refresh evidence", exact=True).click()
        expect(frame.locator("#turn-evidence")).to_contain_text("pkm.chat.session-context/v1")
        expect(frame.locator("#turn-evidence")).to_contain_text("not-injected")
        expect(frame.locator("#turn-evidence")).to_contain_text("NOT proof")
        evidence = frame.locator("#turn-evidence").inner_text()
        checkpoints.append({"stage": "stopped-durable", "transcript": articles, "evidence": evidence})
        receipt("reopen-request.json", {"sessionId": session_id})
        stage("chat-reopened")
        frame = panel()
        chat = frame.get_by_role("region", name="Chats", exact=True)
        chat.get_by_label("Saved Chat").select_option(session_id)
        expect(frame.locator("#turn-status")).to_contain_text("Turn cancelled")
        expect(chat.get_by_role("log")).to_have_text(transcript, use_inner_text=True)
        assert saved_messages() == articles
        frame.get_by_text("Read-only turn evidence", exact=True).click()
        chat.get_by_role("button", name="Refresh evidence", exact=True).click()
        expect(frame.locator("#turn-evidence")).to_have_text(evidence)
        checkpoints.append({"stage": "closed-reopened-exact", "sessionId": session_id,
                            "transcript": articles, "evidence": evidence})
        receipt("handoff-request.json", {"sessionId": session_id})
        stage("handoff")
        dialog = page.get_by_role("dialog").filter(has_text="No uncertain write will be replayed")
        dialog.wait_for(state="visible")
        expect(dialog).to_contain_text("No uncertain write will be replayed")
        dialog.get_by_role("button", name="Approve", exact=True).click()
        stage("handoff-complete")
        chat.get_by_role("button", name="Refresh Chats", exact=True).click()
        expect(frame.locator("#turn-status")).to_contain_text("Turn cancelled")
        expect(chat.get_by_role("log")).to_have_text(transcript, use_inner_text=True)
        assert saved_messages() == articles
        chat.get_by_label("Saved Chat").select_option("")
        chat.get_by_label("Saved Chat").select_option(session_id)
        expect(chat.get_by_role("log")).to_have_text(transcript, use_inner_text=True)
        chat.get_by_role("button", name="Refresh evidence", exact=True).click()
        expect(frame.locator("#turn-evidence")).to_have_text(evidence)
        checkpoints.append({"stage": "same-panel-compatible-handoff-exact", "sessionId": session_id,
                            "webviewUrl": frame.url, "transcript": articles, "evidence": evidence})
        receipt("ui-passed.json", {"passed": True, "sessionId": session_id, "checkpoints": checkpoints,
                                  "editorArgs": args, "namespaces": namespaces,
                                  "transcript": articles, "evidence": evidence})
        stage("complete")
    except Exception as error:
        receipt("ui-failed.json", {"error": str(error), "checkpoints": checkpoints,
                                  "frames": [] if page is None else [frame.url for frame in page.frames]})
        if page is not None:
            page.screenshot(path=str(root / "failed.png"))
        raise
    finally:
        if browser is not None:
            browser.close()

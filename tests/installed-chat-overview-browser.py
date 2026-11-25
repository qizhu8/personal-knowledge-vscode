"""Additive actual-installed journey on the baseline browser's existing CDP session."""
import importlib.util
import json
import re
import sys
import time
from pathlib import Path

from playwright.sync_api import expect


def atomic_json(path, value):
    staging = path.with_suffix(path.suffix + ".next")
    staging.write_text(json.dumps(value, indent=2), encoding="utf-8")
    staging.replace(path)


def run_overview(page):
    fixture = json.loads(Path(sys.argv[1]).read_text())
    base = Path(fixture["base"]).resolve()
    deadline = time.monotonic() + 45
    while not (base / "overview-fixture.json").exists() and time.monotonic() < deadline:
        if (base / "host-failure.json").exists():
            raise AssertionError((base / "host-failure.json").read_text())
        time.sleep(0.1)
    identities = json.loads((base / "overview-fixture.json").read_text())
    a, b = identities["a"]["chatId"], identities["b"]["chatId"]
    sequence = 0
    approvals = []
    try:
        page.bring_to_front()

        def frame_with(selector, timeout=30):
            until = time.monotonic() + timeout
            while time.monotonic() < until:
                if (base / "host-failure.json").exists():
                    raise AssertionError((base / "host-failure.json").read_text())
                for frame in page.frames:
                    try:
                        if frame.locator(selector).count():
                            return frame
                    except Exception:
                        if not frame.is_detached():
                            raise
                page.wait_for_timeout(100)
            raise AssertionError(f"No actual installed overview webview containing {selector}")

        def observe(frame):
            frame.evaluate("""() => {
              if (window.__installedOverviewObserved) return;
              window.__installedOverviewObserved = [];
              window.addEventListener("message", event => {
                if (event.data?.type !== "state") return;
                const state = event.data;
                window.__installedOverviewObserved.push({
                  activeChatId:state.chat?.id, overview:state.taskOverview,
                  approvalIds:(state.approvals || []).map(item => item.id)
                });
              });
            }""")

        def select(frame, chat_id):
            if frame.locator("#library-view").is_visible():
                frame.locator(f'.chat-list-open[data-chat-id="{chat_id}"]').click()
            else:
                frame.locator("#chats").select_option(chat_id)
            expect(frame.locator("#messages")).to_have_attribute("aria-busy", "false", timeout=20000)
            expect(frame.locator("#chats")).to_have_value(chat_id, timeout=20000)

        def overview(frame):
            if frame.locator("#library-view").is_visible():
                frame.locator("#list-task-overview").click()
            else:
                frame.locator("#chat-actions-toggle").focus()
                frame.locator("#open-task-overview").click()
            expect(frame.locator("#task-overview-dialog")).to_be_visible()
            expect(frame.locator("#task-overview-empty")).to_be_hidden()
            return frame.locator("#task-overview-dialog")

        def row(frame, chat_id):
            return frame.locator(f'#task-overview-list [data-chat-id="{chat_id}"]')

        def own_scope(frame):
            expect(frame.locator("#task-overview-namespace")).to_have_text(identities["namespace"])
            expect(row(frame, identities["foreignId"])).to_have_count(0)
            expect(row(frame, identities["trashId"])).to_have_count(0)
            assert "PRIVATE_OTHER_WORKSPACE_TITLE" not in frame.locator("#task-overview-dialog").inner_text()

        def control(action):
            nonlocal sequence
            sequence += 1
            atomic_json(base / "overview-control.json", {"sequence":sequence, "action":action})
            until = time.monotonic() + 15
            while time.monotonic() < until:
                if (base / "host-failure.json").exists():
                    raise AssertionError((base / "host-failure.json").read_text())
                reply = base / "overview-control-result.json"
                if reply.exists():
                    result = json.loads(reply.read_text())
                    if result["sequence"] == sequence:
                        return result["result"]
                page.wait_for_timeout(50)
            raise AssertionError(f"Actual installed host did not acknowledge {action}")

        def allow_visible(frame, named=None):
            cards = frame.locator(".approval")
            if not cards.count() or not cards.first.is_visible():
                return False
            card = cards.first
            text = card.inner_text()
            if named and named in text:
                return False
            assert "add_note" not in text, "Overview fixture must never request a knowledge write"
            approvals.append(text[:1000])
            button = card.get_by_role("button", name=re.compile(r"^Allow once$|^Approve$")).first
            button.focus()
            button.press("Enter")
            return True

        chat = frame_with("#task-overview-dialog")
        observe(chat)
        select(chat, a)
        chat.wait_for_function("() => window.__installedOverviewObserved.some(item => item.overview)")
        dialog = overview(chat)
        own_scope(chat)
        expect(row(chat, a)).to_be_visible()
        expect(row(chat, b)).to_be_visible()
        expect(row(chat, a).locator("strong")).to_have_text("Installed overview duplicate title")
        expect(row(chat, b).locator("strong")).to_have_text("Installed overview duplicate title")
        chat.locator("#task-overview-close").click()
        chat.locator("#options").click()
        chat.locator("#history").uncheck()
        chat.locator("#options").click()
        chat.locator("#permissions").click()
        chat.locator("#permission-mode").select_option("ask")
        chat.locator("#permissions").click()
        chat.locator("#prompt").fill("OVERVIEW_APPROVAL_A: propose the isolated unsaved text edit, then read InstalledGatewayNote.")
        chat.locator("#send").focus()
        chat.locator("#send").press("Enter")
        until = time.monotonic() + 35
        while time.monotonic() < until:
            if chat.locator(".approval").filter(has_text="Apply Agent edit to overview-approval.txt?").count():
                break
            allow_visible(chat, named="Apply Agent edit to overview-approval.txt?")
            page.wait_for_timeout(100)
        approval = chat.locator(".approval").filter(has_text="Apply Agent edit to overview-approval.txt?").first
        expect(approval).to_be_visible()
        approval_id = approval.get_attribute("data-confirmation-id")
        chat.locator("#prompt").fill("Unsent draft belonging to A")
        overview(chat)
        expect(row(chat, a)).to_contain_text("Awaiting approval")
        row(chat, b).click()
        expect(chat.locator("#chats")).to_have_value(b, timeout=15000)
        chat.locator("#prompt").fill("OVERVIEW_RUNNING_B: wait for explicit fixture release.")
        chat.locator("#send").focus()
        chat.locator("#send").press("Enter")
        until = time.monotonic() + 25
        while time.monotonic() < until:
            model_file = base / "overview-model-evidence.json"
            if model_file.exists() and "OVERVIEW_RUNNING_B" in json.loads(model_file.read_text())["pending"]:
                break
            allow_visible(chat)
            page.wait_for_timeout(100)
        assert "OVERVIEW_RUNNING_B" in json.loads((base / "overview-model-evidence.json").read_text())["pending"]
        chat.locator("#prompt").fill("Unsent draft belonging to B")
        control("read-only-begin")
        for _ in range(2):
            overview(chat)
            own_scope(chat)
            expect(row(chat, a)).to_contain_text("Awaiting approval")
            expect(row(chat, b)).to_contain_text("Running")
            expect(chat.locator("#task-overview-counts")).to_contain_text("Awaiting approval: 1")
            row(chat, a).focus()
            chat.page.keyboard.press("Escape")
            expect(chat.locator("#task-overview-dialog")).to_be_hidden()
            expect(chat.locator("#chat-actions-toggle")).to_be_focused()
        readonly = control("read-only-end")
        assert readonly["readOnly"] and a in readonly["runningChatIds"] and b in readonly["runningChatIds"]
        assert approval_id in readonly["pendingApprovals"]
        overview(chat)
        row(chat, a).click()
        expect(chat.locator("#chats")).to_have_value(a, timeout=15000)
        expect(chat.locator("#prompt")).to_have_value("Unsent draft belonging to A")
        expect(chat.locator(f'[data-confirmation-id="{approval_id}"]')).to_be_visible()
        overview(chat)
        row(chat, b).click()
        expect(chat.locator("#prompt")).to_have_value("Unsent draft belonging to B")
        control("release-running")
        expect(chat.locator("#messages")).to_contain_text("OVERVIEW_B_COMPLETED", timeout=25000)
        overview(chat)
        expect(row(chat, b)).to_contain_text("Completed")
        expect(row(chat, a)).to_contain_text("Awaiting approval")
        row(chat, a).click()
        approval = chat.locator(f'[data-confirmation-id="{approval_id}"]')
        approvals.append(approval.inner_text()[:1000])
        approve = approval.get_by_role("button", name="Allow once", exact=True)
        approve.focus()
        expect(approve).to_be_focused()
        approve.press("Enter")
        expect(chat.locator("#messages")).to_contain_text("OVERVIEW_A_COMPLETED", timeout=30000)
        overview(chat)
        expect(row(chat, a)).to_contain_text("Completed")
        chat.locator("#task-overview-close").click()
        chat.locator("#prompt").fill("OVERVIEW_FAIL: produce the fixture's explicit authentication failure.")
        chat.locator("#send").focus()
        chat.locator("#send").press("Enter")
        until = time.monotonic() + 25
        while time.monotonic() < until:
            if chat.locator("#messages").get_by_text(re.compile(r"Model API returned HTTP 401\.")).count():
                break
            allow_visible(chat)
            page.wait_for_timeout(100)
        expect(chat.locator("#messages")).to_contain_text(
            "Model API returned HTTP 401. Check the endpoint, model and credentials.", timeout=1000)
        overview(chat)
        expect(row(chat, a)).to_contain_text("Failed")
        chat.locator("#task-overview-close").click()
        select(chat, identities["foreignId"])
        overview(chat)
        expect(chat.locator("#task-overview-namespace")).to_have_text(identities["foreignNamespace"])
        expect(row(chat, a)).to_have_count(0)
        expect(row(chat, b)).to_have_count(0)
        expect(row(chat, identities["foreignId"])).to_be_visible()
        chat.locator("#task-overview-close").click()
        select(chat, a)
        chat.locator("#prompt").fill("Persisted unsent draft after installed view reload")
        chat.locator("#back").click()
        chat.locator(f'.chat-list-open[data-chat-id="{b}"]').click(button="right")
        chat.get_by_role("menuitem", name="Move to Trash", exact=True).click()
        confirmation = page.locator(".monaco-dialog-box")
        expect(confirmation).to_contain_text("Move Chat to Trash? Task Session evidence is preserved.")
        confirmation.get_by_role("button", name="Move to Trash", exact=True).click()
        expect(confirmation).to_be_hidden()
        overview(chat)
        expect(row(chat, b)).to_have_count(0)
        own_scope(chat)
        chat.locator("#task-overview-close").click()
        expect(chat.locator("#list-task-overview")).to_be_focused()
        page.keyboard.press("Control+Shift+P")
        command = page.locator(".quick-input-widget input").first
        expect(command).to_be_visible()
        expect(command).to_have_value(">")
        command.fill(">Developer: Reload Webviews")
        expect(page.locator(".quick-input-list")).to_contain_text("Reload Webviews")
        command.press("Enter")
        expect(command).to_be_hidden()
        chat = frame_with("#list-task-overview")
        observe(chat)
        select(chat, a)
        expect(chat.locator("#prompt")).to_have_value("Persisted unsent draft after installed view reload")
        dialog = overview(chat)
        own_scope(chat)
        expect(row(chat, b)).to_have_count(0)
        expect(row(chat, a)).to_contain_text("Failed")
        assert dialog.evaluate("(node) => node.scrollWidth <= node.clientWidth + 1")
        observed = chat.evaluate("() => window.__installedOverviewObserved")
        assert any(item.get("overview", {}).get("entries") for item in observed)
        page.screenshot(path=str(base / "installed-chat-overview-accepted.png"), full_page=True)
        result = {"realInstalledIpc":True, "pendingApprovalPreserved":True, "draftsPreserved":True,
                  "namespaceScoped":True, "trashExcluded":True, "reloadVerified":True, "realFailure":True,
                  "a":a, "b":b, "pendingApprovalId":approval_id, "readonly":readonly,
                  "explicitApprovals":approvals, "reloadSnapshots":observed}
        atomic_json(base / "overview-browser-done.json", result)
        print("ACTUAL_INSTALLED_CHAT_OVERVIEW_ACCEPTED: real IPC, concurrent approval/running, read-only window, drafts, scope, Trash and reload", flush=True)
    except Exception:
        page.screenshot(path=str(base / "installed-chat-overview-blocker.png"), full_page=True)
        frames = []
        for frame in page.frames:
            details = {"url": frame.url, "name": frame.name}
            try:
                details["document"] = frame.evaluate("""() => ({
                  title:document.title,
                  ids:[...document.querySelectorAll("[id]")].map(node => node.id),
                  scripts:[...document.scripts].map(script => script.src)
                })""")
            except Exception as error:
                details["error"] = str(error)
            frames.append(details)
        atomic_json(base / "overview-blocked-frames.json", frames)
        raise


if __name__ == "__main__":
    baseline_path = Path(__file__).with_name("installed-compatibility-chat.py")
    spec = importlib.util.spec_from_file_location("installed_chat_baseline", baseline_path)
    baseline = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(baseline)
    baseline.main(after=run_overview)

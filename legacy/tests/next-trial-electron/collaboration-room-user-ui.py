"""Actual renderer actions only; the installed observation driver reads product outcomes."""
import argparse
import importlib.metadata
import json
import pathlib
import re
import sys
import time
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright


def reveal_product_panel(page):
    panel = page.locator(".tabs-container .tab").filter(
        has_text=re.compile(r"^(Personal Knowledge Manager|Threads|Projects|Notes|Portal Connections)$"))
    if panel.count() == 1 and panel.is_visible():
        panel.click()
        return True
    return False


def navigate_product_tab(frame, tab, set_phase):
    navigation = frame.locator(f'.tab[data-tab="{tab}"]')
    if navigation.count() != 1:
        raise ValueError("Exactly one actual product navigation tab is required.")
    if not navigation.is_visible():
        set_phase(f"panel-workspace-reveal-{tab}")
        group = navigation.locator("xpath=ancestor::*[@data-workspace-group][1]")
        workspace = group.get_attribute("data-workspace-group")
        if not workspace or not re.fullmatch(r"[a-zA-Z][a-zA-Z0-9_-]*", workspace):
            raise ValueError("A hidden tab must belong to an actual product workspace.")
        button = frame.locator(f'#workspace-rail .workspace-button[data-workspace="{workspace}"]')
        if button.count() != 1 or not button.is_visible():
            raise ValueError("Exactly one visible product workspace button is required.")
        button.click()
        navigation.wait_for(state="visible")
    if "active" not in (navigation.get_attribute("class") or "").split():
        set_phase(f"panel-navigation-{tab}")
        navigation.click()


def focus_workbench_editor(page):
    editor = page.locator('[id="workbench.parts.editor"] .monaco-editor:visible')
    editor.wait_for(state="visible")
    if editor.count() != 1:
        raise ValueError("Exactly one visible Workbench text editor is required.")
    box = editor.bounding_box()
    if not box or box["width"] <= 0 or box["height"] <= 0:
        raise ValueError("The rendered editor viewport is required.")
    page.mouse.click(box["x"] + min(80, box["width"] / 2), box["y"] + min(12, box["height"] / 2))
    page.keyboard.press("Control+1")
    page.wait_for_function(
        "(editor) => editor.contains(document.activeElement)",
        arg=editor.element_handle(),
    )


def operate_workbench_file_dialog(page, fixture, label, value):
    if not pathlib.Path(value).resolve().is_relative_to(fixture):
        raise ValueError("Open/Save dialogs may select only this private fixture.")
    quick = page.locator(".quick-input-widget:visible")
    if quick.count() != 1:
        raise ValueError("Exactly one visible Workbench file dialog is required.")
    button = quick.get_by_role("button", name=label, exact=True)
    if button.count() == 0 and label == "Save shared file":
        button = quick.get_by_role("button", name="OK", exact=True)
    if button.count() != 1:
        raise ValueError("Exactly one observed Workbench file confirmation button is required.")
    button.wait_for(state="visible")
    textbox = quick.locator("input").first
    textbox.fill(value)
    textbox.press("Enter")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture", required=True)
    parser.add_argument("--host-cdp", required=True)
    parser.add_argument("--guest-cdp", required=True)
    args = parser.parse_args()
    driver_version = importlib.metadata.version("playwright")
    required_version = (pathlib.Path(__file__).parent / "requirements-collaboration-room-ui.txt").read_text().strip().split("==")[1]
    if driver_version != required_version:
        raise ValueError(f"Private Room UI requires Playwright {required_version}; found {driver_version}.")
    project = pathlib.Path(__file__).resolve().parents[2]
    fixture = pathlib.Path(args.fixture).resolve()
    if not fixture.is_relative_to(project / ".migration-test-work") or not fixture.is_dir():
        raise ValueError("Only an existing private project fixture is allowed.")
    endpoints = {"host": args.host_cdp, "guest": args.guest_cdp}
    for endpoint in endpoints.values():
        url = urlsplit(endpoint)
        if url.scheme != "http" or url.hostname not in ("127.0.0.1", "localhost") or not url.port:
            raise ValueError("CDP must be explicitly selected private loopback.")
    with sync_playwright() as playwright:
        browsers = {}
        try:
            for line in sys.stdin:
                phase = "connect"
                def set_phase(value):
                    nonlocal phase
                    phase = value
                project_error = None
                action = json.loads(line)
                role, operation = action["role"], action["operation"]
                if role not in endpoints:
                    raise ValueError("Unknown private profile.")
                try:
                    if operation == "disconnect":
                        if role in browsers:
                            browsers.pop(role).close()
                        print(json.dumps({"id": action["id"], "role": role, "operation": operation,
                                          "clicked": False, "observed": True}), flush=True)
                        continue
                    if role not in browsers:
                        browsers[role] = playwright.chromium.connect_over_cdp(endpoints[role], timeout=45000)
                    browser = browsers[role]
                    frames = []
                    main_page = None
                    for context in browser.contexts:
                        for page in context.pages:
                            if "workbench" in page.url:
                                main_page = page
                                if not operation.startswith("workbench-") and operation != "discover":
                                    phase = "panel-reveal"
                                    reveal_product_panel(page)
                            for frame in page.frames:
                                if frame.locator("#detail").count():
                                    frames.append(frame)
                    if operation == "discover":
                        print(json.dumps({"id": action["id"], "role": role, "operation": operation,
                                          "observed": True, "clicked": False, "panelCount": len(frames),
                                          "workbenchFound": main_page is not None}), flush=True)
                        continue
                    if not operation.startswith("workbench-") and len(frames) != 1 and main_page is not None:
                        main_page.keyboard.press("Control+Shift+p")
                        quick = main_page.locator(".quick-input-widget")
                        quick.locator("input").first.fill("Personal Knowledge Manager: Open Panel")
                        quick.locator(".monaco-list-row").filter(
                            has_text="Personal Knowledge Manager: Open Panel").first.click()
                        end = time.monotonic() + 30
                        while time.monotonic() < end:
                            frames = [candidate for context in browser.contexts for page in context.pages
                                      for candidate in page.frames
                                      if candidate.locator("#detail").count()]
                            if len(frames) == 1:
                                break
                            main_page.wait_for_timeout(100)
                    if len(frames) != 1 and not operation.startswith("workbench-"):
                        raise ValueError("Exactly one actual product panel is required.")
                    frame = frames[0] if len(frames) == 1 else None
                    if frame is not None and not operation.startswith("workbench-"):
                        phase = "panel-networkidle"
                        frame.wait_for_load_state("networkidle")
                    if not operation.startswith("workbench-") and operation not in ("modal", "tab", "note-open-content-editor"):
                        tab = "projects" if operation.startswith("project-") else "chatroom"
                        navigate_product_tab(frame, tab, set_phase)
                    if operation == "tab":
                        if action["tab"] not in ("chatroom", "projects", "portalConnections"):
                            raise ValueError("Unknown actual product tab.")
                        navigate_product_tab(frame, action["tab"], set_phase)
                    elif operation == "workbench-edit-save":
                        phase = "workbench-editor-focus"
                        focus_workbench_editor(main_page)
                        phase = "workbench-editor-replace"
                        main_page.keyboard.press("Control+A")
                        main_page.keyboard.insert_text(action["value"])
                        phase = "workbench-editor-save"
                        main_page.keyboard.press("Control+s")
                    elif operation == "workbench-editor-layout":
                        phase = "workbench-editor-layout"
                        focus_workbench_editor(main_page)
                        main_page.keyboard.press("Control+End")
                        if action.get("switchTabs"):
                            main_page.keyboard.press("Control+PageUp")
                            main_page.keyboard.press("Control+PageDown")
                    elif operation == "note-open-content-editor":
                        phase = "note-open-content-editor"
                        frame.locator("#detail").get_by_role("button", name="Edit Content", exact=True).click()
                    elif operation == "workbench-pick":
                        main_page.locator(".quick-input-widget .monaco-list-row").filter(
                            has_text=action["choice"]).first.click()
                    elif operation == "workbench-notification":
                        main_page.locator(".notifications-list-container").get_by_text(
                            action["text"], exact=False).wait_for(state="visible")
                    elif operation in ("workbench-input", "workbench-file"):
                        phase = operation
                        if operation == "workbench-file":
                            operate_workbench_file_dialog(main_page, fixture, action["title"], action["value"])
                        else:
                            quick = main_page.locator(".quick-input-widget")
                            quick.filter(has_text=action["title"]).wait_for(state="visible")
                            textbox = quick.locator("input").first
                            textbox.fill(action["value"])
                            textbox.press("Enter")
                    elif operation == "workbench-choice":
                        main_page.locator(".monaco-dialog-box").filter(has_text=action["title"]).get_by_role(
                            "button", name=action["choice"], exact=True).click()
                    elif operation == "host":
                        if not frame.locator("#chat-host-form").is_visible():
                            frame.locator("#chat-host-toggle").click()
                        for selector, key in (("#chat-hub-room", "room"), ("#chat-hub-name", "name"), ("#chat-hub-port", "port")):
                            if frame.locator(selector).is_visible():
                                frame.locator(selector).fill(str(action[key]))
                        frame.locator("#chat-hub-key").fill(action.get("secret", ""))
                        frame.locator("#chat-host-form").get_by_role("button", name="Host Room", exact=True).click()
                    elif operation in ("join", "join-wrong-secret"):
                        phase = "join-open-form"
                        if not frame.locator("#chat-join").is_visible():
                            frame.locator('button[onclick="chatToggleJoin()"]').click()
                        for selector, key in (("#chat-url", "url"), ("#chat-room", "room"), ("#chat-name", "name"), ("#chat-secret-in", "secret")):
                            phase = f"join-fill-{key}"
                            frame.locator(selector).fill(action[key])
                        phase = "join-submit"
                        frame.locator("#chat-join").get_by_role("button", name="Join", exact=True).click()
                        if operation == "join-wrong-secret":
                            frame.get_by_text("Wrong secret for room", exact=False).wait_for(state="visible")
                    elif operation == "leave":
                        frame.locator("#chat-leave-btn").click()
                    elif operation == "stop-hub":
                        frame.locator("#chat-stophub-btn").click()
                    elif operation == "send":
                        if "mode" in action:
                            if action["mode"] not in ("announce", "ask", "discuss"):
                                raise ValueError("Unknown actual message mode.")
                            frame.locator(f'#chat-mode-control button[data-mode="{action["mode"]}"]').click()
                        frame.locator("#chat-input").fill(action["text"])
                        frame.locator("#chat-send-btn").click()
                    elif operation == "room-action":
                        phase = "room-card"
                        section = "#chat-hosted-rooms" if action["section"] == "hosted" else "#chat-joined-rooms"
                        divider = frame.locator(section + " .chat-room-card-divider")
                        if action["label"] == "Rehost" and divider.count() and divider.get_attribute("aria-expanded") != "true":
                            divider.click()
                        card = frame.locator(section + " .chat-room-card").filter(
                            has=frame.get_by_text(action["room"], exact=True))
                        card.wait_for(state="visible")
                        if card.count() != 1:
                            raise ValueError("Ambiguous actual Room card.")
                        if action["label"] == "Rehost":
                            phase = "room-rehost"
                            card.locator(".chat-inactive-resume").click()
                        else:
                            button = card.get_by_role("button", name=action["label"], exact=True)
                            if not button.is_visible():
                                phase = "room-actions-expand"
                                card.get_by_role("button", name="Show Room actions", exact=True).click()
                            phase = "room-action-click"
                            button.click()
                    elif operation == "moderate":
                        member = frame.locator('[data-participant-id]').filter(
                            has=frame.get_by_text(action["name"], exact=True))
                        member.get_by_title(action["title"], exact=True).click()
                    elif operation == "assert-no-moderation":
                        frame.locator("#chat-active").wait_for(state="visible")
                        if "connected" not in (frame.locator("#chat-status-dot").get_attribute("class") or "").split():
                            raise ValueError("Guest permission assertions require a real connected Room.")
                        if frame.locator("#chat-leave-btn").inner_text().strip() != "Leave Room":
                            raise ValueError("Guest permission assertions cannot run against the Host view.")
                        if frame.locator("#chat-members .chat-member[data-participant-id] .chat-mod").count():
                            raise ValueError("Guest must not receive Host moderation controls.")
                    elif operation == "assert-no-room-action":
                        if frame.get_by_role("button", name=action["label"], exact=True).count():
                            raise ValueError("An unauthorized Room action was exposed.")
                    elif operation == "project-create":
                        frame.locator('button[onclick^="projectNew("]').first.click()
                    elif operation == "project-open":
                        frame.locator(".project-tree-item").filter(
                            has=frame.get_by_text(action["name"], exact=True)).click()
                    elif operation == "project-thread-create":
                        frame.get_by_role("button", name="Threads", exact=True).click()
                        frame.locator('button[onclick="projectNewThread()"]').click()
                    elif operation == "project-thread-open":
                        row = frame.locator(".project-thread-row").filter(
                            has=frame.get_by_text(action["name"], exact=True))
                        row.get_by_role("button", name="Open chatroom", exact=True).click()
                        frame.locator("#project-action-error, .tab.active[data-tab='chatroom']").first.wait_for(state="visible")
                        rejection = frame.locator("#project-action-error")
                        if rejection.is_visible():
                            project_error = rejection.locator(".project-action-error-message").inner_text()
                            main_page.screenshot(path=str(fixture / f"actual-project-rejection-{action['id']}.png"))
                    elif operation == "modal":
                        phase = "modal-input"
                        dialog = frame.locator("#pk-modal")
                        dialog.locator(".pk-modal-title").get_by_text(action["title"], exact=True).wait_for(state="visible")
                        if "value" in action:
                            dialog.locator("input").fill(action["value"])
                        phase = "modal-confirm"
                        dialog.get_by_role("button", name=action["choice"], exact=True).click()
                    elif operation == "meeting-summary":
                        frame.locator("#chat-meeting-summary-btn").click()
                    elif operation == "meeting-select":
                        frame.locator(".chat-meeting-list-item").filter(
                            has=frame.get_by_text(action["title"], exact=True)).click()
                    elif operation in ("meeting-adjourn", "meeting-open-note"):
                        label = "Adjourn" if operation == "meeting-adjourn" else "Open detailed Note"
                        frame.locator("#chat-meeting-document").get_by_role("button", name=label, exact=True).click()
                    elif operation == "meeting-trash":
                        frame.locator(".chat-meeting-list-item").filter(
                            has=frame.get_by_text(action["title"], exact=True)).click(button="right")
                        frame.get_by_text("Move to Trash…", exact=True).click()
                    elif operation in ("meeting-restore", "meeting-delete"):
                        trash = frame.locator("#chat-meeting-trash")
                        if trash.get_attribute("open") is None:
                            trash.locator("summary").click()
                        row = trash.locator(".chat-meeting-trash-item").filter(
                            has=frame.get_by_text(action["title"], exact=True))
                        label = "Restore Meeting" if operation == "meeting-restore" else "Delete permanently"
                        row.get_by_role("button", name=label, exact=True).click()
                    elif operation == "share-file":
                        frame.get_by_role("button", name="Share File", exact=True).click()
                    elif operation == "recover-saved-file":
                        frame.locator("#chat-recover-saved-file").click()
                    elif operation == "save-file":
                        frame.locator(".chat-file").filter(
                            has=frame.get_by_text(action["name"], exact=True)).get_by_role(
                                "button", name="Save…", exact=True).click()
                    elif operation == "export-history":
                        frame.get_by_role("button", name="Chat History", exact=True).click()
                    else:
                        raise ValueError("Unsupported renderer action.")
                    result = {"id": action["id"], "role": role, "operation": operation,
                              "playwrightVersion": driver_version,
                              "clicked": not operation.startswith("assert-"), "observed": True}
                    if project_error is not None:
                        result["projectError"] = project_error
                except Exception as error:
                    if "main_page" in locals() and main_page is not None:
                        diagnostic = {"id": action["id"], "role": role, "operation": operation,
                                      "errorType": type(error).__name__,
                                      "phase": phase,
                                      "panelsFound": len(frames),
                                      "tabs": main_page.locator(".tabs-container .tab").all_text_contents(),
                                      "pages": [{"url": page.url.split("?")[0],
                                                 "frames": [{"url": candidate.url.split("?")[0],
                                                             "detail": candidate.locator("#detail").count(),
                                                             "tabs": candidate.locator(".tab").count()}
                                                            for candidate in page.frames]}
                                                for context in browser.contexts for page in context.pages]}
                        if operation == "room-action":
                            diagnostic["roomCards"] = [{
                                "name": candidate.locator('strong[slot="title"]').inner_text(),
                                "expanded": candidate.get_attribute("expanded") is not None,
                                "buttons": [{"label": button.get_attribute("aria-label"),
                                             "text": button.inner_text()}
                                            for button in candidate.get_by_role("button").all()]
                            } for candidate in frame.locator(".chat-room-card").all()]
                        if operation == "workbench-edit-save":
                            diagnostic["editors"] = main_page.locator(
                                '[id="workbench.parts.editor"] .monaco-editor'
                            ).evaluate_all("""editors => editors.map(editor => ({
                                visible: !!editor.getClientRects().length,
                                focused: editor.contains(document.activeElement),
                                className: editor.className,
                                inputs: [...editor.querySelectorAll(
                                    'textarea,input,[contenteditable],.native-edit-context'
                                )].map(input => ({
                                    tag: input.tagName, className: input.className,
                                    role: input.getAttribute('role'),
                                    label: input.getAttribute('aria-label'),
                                    contenteditable: input.getAttribute('contenteditable')
                                }))
                            }))""")
                        targets = browser.new_browser_cdp_session().send("Target.getTargets")["targetInfos"]
                        diagnostic["targetTypes"] = [{"type": target["type"], "url": target["url"].split("?")[0]}
                                                     for target in targets]
                        (fixture / f"actual-ui-error-{action['id']}.json").write_text(json.dumps(diagnostic))
                        main_page.screenshot(path=str(fixture / f"actual-ui-error-{action['id']}.png"))
                    result = {"id": action["id"], "role": role, "operation": operation,
                              "clicked": False, "errorType": type(error).__name__, "phase": phase}
                print(json.dumps(result), flush=True)
        finally:
            for browser in browsers.values():
                browser.close()


if __name__ == "__main__":
    main()

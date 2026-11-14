"""Drive the installed VS Code renderer; never inject backend state or assistant output."""
import argparse
import json
import os
import re
import subprocess
import time
import uuid
import urllib.request
from pathlib import Path

from playwright.sync_api import Error as PlaywrightError, expect, sync_playwright


def chat_frame(page):
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        for frame in page.frames:
            try:
                if not frame.is_detached() and frame.locator("#composer").count():
                    return frame
            except PlaywrightError:
                if not frame.is_detached():
                    raise
        page.wait_for_timeout(150)
    raise AssertionError(f"Original Chat webview did not appear: {[(frame.name, frame.url) for frame in page.frames]}")


def dismiss_welcome(page):
    onboarding = page.get_by_role("dialog", name="Welcome to Visual Studio Code", exact=True)
    if onboarding.is_visible():
        print("Dismissing the actual private-profile VS Code welcome dialog without signing in", flush=True)
        page.keyboard.press("Escape")
        expect(onboarding).not_to_be_visible(timeout=5000)


def open_chat(page):
    print("Inspecting actual renderer", page.url, flush=True)
    page.add_locator_handler(
        page.get_by_role("dialog", name="Welcome to Visual Studio Code", exact=True),
        lambda: page.keyboard.press("Escape"),
    )
    page.wait_for_load_state("networkidle", timeout=45000)
    page.bring_to_front()
    dismiss_welcome(page)
    page.get_by_role("button", name="Open Quick Access", exact=True).click(timeout=30000)
    command = page.locator(".quick-input-widget input")
    expect(command).to_be_visible(timeout=15000)
    command.fill(">Personal Knowledge Manager: Open API Chat")
    page.wait_for_timeout(600)
    command.press("Enter")
    frame = chat_frame(page)
    expect(frame.locator("#chats option")).not_to_have_count(0, timeout=30000)
    return frame


def choose(frame, chat_id):
    frame.page.bring_to_front()
    if not frame.locator("#chats").is_visible():
        frame.locator(f'.chat-list-open[data-chat-id="{chat_id}"]').click(timeout=15000)
    frame.locator("#chats").select_option(chat_id)
    expect(frame.locator("#chats")).to_have_value(chat_id)
    expect(frame.locator("#messages")).to_have_attribute("aria-busy", "false", timeout=30000)


def durable_answer(frame, text):
    frame.page.bring_to_front()
    message = frame.locator("#messages [data-message-id]").filter(has_text=text)
    expect(message).to_have_count(1, timeout=45000)
    expect(message).to_be_visible()
    assert message.get_attribute("data-message-id")


def send(frame, text, keyboard=False):
    print("Actual UI input beginning", time.time(), text, flush=True)
    frame.page.bring_to_front()
    print("Actual UI input foreground", time.time(), text, flush=True)
    frame.locator("#prompt").fill(text)
    print("Actual UI input filled", time.time(), text, flush=True)
    expect(frame.locator("#send")).to_be_enabled(timeout=15000)
    print("Actual UI input enabled", time.time(), text, flush=True)
    if keyboard:
        frame.locator("#prompt").press("Enter")
    else:
        frame.locator("#send").click()
    print("Actual UI input", "Enter" if keyboard else "clicked", time.time(), text, flush=True)
    # The original composer posts on the next animation frame; do not background
    # this real window before its user-input event has actually been dispatched.
    frame.evaluate("() => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)))")
    print("Actual UI input dispatched", time.time(), text, flush=True)


def assert_original(frame, descriptor):
    choose(frame, descriptor["inline"])
    image = frame.locator('#messages img[alt="synthetic-pixel.png"]')
    expect(image).to_have_count(1, timeout=15000)
    assert image.get_attribute("src") == descriptor["imageUrl"]
    assert image.evaluate("(image) => image.complete && image.naturalWidth === 1 && image.naturalHeight === 1")
    choose(frame, descriptor["segmented"])
    durable_answer(frame, "Historical ordinary API response.")
    older = frame.locator("#messages .history-load")
    if older.count():
        older.click()
    expect(frame.locator("#messages")).to_contain_text("Synthetic API history.", timeout=15000)


def legacy_worker_probe(page, frame, descriptor):
    choose(frame, descriptor["workerManager"])
    frame.locator("#chat-actions-toggle").click()
    frame.locator("#task").click()
    field = page.locator(".quick-input-widget input")
    expect(field).to_be_visible(timeout=15000)
    field.fill("Synthetic original worker task")
    field.press("Enter")
    expect(frame.locator("#harness-summary")).to_be_visible(timeout=15000)
    send(frame, "LEGACY_CHAT_CONTINUITY_MANAGER: Record this Task goal, read continuity-input.txt, "
         "then spawn one read-only worker to independently read the same file. Do not write or retry.", keyboard=True)
    durable_answer(frame, "LEGACY_CHAT_CONTINUITY_MANAGER_RESULT sha256:" + descriptor["workerInputSha256"])
    expect(frame.locator("#messages")).to_have_attribute("aria-busy", "false", timeout=45000)
    frame.locator("#back").click()
    frame.locator("#group-new").click()
    expect(field).to_be_visible(timeout=15000)
    field.fill("Synthetic continued tasks")
    field.press("Enter")
    group = frame.locator(".chat-list-group").filter(
        has=frame.locator(".chat-list-group-name", has_text="Synthetic continued tasks"))
    expect(group).to_have_count(1, timeout=15000)
    group_id = group.get_attribute("data-group-id")
    assert re.fullmatch(r"chat_group_[a-f0-9]{32}", group_id or "")
    group = frame.locator(f'.chat-list-group[data-group-id="{group_id}"]')
    node = frame.locator(f'.chat-list-node[data-node-chat-id="{descriptor["workerManager"]}"]')
    node.get_by_role("button", name="Chat actions", exact=True).click()
    frame.get_by_role("menuitem", name="Move to group...", exact=True).click()
    expect(field).to_be_visible(timeout=15000)
    field.fill("Synthetic continued tasks")
    page.locator(".quick-input-widget .monaco-list-row").filter(has_text="Synthetic continued tasks").click()
    expect(group.locator(f'[data-node-chat-id="{descriptor["workerManager"]}"]')).to_have_count(1, timeout=15000)
    group.get_by_role("button", name="Group actions", exact=True).click()
    frame.get_by_role("menuitem", name="Rename group", exact=True).click()
    expect(field).to_be_visible(timeout=15000)
    field.fill("Synthetic preserved task library")
    field.press("Enter")
    expect(group.locator(".chat-list-group-name")).to_have_text("Synthetic preserved task library", timeout=15000)
    choose(frame, descriptor["workerManager"])
    frame.locator("#open-harness").click()
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        for candidate in page.frames:
            if candidate.locator(".pkm-harness").count():
                candidate.get_by_role("combobox", name="Attempt records", exact=True).select_option(index=0)
                candidate.get_by_role("button", name="Full execution graph", exact=True).click()
                candidate.get_by_role("button", name=re.compile(
                    r"^Open subgraph: LEGACY_CHAT_CONTINUITY_MANAGER:")).click()
                candidate.get_by_role("button", name="Open subgraph: Attempt 1", exact=True).click()
                candidate.get_by_role("button", name=re.compile(r"^Open subgraph: \d+ recorded calls$")).click()
                candidate.get_by_role("button", name="Read continuity-input.txt, lines 1-1", exact=True).click()
                expect(candidate.locator("body")).to_contain_text("read_file", timeout=15000)
                print("PASS actual old UI managed Task/Harness contains real read_file execution.", flush=True)
                return
        page.wait_for_timeout(150)
    raise AssertionError("The actual old managed Task Harness view did not appear.")


def native_managed_chat(page, frame, descriptor, stage):
    expect(frame.locator("#native-chat-experiment")).to_be_visible(timeout=15000)
    choose(frame, descriptor["workerManager"])
    original = "LEGACY_CHAT_CONTINUITY_MANAGER_RESULT sha256:" + descriptor["workerInputSha256"]
    for _ in range(20):
        if frame.locator("#messages [data-message-id]").filter(has_text=original).count():
            break
        older = frame.locator("#messages .history-load")
        if not older.count():
            break
        count = frame.locator("#messages [data-message-id]").count()
        frame.locator("#messages").hover()
        page.mouse.wheel(0, -10000)
        expect(frame.locator("#messages [data-message-id]")).not_to_have_count(count, timeout=15000)
    durable_answer(frame, original)
    expect(frame.locator("#harness-summary")).to_be_visible(timeout=15000)
    if stage.startswith("native-workflow-"):
        from native_chat_workflow_ui import run
        run(page, frame, descriptor, stage, send, durable_answer)
        return
    if stage == "native-managed-unknown":
        send(frame, "NATIVE_MANAGED_UNKNOWN: Read native-input.txt, then delegate one worker to read native-crash.txt once; never retry an unacknowledged effect.", keyboard=True)
        expect(frame.locator("#messages")).to_contain_text("NATIVE_MANAGED_UNKNOWN", timeout=15000)
        return
    if stage == "native-managed-reopen":
        durable_answer(frame, "NATIVE_MANAGED_PARENT sha256:" + descriptor["nativeManagedSha256"])
        expect(frame.locator("#messages")).to_contain_text("NATIVE_MANAGED_UNKNOWN", timeout=15000)
        expect(frame.locator("#send")).to_be_disabled(timeout=15000)
        if descriptor.get("nativeChatWorkflows"):
            from native_chat_workflow_ui import run
            run(page, frame, descriptor, "native-workflow-review", send, durable_answer)
        print("PASS actual installed Task restart preserves original/native history and blocks unknown effect resend.", flush=True)
        return
    send(frame, "NATIVE_MANAGED_CONTINUE: Continue this original Task. Read native-input.txt, "
         "then dispatch one independent read-only child. Never write or retry.", keyboard=True)
    durable_answer(frame, "NATIVE_MANAGED_PARENT sha256:" + descriptor["nativeManagedSha256"])
    expect(frame.locator("#messages")).to_have_attribute("aria-busy", "false", timeout=45000)
    frame.locator("#back").click()
    group = frame.locator(".chat-list-group").filter(
        has=frame.locator(".chat-list-group-name", has_text="Synthetic preserved task library"))
    expect(group).to_have_count(1, timeout=15000)
    group.get_by_role("button", name="Group actions", exact=True).click()
    frame.get_by_role("menuitem", name="Rename group", exact=True).click()
    field = page.locator(".quick-input-widget input")
    expect(field).to_be_visible(timeout=15000)
    field.fill("Native preserved task library")
    field.press("Enter")
    expect(frame.locator(".chat-list-group-name", has_text="Native preserved task library")).to_have_count(1, timeout=15000)
    choose(frame, descriptor["workerManager"])
    frame.locator("#open-harness").click()
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        for candidate in page.frames:
            if candidate.locator(".pkm-harness").count():
                candidate.get_by_role("button", name="Current execution", exact=True).click()
                candidate.get_by_role("button", name=re.compile(r"^Open subgraph: 2 recorded calls$")).click()
                candidate.get_by_role("button", name=re.compile(r"^(?:Open subgraph: )?Read native-input\.txt")).first.click()
                expect(candidate.locator("body")).to_contain_text(descriptor["nativeManagedFileContent"], timeout=15000)
                print("PASS actual installed original Task, native parent/child tools, original Library rename and actual read_file Harness inspector.", flush=True)
                page.keyboard.press("Control+w")
                continued = chat_frame(page)
                choose(continued, descriptor["workerManager"])
                if descriptor.get("nativeTaskControls"):
                    native_task_controls(page, continued, descriptor)
                    return
                send(continued, "NATIVE_MANAGED_UNKNOWN: Read native-input.txt, then delegate one worker to read native-crash.txt once; never retry an unacknowledged effect.", keyboard=True)
                expect(continued.locator("#messages")).to_contain_text("NATIVE_MANAGED_UNKNOWN", timeout=15000)
                return
        page.wait_for_timeout(150)
    raise AssertionError("The native-managed original Harness renderer did not appear.")


def native_task_controls(page, frame, descriptor):
    fixture = Path(descriptor["root"]).parent
    grant_path = fixture / "u/User/globalStorage/uone.personal-knowledge/next-chat-ui-experiment.json"

    def rpc(method, **arguments):
        grant = json.loads(grant_path.read_text())
        assert Path(grant["fixture"]) == fixture and grant["root"] == descriptor["root"]
        request = urllib.request.Request(grant["endpoint"] + "/rpc",
            data=json.dumps({"method": method, **arguments}).encode(), method="POST",
            headers={"Authorization": "Bearer " + grant["bearer"], "X-Pkm-Native-Actor": grant["actorId"],
                     "Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=15) as response:
            return json.load(response)["value"]

    identity = {"namespace": descriptor["namespace"], "chatId": descriptor["workerManager"]}

    def history():
        return rpc("history", **identity)

    def complete():
        if not frame.locator("#task").is_visible():
            frame.locator("#chat-actions-toggle").click()
        frame.locator("#task").click()
        page.get_by_role("button", name="Complete Task", exact=True).click(timeout=15000)
        expect(frame.locator("#harness-summary")).not_to_be_visible(timeout=15000)

    def create(title):
        if not frame.locator("#task").is_visible():
            frame.locator("#chat-actions-toggle").click()
        frame.locator("#task").click()
        field = page.locator(".quick-input-widget input")
        expect(field).to_be_visible(timeout=15000)
        field.fill(title)
        field.press("Enter")
        expect(frame.locator("#harness-summary")).to_be_visible(timeout=15000)
        session_id = history()["metadata"]["sessionId"]
        assert re.fullmatch(r"agent_session_[a-f0-9]{32}", session_id)
        return session_id

    complete()
    session_id = create("Actual native controlled Task")
    assert session_id != descriptor["nativeManagedSessionId"]
    send(frame, "NATIVE_CONTROL_CANCEL_MODEL: wait for actual UI Stop before any tool.", keyboard=True)
    observed = fixture / "native-control-model-observed.json"
    deadline = time.monotonic() + 20
    while not observed.exists() and time.monotonic() < deadline:
        page.wait_for_timeout(100)
    assert observed.exists(), "The real model request must precede Stop."
    expect(frame.locator("#stop")).to_be_visible(timeout=15000)
    expect(frame.locator("#stop")).to_be_enabled(timeout=15000)
    frame.locator("#stop").click()
    expect(frame.locator("#send")).to_have_attribute("aria-label", "Resume Chat", timeout=15000)
    expect(frame.locator("#send")).to_be_enabled(timeout=15000)
    frame.locator("#prompt").fill("RETAINED_RESUME_DRAFT")
    frame.locator("#send").click()
    expect(frame.locator("#send")).to_have_attribute("aria-label", "Send", timeout=15000)
    expect(frame.locator("#prompt")).to_have_value("RETAINED_RESUME_DRAFT")
    cancelled = history()["nativeTurns"][-1]
    assert cancelled["status"] == "cancelled" and not cancelled["uncertain"]
    snapshot = history()
    rpc("task-control", input={**identity, "kind": "pause", "operationId": str(uuid.uuid4()),
        "expectedRevision": snapshot["taskControl"]["revision"]})
    expect(frame.locator("#send")).to_have_attribute("aria-label", "Resume Chat", timeout=15000)
    expect(frame.locator("#send")).to_be_enabled(timeout=15000)
    frame.locator("#send").click()
    expect(frame.locator("#send")).to_have_attribute("aria-label", "Send", timeout=15000)
    expect(frame.locator("#prompt")).to_have_value("RETAINED_RESUME_DRAFT")
    send(frame, "NATIVE_CONTROL_SINGLE: read native-input.txt once under this new Task.", keyboard=True)
    durable_answer(frame, "NATIVE_CONTROL_READ sha256:" + descriptor["nativeManagedSha256"])
    expect(frame.locator("#messages")).to_have_attribute("aria-busy", "false", timeout=15000)
    harness = rpc("harness", **identity, sessionId=session_id)
    assert harness["metadataAuthority"] == "native_core"
    assert harness["record"]["task"] == "Actual native controlled Task"
    assert all(message["taskId"] == session_id for message in harness["history"]["messages"])
    assert not harness["sourceWorkers"]
    frame.locator("#open-harness").click()
    deadline = time.monotonic() + 30
    inspected = False
    while time.monotonic() < deadline and not inspected:
        for candidate in page.frames:
            if candidate.locator(".pkm-harness").count():
                candidate.get_by_role("button", name="Current execution", exact=True).click()
                candidate.get_by_role("button", name=re.compile(r"^Open subgraph: 1 recorded call")).click()
                candidate.get_by_role("button", name=re.compile(r"^(?:Open subgraph: )?Read native-input\.txt")).first.click()
                expect(candidate.locator("body")).to_contain_text(descriptor["nativeManagedFileContent"], timeout=15000)
                inspected = True
                break
        if not inspected:
            page.wait_for_timeout(150)
    assert inspected, "The fresh Core Task must use the actual Harness renderer."
    page.keyboard.press("Control+w")
    frame = chat_frame(page)
    choose(frame, descriptor["workerManager"])
    complete()
    crash_session = create("Actual native crash-controlled Task")
    assert crash_session != session_id
    (fixture / "native-task-control-ui-evidence.json").write_text(json.dumps({
        "createdTaskSessionId": session_id, "crashTaskSessionId": crash_session, "draftRetained": True,
        "cancelledTurn": cancelled, "taskControl": history()["taskControl"]}))
    if descriptor.get("nativeChatWorkflows"):
        from native_chat_workflow_ui import run
        run(page, frame, descriptor, "native-workflow-queue", send, durable_answer)
        return
    send(frame, "NATIVE_MANAGED_UNKNOWN: Read native-input.txt, then delegate one worker to read native-crash.txt once; never retry an unacknowledged effect.", keyboard=True)
    expect(frame.locator("#messages")).to_contain_text("NATIVE_MANAGED_UNKNOWN", timeout=15000)
    print("PASS actual installed create/complete dialogs, real model Stop, draft-preserving Resume and exact pause API; fresh Task read and task-scoped Harness.", flush=True)


def open_todo(page, slug):
    existing_urls = {candidate.url for candidate in page.frames}
    page.bring_to_front()
    page.get_by_role("button", name="Open Quick Access", exact=True).click()
    command = page.locator(".quick-input-widget input")
    expect(command).to_be_visible()
    command.fill(">Personal Knowledge Manager: Open Native Todo Board (Private)")
    page.locator(".quick-input-widget .monaco-list-row").filter(
        has_text="Open Native Todo Board (Private)"
    ).first.click(timeout=20000)
    expect(page.locator(".quick-input-widget")).to_contain_text("Original Todo Boards", timeout=20000)
    command.fill(slug)
    page.wait_for_timeout(300)
    command.press("Enter")
    return wait_todo(page, slug, existing_urls)


def wait_todo(page, slug, existing_urls=()):
    deadline = time.monotonic() + 40
    while time.monotonic() < deadline:
        for candidate in page.frames:
            if candidate.url not in existing_urls and candidate.locator("#note-todo").count():
                if candidate.evaluate("() => typeof currentDetail !== 'undefined' && currentDetail?.slug") == slug:
                    candidate.wait_for_function("() => noteTodo.snapshot && !noteTodo.pending", timeout=20000)
                    assert candidate.evaluate("() => noteTodo.readOnly") is False
                    return candidate
        page.wait_for_timeout(150)
    opened = []
    for candidate in page.frames:
        if candidate.locator("#note-todo").count():
            opened.append(candidate.evaluate("() => typeof currentDetail !== 'undefined' ? currentDetail?.slug : null"))
    raise AssertionError(f"Original Todo renderer did not open for {slug}; actual open slugs: {opened}; quick input: "
                         + page.locator(".quick-input-widget").inner_text())


def open_library(page):
    page.bring_to_front()
    page.get_by_role("button", name="Open Quick Access", exact=True).click()
    command = page.locator(".quick-input-widget input")
    command.fill(">Personal Knowledge Manager: Open Panel")
    page.wait_for_timeout(500)
    command.press("Enter")
    deadline = time.monotonic() + 40
    while time.monotonic() < deadline:
        panel = next((frame for frame in page.frames if frame.locator("#workspace-shell").count()), None)
        if panel:
            panel.get_by_role("button", name="Knowledge", exact=True).click()
            panel.get_by_role("tab", name="Notes", exact=True).click()
            return panel
        page.wait_for_timeout(100)
    raise AssertionError("The original Library renderer did not open through the private native transport.")


def legacy_todo_workflow(page, descriptor):
    page.bring_to_front()
    page.get_by_role("button", name="Open Quick Access", exact=True).click()
    command = page.locator(".quick-input-widget input")
    command.fill(">Personal Knowledge Manager: Open Panel")
    page.wait_for_timeout(500)
    command.press("Enter")
    deadline = time.monotonic() + 40
    panel = None
    while time.monotonic() < deadline:
        panel = next((frame for frame in page.frames if frame.locator("#workspace-shell").count()), None)
        if panel:
            break
        page.wait_for_timeout(150)
    assert panel, "Actual old VSIX Library panel did not render."
    panel.get_by_role("button", name="Knowledge", exact=True).click()
    panel.get_by_role("tab", name="Notes", exact=True).click()
    panel.get_by_role("tab", name="Notes", exact=True).press("Control+f")
    panel.locator("#searchbox").fill("Board")
    row = panel.locator('[data-note-slug="Team/Board"]')
    expect(row).to_be_visible(timeout=20000)
    row.click()
    panel.wait_for_function("() => typeof noteTodo !== 'undefined' && noteTodo.snapshot?.items.some(item=>item.id==='old-task') && !noteTodo.pending")
    panel.locator("[data-todo-expand-all]").click()
    panel.locator("[data-todo-open=old-task]").dblclick()
    form = panel.locator("#note-todo-editor")
    expect(form.locator("[name=ownerId]")).to_have_value(f"chat:{descriptor['text']}")
    form.locator("[name=goal]").fill("OLD_UI_BUTTON_SAVED_TODO")
    form.locator("[name=reason]").fill("Actual untouched old installed Todo UI mutation")
    form.get_by_role("button", name="Save Work Item").click()
    todo_saved(panel)
    assert panel.evaluate("() => noteTodo.snapshot.items.find(item=>item.id==='old-task').goal") == "OLD_UI_BUTTON_SAVED_TODO"
    create_board_from_library(page, panel, "OLD_UI_CREATED_BOARD")
    target = Path(descriptor["root"]) / "notes/OLD_UI_CREATED_BOARD.assets/pkm-todo-board.json"
    deadline = time.monotonic() + 30
    while not target.is_file() and time.monotonic() < deadline:
        page.wait_for_timeout(100)
    assert target.is_file(), "The real old Library did not publish its new assets-layout Board."
    (Path(descriptor["fixture"]) / "old-ui-created-board.json").write_text(json.dumps({"slug": "OLD_UI_CREATED_BOARD"}))
    print("PASS: actual untouched old installed VSIX Library/Todo renderer reads the assets-layout Board and saves original Chat-linked work through real user buttons.", flush=True)
    print("PASS: actual untouched old Library New Note/folder/title/Todo Board dialogs create a genuine old-layout Board.", flush=True)


def create_board_from_library(page, panel, title):
    panel.locator("#btn-add-knowledge").click()
    widget = page.locator(".quick-input-widget")
    expect(widget).to_contain_text("Choose Notes folder")
    widget.locator("input").fill("Select this folder")
    widget.locator("input").press("Enter")
    expect(widget).to_contain_text("New note title")
    widget.locator("input").fill(title)
    widget.locator("input").press("Enter")
    expect(widget.locator("input")).to_have_attribute("placeholder", "Choose document type")
    widget.locator("input").fill("Todo Board")
    widget.locator("input").press("Enter")


def library_note(page, slug):
    panel = open_library(page)
    if panel.locator("#searchbox").is_visible():
        panel.locator("#searchbox").fill("")
    row = panel.locator(f'[data-note-slug="{slug}"]')
    deadline = time.monotonic() + 20
    names = slug.split("/")[:-1] or ["(uncategorized)"]
    while not row.is_visible() and time.monotonic() < deadline:
        for name in names:
            folders = panel.locator(f'.tree-cat-hdr[title="{name}"]')
            for index in range(folders.count()):
                folder = folders.nth(index)
                if folder.is_visible() and folder.get_attribute("aria-expanded") == "false":
                    folder.click()
        page.wait_for_timeout(100)
    expect(row).to_be_visible(timeout=5000)
    return panel, row


def rename_library_note(page, slug, title, legacy=False):
    panel, row = library_note(page, slug)
    row.click(button="right")
    panel.locator("#paper-ctx").get_by_text("Edit Metadata", exact=True).click()
    widget = page.locator(".quick-input-widget")
    expect(widget).to_contain_text("Edit Knowledge Metadata (1/4)")
    widget.locator("input").fill(title)
    widget.locator("input").press("Enter")
    expect(widget).to_contain_text("Edit Knowledge Metadata (2/4)")
    widget.locator("input").press("Enter")
    expect(widget).to_contain_text("Edit Knowledge Metadata (3/4)")
    widget.locator("input").press("Enter")
    expect(widget).to_contain_text("Choose Notes folder")
    widget.locator("input").fill("Select this folder")
    widget.locator("input").press("Enter")
    if legacy:
        expect(page.get_by_role("tab", name=re.compile(re.escape(title) + r"\.md")).last).to_have_attribute("aria-selected", "true", timeout=20000)


def move_library_note(page, slug, category):
    panel, row = library_note(page, slug)
    row.click(button="right")
    panel.locator("#paper-ctx").get_by_text("Move", exact=True).click()
    modal = panel.locator("#pk-modal")
    expect(modal).to_contain_text("Move note")
    modal.locator("input").fill(category)
    modal.get_by_role("button", name="Move", exact=True).click()


def trash_restore_library_note(page, slug, root):
    panel, row = library_note(page, slug)
    # Observe the real final list, not the earlier filesystem prefix or optimistic Trash result.
    panel.evaluate("""path => {
      window.__pkmObservedTrashList = false;
      const observed = event => {
        const message = event.data;
        if (message?.command === 'list' && message.tab === 'notes'
          && message.knowledgeTrash?.some(entry => entry.originalPath === path || entry.originalPath === 'notes/' + path)) {
          window.__pkmObservedTrashList = true;
          window.removeEventListener('message', observed);
        }
      };
      window.addEventListener('message', observed);
    }""", f"{slug}.md")
    row.click(button="right")
    panel.locator("#paper-ctx").get_by_text("Move to Trash…", exact=True).click()
    panel.locator("#pk-modal").get_by_role("button", name="Move to Trash", exact=True).click()
    target = root / "notes" / f"{slug}.md"
    deadline = time.monotonic() + 20
    while target.exists() and time.monotonic() < deadline:
        page.wait_for_timeout(100)
    assert not target.exists(), "Board descriptor did not enter real Trash."
    panel.wait_for_function("() => window.__pkmObservedTrashList === true", timeout=20000)
    dock = panel.locator("#knowledge-trash-dock")
    entry = dock.locator(".knowledge-trash-item").filter(has_text=slug.split("/")[-1])
    expect(entry).to_be_attached(timeout=15000)
    if not dock.locator(".knowledge-trash-popover").is_visible():
        dock.locator(".knowledge-trash-dock-row").click()
    expect(entry).to_be_visible(timeout=15000)
    entry.get_by_role("button", name="Restore", exact=True).press("Enter")
    deadline = time.monotonic() + 20
    while not target.exists() and time.monotonic() < deadline:
        page.wait_for_timeout(100)
    assert target.exists(), "Real Library Restore did not recover its exact descriptor."


def old_board_file_workflow(page, descriptor):
    root = Path(descriptor["root"])
    panel, row = library_note(page, "OLD_UI_CREATED_BOARD")
    row.click()
    panel.wait_for_function("() => currentDetail?.slug==='OLD_UI_CREATED_BOARD' && currentDetail.knowledgeId && noteTodo.snapshot && !noteTodo.pending")
    identity = panel.evaluate("() => currentDetail.knowledgeId")
    golden = json.loads((Path(descriptor["fixture"]) / "todo-board-fixture.json").read_text())
    related = next(board["note"]["knowledgeId"] for board in golden["boards"] if board["slug"] == "Team/Board")
    panel.get_by_role("button", name="New Work Item", exact=True).click()
    form = panel.locator("#note-todo-editor")
    for field, value in {
        "title": "OLD_UI_FILE_LINKED_TASK", "goal": "Real old UI file lifecycle preserves Note and Chat identity",
        "scope": "Synthetic original root", "acceptance": "Original UUID links and audit survive",
        "ownerId": f"chat:{descriptor['inline']}", "links": f"pkm://knowledge/{related}",
    }.items():
        form.locator(f"[name={field}]").fill(value)
    form.get_by_role("button", name="Save Work Item").click()
    todo_saved(panel)
    item = panel.evaluate("() => noteTodo.snapshot.items.find(item=>item.title==='OLD_UI_FILE_LINKED_TASK')")
    rename_library_note(page, "OLD_UI_CREATED_BOARD", "OLD_UI_FILE_RENAMED_BOARD", legacy=True)
    panel, row = library_note(page, "OLD_UI_FILE_RENAMED_BOARD")
    move_library_note(page, "OLD_UI_FILE_RENAMED_BOARD", "Old File Journey")
    moved = "Old File Journey/OLD_UI_FILE_RENAMED_BOARD"
    trash_restore_library_note(page, moved, root)
    panel, row = library_note(page, moved)
    row.click()
    panel.wait_for_function("() => currentDetail?.slug==='Old File Journey/OLD_UI_FILE_RENAMED_BOARD' && noteTodo.snapshot && !noteTodo.pending")
    assert panel.evaluate("() => currentDetail.knowledgeId") == identity
    assert panel.evaluate("(id) => noteTodo.snapshot.items.find(item=>item.id===id)", item["id"]) == item
    move_library_note(page, moved, "")
    rename_library_note(page, "OLD_UI_FILE_RENAMED_BOARD", "OLD_UI_CREATED_BOARD", legacy=True)
    panel, row = library_note(page, "OLD_UI_CREATED_BOARD")
    row.click()
    panel.wait_for_function("() => currentDetail?.slug==='OLD_UI_CREATED_BOARD' && noteTodo.snapshot && !noteTodo.pending")
    assert panel.evaluate("() => currentDetail.knowledgeId") == identity
    assert panel.evaluate("(id) => noteTodo.snapshot.items.find(item=>item.id===id)", item["id"]) == item
    (Path(descriptor["fixture"]) / "old-ui-file-lifecycle.json").write_text(json.dumps({
        "slug": "OLD_UI_CREATED_BOARD", "knowledgeId": identity, "relatedNoteId": related, "item": item,
    }))
    print("PASS: untouched old VSIX real metadata/folder/Trash/Restore controls preserve the actual old-code Board Note UUID and linked original Chat/Note task audit.", flush=True)


def native_board_creation(page, descriptor):
    panel = open_library(page)
    original_row = panel.locator('[data-note-slug="OLD_UI_CREATED_BOARD"]')
    if not original_row.is_visible():
        panel.get_by_role("button", name="(uncategorized) Folder", exact=False).click()
    expect(original_row).to_be_visible(timeout=20000)
    create_board_from_library(page, panel, "NATIVE_UI_CREATED_BOARD")
    target = Path(descriptor["root"]) / "boards/NATIVE_UI_CREATED_BOARD/pkm-todo-board.json"
    deadline = time.monotonic() + 30
    while not target.is_file() and time.monotonic() < deadline:
        page.wait_for_timeout(100)
    assert target.is_file(), "Actual original Library creation did not reach the native Board authority."
    assert not (Path(descriptor["root"]) / "notes/NATIVE_UI_CREATED_BOARD.assets").exists()
    board = wait_todo(page, "NATIVE_UI_CREATED_BOARD")
    identity = board.evaluate("() => currentDetail.knowledgeId")
    assert isinstance(identity, str) and identity
    board.get_by_role("button", name="New Work Item", exact=True).click()
    form = board.locator("#note-todo-editor")
    form.locator("[name=title]").fill("NATIVE_NEW_BOARD_TASK")
    form.locator("[name=goal]").fill("Real user-created Board continues after full restart")
    form.locator("[name=scope]").fill("Synthetic same original root")
    form.locator("[name=acceptance]").fill("Stable identity and original Chat link")
    form.locator("[name=ownerId]").fill(f"chat:{descriptor['inline']}")
    form.get_by_role("button", name="Save Work Item").click()
    todo_saved(board)
    item = board.evaluate("() => noteTodo.snapshot.items.find(item=>item.title==='NATIVE_NEW_BOARD_TASK')")
    (Path(descriptor["fixture"]) / "new-ui-created-board.json").write_text(json.dumps({
        "slug": "NATIVE_UI_CREATED_BOARD", "knowledgeId": identity, "itemId": item["id"],
    }))
    before_duplicate = target.read_bytes()
    panel = open_library(page)
    create_board_from_library(page, panel, "NATIVE_UI_CREATED_BOARD")
    expect(page.locator(".notification-list-item-message").filter(has_text="already exists").last).to_be_visible(timeout=20000)
    assert target.read_bytes() == before_duplicate, "Duplicate creation overwrote an existing native Board."
    print("PASS: real original Library dialogs create a native user Board on the same adopted root; original Todo UI adds an original-Chat-owned item.", flush=True)


def todo_saved(frame):
    frame.wait_for_function("() => !noteTodo.pending && !noteTodo.editor", timeout=20000)


def todo_confirm(frame, reason):
    dialog = frame.get_by_role("dialog", name="Todo confirmation")
    expect(dialog).to_be_visible()
    dialog.get_by_role("textbox", name="Reason").fill(reason)
    dialog.get_by_role("button", name="Confirm", exact=True).click()


def original_board_lifecycle(page, chat, descriptor):
    board = open_todo(page, "OLD_UI_CREATED_BOARD")
    identity = board.evaluate("() => currentDetail.knowledgeId")
    old = json.loads((Path(descriptor["fixture"]) / "todo-board-fixture.json").read_text())
    assert identity == next(entry for entry in old["boards"] if entry["slug"] == "OLD_UI_CREATED_BOARD")["note"]["knowledgeId"]
    board.get_by_role("button", name="New Work Item", exact=True).click()
    form = board.locator("#note-todo-editor")
    for field, value in {
        "title": "ORIGINAL_BOARD_CROSS_CHAT_TASK", "goal": "Preserve identity across real Chat reassignment",
        "scope": "Private original UI Board", "acceptance": "Delete and restore preserve all audit history",
        "ownerId": f"chat:{descriptor['text']}",
    }.items():
        form.locator(f"[name={field}]").fill(value)
    form.get_by_role("button", name="Save Work Item").click()
    todo_saved(board)
    original = board.evaluate("() => noteTodo.snapshot.items.find(item=>item.title==='ORIGINAL_BOARD_CROSS_CHAT_TASK')")
    board.locator(f'[data-todo-open="{original["id"]}"]').dblclick()
    form.locator("[name=ownerId]").fill(f"chat:{descriptor['inline']}")
    form.locator("[name=reason]").fill("Move the original Board task between two original PKM Chats")
    form.get_by_role("button", name="Open associated Chat", exact=True).click()
    expect(chat.locator("#chats")).to_have_value(descriptor["inline"], timeout=15000)
    form.get_by_role("button", name="Save Work Item").click()
    todo_saved(board)
    board.locator(f'[data-todo-open="{original["id"]}"]').dblclick()
    form.get_by_role("button", name="Delete Work Item", exact=True).click()
    todo_confirm(board, "Explicit user deletion on the same original Board")
    todo_saved(board)
    expect(board.locator(f'[data-todo-open="{original["id"]}"]')).to_have_count(0)
    board.locator(f'[data-native-todo-restore="{original["id"]}"]').click()
    todo_confirm(board, "Restore the same Work Item identity and its original Chat history")
    todo_saved(board)
    restored = board.evaluate("(id) => noteTodo.snapshot.items.find(item=>item.id===id)", original["id"])
    assert restored["ownerId"] == f"chat:{descriptor['inline']}"
    assert not restored.get("deletedAt")
    assert restored["history"][:len(original["history"])] == original["history"]
    assert {entry["action"] for entry in restored["history"]} >= {"create", "edit", "delete", "restore"}
    reassignment = next(entry for entry in restored["history"] if entry["action"] == "edit")
    assert reassignment["actorId"] == "user:local"
    assert {
        "field": "ownerId", "before": json.dumps(f"chat:{descriptor['text']}"),
        "after": json.dumps(f"chat:{descriptor['inline']}"),
    } in reassignment["changes"]
    (Path(descriptor["fixture"]) / "original-board-lifecycle.json").write_text(json.dumps({
        "slug": "OLD_UI_CREATED_BOARD", "knowledgeId": identity, "item": restored,
    }))
    print("PASS: real original UI creates on an old-UI-created Board, reassigns between two original Chat UUIDs, navigates, deletes and restores the same item and audit history.", flush=True)


def open_identity_link(page, board, item_id, note_id):
    board.locator("[data-note-view=table]").click()
    row = board.locator(f'tr[data-todo-card-id="{item_id}"]')
    row.locator("details.note-todo-details > summary").click()
    existing_urls = {candidate.url for candidate in page.frames}
    row.locator(f'a[href="pkm://knowledge/{note_id}"]').click()
    related = wait_todo(page, "Team/Board", existing_urls)
    assert related.evaluate("() => currentDetail.knowledgeId") == note_id


def native_board_file_workflow(page, descriptor):
    root = Path(descriptor["root"])
    original = json.loads((Path(descriptor["fixture"]) / "old-ui-file-lifecycle.json").read_text())
    board = open_todo(page, original["slug"])
    identity = board.evaluate("() => currentDetail.knowledgeId")
    assert identity == original["knowledgeId"]
    before = board.evaluate("() => noteTodo.snapshot")
    assert next(item for item in before["items"] if item["id"] == original["item"]["id"]) == original["item"]
    native = root / "boards" / original["slug"] / "pkm-todo-board.json"
    native_bytes = native.read_bytes()
    descriptor_bytes = (root / "notes" / f"{original['slug']}.md").read_bytes()
    rename_library_note(page, original["slug"], "NATIVE_UI_CREATED_BOARD")
    expect(page.locator(".notification-list-item-message").filter(has_text="absent").last).to_be_visible(timeout=15000)
    assert (root / "notes" / f"{original['slug']}.md").read_bytes() == descriptor_bytes
    assert native.read_bytes() == native_bytes
    rename_library_note(page, original["slug"], "OLD_UI_FILE_RENAMED_BOARD")
    expect(page.locator(".notification-list-item-message").filter(has_text="original Sync deletion").last).to_be_visible(timeout=15000)
    assert (root / "notes" / f"{original['slug']}.md").read_bytes() == descriptor_bytes
    assert native.read_bytes() == native_bytes
    rename_library_note(page, original["slug"], "NATIVE_FILE_RENAMED_BOARD")
    move_library_note(page, "NATIVE_FILE_RENAMED_BOARD", "Moved/Board lifecycle")
    current = "Moved/Board lifecycle/NATIVE_FILE_RENAMED_BOARD"
    trash_restore_library_note(page, current, root)
    board = open_todo(page, original["slug"])
    assert board.evaluate("() => currentDetail.knowledgeId") == identity
    assert board.evaluate("() => currentDetail.path") == current + ".md"
    assert board.evaluate("() => noteTodo.snapshot") == before
    assert native.read_bytes() == native_bytes
    board.locator("[data-todo-expand-all]").click()
    board.locator(f'[data-todo-open="{original["item"]["id"]}"]').dblclick()
    form = board.locator("#note-todo-editor")
    expect(form.locator("[name=ownerId]")).to_have_value(f"chat:{descriptor['inline']}")
    associated = chat_frame(page)
    choose(associated, descriptor["text"])
    form.get_by_role("button", name="Open associated Chat", exact=True).click()
    expect(associated.locator("#chats")).to_have_value(descriptor["inline"])
    board = open_todo(page, original["slug"])
    open_identity_link(page, board, original["item"]["id"], original["relatedNoteId"])
    (Path(descriptor["fixture"]) / "board-file-lifecycle.json").write_text(json.dumps({
        "boardSlug": original["slug"], "originalPath": original["slug"] + ".md", "path": current + ".md",
        "knowledgeId": identity, "documentId": board.evaluate("() => currentDetail.documentId"),
        "snapshot": before, "relatedNoteId": original["relatedNoteId"], "linkedItemId": original["item"]["id"],
    }))
    print("PASS: real native Library metadata rename, folder move, Trash and Restore retain canonical Board key, Note/linked Note/Chat UUIDs and the full exact task audit; collision makes no changes.", flush=True)


def board_file_interruption(page, descriptor, recovering=False):
    operation = descriptor["boardFileCrash"]
    retained = json.loads((Path(descriptor["fixture"]) / "board-file-lifecycle.json").read_text())
    if recovering:
        if operation["kind"] == "trash":
            panel = open_library(page)
            dock = panel.locator("#knowledge-trash-dock")
            expect(dock).to_be_visible(timeout=20000)
            entry = dock.locator(".knowledge-trash-item").filter(has_text=Path(retained["path"]).stem)
            expect(entry).to_be_attached(timeout=15000)
            if not dock.locator(".knowledge-trash-popover").is_visible():
                dock.locator(".knowledge-trash-dock-row").click()
            expect(entry).to_be_visible()
            assert not (Path(descriptor["root"]) / "notes" / retained["path"]).exists()
        else:
            board = open_todo(page, retained["boardSlug"])
            assert board.evaluate("() => currentDetail.knowledgeId") == retained["knowledgeId"]
            assert board.evaluate("() => currentDetail.documentId") == retained["documentId"]
            assert board.evaluate("() => currentDetail.path") == retained["path"]
            assert board.evaluate("() => noteTodo.snapshot") == retained["snapshot"]
        print(f"PASS: actual Library/Todo UI reads recovered {operation['kind']} after real renameat2 prefix, exact fixture broker SIGKILL and complete Code restart.", flush=True)
    elif operation["kind"] == "move":
        move_library_note(page, retained["path"][:-3], "Crash move")
    elif operation["kind"] == "trash":
        panel, row = library_note(page, retained["path"][:-3])
        row.click(button="right")
        panel.locator("#paper-ctx").get_by_text("Move to Trash…", exact=True).click()
        panel.locator("#pk-modal").get_by_role("button", name="Move to Trash", exact=True).click()
    else:
        panel = open_library(page)
        dock = panel.locator("#knowledge-trash-dock")
        expect(dock).to_be_visible(timeout=20000)
        entry = dock.locator(".knowledge-trash-item").filter(has_text=Path(retained["path"]).stem)
        expect(entry).to_be_attached(timeout=15000)
        if not dock.locator(".knowledge-trash-popover").is_visible():
            dock.locator(".knowledge-trash-dock-row").click()
        entry.get_by_role("button", name="Restore", exact=True).press("Enter")


def todo_stale_draft(page, primary, slug):
    tabs = page.get_by_role("tab").filter(has_text="Native Todo · Board")
    tabs.first.click()
    primary.locator("[data-todo-open=old-task]").dblclick()
    original_form = primary.locator("#note-todo-editor")
    original_form.locator("[name=goal]").fill("ACTUAL_TODO_STALE_DRAFT_RETAINED")
    original_form.locator("[name=reason]").fill("User resolves concurrent native Todo edits")
    newer = open_todo(page, slug)
    newer.locator("[data-todo-expand-all]").click()
    newer.locator("[data-todo-open=old-task]").dblclick()
    form = newer.locator("#note-todo-editor")
    form.locator("[name=goal]").fill("OTHER_REAL_TODO_VIEW_COMMITTED_FIRST")
    form.locator("[name=reason]").fill("Another real Todo view changes the original Work Item")
    form.get_by_role("button", name="Save Work Item").click()
    todo_saved(newer)
    tabs.first.click()
    original_form.get_by_role("button", name="Save Work Item").click()
    primary.wait_for_function("() => !noteTodo.pending && !!noteTodo.error")
    expect(original_form.locator("[name=goal]")).to_have_value("ACTUAL_TODO_STALE_DRAFT_RETAINED")
    primary.get_by_role("dialog").get_by_role("button", name="Reload from Note", exact=True).click()
    primary.wait_for_function("() => !noteTodo.pending && !noteTodo.error")
    expect(original_form.locator("[name=goal]")).to_have_value("ACTUAL_TODO_STALE_DRAFT_RETAINED")
    original_form.get_by_role("button", name="Save Work Item").click()
    todo_saved(primary)
    assert primary.evaluate("() => noteTodo.snapshot.items.find(item=>item.id==='old-task').goal") == "ACTUAL_TODO_STALE_DRAFT_RETAINED"
    print("PASS: two real original Todo views reject a stale native edit, retain the draft through explicit reload, and persist the user's retry.", flush=True)


def native_todo_workflow(page, chat, descriptor):
    old = json.loads((Path(descriptor["fixture"]) / "todo-board-fixture.json").read_text())
    primary = open_todo(page, old["primary"])
    original = next(board for board in old["boards"] if board["slug"] == old["primary"])
    assert primary.evaluate("() => currentDetail.knowledgeId") == original["note"]["knowledgeId"]
    assert primary.evaluate("() => currentDetail.aliases") == original["note"]["aliases"]
    assert primary.evaluate("() => noteTodo.snapshot.items") == original["snapshot"]["items"]
    primary.locator("[data-note-view=table]").click()
    history = primary.locator('[data-todo-card-id="old-task"] .note-todo-details')
    history.locator("summary").first.click()
    history.locator(".note-todo-attempts summary").first.click()
    expect(history.locator(".note-todo-history")).to_contain_text("comment")
    primary.locator("[data-note-view=board]").click()
    primary.locator("[data-todo-expand-all]").click()
    primary.locator("[data-todo-open=old-story]").dblclick()
    overview = primary.get_by_role("region", name="User Story overview")
    expect(overview).to_contain_text("Preserve genuine old Todo workflows")
    overview.get_by_role("button", name="Edit User Story", exact=True).click()
    form = primary.locator("#note-todo-editor")
    form.locator("[name=storyStatus]").select_option("confirmed")
    form.locator("[name=reason]").fill("Native user confirms the original Story contract")
    form.get_by_role("button", name="Save Work Item").click()
    todo_saved(primary)
    primary.locator("[data-todo-expand-all]").click()
    primary.locator("[data-todo-open=old-task]").dblclick()
    expect(form.locator("[name=ownerId]")).to_have_value(f"chat:{descriptor['text']}")
    form.locator("[name=title]").fill("NATIVE_TODO_USER_EDITED_ORIGINAL")
    form.locator("[name=goal]").fill("Original user draft and history continue on the native Board")
    form.locator("[name=reviewerIds]").fill("user:local")
    form.locator("[name=plannedStart]").fill("2026-11-01")
    form.locator("[name=plannedEnd]").fill("2026-11-05")
    assert form.locator("[name=projectId] option").count() > 1
    form.locator("[name=projectId]").select_option(index=1)
    form.get_by_role("button", name="Open associated Chat", exact=True).click()
    expect(chat.locator("#chats")).to_have_value(descriptor["text"], timeout=15000)
    expect(form.locator("[name=title]")).to_have_value("NATIVE_TODO_USER_EDITED_ORIGINAL")
    send(chat, "NATIVE_UI_TODO_CHAT")
    durable_answer(chat, "NATIVE_UI_DURABLE_TODO_CHAT")
    page.bring_to_front()
    form.locator("[name=reason]").fill("Actual original renderer saves native user-only fields")
    form.get_by_role("button", name="Save Work Item").click()
    todo_saved(primary)
    primary.locator("[data-note-view=table]").click()
    expect(primary.locator(".note-todo-table")).to_contain_text("NATIVE_TODO_USER_EDITED_ORIGINAL")
    primary.locator("[data-note-view=timeline]").click()
    expect(primary.locator(".note-todo-timeline")).to_contain_text("NATIVE_TODO_USER_EDITED_ORIGINAL")
    primary.locator("[data-note-view=board]").click()
    primary.locator("[data-todo-expand-all]").click()
    primary.locator("[data-todo-open=old-task]").dblclick()
    form.locator("[name=state]").select_option("Done")
    form.locator("[name=outcome]").select_option("Success")
    form.locator("[name=evidence]").fill("fixture://actual-native-todo-user")
    for layer in ("unit", "functional", "e2e"):
        form.locator(f"[name=verify-{layer}]").select_option("passed")
        form.locator(f"[name=evidence-{layer}]").fill(f"fixture://actual-native-todo-{layer}")
    form.locator("[name=reason]").fill("User records a synthetic result, not production evidence")
    form.get_by_role("button", name="Save Work Item").click()
    todo_saved(primary)
    primary.locator('[data-todo-card-id="old-task"]').get_by_role("button", name="Accept", exact=True).click()
    todo_confirm(primary, "Explicit native user acceptance")
    primary.wait_for_function("() => !noteTodo.pending && noteTodo.snapshot.items.find(item=>item.id==='old-task').acceptanceDecision")
    primary.locator('[data-todo-card-id="old-task"]').get_by_role("button", name="Reopen", exact=True).click()
    todo_confirm(primary, "Native user reopens original work for continuation")
    primary.wait_for_function("() => !noteTodo.pending && !noteTodo.snapshot.items.find(item=>item.id==='old-task').acceptanceDecision")
    primary.get_by_role("button", name="New Work Item", exact=True).click()
    form.locator("[name=title]").fill("NATIVE_TODO_USER_CREATED")
    form.locator("[name=goal]").fill("Actual UI creation after old-layout import")
    form.locator("[name=scope]").fill("Isolated native upgrade only")
    form.locator("[name=acceptance]").fill("Persistent identity and user history")
    form.locator("[name=parentId]").select_option("old-story")
    form.locator("[name=ownerId]").fill("external:copilot:fixture-worker")
    form.get_by_role("button", name="Save Work Item").click()
    todo_saved(primary)
    assert primary.evaluate("() => noteTodo.snapshot.items.filter(item=>item.title==='NATIVE_TODO_USER_CREATED').length") == 1
    created = primary.evaluate("() => noteTodo.snapshot.items.find(item=>item.title==='NATIVE_TODO_USER_CREATED').id")
    primary.locator("[data-todo-expand-all]").click()
    primary.locator(f'[data-todo-open="{created}"]').dblclick()
    form.locator("[name=goal]").fill("UNSAVED_DURING_WORKER_GRANT")
    for _ in range(2):
        before = primary.evaluate("() => noteTodo.snapshot.digest")
        form.get_by_role("button", name="Copy / rotate external worker token", exact=True).click()
        primary.wait_for_function("(old) => !noteTodo.pending && (noteTodo.snapshot.digest!==old || !!noteTodo.error)", arg=before)
        assert not primary.evaluate("() => noteTodo.error"), "Actual worker grant refused: " + primary.evaluate("() => noteTodo.error")
        expect(form.locator("[data-native-todo-worker-secret]")).to_have_text("Worker grant matches this private profile SecretStorage.")
        expect(form.locator("[name=goal]")).to_have_value("UNSAVED_DURING_WORKER_GRANT")
    form.get_by_role("button", name="Cancel", exact=True).click()
    converted = open_todo(page, old["converted"])
    converted.locator("[data-todo-open=old-inline]").dblclick()
    converted_form = converted.locator("#note-todo-editor")
    converted_form.locator("[name=title]").fill("NATIVE_TODO_INLINE_CONVERSION_CONTINUED")
    converted_form.locator("[name=reason]").fill("Continue genuine old inline-to-Board migration")
    converted_form.get_by_role("button", name="Save Work Item").click()
    todo_saved(converted)
    todo_stale_draft(page, primary, old["primary"])
    print("PASS: actual original Todo UI edits/confirms Story, reads legacy audit, preserves Chat UUID/navigation, creates tasks, changes Table/Board/Timeline, accepts/reopens and writes old inline conversion.", flush=True)
    print("PASS: actual original worker-token button grants and rotates through the native user journal and real private-profile SecretStorage without submitting or discarding a draft.", flush=True)


def run():
    parser = argparse.ArgumentParser()
    parser.add_argument("endpoint")
    parser.add_argument("descriptor")
    parser.add_argument("stage", choices=["baseline", "legacy-worker-probe", "legacy-recipe", "native", "native-session", "race", "crash", "reopen",
                                          "native-managed", "native-managed-unknown", "native-managed-reopen",
                                          "native-workflow-resume", "native-workflow-reviewed-reopen",
                                          "native-memory-start", "native-memory-reopen",
                                          "native-memory-unknown-reopen", "native-memory-final-reopen",
                                          "native-recipe-complete", "native-recipe-cancel", "native-recipe-reopen",
                                          "native-recipe-crash", "native-recipe-unknown-reopen", "native-recipe-final-reopen",
                                          "native-recipe-start", "native-recipe-reopen-crash",
                                          "native-library-author", "native-library-crash",
                                          "native-library-recovered", "native-library-final",
                                          "native-lazy-start", "native-lazy-reopen", "native-lazy-unknown",
                                          "native-knowledge-start", "native-knowledge-reopen",
                                          "native-report-start", "native-report-reopen",
                                          "native-branch-start", "native-branch-reopen",
                                          "native-reflection-gate-start", "native-reflection-gate-reopen",
                                          "board-file-interrupt", "board-file-recovered",
                                          "worker-interrupt", "worker-recovered", "board-create-interrupt", "board-create-recovered"])
    args = parser.parse_args()
    descriptor = json.loads(Path(args.descriptor).read_text())
    with sync_playwright() as playwright:
        print("Connecting to private Electron CDP", args.endpoint, flush=True)
        browser = playwright.chromium.connect_over_cdp(args.endpoint, timeout=30000)
        try:
            pages = [page for context in browser.contexts for page in context.pages if "workbench" in page.url]
            assert pages, "No actual VS Code renderer target."
            for current in pages:
                current.on("pageerror", lambda error: print("Actual renderer JavaScript error:", error, flush=True))
            page = pages[0]
            frame = None if args.stage == "legacy-recipe" else open_chat(page)
            if args.stage == "legacy-recipe":
                from native_chat_recipe_ui import original
                original(playwright, page, descriptor)
            if args.stage.startswith("native-memory-"):
                from native_chat_memory_ui import run as memory_run
                memory_run(page, frame, descriptor, args.stage, choose, send, durable_answer)
            if args.stage.startswith("native-recipe-"):
                from native_chat_recipe_ui import native
                phases = {"native-recipe-start": ("native-recipe-complete", "native-recipe-cancel"),
                          "native-recipe-reopen-crash": ("native-recipe-reopen", "native-recipe-crash")}
                for phase in phases.get(args.stage, (args.stage,)):
                    native(page, frame, descriptor, phase, choose)
            if args.stage.startswith("native-library-"):
                from native_chat_recipe_ui import library
                library(page, frame, descriptor, args.stage, choose)
            if args.stage.startswith("native-lazy-"):
                from native_chat_recipe_lazy_ui import run as lazy_run
                lazy_run(page, frame, descriptor, args.stage, choose)
            if args.stage.startswith("native-knowledge-"):
                from native_chat_recipe_knowledge_ui import run as knowledge_run
                knowledge_run(page, frame, descriptor, args.stage, choose)
            if args.stage.startswith("native-report-"):
                from native_chat_recipe_report_ui import run as report_run
                report_run(page, frame, descriptor, args.stage, choose)
            if args.stage.startswith("native-branch-"):
                from native_chat_recipe_branch_ui import run as branch_run
                branch_run(page, frame, descriptor, args.stage, choose)
            if args.stage.startswith("native-reflection-gate-"):
                from native_chat_recipe_reflection_gate_ui import run as reflection_gate_run
                reflection_gate_run(page, frame, descriptor, args.stage, choose)
            if args.stage == "legacy-worker-probe":
                legacy_worker_probe(page, frame, descriptor)
            if args.stage in ("native-managed", "native-managed-unknown", "native-managed-reopen",
                              "native-workflow-resume", "native-workflow-reviewed-reopen"):
                native_managed_chat(page, frame, descriptor, args.stage)
            if args.stage in ("board-file-interrupt", "board-file-recovered"):
                board_file_interruption(page, descriptor, recovering=args.stage == "board-file-recovered")
            if args.stage in ("baseline", "native", "native-session", "reopen"):
                assert_original(frame, descriptor)
            if args.stage == "baseline":
                choose(frame, descriptor["text"])
                send(frame, "LEGACY_UI_ACTUAL_SEND")
                deadline = time.monotonic() + 40
                while time.monotonic() < deadline:
                    if frame.locator("#messages [data-message-id]").filter(has_text="LEGACY_UI_DURABLE_RESPONSE").count():
                        break
                    approval = frame.get_by_role("button", name="Allow once", exact=True)
                    if approval.count() and approval.is_visible() and approval.is_enabled():
                        print("Approving one actual read of the synthetic Knowledge Root", flush=True)
                        try:
                            approval.click(timeout=1500)
                        except PlaywrightError:
                            if frame.locator("#messages [data-message-id]").filter(has_text="LEGACY_UI_DURABLE_RESPONSE").count():
                                break
                            if approval.count() and approval.is_visible() and approval.is_enabled():
                                raise
                    page.wait_for_timeout(200)
                durable_answer(frame, "LEGACY_UI_DURABLE_RESPONSE")
                if descriptor.get("todoBoards"):
                    legacy_todo_workflow(page, descriptor)
                    old_board_file_workflow(page, descriptor)
                if descriptor.get("workerManager"):
                    legacy_worker_probe(page, frame, descriptor)
            elif args.stage in ("native", "native-session"):
                expect(frame.locator("#native-chat-experiment")).to_be_visible()
                choose(frame, descriptor["text"])
                durable_answer(frame, "LEGACY_UI_DURABLE_RESPONSE" if descriptor["legacyUiActivated"] else "Original bounded text history.")
                choose(frame, descriptor["inline"])
                frame.locator("#prompt").evaluate("""(prompt, source) => {
                    const bytes = Uint8Array.from(atob(source), character => character.charCodeAt(0));
                    const clipboardData = new DataTransfer();
                    clipboardData.items.add(new File([bytes], "new-native-pixel.png", {type:"image/png"}));
                    prompt.dispatchEvent(new ClipboardEvent("paste", {clipboardData, bubbles:true, cancelable:true}));
                }""", descriptor["nativeImageBase64"])
                attached = frame.locator(f'#images img[alt="{descriptor["nativeImageLabel"]}"]')
                expect(attached).to_have_count(1, timeout=15000)
                assert attached.evaluate("(image) => image.complete && image.naturalWidth === 1 && image.naturalHeight === 1")
                send(frame, "NATIVE_UI_WINDOW_ONE")
                durable_answer(frame, "NATIVE_UI_DURABLE_WINDOW_ONE")
                expect(frame.locator(f'#messages img[alt="{descriptor["nativeImageLabel"]}"]')).to_have_count(1)
                print("PASS: actual installed native renderer reads original history and sends distinct pasted PNG through HTTP", flush=True)
                if descriptor.get("todoBoards"):
                    native_todo_workflow(page, frame, descriptor)
                    native_board_creation(page, descriptor)
                    original_board_lifecycle(page, frame, descriptor)
                    native_board_file_workflow(page, descriptor)
            if args.stage in ("race", "native-session"):
                page.bring_to_front()
                dismiss_welcome(page)
                if len(pages) == 1:
                    subprocess.run([descriptor["privateCodeCli"], *descriptor["privateCodeArgs"], "--new-window"],
                                   env={**os.environ, "PKM_PRIVATE_NATIVE_CHAT_UI_GRANT": descriptor["privateGrantFile"]},
                                   check=True, timeout=30)
                    deadline = time.monotonic() + 30
                    while time.monotonic() < deadline:
                        pages = [current for context in browser.contexts for current in context.pages if "workbench" in current.url]
                        if len(pages) == 2:
                            break
                        page.wait_for_timeout(150)
                assert len(pages) == 2, f"Two actual VS Code windows required, got {len(pages)}."
                second_page = next(current for current in pages if current is not page)
                second = open_chat(second_page)
                assert second.page is not frame.page, "The race must use two different actual workbench windows."
                for current in (frame, second):
                    choose(current, descriptor["inline"])
                    durable_answer(current, "NATIVE_UI_DURABLE_WINDOW_ONE")
                send(frame, "NATIVE_UI_MULTI_A", keyboard=True)
                expect(frame.locator("#send")).to_have_attribute("aria-label", "Steer", timeout=15000)
                page.wait_for_timeout(200)
                send(second, "NATIVE_UI_MULTI_B", keyboard=True)
                durable_answer(frame, "NATIVE_UI_DURABLE_MULTI_A")
                durable_answer(second, "NATIVE_UI_DURABLE_MULTI_A")
                expect(second.locator("#prompt")).to_have_value("NATIVE_UI_MULTI_B", timeout=15000)
                expect(second.locator("#messages [data-message-id]").filter(has_text="NATIVE_UI_DURABLE_MULTI_B")).to_have_count(0)
                send(second, "NATIVE_UI_MULTI_B", keyboard=True)
                for current in (frame, second):
                    durable_answer(current, "NATIVE_UI_DURABLE_MULTI_B")
                print("PASS: two real Code windows preserve the rejected stale draft and publish one durable retry", flush=True)
            if args.stage in ("crash", "native-session"):
                choose(frame, descriptor["inline"])
                durable_answer(frame, "NATIVE_UI_DURABLE_MULTI_B")
                send(frame, "NATIVE_UI_CRASH_RESULT")
                expect(frame.locator("#messages [data-message-id]").filter(has_text="NATIVE_UI_DURABLE_CRASH_RESULT")).to_have_count(0)
            elif args.stage == "reopen":
                choose(frame, descriptor["inline"])
                for answer in ["NATIVE_UI_DURABLE_WINDOW_ONE", "NATIVE_UI_DURABLE_MULTI_A",
                               "NATIVE_UI_DURABLE_MULTI_B", "NATIVE_UI_DURABLE_CRASH_RESULT"]:
                    durable_answer(frame, answer)
                if descriptor.get("todoBoards"):
                    created_metadata = json.loads((Path(descriptor["fixture"]) / "new-ui-created-board.json").read_text())
                    created_board = open_todo(page, created_metadata["slug"])
                    assert created_board.evaluate("() => currentDetail.knowledgeId") == created_metadata["knowledgeId"]
                    saved_item = created_board.evaluate("(id) => noteTodo.snapshot.items.find(item=>item.id===id)", created_metadata["itemId"])
                    assert saved_item["ownerId"] == f"chat:{descriptor['inline']}"
                    assert saved_item["goal"] == "Real user-created Board continues after full restart"
                    lifecycle = json.loads((Path(descriptor["fixture"]) / "original-board-lifecycle.json").read_text())
                    original_board = open_todo(page, lifecycle["slug"])
                    assert original_board.evaluate("() => currentDetail.knowledgeId") == lifecycle["knowledgeId"]
                    assert original_board.evaluate("(id) => noteTodo.snapshot.items.find(item=>item.id===id)", lifecycle["item"]["id"]) == lifecycle["item"]
                    files = json.loads((Path(descriptor["fixture"]) / "board-file-lifecycle.json").read_text())
                    assert original_board.evaluate("() => currentDetail.path") == files["path"]
                    assert original_board.evaluate("() => noteTodo.snapshot") == files["snapshot"]
                    open_identity_link(page, original_board, files["linkedItemId"], files["relatedNoteId"])
                    primary = open_todo(page, descriptor["todoBoards"][0])
                    assert primary.evaluate("() => noteTodo.snapshot.items.find(item=>item.id==='old-task').title") == "NATIVE_TODO_USER_EDITED_ORIGINAL"
                    assert primary.evaluate("() => noteTodo.snapshot.items.filter(item=>item.title==='NATIVE_TODO_USER_CREATED').length") == 1
                    created = primary.evaluate("() => noteTodo.snapshot.items.find(item=>item.title==='NATIVE_TODO_USER_CREATED').id")
                    primary.locator("[data-todo-expand-all]").click()
                    primary.locator(f'[data-todo-open="{created}"]').dblclick()
                    form = primary.locator("#note-todo-editor")
                    expect(form.locator("[name=ownerId]")).to_have_value("external:copilot:fixture-worker")
                    expect(form.locator("[name=goal]")).to_have_value("Actual UI creation after old-layout import")
                    expect(form.locator("[data-native-todo-worker-secret]")).to_have_text("Worker grant matches this private profile SecretStorage.")
                    form.get_by_role("button", name="Cancel", exact=True).click()
                    converted = open_todo(page, descriptor["todoBoards"][1])
                    assert converted.evaluate("() => noteTodo.snapshot.items.find(item=>item.id==='old-inline').title") == "NATIVE_TODO_INLINE_CONVERSION_CONTINUED"
                    print("PASS: actual original Todo renderer reads native edits/created identities after complete Code and broker restart.", flush=True)
                    print("PASS: rotated native worker grant still matches real private-profile SecretStorage after full Code/broker restart; the unsaved grant-time draft was never submitted.", flush=True)
                expect(frame.locator(f'#messages img[alt="{descriptor["nativeImageLabel"]}"]')).to_have_count(1)
            if args.stage in ("worker-interrupt", "worker-recovered"):
                primary = open_todo(page, descriptor["todoBoards"][0])
                primary.locator("[data-todo-expand-all]").click()
                created = primary.evaluate("() => noteTodo.snapshot.items.find(item=>item.title==='NATIVE_TODO_USER_CREATED').id")
                primary.locator(f'[data-todo-open="{created}"]').dblclick()
                form = primary.locator("#note-todo-editor")
                expect(form.locator("[data-native-todo-worker-secret]")).to_have_text("Worker grant matches this private profile SecretStorage.")
                expect(form.locator("[name=goal]")).to_have_value("Actual UI creation after old-layout import")
                if args.stage == "worker-interrupt":
                    form.get_by_role("button", name="Copy / rotate external worker token", exact=True).click()
                    primary.wait_for_function("() => noteTodo.pending && noteTodo.pending.kind==='worker-grant'")
                    print("Actual original worker button is waiting for its withheld native grant acknowledgement.", flush=True)
                else:
                    print("PASS: original renderer verifies the recovered real SecretStorage token against the interrupted native worker grant.", flush=True)
            if args.stage == "board-create-interrupt":
                panel = open_library(page)
                create_board_from_library(page, panel, "NATIVE_BOARD_CRASH_CREATION")
                deadline = time.monotonic() + 30
                evidence = Path(descriptor["fixture"]) / "board-create-crash-evidence.json"
                while not evidence.is_file() and time.monotonic() < deadline:
                    page.wait_for_timeout(100)
                assert evidence.is_file(), "The real UI did not reach the durable creation fault."
            elif args.stage == "board-create-recovered":
                board = open_todo(page, "NATIVE_BOARD_CRASH_CREATION")
                assert board.evaluate("() => noteTodo.snapshot.items") == []
                identity = board.evaluate("() => currentDetail.knowledgeId")
                assert isinstance(identity, str) and identity
            screenshot = Path(descriptor["fixture"]).relative_to(Path.cwd()) / f"renderer-{args.stage}.png"
            page.screenshot(path=str(screenshot))
            print(f"PASS: actual installed VS Code renderer {args.stage}", flush=True)
        except Exception:
            for index, context in enumerate(browser.contexts):
                for number, current in enumerate(context.pages):
                    if not current.is_closed():
                        destination = Path(descriptor["fixture"]).relative_to(Path.cwd()) / f"failure-{args.stage}-{index}-{number}"
                        try:
                            current.screenshot(path=f"{destination}.png", timeout=3000)
                            Path(f"{destination}.txt").write_text(current.locator("body").inner_text(timeout=3000)[:16000])
                            for frame_index, child in enumerate(current.frames):
                                if child.locator("#composer,#note-todo").count():
                                    Path(f"{destination}-frame-{frame_index}.txt").write_text(child.locator("body").inner_text(timeout=3000)[:16000])
                                if child.locator("#note-todo").count():
                                    safe = child.evaluate("() => ({slug:noteTodo.slug,pendingKind:noteTodo.pending?.kind,pendingRequestId:noteTodo.pending?.requestId,error:noteTodo.error,workerSecretStatus:noteTodo.workerSecretStatus})")
                                    Path(f"{destination}-todo-{frame_index}.json").write_text(json.dumps(safe))
                        except Exception:
                            pass
            raise
        finally:
            browser.close()


if __name__ == "__main__":
    run()

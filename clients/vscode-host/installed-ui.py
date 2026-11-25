import json
import os
import re
import sys
import time
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

fixture = json.loads(Path(sys.argv[1]).read_text())
root = Path(fixture["root"])
source_picker_traces = []
SOURCE_TITLE = "Select a quiescent DISPOSABLE legacy copy (never the live Knowledge Root)"
DESTINATION_TITLE = "Choose a NEW isolated destination directory path (must not exist)"


def validate_source_picker_state(state, path):
    assert state["title"] == SOURCE_TITLE, state
    assert state["inputValue"] == path + "/", state
    assert state["idle"], state
    assert "notes" in state["labels"], state
    assert state["activeRows"] == [] and not state["activeDescendant"], state


def native_tool_count(text, expected):
    match = re.search(r"\bDiscovered\s+(\d+)\s+tools\b", text)
    assert match is not None, "Native MCP tool discovery count is missing"
    count = int(match.group(1))
    assert count == expected, f"Native tool count {count} differs from verified stdio count {expected}"
    return count


def native_channel_evidence(text, expected, stopped=False):
    normalized = re.sub(r"\s+", " ", text)
    start = re.search(r"\bStarting server pkm-v5(?=\s|$)", normalized)
    assert start is not None, "The exact native channel did not start pkm-v5"
    running = normalized.find("Connection state: Running", start.end())
    assert running >= 0, "Native MCP did not reach Running after Starting"
    discovery = re.search(r"\bDiscovered\s+\d+\s+tools\b", normalized[running:])
    assert discovery is not None, "Native MCP tool discovery did not follow Running"
    count = native_tool_count(discovery.group(), expected)
    stop = normalized.find("Connection state: Stopped", running + discovery.end())
    assert not stopped or stop >= 0, "Explicit native Stop did not produce Stopped after discovery"
    assert "Connection state: Error" not in normalized, normalized
    return {"started": True, "discoveredTools": count, "stopped": stop >= 0}


def stage(expected, timeout_seconds=None):
    if timeout_seconds is None:
        timeout_seconds = (
            95
            if expected == "native-chat-resolve"
            and fixture.get("nativeModels")
            and fixture.get("nativeModelRounds") == 48
            else 60
        )
    for _ in range(timeout_seconds * 10):
        try:
            progress = json.loads((root / "progress.json").read_text())
            assert progress["stage"] != "failed", progress.get("error")
            if progress["stage"] == expected:
                return
        except (FileNotFoundError, json.JSONDecodeError):
            pass
        time.sleep(0.1)
    raise AssertionError(f"Runner did not reach {expected}")


with sync_playwright() as playwright:
    browser = None
    page = None
    try:
        for _ in range(300):
            try:
                browser = playwright.chromium.connect_over_cdp(
                    f"http://127.0.0.1:{fixture['port']}", timeout=1000
                )
                if browser.contexts and browser.contexts[0].pages:
                    page = browser.contexts[0].pages[0]
                    break
            except Exception:
                pass
            time.sleep(0.1)
        assert page is not None, "Private VS Code CDP unavailable"
        page.set_default_timeout(15000)
        page.wait_for_load_state("domcontentloaded")
        page.locator(".monaco-workbench").wait_for()

        def source_state(widget):
            return widget.evaluate("""widget => {
                const input = widget.querySelector("input");
                const progress = widget.querySelector(".quick-input-progress");
                const rows = [...widget.querySelectorAll(".monaco-list-row")];
                return {
                    title: widget.querySelector(".quick-input-title")?.innerText,
                    inputValue: input.value,
                    breadcrumb: widget.querySelector(".quick-input-description")?.innerText,
                    idle: Boolean(progress && progress.getAttribute("aria-hidden") === "true"
                        && !progress.classList.contains("active")),
                    labels: rows.flatMap(row => [...row.querySelectorAll(".label-name")].map(label => label.innerText)),
                    list: rows.map(row => row.innerText),
                    activeRows: rows.filter(row => row.classList.contains("focused")
                        || row.getAttribute("aria-selected") === "true").map(row => row.innerText),
                    activeDescendant: input.getAttribute("aria-activedescendant")
                };
            }""")

        def await_json(path, timeout=15):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                try:
                    return json.loads(path.read_text())
                except (FileNotFoundError, json.JSONDecodeError):
                    page.wait_for_timeout(25)
            raise AssertionError(f"Native evidence handshake timed out: {path}")

        def picker(path, title):
            widget = page.locator(".quick-input-widget")
            widget.wait_for(state="visible")
            widget.get_by_text(title, exact=True).wait_for(state="visible")
            field = widget.locator("input").first
            if title == SOURCE_TITLE:
                assert path == fixture["source"] and str(Path(path).resolve(strict=True)) == path
                phase = json.loads((root / "progress.json").read_text())["stage"]
                assert phase in ["preview-deny", "preview-accept"]
                trace = {"phase": phase, "before": source_state(widget), "pageUrl": page.url,
                         "pages": [{"url": candidate.url, "title": candidate.title()}
                                   for candidate in browser.contexts[0].pages]}
                source_picker_traces.append(trace)
                editor_args = Path(f"/proc/{fixture['editorPid']}/cmdline").read_bytes().decode().split("\0")
                assert f"--user-data-dir={root}/u" in editor_args
                assert f"--extensions-dir={root}/x" in editor_args
                namespaces = {
                    owner: {name: os.readlink(f"/proc/{pid}/ns/{name}") for name in ["user", "mnt", "net"]}
                    for owner, pid in [("ui", os.getpid()), ("editor", fixture["editorPid"])]
                }
                assert namespaces["ui"] == namespaces["editor"], namespaces
                trace.update({"editorPid": fixture["editorPid"], "editorArgs": editor_args,
                              "namespaces": namespaces})
                expect(widget.locator(".quick-input-progress")).to_have_attribute("aria-hidden", "true")
                field.fill(path + "/")
                expect(field).to_have_value(path + "/")
                expect(widget.locator(".quick-input-progress")).to_have_attribute("aria-hidden", "true")
                expect(widget.locator(".monaco-list-row").filter(
                    has=page.get_by_text("notes", exact=True)).first).to_be_visible()
                # SimpleFileDialog navigates a focused folder on Enter; zero active items selects its current path.
                expect(widget.locator(".monaco-list-row.focused, .monaco-list-row[aria-selected='true']")).to_have_count(0)
                trace["beforeAccept"] = source_state(widget)
                validate_source_picker_state(trace["beforeAccept"], path)
                info = os.stat(path)
                trace["selectionTimeStat"] = {"path": path, "dev": info.st_dev, "ino": info.st_ino,
                                              "mode": info.st_mode, "mtimeNs": info.st_mtime_ns}
                nonce = str(time.time_ns())
                (root / f"source-picker-{phase}-request.json").write_text(json.dumps({
                    "nonce": nonce, "source": path,
                }))
                native = await_json(root / f"source-picker-{phase}-response.json")
                trace["nativeFileService"] = native
                assert native["nonce"] == nonce and native["source"] == path
                trace["immediatelyBeforeAccept"] = source_state(widget)
                validate_source_picker_state(trace["immediatelyBeforeAccept"], path)
                (root / "source-picker-diagnostics.json").write_text(json.dumps(source_picker_traces))
                field.press("Enter")
                page.wait_for_function("""sourceTitle => {
                    const widget = document.querySelector(".quick-input-widget");
                    const title = widget?.querySelector(".quick-input-title")?.innerText;
                    return title && title !== sourceTitle;
                }""", arg=SOURCE_TITLE)
                trace["afterAccept"] = source_state(widget)
                assert trace["afterAccept"]["title"] == DESTINATION_TITLE, trace
                (root / "source-picker-diagnostics.json").write_text(json.dumps(source_picker_traces))
                return
            field.fill(path)
            field.press("Enter")

        def preview():
            picker(fixture["source"], SOURCE_TITLE)
            picker(fixture["destination"], DESTINATION_TITLE)
            picker(fixture["node"], "Select trusted Node.js executable (>=22.18, node:sqlite required)")
            picker(fixture["python"], "Select trusted Python executable for atomic no-replace publication")
            inspection = page.locator(".monaco-dialog-box")
            page.get_by_role("button", name="Inspect disposable copy", exact=True).wait_for(state="visible")
            detail = inspection.inner_text()
            actual_source = re.search(r"(?m)^Source:\s*(.+)$", detail).group(1).strip()
            actual_destination = re.search(r"(?m)^Destination:\s*(.+)$", detail).group(1).strip()
            assert actual_source == fixture["source"], detail
            assert actual_destination == fixture["destination"], detail
            trace = source_picker_traces[-1]
            trace["nativeInspectionDialog"] = detail
            trace["selectedSourceUriFromNativeDialog"] = Path(actual_source).as_uri()
            page.get_by_role("button", name="Inspect disposable copy", exact=True).click()
            page.get_by_text(
                "Review the read-only plan in pkm-v5 Experimental output", exact=False
            ).last.wait_for(state="visible")
            clear_notifications()
            output = page.locator('.monaco-editor[data-uri^="output:"]')
            output.click()
            page.keyboard.press("Control+a")
            page.keyboard.press("Control+c")
            phase = trace["phase"]
            (root / f"preview-source-{phase}-copied.json").write_text('{"copied":true}')
            verified = await_json(root / f"preview-source-{phase}-verified.json")
            assert verified["passed"] and verified["source"] == fixture["source"]
            assert verified["selectedSourceUri"] == trace["selectedSourceUriFromNativeDialog"]
            assert verified["fingerprint"] == trace["nativeFileService"]["expectedFingerprint"]
            trace["verifiedNativePreview"] = verified
            (root / "source-picker-diagnostics.json").write_text(json.dumps(source_picker_traces))

        def clear_notifications():
            page.keyboard.press("Control+Shift+P")
            widget = page.locator(".quick-input-widget")
            widget.wait_for(state="visible")
            widget.locator("input").first.fill(">Notifications: Clear All Notifications")
            page.keyboard.press("Enter")
            widget.wait_for(state="hidden")

        if fixture.get("coldComponent"):
            trash_recovery = fixture.get("nativeOriginalTrashRecoveryEpoch")
            todo_recovery = fixture.get("nativeOriginalTodoRecoveryEpoch")
            recovery_decision = fixture.get("nativePrivateResourceRecoveryEpoch") or trash_recovery or todo_recovery
            if recovery_decision:
                assert recovery_decision in ["deny", "approve"]
            stage(f"native-todo-recovery-{recovery_decision}-attach" if todo_recovery else
                  f"native-trash-recovery-{recovery_decision}-attach" if trash_recovery else
                  f"native-recovery-{recovery_decision}-attach" if recovery_decision else "native-cold-attach")
            dialog = page.locator(".monaco-dialog-box")
            dialog.get_by_role("button", name="Attach native producer", exact=True).wait_for(state="visible")
            assert fixture["coldComponent"]["root"] in dialog.inner_text()
            dialog.get_by_role("button", name="Attach native producer", exact=True).click()
            script_segment = fixture.get("nativeScriptSegment")
            if script_segment:
                assert script_segment in ["deny", "approve"]
                stage(f"native-script-{script_segment}-effects-complete")
                evidence = json.loads((root / f"native-script-{script_segment}-effects.json").read_text())
                assert evidence["passed"] and evidence["componentClosed"] and evidence["segment"] == script_segment
                assert evidence["runId"] == fixture["nativeScriptEpochRunId"]
                assert evidence["sourceRoot"] == fixture["coldComponent"]["root"]
                assert evidence["actualInstalledScriptRead"] == (script_segment == "approve")
                (root / f"ui-native-script-{script_segment}-passed.json").write_text(json.dumps({
                    "passed": True, "actualNativeUi": True, "segment": script_segment,
                    "runId": fixture["nativeScriptEpochRunId"], "sourceRoot": fixture["coldComponent"]["root"],
                }))
                print(f"PASS actual frozen Script editor segment: {script_segment}")
                sys.exit(0)
            if fixture.get("nativeMemory") or fixture.get("nativeTodoAssignment") or fixture.get("nativeManagedTask"):
                dialog.get_by_role("button", name="Allow this native model request", exact=True).wait_for(state="visible")
                assert fixture["coldComponent"]["root"] in dialog.inner_text()
                dialog.get_by_role("button", name="Allow this native model request", exact=True).click()
            dialog.get_by_role("button", name="Approve this request", exact=True).wait_for(state="visible")
            assert "read public content" in dialog.inner_text()
            assert fixture["coldComponent"]["root"] in dialog.inner_text()
            dialog.get_by_role("button", name="Approve this request", exact=True).click()
            if recovery_decision:
                if todo_recovery:
                    stage(f"native-todo-recovery-{recovery_decision}-complete")
                    evidence = json.loads((root / f"native-todo-recovery-{recovery_decision}-effects.json").read_text())
                    assert evidence["passed"] and evidence["epochClosed"] and evidence["decision"] == recovery_decision
                    assert evidence["runId"] == fixture["nativeTodoRecoveryRunId"]
                    assert evidence["sourceRoot"] == fixture["coldComponent"]["root"]
                    (root / f"ui-todo-recovery-{recovery_decision}-passed.json").write_text(json.dumps({
                        "passed": True, "actualNativeUi": True, "decision": recovery_decision,
                        "runId": fixture["nativeTodoRecoveryRunId"], "sourceRoot": fixture["coldComponent"]["root"],
                    }))
                    print(f"PASS actual fresh Todo recovery epoch: {recovery_decision}")
                    sys.exit(0)
                if trash_recovery:
                    stage(f"native-trash-recovery-{recovery_decision}-complete")
                    evidence = json.loads((root / f"native-trash-recovery-{recovery_decision}-effects.json").read_text())
                    assert evidence["passed"] and evidence["epochClosed"] and evidence["decision"] == recovery_decision
                    assert evidence["runId"] == fixture["nativeTrashRecoveryRunId"]
                    assert evidence["sourceRoot"] == fixture["coldComponent"]["root"]
                    (root / f"ui-trash-recovery-{recovery_decision}-passed.json").write_text(json.dumps({
                        "passed": True, "actualNativeUi": True, "decision": recovery_decision,
                        "runId": fixture["nativeTrashRecoveryRunId"], "sourceRoot": fixture["coldComponent"]["root"],
                    }))
                    print(f"PASS actual fresh Trash recovery epoch: {recovery_decision}")
                    sys.exit(0)
                stage(f"native-recovery-{recovery_decision}-complete")
                evidence = json.loads((root / f"native-recovery-{recovery_decision}-effects.json").read_text())
                assert evidence["passed"] and evidence["epochClosed"] and evidence["decision"] == recovery_decision
                (root / f"ui-recovery-{recovery_decision}-passed.json").write_text('{"passed":true,"actualNativeUi":true}')
                print(f"PASS actual fresh recovery epoch: {recovery_decision}")
                sys.exit(0)
            skill_steps = [
                ("native-cold-note-deny", "Deny"),
                ("native-cold-note-write", "Approve this request"),
                ("native-cold-skill-create", "Approve this request"),
                ("native-cold-skill-update", "Approve this request"),
            ]
            if fixture.get("nativeSkillBasic"):
                skill_steps.append(("native-cold-skill-overwrite", "Approve this request"))
            for phase, choice in skill_steps:
                stage(phase)
                dialog = page.locator(".monaco-dialog-box")
                if fixture.get("nativeSkillBasic"):
                    expected_tool = {
                        "native-cold-note-deny": "update_note",
                        "native-cold-note-write": "update_note",
                        "native-cold-skill-create": "add_skill",
                        "native-cold-skill-update": "update_skill",
                        "native-cold-skill-overwrite": "add_skill",
                    }[phase]
                    dialog.get_by_text(f"Allow PKM v5 {expected_tool} for this exact request?", exact=True).wait_for(state="visible")
                dialog.get_by_role("button", name=choice, exact=True).wait_for(state="visible")
                assert fixture["coldComponent"]["root"] in dialog.inner_text()
                handle = dialog.element_handle() if fixture.get("nativeSkillBasic") else None
                text = dialog.inner_text() if handle else None
                dialog.get_by_role("button", name=choice, exact=True).click()
                if handle:
                    page.wait_for_function(
                        "(v)=>!v.node.isConnected||v.node.offsetParent===null||v.node.innerText!==v.text",
                        arg={"node": handle, "text": text},
                    )
            stage("native-cold-effects-complete", timeout_seconds=300 if fixture.get("nativePrivateResourceLifecycle") else 60)
            assert json.loads((root / "cold-component-effects-passed.json").read_text())["passed"]
            (root / "ui-cold-passed.json").write_text('{"passed":true,"actualNativeUi":true}')
            print("PASS actual cold bootstrap/native Core effects; editor must exit before B1/restore")
            sys.exit(0)

        stage("cancel-source")
        page.locator(".quick-input-widget").wait_for(state="visible")
        page.keyboard.press("Escape")
        stage("preview-deny")
        preview()
        stage("deny-confirm")
        page.get_by_role("button", name="Cancel", exact=True).click()
        stage("preview-accept")
        preview()
        stage("accept-confirm")
        body = page.locator(".monaco-dialog-box").inner_text()
        assert fixture["source"] in body and fixture["destination"] in body
        digest = re.search(r"Plan SHA-256:\s*([a-f0-9]{64})", body).group(1)
        page.get_by_role("button", name="Import exact inspected plan", exact=True).click()
        page.get_by_text("Isolated import published. No service", exact=False).last.wait_for(state="visible")
        clear_notifications()
        stage("published")
        output = page.locator('.monaco-editor[data-uri^="output:"]')
        output.click()
        page.keyboard.press("Control+a")
        page.keyboard.press("Control+c")
        (root / "ui-copied.json").write_text(json.dumps({"planSha256": digest}))
        for _ in range(150):
            try:
                assert json.loads((root / "output-verified.json").read_text())["passed"]
                break
            except FileNotFoundError:
                time.sleep(0.1)
        else:
            raise AssertionError("Installed runner did not verify real Output clipboard")
        (root / "ui-import-passed.json").write_text(json.dumps({"passed": True, "planSha256": digest}))
        if fixture.get("nativeIdentity"):
            stage("native-identity-enroll")
            dialog = page.locator(".monaco-dialog-box")
            dialog.wait_for(state="visible")
            assert "Old extension credentials are not read or copied" in dialog.inner_text()
            dialog.get_by_role("button", name="Enroll native identity", exact=True).click()
            stage("native-attachment-confirm")
            dialog = page.locator(".monaco-dialog-box")
            dialog.wait_for(state="visible")
            assert fixture["source"] in dialog.inner_text()
            assert "authenticates attachment only" in dialog.inner_text()
            dialog.get_by_role("button", name="Attach native producer", exact=True).click()
            for phase, choice in [
                ("native-request-admission", "Approve this request"),
                ("native-request-deny", "Deny"),
                ("native-request-approve", "Approve this request"),
            ]:
                stage(phase)
                dialog = page.locator(".monaco-dialog-box")
                dialog.wait_for(state="visible")
                assert fixture["source"] in dialog.inner_text()
                dialog.get_by_role("button", name=choice, exact=True).click()
            stage("native-request-cancel")
            dialog = page.locator(".monaco-dialog-box")
            dialog.wait_for(state="visible")
            assert "late-native-click-must-not-authorize" in dialog.inner_text()
            (root / "native-request-cancel-visible.json").write_text('{"visible":true}')
            await_json(root / "native-request-cancelled.json")
            dialog.get_by_role("button", name="Approve this request", exact=True).click()
            (root / "native-request-late-click.json").write_text('{"clicked":true}')
            if fixture.get("nativeModels"):
                for phase in ["native-model-enable", "native-model-select", "native-model-stream",
                              "native-model-select-execution", "native-model-execution",
                              "native-chat-resolve", "native-chat-authorize"]:
                    stage(phase)
                    dialog = page.locator(".monaco-dialog-box")
                    dialog.get_by_role("button", name="Allow this native model request", exact=True).wait_for(state="visible")
                    assert fixture["source"] in dialog.inner_text()
                    dialog.get_by_role("button", name="Allow this native model request", exact=True).click()
                stage("native-chat-presentation")
                binding = page.locator(".monaco-editor .view-lines").filter(has_text="PKM native Chat binding").first
                binding.wait_for(state="visible")
                binding.get_by_text("Permission: protective", exact=True).wait_for(state="visible")
                (root / "native-chat-binding-ui-passed.json").write_text('{"passed":true,"readonlyBinding":true}')
                stage("native-chat-cancel")
                dialog = page.locator(".monaco-dialog-box")
                dialog.get_by_role("button", name="Allow this native model request", exact=True).wait_for(state="visible")
                assert "Cancel this exact owned native PKM Chat request" in dialog.inner_text()
                (root / "native-chat-cancel-visible.json").write_text('{"visible":true}')
                await_json(root / "native-chat-cancelled.json")
                dialog.get_by_role("button", name="Allow this native model request", exact=True).click()
                (root / "native-chat-late-click.json").write_text('{"clicked":true}')
                for phase, title in [
                    ("native-action-enable", "Enable separate native Action approvals"),
                    ("native-action-source", "Admit this exact original Action source/state capsule"),
                    ("native-action-invocation", "Execute this exact admitted native Action invocation"),
                ]:
                    stage(phase)
                    dialog = page.locator(".monaco-dialog-box")
                    button = dialog.get_by_role("button", name="Approve this exact Action request", exact=True)
                    button.wait_for(state="visible")
                    assert title in dialog.inner_text()
                    assert fixture["source"] in dialog.inner_text()
                    button.click()
                stage("native-action-cancel")
                dialog = page.locator(".monaco-dialog-box")
                button = dialog.get_by_role("button", name="Approve this exact Action request", exact=True)
                button.wait_for(state="visible")
                assert "Execute this exact admitted native Action invocation" in dialog.inner_text()
                (root / "native-action-cancel-visible.json").write_text('{"visible":true}')
                await_json(root / "native-action-cancelled.json")
                button.click()
                (root / "native-action-late-click.json").write_text('{"clicked":true}')
                stage("native-action-revoke")
                action_status = page.get_by_text("PKM Action approvals", exact=True)
                action_status.wait_for(state="visible")
                action_status.click()
                action_status.wait_for(state="hidden")
                (root / "native-action-revoked-ui.json").write_text('{"revoked":true}')
                stage("native-model-complete")
                assert json.loads((root / "native-model-rpc-passed.json").read_text())["passed"]
                (root / "native-model-ui-passed.json").write_text('{"passed":true,"actualNativeUi":true}')
            stage("native-identity-restored")
            restored = json.loads((root / "native-identity-passed.json").read_text())
            assert restored["passed"] and restored["keyContinuityAcrossNativeReload"]
            (root / "native-identity-ui-passed.json").write_text(json.dumps({
                "passed": True, "actualNativeModal": True, "reloadObserved": True,
            }))
        native_mcp = None
        if fixture.get("sideBySide"):
            stage("native-mcp-empty-discovery")
            page.keyboard.press("Control+Shift+P")
            empty_widget = page.locator(".quick-input-widget")
            empty_widget.wait_for(state="visible")
            empty_widget.locator("input").first.fill(">MCP: List Servers")
            empty_widget.get_by_text("MCP: List Servers", exact=True).wait_for(state="visible")
            page.keyboard.press("Enter")
            page.wait_for_timeout(1000)
            empty_listing = empty_widget.inner_text() if empty_widget.is_visible() else ""
            assert not empty_widget.get_by_text("pkm-v5", exact=True).is_visible(), empty_listing
            page.keyboard.press("Escape")
            (root / "native-mcp-empty-ui.json").write_text(json.dumps({
                "passed": True, "listing": empty_listing,
                "observation": "real native MCP list has no pkm-v5 server before global managedRoot is set",
            }))
            stage("native-mcp-discovery")
            protocol = json.loads((root / "side-by-side-protocol.json").read_text())
            expected_tools = len(protocol["toolNames"])

            def native_channel():
                logs = list((root / "u/logs").glob(
                    "*/window*/mcpServer.pkm-nonproduction.pkm-v5pkm-v5.log"
                ))
                assert len(logs) <= 1, "Ambiguous owned native MCP log channel"
                if not logs:
                    return None, ""
                channel = logs[0]
                assert not channel.is_symlink()
                assert channel.resolve().is_relative_to((root / "u/logs").resolve())
                return str(channel), channel.read_text()

            def server_options():
                page.keyboard.press("Control+Shift+P")
                widget = page.locator(".quick-input-widget")
                widget.wait_for(state="visible")
                widget.locator("input").first.fill(">MCP: List Servers")
                widget.get_by_text("MCP: List Servers", exact=True).wait_for(state="visible")
                page.keyboard.press("Enter")
                row = widget.locator(".monaco-list-row").filter(
                    has=page.get_by_text("pkm-v5", exact=True)
                ).first
                row.wait_for(state="visible")
                listing = widget.inner_text()
                assert not re.search(r"(?m)^\s*pkm\s*$", listing), listing
                row.click()
                widget.get_by_text("Start Server", exact=True).or_(
                    widget.get_by_text("Stop Server", exact=True)
                ).first.wait_for(state="visible")
                return widget, listing

            widget, listing = server_options()
            _, before_start_log = native_channel()
            assert "Starting server pkm-v5" not in before_start_log
            widget.get_by_text("Start Server", exact=True).click()
            trust_dialogs = []
            started_output = None
            for _ in range(1200):
                dialog = page.locator(".monaco-dialog-box")
                if dialog.count() and dialog.is_visible():
                    body = dialog.inner_text()
                    assert "pkm-v5" in body, body
                    assert (fixture["sideBySide"]["managedRoot"] in body
                            or fixture["python"] in body), body
                    trust = dialog.get_by_role(
                        "button", name=re.compile(r"^(Trust|Trust and Run)$")
                    )
                    assert trust.count() == 1, body
                    trust_dialogs.append(body)
                    trust.click()
                output = page.locator('.monaco-editor[data-uri^="output:"] .view-lines')
                text = output.inner_text() if output.count() else ""
                assert not re.search(
                    r"Connection state: Error|Failed to start|definition is stale or changed|MCP_API_UNAVAILABLE",
                    text, re.IGNORECASE
                ), text
                if re.search(r"Discovered\s+\d+\s+tools", text):
                    native_tool_count(text, expected_tools)
                    channel_path, channel_log = native_channel()
                    if re.search(r"Discovered\s+\d+\s+tools", channel_log):
                        native_channel_evidence(channel_log, expected_tools)
                        started_output = text
                        break
                page.wait_for_timeout(50)
            assert started_output is not None, "Native MCP did not complete real tool discovery"
            count = native_tool_count(started_output, expected_tools)
            (root / "native-mcp-running.json").write_text(json.dumps({
                "ready": True, "label": "pkm-v5", "discoveredTools": count,
                "managedRoot": fixture["sideBySide"]["managedRoot"],
            }))
            print("READY real native pkm-v5 MCP running in owned isolated profile", flush=True)
            for _ in range(300):
                if (root / "native-mcp-processes-recorded.json").exists():
                    assert json.loads((root / "native-mcp-processes-recorded.json").read_text())["passed"]
                    break
                page.wait_for_timeout(50)
            else:
                raise AssertionError("Extension host did not record its actual owned MCP child processes")
            widget, running_listing = server_options()
            widget.get_by_text("Stop Server", exact=True).click()
            stopped_output = None
            for _ in range(600):
                output = page.locator('.monaco-editor[data-uri^="output:"] .view-lines')
                text = output.inner_text() if output.count() else ""
                channel_path, channel_log = native_channel()
                if re.search(r"Connection\s+state:\s+Stopped", text):
                    native_channel_evidence(channel_log, expected_tools, stopped=True)
                    stopped_output = text
                    break
                assert not re.search(r"Connection\s+state:\s+Error", text), text
                page.wait_for_timeout(50)
            assert stopped_output is not None, "Native owned MCP did not stop"
            os.kill(fixture["editorPid"], 0)
            assert page.evaluate("Boolean(document.querySelector('.monaco-workbench'))")
            native_mcp = {
                "passed": True, "discoveredLabel": "pkm-v5",
                "discovery": "real workbench MCP: List Servers, not a provider Map mock",
                "listing": listing, "runningListing": running_listing,
                "started": True, "stopped": True, "discoveredTools": count,
                "startedOutput": started_output, "stoppedOutput": stopped_output,
                "nativeChannelPath": channel_path, "nativeChannelLog": channel_log,
                "explicitStartAction": True, "explicitStopAction": True,
                "editorPid": fixture["editorPid"], "editorAliveAtStop": True,
                "trustDialogs": trust_dialogs,
            }
            (root / "native-mcp-ui-verified.json").write_text(json.dumps(native_mcp))
            stage("native-mcp-complete")
        preflight_safety = (fixture.get("coordinator") or {}).get("mode") == "preflight-safety"
        if preflight_safety:
            stage("coordinator-preflight-ready")
            page.evaluate("""() => {
                const visibleDialogs = new Set();
                let samples = 0, mutations = 0;
                const startedAt = new Date().toISOString();
                const started = performance.now();
                const sample = () => {
                    samples++;
                    for (const element of document.querySelectorAll(".monaco-dialog-box")) {
                        const style = getComputedStyle(element);
                        if (element.getClientRects().length && style.visibility !== "hidden" && style.display !== "none")
                            visibleDialogs.add(element.innerText);
                    }
                    return {visibleDialogs: [...visibleDialogs], samples, mutations, startedAt,
                            durationMs: performance.now() - started};
                };
                const observer = new MutationObserver(records => { mutations += records.length; sample(); });
                observer.observe(document.documentElement, {subtree: true, childList: true, attributes: true});
                const timer = setInterval(sample, 25);
                window.__pkmPreflightDialogs = {
                    sample,
                    stop() { clearInterval(timer); observer.disconnect(); return sample(); }
                };
                sample();
            }""")
            assert page.evaluate("window.__pkmPreflightDialogs.sample().visibleDialogs") == []
            (root / "preflight-dialog-monitor-ready.json").write_text(json.dumps({"ready": True}))
            for _ in range(600):
                observation = page.evaluate("window.__pkmPreflightDialogs.sample()")
                assert observation["visibleDialogs"] == [], observation["visibleDialogs"]
                try:
                    progress = json.loads((root / "progress.json").read_text())
                except (FileNotFoundError, json.JSONDecodeError):
                    time.sleep(0.05)
                    continue
                assert progress["stage"] != "failed", progress.get("error")
                if progress["stage"] == "coordinator-preflight-observed":
                    break
                time.sleep(0.05)
            else:
                raise AssertionError("Native preflight command did not produce its exact safety outcome")
            page.wait_for_timeout(250)
            observation = page.evaluate("window.__pkmPreflightDialogs.stop()")
            assert observation["visibleDialogs"] == [], observation["visibleDialogs"]
            assert observation["samples"] > 1 and observation["durationMs"] >= 250
            (root / "preflight-ui-verified.json").write_text(json.dumps({"passed": True, **observation}))
            stage("coordinator-preflight-complete")
            assert json.loads((root / "coordinator-preflight-passed.json").read_text())["passed"]
        elif fixture.get("coordinator"):
            def authorize_coordinator(operation):
                page.get_by_role("button", name="Allow Selected Snapshot Operations", exact=True).wait_for(state="visible")
                body = page.locator(".monaco-dialog-box").inner_text()
                assert fixture["coordinator"]["root"] in body
                page.get_by_role("button", name="Allow Selected Snapshot Operations", exact=True).click()
                button = page.get_by_role("button", name="Approve exact same-root transition", exact=True)
                button.wait_for(state="visible")
                body = page.locator(".monaco-dialog-box").inner_text()
                preview = json.loads((root / "coordinator-preview.json").read_text())
                assert f"Operation: {operation}" in body
                for value in [preview["root"], preview["profile"], preview["buildId"], preview["planSha256"]]:
                    assert value in body
                button.click()

            stage("coordinator-transition")
            authorize_coordinator("adopt")
            stage("coordinator-rollback")
            authorize_coordinator("rollback-committed")
            stage("coordinator-complete")
            assert json.loads((root / "coordinator-passed.json").read_text())["passed"]
        (root / "ui-passed.json").write_text(json.dumps({"passed": True, "planSha256": digest,
                                                     "sourcePickerTraces": source_picker_traces,
                                                     "nativeMcp": native_mcp,
                                                     "sameRootCoordinator": bool(fixture.get("coordinator")) and not preflight_safety,
                                                     "coordinatorPreflightSafety": preflight_safety}))
        print("PASS real installed-host workbench dialogs and preview/receipt output")
    except Exception:
        (root / "source-picker-diagnostics.json").write_text(json.dumps(source_picker_traces))
        if page is not None:
            try:
                (root / "ui-dom.html").write_text(page.content())
                (root / "ui-text.txt").write_text(page.locator("body").inner_text())
            except Exception:
                pass
        raise
    finally:
        if browser is not None:
            browser.close()

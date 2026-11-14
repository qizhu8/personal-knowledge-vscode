import base64
import json
from pathlib import Path
import sys
import uuid

from playwright.sync_api import expect, sync_playwright


settings = json.loads(sys.stdin.readline())


def checkpoint(name):
    print(json.dumps({"checkpoint": name}), flush=True)
    assert json.loads(sys.stdin.readline())["ready"]


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    try:
        page = browser.new_page(viewport={"width": 1440, "height": 1000})
        page.set_default_timeout(8000)
        page.set_default_navigation_timeout(10000)
        errors, requests = [], []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("request", lambda request: requests.append(request.url))
        assert page.goto(settings["url"], wait_until="networkidle").status == 200
        page.get_by_label("Access token").fill(settings["token"])
        page.get_by_role("button", name="Connect", exact=True).click()
        expect(page.locator(".connection-status")).to_contain_text("Connected")
        lifecycle = page.get_by_role("region", name="Knowledge lifecycle", exact=True)
        expect(lifecycle).to_be_visible()
        assert lifecycle.evaluate("(element) => getComputedStyle(element).backgroundColor") == "rgb(27, 37, 31)"
        assert lifecycle.evaluate("(element) => getComputedStyle(element).color") == "rgb(238, 234, 222)"
        assert page.get_by_role("link", name="Lifecycle", exact=True).get_attribute("href") == "#knowledge-lifecycle"
        notice = lifecycle.locator("[role=status]").last
        alert = lifecycle.locator("[role=alert]")
        assert page.get_by_label("Access token").input_value() == ""
        page.get_by_label("Project ID", exact=True).fill("project-feature")
        page.get_by_label("Run ID", exact=True).fill("batch09-intermediate")
        page.get_by_role("button", name="Open run", exact=True).click()
        intermediate = page.locator(".result-card").filter(has_text="worker-1").first
        intermediate.wait_for()
        before_intermediate = intermediate.inner_text()
        assert "pending" in before_intermediate and "delivery" in before_intermediate

        def section(heading):
            return lifecycle.locator("section").filter(has=page.get_by_role("heading", name=heading, exact=True)).last

        create_panel = section("Create specialized document")

        def create(kind, title, body, extra=None):
            create_panel.get_by_label("New Knowledge kind").select_option(kind)
            create_panel.get_by_label("Title or Skill name", exact=True).fill(title)
            create_panel.get_by_label("Category folder", exact=True).fill("browser")
            create_panel.get_by_label("Markdown content", exact=True).fill(body)
            for label, value in (extra or {}).items():
                create_panel.get_by_label(label, exact=True).fill(value)
            create_panel.get_by_role("button", name="Create", exact=True).click()
            expect(notice).to_contain_text("Created ")

        create("note", "Browser Note", "Browser-created note")
        create("skill", "Browser Skill", "Browser-created skill", {"Source project": "isolated-fixture"})
        create("research", "Browser Source", "Synthetic citation source", {"Research kind": "paper"})

        def call(operation, arguments, read=True):
            response = page.request.post(
                settings["url"] + "/v1/" + ("capability_read" if read else "capability_call"),
                headers={"authorization": "Bearer " + settings["token"], "content-type": "application/json"},
                data=json.dumps({"operation": operation, "version": 1, "arguments": arguments}))
            result = response.json()
            assert response.status == 200 and "result" in result, result
            return result["result"]

        source = next(item for item in call("knowledge.research.list", {})["items"] if item["title"] == "Browser Source")
        create("research", "Browser Citation", "Synthetic claim", {
            "Research kind": "idea",
            "Citations (JSON array)": json.dumps([{"paper": source["slug"], "note": "Initial support"}])})

        def edit(kind, title):
            lifecycle.get_by_label("Knowledge kind", exact=True).select_option(kind)
            lifecycle.get_by_role("button", name="Load entries", exact=True).click()
            expect(notice).to_contain_text("entries loaded")
            lifecycle.get_by_role("button", name=title + " ·", exact=False).click()
            expect(lifecycle.get_by_role("heading", name=title + " ·", exact=False)).to_be_visible()
            editor = lifecycle.locator("form").filter(has=page.get_by_role("button", name="Save specialized fields", exact=True))
            editor.wait_for()
            return editor

        editor = edit("note", "Browser Note")
        editor.get_by_label("Markdown content", exact=True).fill("Browser note edited")
        editor.get_by_role("button", name="Save specialized fields", exact=True).click()
        expect(notice).to_contain_text("Saved by the native server")
        editor = edit("skill", "Browser Skill")
        editor.get_by_label("Description", exact=True).fill("Skill edited")
        editor.get_by_role("button", name="Save specialized fields", exact=True).click()
        expect(notice).to_contain_text("Saved by the native server")
        editor = edit("research", "Browser Citation")
        editor.get_by_label("Citations", exact=True).fill(json.dumps([{"paper": source["slug"], "note": "Reviewed support"}]))
        citing = next(item for item in call("knowledge.document.list", {})["items"] if item["title"] == "Browser Citation")
        call("knowledge.document.update", {
            "operationId": str(uuid.uuid4()), "id": citing["id"], "expectedRevision": citing["revision"],
            "expectedSha256": citing["sha256"], "title": citing["title"], "content": "Concurrent research source"}, False)
        editor.get_by_role("button", name="Save specialized fields", exact=True).click()
        expect(alert).to_contain_text("No overwrite was made")
        lifecycle.get_by_role("button", name="Rebase draft onto latest (review before saving)", exact=True).click()
        expect(notice).to_contain_text("nothing was written")
        assert editor.get_by_label("Markdown content", exact=True).input_value() == "Concurrent research source"
        unmodified = next(item for item in call("knowledge.research.list", {})["items"] if item["title"] == "Browser Citation")
        assert unmodified["cites"] == [{"paper": source["slug"], "note": "Initial support"}]
        editor.get_by_role("button", name="Save specialized fields", exact=True).click()
        expect(notice).to_contain_text("Saved by the native server")

        editor = edit("note", "Pinned edit")
        assert "<script>unsafe()</script>" in lifecycle.locator("pre").first.inner_text()
        assert lifecycle.locator("script, img").count() == 0
        editor.get_by_label("Markdown content", exact=True).fill("Reviewed browser draft")
        pinned = call("knowledge.document.get", {"id": settings["conflictId"]})
        call("knowledge.document.update", {
            "operationId": str(uuid.uuid4()), "id": pinned["id"], "expectedRevision": pinned["revision"],
            "expectedSha256": pinned["sha256"], "title": pinned["title"], "content": "Concurrent native source"}, False)
        editor.get_by_role("button", name="Save specialized fields", exact=True).click()
        expect(alert).to_contain_text("No overwrite was made")
        assert call("knowledge.document.get", {"id": pinned["id"]})["content"] == "Concurrent native source"
        lifecycle.get_by_role("button", name="Rebase draft onto latest (review before saving)", exact=True).click()
        expect(notice).to_contain_text("nothing was written")
        assert editor.get_by_label("Markdown content", exact=True).input_value() == "Reviewed browser draft"
        assert call("knowledge.document.get", {"id": pinned["id"]})["content"] == "Concurrent native source"
        editor.get_by_role("button", name="Save specialized fields", exact=True).click()
        expect(notice).to_contain_text("Saved by the native server")

        assets = section("Paired assets")
        assets.get_by_label("Document ID", exact=True).fill(settings["pairedId"])
        assets.get_by_role("button", name="Load owned/referenced assets", exact=True).click()
        expect(notice).to_contain_text("resources discovered")
        payload_asset = assets.locator("article").filter(has_text="payload.bin")
        with page.expect_download() as download:
            payload_asset.get_by_role("button", name="Download pinned bytes", exact=True).click()
        downloaded = download.value
        assert downloaded.suggested_filename == "payload.bin"
        assert Path(downloaded.path()).read_bytes() == base64.b64decode(settings["assetBase64"])
        chunk = call("knowledge.asset.get", {
            "id": settings["pairedId"], "path": "Folder/Paired browser.assets/payload.bin",
            "expectedDocumentSha256": call("knowledge.document.get", {"id": settings["pairedId"]})["sha256"],
            "expectedDigest": settings["assetDigest"], "offset": 0, "length": 65536})
        assert base64.b64decode(chunk["data"]) == base64.b64decode(settings["assetBase64"])[:65536]
        mutable = assets.locator("article").filter(has_text="mutable.bin")
        mutable.get_by_label("New asset name for Folder/Paired browser.assets/mutable.bin", exact=True).fill("renamed.bin")
        mutable.get_by_role("button", name="Preview asset rename", exact=True).click()
        expect(notice).to_contain_text("rename preview is pinned")
        mutable.get_by_role("button", name="Rename pinned asset", exact=True).click()
        expect(notice).to_contain_text("Renamed Folder/Paired browser.assets/mutable.bin")
        assets.get_by_role("button", name="Load owned/referenced assets", exact=True).click()
        renamed = assets.locator("article").filter(has_text="renamed.bin")
        renamed.get_by_role("button", name="Preview asset delete", exact=True).click()
        expect(notice).to_contain_text("delete preview is pinned")
        renamed.get_by_role("button", name="Delete pinned asset", exact=True).click()
        expect(notice).to_contain_text("Deleted Folder/Paired browser.assets/renamed.bin")

        move = section("Move document and paired assets")
        for label, value in {"Document ID": settings["pairedId"], "Current Markdown path": "Folder/Paired browser.md",
                             "Destination Markdown path": "Folder/Renamed.md"}.items():
            move.get_by_label(label, exact=True).fill(value)
        move.get_by_role("button", name="Preview pinned move", exact=True).click()
        expect(notice).to_contain_text("No files were moved")
        move.get_by_role("button", name="Move document and paired assets", exact=True).click()
        expect(notice).to_contain_text("assets moved")
        checkpoint("document-moved")
        folder = section("Move a folder")
        folder.get_by_label("Current folder path").fill("Folder")
        folder.get_by_label("Destination folder path").fill("Moved")
        folder.get_by_role("button", name="Preview folder move", exact=True).click()
        expect(notice).to_contain_text("no files were moved")
        folder.get_by_role("button", name="Move folder", exact=True).click()
        expect(notice).to_contain_text("Folder moved")

        trash = section("Recoverable trash")
        trash.get_by_label("Document or folder path", exact=True).fill("Recover browser.md")
        trash.get_by_role("button", name="Preview recoverable trash", exact=True).click()
        expect(notice).to_contain_text("No files were changed")
        trash.get_by_role("button", name="Move to recoverable trash", exact=True).click()
        expect(notice).to_contain_text("Moved to recoverable trash")
        assert len(trash.get_by_label("Committed trash entry ID (UUID)").input_value()) == 36
        checkpoint("collision")
        trash.get_by_role("button", name="Restore this exact entry", exact=True).click()
        expect(alert).to_contain_text("Nothing was overwritten")
        checkpoint("remove-collision")
        trash.get_by_role("button", name="Restore this exact entry", exact=True).click()
        expect(notice).to_contain_text("Restored notes/Recover browser.md")
        assert intermediate.inner_text() == before_intermediate
        assert "state: active" in page.locator(".run-phase").inner_text()
        assert settings["token"] not in page.content()
        assert page.evaluate("() => Object.keys(localStorage).length + Object.keys(sessionStorage).length") == 0
        assert page.context.cookies() == []
        assert all(url.startswith(settings["url"] + "/") or url == settings["url"] for url in requests)
        screenshot_bytes = len(page.screenshot(full_page=True))
        page.get_by_role("button", name="Disconnect", exact=True).click()
        assert lifecycle.count() == 0
        assert not page.get_by_role("button", name="Send feedback", exact=True).is_enabled()
        assert page.goto(settings["readerUrl"], wait_until="networkidle").status == 200
        page.get_by_label("Access token").fill(settings["token"])
        page.get_by_role("button", name="Connect", exact=True).click()
        expect(page.locator(".connection-status")).to_contain_text("Connected")
        reader = page.get_by_role("region", name="Knowledge lifecycle", exact=True)
        expect(reader).to_contain_text("mutation forms are omitted")
        for label in ["Create", "Save specialized fields", "Move folder", "Move document and paired assets",
                      "Move to recoverable trash", "Restore this exact entry", "Preview asset rename",
                      "Rename pinned asset", "Preview asset delete", "Delete pinned asset"]:
            assert reader.get_by_role("button", name=label, exact=True).count() == 0
        reader.get_by_role("button", name="Load entries", exact=True).click()
        expect(reader.locator("[role=status]").last).to_contain_text("entries loaded")
        reader.get_by_role("button", name="Browser Note ·", exact=False).click()
        expect(reader).to_contain_text("no edit controls")
        assert not errors, errors
        print(json.dumps({"browser": "chromium", "screenshotBytes": screenshot_bytes, "errors": errors,
                          "sameOrigin": True, "readOnly": True, "intermediateUnaffected": True}), flush=True)
    finally:
        browser.close()

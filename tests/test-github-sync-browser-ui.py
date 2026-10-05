#!/usr/bin/env python3
import os

from playwright.sync_api import sync_playwright


def send(page, command, data):
    page.evaluate("""({command, data}) => window.dispatchEvent(
        new MessageEvent('message', {data: {command, data}}))""", {"command": command, "data": data})


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    page.goto(os.environ.get("PKM_PREVIEW_URL", "http://127.0.0.1:4178") + "/projects", wait_until="networkidle")
    page.locator('[data-workspace="settings"]').click()
    page.locator('.tab[data-tab="githubSync"]').click()

    old_attempt = "2026-09-30T20:00:00Z"
    new_attempt = "2026-09-30T21:00:00Z"
    old_state = {"status": "error", "phase": "fetch", "lastError": "old failure",
                 "lastAttemptAt": old_attempt, "activityAt": old_attempt}
    send(page, "githubSyncRuntimeState", {"targetId": "demo-github", "state": old_state})
    card = page.locator('.sub-broker-card', has_text="Knowledge Backup")
    button = card.locator('button[onclick*="githubSyncForce("]')
    assert "old failure" in card.inner_text()

    button.click()
    assert "Git lock" in card.locator('.github-sync-phase-current').inner_text()
    assert "old failure" not in card.inner_text()
    page.wait_for_function("window.__previewMessages.some(message => message.command === 'githubSyncRun')")
    send(page, "githubSyncRunQueued", {"targetId": "demo-github", "queued": True})
    send(page, "githubSyncState", {"runtime": {"demo-github": old_state}})
    assert "Git lock" in card.locator('.github-sync-phase-current').inner_text()
    assert "old failure" not in card.inner_text()

    send(page, "githubSyncState", {"runtime": {"demo-github": {
        "status": "queued", "phase": "authenticating", "detail": "Running in the shared leader window",
        "lastAttemptAt": new_attempt,
        "activityAt": "2026-09-30T21:00:01Z"}}})
    assert "Authentication" in card.locator('.github-sync-phase-current').inner_text()
    send(page, "githubSyncRuntimeState", {"targetId": "demo-github", "state": {
        "status": "queued", "phase": "fetch", "detail": "Running in the shared leader window",
        "lastAttemptAt": new_attempt,
        "activityAt": "2026-09-30T21:00:02Z"}})
    assert "Fetch / Pull" in card.locator('.github-sync-phase-current').inner_text()
    send(page, "githubSyncState", {"runtime": {"demo-github": old_state}})
    assert "Fetch / Pull" in card.locator('.github-sync-phase-current').inner_text()
    assert "old failure" not in card.inner_text()
    send(page, "githubSyncRuntimeState", {"targetId": "demo-github", "state": {
        "status": "syncing", "phase": "waiting-for-lock", "lastAttemptAt": new_attempt,
        "activityAt": "2026-09-30T21:00:01Z"}})
    assert "Fetch / Pull" in card.locator('.github-sync-phase-current').inner_text()
    send(page, "githubSyncRuntimeState", {"targetId": "demo-github", "state": {
        "status": "error", "phase": "fetch", "lastError": "current failure",
        "lastAttemptAt": new_attempt, "activityAt": "2026-09-30T21:00:03Z"}})
    assert "Fetch / Pull failed" in card.locator('.github-sync-phase-current').inner_text()
    assert "current failure" in card.inner_text()
    page.locator('.tab[data-tab="mcp"]').click()
    page.locator('.tab[data-tab="githubSync"]').click()
    page.wait_for_function("window.__previewMessages.some(message => message.command === 'githubSyncRuntimeSnapshot')")
    send(page, "githubSyncRuntimeSnapshot", {"demo-github": {
        "status": "scheduled", "phase": "scheduled", "lastAttemptAt": new_attempt,
        "activityAt": "2026-09-30T21:00:04Z"}})
    assert "Git lock" not in card.locator('.github-sync-phase-current').inner_text()
    page.evaluate("ask = () => {}")
    page.locator('[data-workspace="knowledge"]').click()
    page.locator('.tab[data-tab="notes"]').click()
    page.evaluate("""() => {
        state.tab = 'notes';
        state.search = '';
        state.folders = [];
        state.items = [
          {slug:'Adhoc/same',title:'Same',type:'general',category:'Adhoc'},
          {slug:'Adhoc/changed',title:'Changed',type:'general',category:'Adhoc'},
          {slug:'System/PKM/read-only',title:'Read Only',type:'general',category:'System/PKM'}
        ];
        renderList();
    }""")
    page.locator('.tree-cat-hdr[title="Adhoc"]').click()
    send(page, "githubSyncState", {
        "fingerprintsDeferred": False,
        "catalog": {"notes": [
            {"id": "Adhoc/same", "syncPath": "notes/Adhoc/same.md"},
            {"id": "Adhoc/changed", "syncPath": "notes/Adhoc/changed.md"}]},
        "fileShields": {"notes": {"notes/Adhoc/same.md": "green", "notes/Adhoc/changed.md": "yellow"}},
        "folderShields": {"notes": {"Adhoc": "yellow"}}})
    same = page.locator('[data-note-slug="Adhoc/same"] .github-sync-file-status')
    changed = page.locator('[data-note-slug="Adhoc/changed"] .github-sync-file-status')
    system = page.locator('[data-note-slug="System/PKM/read-only"] .github-sync-file-status')
    assert same.get_attribute('data-status') == 'green'
    assert changed.get_attribute('data-status') == 'yellow'
    assert system.get_attribute('data-status') == 'outline'
    assert 'File notes/Adhoc/changed.md' in changed.get_attribute('title')
    send(page, "githubSyncState", {"fingerprintsDeferred": True})
    assert changed.get_attribute('data-status') == 'yellow'
    for width in [1440, 390]:
        page.set_viewport_size({"width": width, "height": 1000})
        size = changed.evaluate("el => ({width: getComputedStyle(el).width, height: getComputedStyle(el).height, font: getComputedStyle(el).fontSize})")
        assert size == {"width": "5px", "height": "5px", "font": "5px"}, size
        assert changed.bounding_box()['width'] == 5
        page.screenshot(path=f"/tmp/pkm-github-file-markers-{width}.png")
    for width in [1440, 390]:
        page.set_viewport_size({"width": width, "height": 1000})
        page.evaluate("""() => {
            state.tab = 'notes';
            state.search = '';
            state.filter = 'all';
            state.folders = ['Projects', 'Projects/Nested', 'Project'];
            state.knowledgeTrash = [];
            state.items = [
              {slug:'Projects/Nested/Old',title:'Old',type:'general',category:'Projects/Nested'},
              {slug:'Project/Retained',title:'Retained',type:'general',category:'Project'}
            ];
            renderList();
        }""")
        assert page.locator('.tree-cat-hdr[title="Projects"]').count() == 1
        send(page, "knowledgeTrashResult", {
            "ok": True, "action": "moved", "area": "notes", "path": "Projects",
            "entry": {"id": "test-deleted-projects", "name": "Projects", "kind": "folder",
                      "originalPath": "Projects", "deletedAt": "2026-10-02T23:00:00Z"}})
        assert page.locator('.tree-cat-hdr[title="Projects"]').count() == 0
        assert page.locator('.tree-cat-hdr[title="Project"]').count() == 1
        assert page.evaluate("state.items.map(item => item.slug)") == ['Project/Retained']
        page.locator('#knowledge-trash-dock .knowledge-trash-dock-row').click()
        assert 'Projects' in page.locator('#knowledge-trash-dock').inner_text()
        assert page.locator('#knowledge-trash-dock').get_by_role('button', name='Restore', exact=True).is_visible()
        page.screenshot(path=f"/tmp/pkm-notes-trash-immediate-{width}.png")
    browser.close()

print("GitHub Sync browser phase/file indicators and immediate Notes Trash refresh passed")
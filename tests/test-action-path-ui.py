"""Migration remains an explicit editor action, never an automatic save."""

import json
import unittest
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]


class PathUiTests(unittest.TestCase):
    def test_preview_and_use_candidate_do_not_save_and_keep_local_rollback_evidence(self):
        definition = {"action_id": "test.paths", "version": 2, "implementations": [
            {"files": ["/publisher/source.py"], "args": ["/publisher/source.py"]}]}
        candidate = json.loads(json.dumps(definition))
        candidate["implementations"][0].update(files=["pkm://script/script_" + "a" * 24],
                                                args=["pkm://script/script_" + "a" * 24])
        state = {"graph": {"nodes": [], "edges": []}, "editorState": {
            "action_id": "test.paths", "name": "Path fixture", "language": "Python",
            "definition": definition, "files": [], "filename": "", "dirty": False,
            "content": json.dumps(definition), "content_hash": "original"}}
        report = {"ok": True, "name": "Path fixture", "id": "test.paths",
                  "candidate": candidate, "original": definition, "original_sha256": "original_digest",
                  "changes": [{"field": "implementations[0].files[0]", "before": "/publisher/source.py",
                               "after": candidate["implementations"][0]["files"][0], "sha256": "verified"}],
                  "diagnostics": [], "applied": False}
        bootstrap = "window.__state=" + json.dumps(state) + ";window.__report=" + json.dumps(report) + ";" + """
window.__posts=[];window.acquireVsCodeApi=()=>({
 getState:()=>__state,setState:value=>{window.__state=value},
 postMessage:message=>{
  __posts.push(message);
  const result=message.method==='migration_preview'?__report:
    {ok:true,actions:[],groups:[],module_sets:[],queue:{jobs:[]},runs:[]};
  queueMicrotask(()=>window.dispatchEvent(new MessageEvent('message',{data:{requestId:message.requestId,result}})));
 }});
"""
        self.exercise(bootstrap, lambda page: self.preview_checks(page, candidate, definition))

    def preview_checks(self, page, candidate, original):
        page.get_by_role("button", name="Preview path migration").click()
        expect(page.locator("#migration-evidence")).to_contain_text("implementations[0].files[0]")
        self.assertEqual(page.evaluate("__posts.filter(item=>item.method.includes('save')).length"), 0)
        page.get_by_role("button", name="Use candidate in editor").click()
        self.assertEqual(json.loads(page.locator("#editor-content").input_value()), candidate)
        self.assertEqual(page.evaluate("__state.editorState.migrationEvidence.original"), original)
        self.assertTrue(page.evaluate("__state.editorState.dirty"))
        self.assertEqual(page.evaluate("__posts.filter(item=>item.method.includes('save')).length"), 0)

    def test_component_identity_navigation_displays_read_only_contract(self):
        component = {"action_id": "core.file-path", "display_name": "File Path", "version": 1,
                     "component": True, "category": "core", "read_only": True, "editable": False,
                     "input_schema": {"type": "object", "properties": {"path": {"type": "string"}}},
                     "output_schema": {"type": "object", "properties": {"path": {"type": "string"}}},
                     "availability": {"state": "ready"}}
        bootstrap = "window.__component=" + json.dumps(component) + ";" + """
window.__posts=[];window.acquireVsCodeApi=()=>({
 getState:()=>({targetAction:'core.file-path'}),setState:()=>{},
 postMessage:message=>{
  __posts.push(message);const result={ok:true,actions:[__component],groups:['core'],module_sets:[],queue:{jobs:[]},runs:[]};
  queueMicrotask(()=>window.dispatchEvent(new MessageEvent('message',{data:{requestId:message.requestId,result}})));
 }});
"""
        def checks(page):
            expect(page.locator("#editor-title")).to_contain_text("core.file-path")
            expect(page.locator("#save-definition")).to_be_disabled()
            expect(page.locator("#preview-path-migration")).to_be_disabled()
            self.assertTrue(page.locator("#editor-content").evaluate("element=>element.readOnly"))
            self.assertEqual(json.loads(page.locator("#editor-content").input_value())["action_id"], "core.file-path")
            self.assertFalse(page.evaluate("__posts.some(item=>item.method==='call')"))
            page.locator('[data-action="core.file-path"]').click(button="right")
            page.get_by_role("menuitem", name="Copy Path", exact=True).click()
            page.wait_for_function("__posts.some(item=>item.method==='copy_path')")
            self.assertEqual(page.evaluate("__posts.find(item=>item.method==='copy_path').params.reference"),
                             "pkm://components/core.file-path")
        self.exercise(bootstrap, checks)

    def exercise(self, bootstrap, checks):
        html = (ROOT / "resources" / "action-workbench.html").read_text()
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                page = browser.new_page()
                errors = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.route("http://127.0.0.1/", lambda route: route.fulfill(content_type="text/html", body=html))
                page.add_init_script(bootstrap)
                page.goto("http://127.0.0.1/")
                checks(page)
                self.assertEqual(errors, [])
            finally:
                browser.close()


if __name__ == "__main__":
    unittest.main()

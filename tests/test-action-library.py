import json
import os
import platform
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "resources"))
from action_modules import ModuleRuntime, object_schema


class LibraryTests(unittest.TestCase):
    def create_runtime(self, directory):
        runtime = ModuleRuntime(Path(directory) / "store")
        runtime.configure_workspace(str(Path(directory) / "workspace"))
        definition = runtime.register({
            "schema": "pkm.action.definition/v1", "action_id": "test.library.echo", "version": 1,
            "description": "Library typed input fixture",
            "input_schema": object_schema({"value": {"type": "string"}}),
            "output_schema": object_schema({"value": {"type": "string"}}),
            "effects": ["pure"], "examples": [{"inputs": {"value": "fixture"}, "output": {"value": "fixture"}}],
            "implementations": [{"id": "pipeline", "kind": "pipeline",
                                 "platforms": [platform.system()], "steps": [],
                                 "output": {"value": {"$input": "value"}}}],
        })
        return runtime, definition

    def test_readiness_stages_are_independent_and_inspection_never_executes(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime, definition = self.create_runtime(directory)
            with patch.object(runtime, "call", side_effect=AssertionError("inspection executed an Action")):
                detail = runtime.library_get(definition["action_id"])
                self.assertEqual(detail["installation"], "installed")
                self.assertTrue(detail["enabled"])
                self.assertEqual(detail["grant"]["state"], "not-required")
                self.assertEqual(detail["qualification"]["state"], "unverified")
                self.assertEqual(detail["action"]["availability"]["state"], "unverified")
                self.assertEqual(detail["environment"]["implementation_id"], "pipeline")
                with self.assertRaises(ValueError):
                    runtime.library_get("test.foreign")
            self.assertTrue(runtime.validate(definition["action_id"], definition["content_hash"])["ok"])
            detail = runtime.library_get(definition["action_id"])
            self.assertEqual(detail["qualification"]["state"], "passed")
            self.assertEqual(detail["action"]["availability"]["state"], "ready")
            filename = runtime.registry / (definition["action_id"] + ".json")
            changed = json.loads(filename.read_text())
            changed["version"] += 1
            filename.write_text(json.dumps(changed))
            self.assertEqual(runtime.library_get(definition["action_id"])["qualification"]["state"], "stale")
            self.assertEqual(runtime.library_get("core.constant")["grant"]["state"], "not-required")

    def test_library_real_runtime_browser_drafts_runs_and_mobile(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime, definition = self.create_runtime(directory)
            calls = []
            lose_submission = [True]

            class Handler(BaseHTTPRequestHandler):
                def log_message(self, *_args):
                    pass

                def do_GET(self):
                    self.send_response(200)
                    self.send_header("Content-Type", "text/html")
                    self.end_headers()
                    self.wfile.write((ROOT / "resources/action-workbench.html").read_bytes())

                def do_POST(self):
                    value = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                    calls.append(value)
                    result = subprocess.run(
                        [sys.executable, str(ROOT / "resources/action_modules.py"), "--api", str(runtime.store)],
                        input=json.dumps(value), capture_output=True, text=True, check=True,
                    )
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    if value["method"] == "call" and lose_submission[0]:
                        lose_submission[0] = False
                        self.wfile.write(json.dumps({"ok": False, "error": "Fixture lost the original launch response."}).encode())
                    else:
                        self.wfile.write(result.stdout.encode())

            server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            thread = threading.Thread(target=server.serve_forever)
            thread.start()
            try:
                with sync_playwright() as playwright:
                    browser = playwright.chromium.launch(headless=True)
                    try:
                        for width in [1280, 390, 320]:
                            page = browser.new_page(viewport={"width": width, "height": 900})
                            errors = []
                            page.on("pageerror", lambda error: errors.append(str(error)))
                            page.goto(f"http://127.0.0.1:{server.server_port}/")
                            page.locator("#open-library").click()
                            page.locator("#library-search").fill("typed input fixture")
                            inspect = page.locator('[data-inspect-library="test.library.echo"]')
                            expect(inspect).to_be_visible()
                            inspect.click()
                            expect(page.locator("#library-detail")).to_contain_text("unverified")
                            expect(page.locator("#library-run")).to_be_disabled()
                            self.assertFalse(any(call["method"] in {"call", "validate", "platform_call"} for call in calls))
                            self.assertLessEqual(page.locator("#action-library").evaluate("node=>node.scrollWidth"), width)
                            if os.environ.get("PKM_ACTION_ACCEPTANCE_OUTPUT"):
                                output = Path(os.environ["PKM_ACTION_ACCEPTANCE_OUTPUT"])
                                output.mkdir(parents=True, exist_ok=True)
                                page.screenshot(path=str(output / f"library-{width}.png"))
                            page.locator('#library-fields [aria-label="value"]').fill("draft-" + str(width))
                            page.wait_for_function("!refreshing")
                            page.wait_for_load_state("networkidle")
                            page.reload()
                            page.locator("#open-library").click()
                            page.locator("#library-search").fill("test.library.echo")
                            page.locator('[data-inspect-library="test.library.echo"]').click()
                            expect(page.locator('#library-fields [aria-label="value"]')).to_have_value("draft-" + str(width))
                            page.locator("#library-close").click()
                            page.evaluate("""() => {
                              graph={action_id:'test.nested.'+innerWidth,name:'Nested fixture',nodes:[],edges:[]};
                              saved=null;addBlock('core.for');
                            }""")
                            page.locator('[data-value-type]').select_option("number")
                            page.locator('[data-field="items"]').fill("[1,2]")
                            page.locator('[data-field="items"]').blur()
                            page.locator('[data-field="value"]').fill('{"$step":"choose.value"}')
                            page.locator('[data-field="value"]').blur()
                            page.locator('[data-edit-body="body"]').click()
                            page.locator("#nested-kind").select_option("core.if-else")
                            page.locator("#nested-add").click()
                            page.locator("[data-step-id]").fill("choose")
                            page.locator("[data-step-id]").blur()
                            for field, value in {
                                "condition": '{"$op":"gt","args":[{"$var":"item"},1]}',
                                "then_value": '{"$var":"item"}', "else_value": "0",
                            }.items():
                                page.get_by_label(field + " for nested choose", exact=True).fill(value)
                                page.get_by_label(field + " for nested choose", exact=True).blur()
                            page.locator('[data-nested-field="then_steps"]').click()
                            page.locator("#nested-kind").select_option("core.constant")
                            page.locator("#nested-add").click()
                            page.locator("[data-step-id]").fill("literal")
                            page.locator("[data-step-id]").blur()
                            page.get_by_label("value for nested literal", exact=True).fill('"branch-evidence"')
                            page.get_by_label("value for nested literal", exact=True).blur()
                            page.get_by_label("value for nested literal", exact=True).fill("{broken")
                            page.get_by_label("value for nested literal", exact=True).blur()
                            page.locator("#nested-apply").click()
                            expect(page.locator("#nested-error")).to_contain_text("Correct invalid draft fields")
                            expect(page.locator("#nested-editor")).to_be_visible()
                            page.get_by_label("value for nested literal", exact=True).fill('"branch-evidence"')
                            page.get_by_label("value for nested literal", exact=True).blur()
                            page.locator("[data-nested-delete]").click()
                            expect(page.locator("#nested-nodes article")).to_have_count(0)
                            page.locator("#nested-undo").click()
                            expect(page.locator("#nested-nodes article")).to_have_count(1)
                            page.locator("#nested-close").click()
                            page.wait_for_function("!refreshing")
                            page.wait_for_load_state("networkidle")
                            page.reload()
                            page.locator('[data-edit-body="body"]').click()
                            expect(page.locator("[data-step-id]")).to_have_value("literal")
                            page.locator("#nested-route button").first.click()
                            expect(page.locator("[data-step-id]")).to_have_value("choose")
                            page.locator("#nested-editor summary").click()
                            original = page.locator("#nested-json").input_value()
                            page.locator("#nested-json").fill("{invalid")
                            page.locator("#nested-use-json").click()
                            expect(page.locator("#nested-error")).not_to_be_empty()
                            page.locator("#nested-apply").click()
                            expect(page.locator("#nested-error")).to_contain_text("pending Exact subgraph JSON")
                            if width == 320:
                                page.wait_for_load_state("networkidle")
                                page.reload()
                                page.locator('[data-edit-body="body"]').click()
                                expect(page.locator("#nested-json")).to_have_value("{invalid")
                                page.locator("#nested-check").click()
                                expect(page.locator("#nested-error")).to_contain_text("pending Exact subgraph JSON")
                            page.locator("#nested-json").fill(original)
                            page.locator("#nested-apply").click()
                            expect(page.locator("#nested-error")).to_contain_text("pending Exact subgraph JSON")
                            page.locator("#nested-use-json").click()
                            page.locator("#nested-check").click()
                            expect(page.locator("#nested-success")).to_contain_text("Whole draft contract is valid")
                            self.assertLessEqual(page.locator("#nested-editor").evaluate("node=>node.scrollWidth"), width)
                            heading = page.locator("#nested-editor h2").bounding_box()
                            self.assertGreaterEqual(heading["width"], 180)
                            self.assertLess(heading["height"], 100)
                            if os.environ.get("PKM_ACTION_ACCEPTANCE_OUTPUT"):
                                page.screenshot(path=str(output / f"nested-{width}.png"))
                            page.evaluate("graph.nodes[0].parameters.body=[{id:'newer_edit',component:'core.constant',inputs:{value:9}}]")
                            page.locator("#nested-apply").click()
                            expect(page.locator("#nested-error")).to_contain_text("parent field changed")
                            page.evaluate("graph.nodes[0].parameters.body=[]")
                            page.locator("#nested-apply").focus()
                            page.keyboard.press("Enter")
                            page.locator("#save").click()
                            page.wait_for_function("saved?.version===1")
                            graph_definition = page.evaluate("saved")
                            self.assertTrue(runtime.validate(graph_definition["action_id"], graph_definition["content_hash"])["ok"])
                            run = runtime.call(graph_definition["action_id"], {}, "nested-" + str(width), graph_definition["content_hash"])
                            self.assertEqual(runtime.wait(run["run_id"])["output"], {"values": [0, 2]})
                            self.assertEqual(errors, [])
                            page.wait_for_load_state("networkidle")
                            page.close()
                        self.assertTrue(runtime.validate(definition["action_id"], definition["content_hash"])["ok"])
                        page = browser.new_page()
                        page.goto(f"http://127.0.0.1:{server.server_port}/")
                        page.locator("#open-library").click()
                        page.locator("#library-search").fill("test.library.echo")
                        page.locator('[data-inspect-library="test.library.echo"]').click()
                        expect(page.locator("#library-detail")).to_contain_text("passed")
                        page.locator('#library-fields [aria-label="value"]').fill("real-library-result")
                        page.locator("#library-approve").check()
                        page.locator('#library-fields [aria-label="value"]').fill("approved-result")
                        expect(page.locator("#library-approve")).not_to_be_checked()
                        page.locator("#library-approve").check()
                        page.locator("#library-run").click()
                        expect(page.locator("#library-error")).to_contain_text("Original launch key retained")
                        original_key = [call for call in calls if call["method"] == "call"][0]["params"]["key"]
                        page.wait_for_load_state("networkidle")
                        page.reload()
                        page.locator("#open-library").click()
                        page.locator("#library-search").fill("test.library.echo")
                        page.locator('[data-inspect-library="test.library.echo"]').click()
                        expect(page.locator('#library-fields [aria-label="value"]')).to_have_value("approved-result")
                        page.locator("#library-approve").check()
                        page.locator("#library-run").click()
                        expect(page.locator("#action-library")).not_to_be_visible()
                        page.wait_for_function("JSON.parse(document.querySelector('#result').textContent||'{}').state==='Completed'")
                        self.assertEqual(json.loads(page.locator("#result").inner_text())["output"], {"value": "approved-result"})
                        launches = [call for call in calls if call["method"] == "call"]
                        self.assertEqual(len(launches), 2)
                        self.assertEqual([call["params"]["key"] for call in launches], [original_key, original_key])
                        page.wait_for_load_state("networkidle")
                        page.reload()
                        page.locator("#open-library").click()
                        page.locator("#library-search").fill("test.library.echo")
                        page.locator('[data-inspect-library="test.library.echo"]').click()
                        expect(page.locator("#library-runs")).to_contain_text("Completed")
                        self.assertEqual(len([call for call in calls if call["method"] == "call"]), 2)
                        records = [json.loads(path.read_text()) for path in (runtime.root / "runs").glob("*/run.json")]
                        self.assertEqual(len([record for record in records
                                              if record["action_id"] == definition["action_id"] and not record.get("validation")]), 1)
                        page.wait_for_load_state("networkidle")
                    finally:
                        browser.close()
            finally:
                server.shutdown()
                thread.join()
                server.server_close()


if __name__ == "__main__":
    unittest.main()

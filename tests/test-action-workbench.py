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
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "resources"))
from action_modules import ModuleRuntime, INTEGER, object_schema
from action_components import component_definitions


class WorkbenchTests(unittest.TestCase):
    def test_math_expression_ports_highlights_and_example(self):
        html = (ROOT / "resources" / "action-workbench.html").read_text()
        catalog = {"actions": [{**value, "availability": {"state": "ready"}, "content_hash": "fixture", "read_only": True}
                               for value in component_definitions().values()], "groups": ["core"], "module_sets": [], "queue": {"jobs": []}}
        bootstrap = "window.__catalog=" + json.dumps(catalog) + ";" + """
window.acquireVsCodeApi=()=>({getState:()=>null,setState:()=>{},postMessage:message=>{
  queueMicrotask(()=>window.dispatchEvent(new MessageEvent('message',{data:{requestId:message.requestId,result:window.__catalog}})));
}});
"""
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                for width in [1280, 390]:
                    with self.subTest(width=width):
                        page = browser.new_page(viewport={"width": width, "height": 900})
                        errors = []
                        page.on("pageerror", lambda error: errors.append(str(error)))
                        page.route("http://127.0.0.1/", lambda route: route.fulfill(content_type="text/html", body=html))
                        page.add_init_script(bootstrap)
                        page.goto("http://127.0.0.1/")
                        expect(page.locator('[data-category=\'["core","logic"]\']')).to_be_visible()
                        page.locator('[data-add="core.math-expression"]').click()
                        block = page.locator(".block").first
                        expect(block.locator('[data-input^="input_"]')).to_have_count(4)
                        expect(block.locator('[data-output="value"]')).to_be_visible()
                        expect(block.locator(".component-type")).to_have_count(0)
                        expect(block.locator('mark[title="math.log"]')).to_have_text("log")
                        expect(block.locator(".math-provenance")).to_contain_text("log : math.log")
                        expression = block.locator('[data-field="expression"]')
                        expression.fill("{0} + sqrt({4})")
                        expect(block.locator('mark[title="math.sqrt"]')).to_have_text("sqrt")
                        expression.press("Tab")
                        expect(block.locator('[data-input="input_4"]')).to_be_visible()
                        block.locator('[data-field="input_4"]').fill("16")
                        block.locator('[data-field="input_4"]').press("Tab")
                        self.assertEqual(page.evaluate("() => graph.nodes[0].parameters.input_4"), 16)
                        block.get_by_role("button", name="Apply math example", exact=True).click()
                        expect(block.locator('[data-input^="input_"]')).to_have_count(4)
                        expect(block.locator('[data-field="expression"]')).to_have_value("{0} x {1} + {2} * log {3}")
                        self.assertEqual(errors, [])
                        page.close()
            finally:
                browser.close()

    def test_inline_user_choice_submit_and_cancel(self):
        html = (ROOT / "resources" / "action-workbench.html").read_text()
        bootstrap = """
window.__posts=[];window.__choiceId=0;
window.acquireVsCodeApi=()=>({getState:()=>null,setState:()=>{},postMessage:message=>{
  window.__posts.push(message);
  let result={ok:true};
  if(message.method==='catalog')result={actions:[],groups:[],module_sets:[],queue:{jobs:[]}};
  if(message.method==='choices')result={requests:[{run_id:'child',request_id:'choice_'+window.__choiceId,
    prompt:'Choose a branch',options:['First','Second','Third','Fourth'].map(label=>({label,value:label}))}]};
  queueMicrotask(()=>window.dispatchEvent(new MessageEvent('message',{data:{requestId:message.requestId,result}})));
}});
"""
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                for width in [1280, 390]:
                    with self.subTest(width=width):
                        page = browser.new_page(viewport={"width": width, "height": 800})
                        errors = []
                        page.on("pageerror", lambda error: errors.append(str(error)))
                        page.route("http://127.0.0.1/", lambda route: route.fulfill(content_type="text/html", body=html))
                        page.add_init_script(bootstrap)
                        page.goto("http://127.0.0.1/")
                        page.wait_for_function("() => document.querySelector('#status').textContent !== 'Connecting'")
                        page.evaluate("() => renderChoices('root')")
                        form = page.locator("#chat-messages form").first
                        expect(form.get_by_role("radio")).to_have_count(4)
                        expect(form.locator("input:checked")).to_have_count(0)
                        form.get_by_role("button", name="Submit", exact=True).click()
                        self.assertFalse(page.evaluate("() => __posts.some(item=>item.method==='answer_choice')"))
                        form.get_by_role("radio", name="Third", exact=True).check()
                        form.get_by_role("button", name="Submit", exact=True).click()
                        expect(form.locator(".chat-answer")).to_have_text("Third")
                        self.assertEqual(page.evaluate("() => __posts.find(item=>item.method==='answer_choice').params"),
                                        {"run_id": "child", "request_id": "choice_0", "index": 2})
                        self.assertEqual(form.locator("input:enabled,button:enabled").count(), 0)
                        page.evaluate("() => { __choiceId=1; return renderChoices('root'); }")
                        second = page.locator("#chat-messages form").nth(1)
                        second.get_by_role("button", name="Cancel run", exact=True).click()
                        expect(second.locator(".chat-answer")).to_have_text("Run cancellation requested")
                        self.assertEqual(page.evaluate("() => __posts.find(item=>item.method==='cancel_run').params"), {"run_id": "root"})
                        self.assertFalse(page.evaluate("() => __posts.some(item=>item.method==='show_choices')"))
                        self.assertEqual(page.evaluate("() => __posts.filter(item=>item.method==='answer_choice').length"), 1)
                        self.assertEqual(errors, [])
                        page.close()
            finally:
                browser.close()

    def test_authenticated_browser_handoff_reload_and_shared_runtime(self):
        acceptance = Path("/tmp/pkm-action-acceptance")
        acceptance.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="browser-workbench-", dir=acceptance) as temporary:
            workspace = Path(temporary)
            store = workspace / "store"
            runtime = ModuleRuntime(store)
            runtime.configure_workspace(str(workspace))
            python_source = workspace / "authoring.py"
            csharp_source = workspace / "Authoring.cs"
            python_source.write_text("import json\nprint(json.dumps({'value': 3}))\n")
            csharp_source.write_text("class Authoring {}\n")
            for identifier, program, files in [("browser.python", sys.executable, [str(python_source)]),
                                                ("browser.csharp", "dotnet", [str(csharp_source)]),
                                                ("browser.hybrid", sys.executable, [str(python_source), str(csharp_source)])]:
                runtime.register({"schema": "pkm.action.definition/v1", "action_id": identifier, "version": 1,
                    "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
                    "output_schema": {"type": "object", "properties": {"value": {"type": "integer"}}, "required": ["value"]},
                    "effects": ["pure"], "examples": [{"inputs": {}, "output": {"value": 3}}],
                    "implementations": [{"kind": "program", "platforms": [platform.system()],
                                         "program": program, "args": [files[0]], "files": files}]})
            python_definition = runtime.definition("browser.python")
            policy = runtime.root / "policy.json"
            policy.write_text(json.dumps({"schema": "pkm.action.policy/v1", "grants": [{"action_id": "browser.python",
                "content_hash": python_definition["content_hash"], "trusted_host_execution": True}]}))
            self.assertTrue(runtime.validate("browser.python", python_definition["content_hash"])["ok"])
            constant = next(item for item in runtime.components() if item["action_id"] == "core.constant")
            draft = {"graph": {"action_id": "browser.handoff", "name": "Browser handoff", "nodes": [{
                "id": "constant", "action_id": "core.constant", "content_hash": constant["content_hash"],
                "value_type": "integer", "parameters": {"value": 7}, "x": 40, "y": 40}],
                "edges": [], "output_node": "constant"}}
            fixture = """
const path = require("path"), { execFile } = require("child_process");
const [root, python, store, workspace, draft] = process.argv.slice(1);
const { createActionWorkbenchServer } = require(path.join(root, "dist/runtime/action-workbench-server"));
createActionWorkbenchServer({ extensionPath: root, async request(method, params) {
  if (method === "access") return { ok: true };
  if (method === "background_tasks") method = "queue";
  return new Promise((resolve, reject) => {
    const child = execFile(python, [path.join(root, "resources/action_modules.py"), "--api", store], { timeout: 30000 }, (error, stdout) => {
      if (error) return reject(error);
      try { const result = JSON.parse(stdout); if (method === "catalog") result.workspace_root = workspace; resolve(result); }
      catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify({ method, params }));
  });
} }).then(server => {
  server.setDraft(JSON.parse(draft));
  process.stdout.write(server.url + "\\n");
  process.on("SIGTERM", () => { server.dispose(); process.exit(0); });
}).catch(error => { console.error(error); process.exitCode = 1; });
"""
            process = subprocess.Popen(["node", "-e", fixture, str(ROOT), sys.executable, str(store), str(workspace), json.dumps(draft)],
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                url = process.stdout.readline().strip()
                self.assertTrue(url.startswith("http://127.0.0.1:"), "Authenticated server did not start")
                with sync_playwright() as playwright:
                    browser = playwright.chromium.launch(headless=True)
                    page = browser.new_page(viewport={"width": 1920, "height": 1080})
                    errors = []
                    page.on("pageerror", lambda error: errors.append(str(error)))
                    page.on("dialog", lambda dialog: dialog.accept())
                    page.goto(url + "&launch=first")
                    page.wait_for_load_state("networkidle")
                    page.wait_for_selector(".block")
                    self.assertTrue(page.evaluate("document.fonts.check('16px codicon')"))
                    self.assertEqual(urlsplit(page.url).fragment, "")
                    self.assertEqual(page.locator("#name").input_value(), "Browser handoff")
                    self.assertEqual(page.locator('[data-field="value"]').input_value(), "7")
                    self.assertTrue(page.locator("#open-browser").is_hidden())
                    self.assertTrue(page.locator("#background-tasks").is_visible())
                    expect(page.locator("#search")).to_be_hidden()
                    page.keyboard.press("Control+f")
                    expect(page.locator("#search")).to_be_focused()
                    page.locator("#search").fill("core.math-expression")
                    expect(page.locator('[data-action="core.math-expression"]')).to_be_visible()
                    page.keyboard.press("Escape")
                    expect(page.locator("#search")).to_be_hidden()
                    for width in [1280, 390]:
                        page.set_viewport_size({"width": width, "height": 800})
                        tree = page.locator("#action-tree").bounding_box()
                        body = page.locator(".workspace").bounding_box()
                        self.assertAlmostEqual(tree["y"], body["y"])
                        self.assertGreaterEqual(body["x"], tree["x"] + tree["width"] - 1)
                        page.locator("#toggle-tree").click()
                        expect(page.locator("#action-tree")).to_be_hidden()
                        self.assertLess(page.locator(".workspace").bounding_box()["x"], body["x"])
                        page.locator("#toggle-tree").click()
                    page.set_viewport_size({"width": 1920, "height": 1080})
                    unauthorized = page.request.post(url.split("#")[0] + "api", data={"method": "catalog", "params": {}},
                                                    headers={"Origin": urlsplit(url).scheme + "://" + urlsplit(url).netloc})
                    self.assertEqual(unauthorized.status, 403)
                    page.locator("#workspace").click()
                    page.wait_for_selector("#workspace-dialog[open]")
                    self.assertEqual(page.locator("#workspace-path").input_value(), str(workspace))
                    page.locator("#close-workspace").click()
                    page.locator("#save").click()
                    expect(page.locator("#status")).to_contain_text("Saved v", timeout=30000)
                    self.assertEqual(runtime.definition("browser.handoff")["version"], 1)
                    page.locator("#validate").click()
                    expect(page.locator("#run")).to_be_enabled(timeout=30000)
                    page.locator("#run").click()
                    expect(page.locator("#result")).to_contain_text('"value": 7', timeout=30000)
                    self.assertEqual(json.loads(page.locator("#result").inner_text()), {"value": 7})
                    page.locator('[data-field="value"]').fill("17")
                    page.locator('[data-field="value"]').blur()
                    page.reload()
                    page.wait_for_selector(".block")
                    self.assertEqual(page.locator('[data-field="value"]').input_value(), "17")
                    self.assertTrue(page.locator("#run").is_disabled())
                    page.screenshot(path=str(acceptance / "action-workbench-authenticated-desktop.png"), full_page=True)
                    page.locator('[data-add="core.user-action"]').click()
                    page.locator('[data-field="prompt"]').fill("Continue with this Action?")
                    page.locator('[data-field="prompt"]').blur()
                    page.locator("#save").click()
                    expect(page.locator("#status")).to_contain_text("Saved v2", timeout=30000)
                    self.assertEqual(runtime.definition("browser.handoff")["version"], 2)
                    page.locator("#validate").click()
                    expect(page.locator("#run")).to_be_enabled(timeout=30000)
                    page.locator("#run").click()
                    page.wait_for_selector("[data-choice]", timeout=30000)
                    page.reload()
                    page.wait_for_selector("[data-choice]", timeout=30000)
                    page.locator('.chat-options input[type="radio"]').first.check()
                    page.locator('.chat-message button[type="submit"]').click()
                    expect(page.locator("#result")).to_contain_text('"value": "continue"', timeout=30000)
                    self.assertEqual(json.loads(page.locator("#result").inner_text()), {"value": "continue"})
                    page.locator("#background-tasks").click()
                    page.set_viewport_size({"width": 390, "height": 844})
                    self.assertTrue(page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth"))
                    page.screenshot(path=str(acceptance / "action-workbench-authenticated-mobile.png"), full_page=True)
                    page.goto(url + "&launch=second")
                    expect(page.locator('[data-field="value"]')).to_have_value("7", timeout=30000)
                    self.assertEqual(page.locator(".block").count(), 1)
                    self.assertTrue(page.locator("#run").is_disabled())
                    page.set_viewport_size({"width": 1920, "height": 1080})

                    def menu(identifier, label):
                        page.locator('[data-action="' + identifier + '"]').click(button="right")
                        page.locator("#catalog-menu").get_by_role("menuitem", name=label, exact=True).click()

                    page.locator("#add-group").click()
                    page.locator("#catalog-name").fill("Tools")
                    page.locator("#catalog-submit").click()
                    expect(page.locator("#catalog-dialog")).not_to_be_visible(timeout=30000)
                    group = page.locator('[data-category=\'["Tools"]\']')
                    expect(group).to_be_visible()
                    group.click(button="right")
                    page.locator("#catalog-menu").get_by_role("menuitem", name="Add subgroup").click()
                    page.locator("#catalog-name").fill("Numbers")
                    page.locator("#catalog-submit").click()
                    expect(page.locator("#catalog-dialog")).not_to_be_visible(timeout=30000)
                    expect(page.locator('[data-category=\'["Tools","Numbers"]\']')).to_be_visible()
                    pin = runtime.definition("browser.handoff")["content_hash"]
                    menu("browser.handoff", "Rename")
                    page.locator("#catalog-name").fill("Renamed Action")
                    page.locator("#catalog-submit").click()
                    expect(page.locator("#catalog-dialog")).not_to_be_visible(timeout=30000)
                    expect(page.locator('[data-action="browser.handoff"] strong')).to_have_text("Renamed Action")
                    menu("browser.handoff", "Move to")
                    page.locator("#catalog-group").select_option("Tools/Numbers")
                    page.locator("#catalog-submit").click()
                    expect(page.locator("#catalog-dialog")).not_to_be_visible(timeout=30000)
                    self.assertEqual(runtime.definition("browser.handoff")["content_hash"], pin)
                    page.reload()
                    expect(page.locator('[data-category=\'["Tools","Numbers"]\']')).to_be_visible()
                    self.assertEqual(runtime.catalog_layout()["actions"]["browser.handoff"]["category"], "Tools/Numbers")
                    for identifier, language in [("browser.python", "Python"), ("browser.csharp", "C#"), ("browser.hybrid", "Hybrid")]:
                        expect(page.locator('[data-action="' + identifier + '"] .language')).to_have_text(language)
                    self.assertEqual(page.locator('[data-action="browser.hybrid"] .language').get_attribute("title"), "C# + Python")
                    page.locator('[data-action="core.constant"]').click(button="right")
                    self.assertEqual(page.locator("#catalog-menu button:disabled").count(), 4)
                    page.keyboard.press("Escape")
                    page.locator('[data-category=\'["core"]\']').click(button="right")
                    expect(page.locator("#catalog-menu button")).to_be_disabled()
                    page.keyboard.press("Escape")
                    page.locator('[data-action="core.constant"] strong').dblclick()
                    self.assertEqual(page.locator(".block").count(), 1)
                    page.locator('[data-action="core.constant"]').drag_to(page.locator("#canvas"), target_position={"x": 460, "y": 110})
                    expect(page.locator(".block")).to_have_count(2)
                    self.assertEqual(page.evaluate("graph.nodes.at(-1).x"), 460)
                    self.assertEqual(page.evaluate("graph.nodes.at(-1).y"), 110)
                    expect(page.locator('[data-add="browser.csharp"]')).to_be_disabled()
                    transfer = page.evaluate_handle("() => { const transfer = new DataTransfer(); transfer.setData('application/x-pkm-action', 'browser.csharp'); return transfer; }")
                    page.locator("#canvas").dispatch_event("drop", {"dataTransfer": transfer})
                    self.assertEqual(page.locator(".block").count(), 2)
                    transfer.dispose()
                    page.locator('[data-action="browser.handoff"] strong').dblclick()
                    expect(page.locator("#catalog-dialog")).to_be_visible()
                    page.locator("#catalog-submit").click()
                    expect(page.locator("#name")).to_have_value("Renamed Action")
                    self.assertEqual(page.locator(".block").count(), 2)
                    page.locator('[data-action="browser.python"] strong').dblclick()
                    expect(page.locator("#definition-editor")).to_be_visible()
                    definition = json.loads(page.locator("#editor-content").input_value())
                    definition["description"] = "Edited in the browser"
                    page.locator("#editor-content").fill(json.dumps(definition, indent=2))
                    page.locator("#save-definition").click()
                    expect(page.locator("#status")).to_contain_text("Saved; validation", timeout=30000)
                    self.assertEqual(runtime.definition("browser.python")["version"], 2)
                    python_definition = runtime.definition("browser.python")
                    policy.write_text(json.dumps({"schema": "pkm.action.policy/v1", "grants": [{"action_id": "browser.python",
                        "content_hash": python_definition["content_hash"], "trusted_host_execution": True}]}))
                    self.assertTrue(runtime.validate("browser.python", python_definition["content_hash"])["ok"])
                    self.assertEqual(runtime.availability("browser.python")["state"], "ready")
                    page.locator("#editor-file").select_option(str(python_source))
                    expect(page.locator("#editor-content")).to_have_value(python_source.read_text())
                    changed_source = "import json\nprint(json.dumps({'value': 9}))\n"
                    page.locator("#editor-content").fill(changed_source)
                    page.reload()
                    expect(page.locator("#definition-editor")).to_be_visible()
                    expect(page.locator("#editor-content")).to_have_value(changed_source)
                    page.locator("#save-definition").click()
                    expect(page.locator("#status")).to_contain_text("Saved; validation", timeout=30000)
                    self.assertEqual(python_source.read_text(), changed_source)
                    self.assertNotEqual(runtime.availability("browser.python")["state"], "ready")
                    page.locator("#editor-content").fill(changed_source + "\n")
                    python_source.write_text("external edit\n")
                    page.locator("#save-definition").click()
                    expect(page.locator("#status")).to_contain_text("Source changed", timeout=30000)
                    self.assertEqual(python_source.read_text(), "external edit\n")
                    page.set_viewport_size({"width": 390, "height": 844})
                    page.locator('[data-action="browser.python"]').click(button="right")
                    bounds = page.locator("#catalog-menu").bounding_box()
                    self.assertGreaterEqual(bounds["x"], 0)
                    self.assertLessEqual(bounds["x"] + bounds["width"], 390)
                    self.assertLessEqual(bounds["y"] + bounds["height"], 844)
                    self.assertTrue(page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth"))
                    page.screenshot(path=str(acceptance / "action-workbench-authoring-mobile.png"), full_page=True)
                    page.keyboard.press("Escape")
                    page.locator("#close-definition").click()
                    page.locator("#catalog-submit").click()
                    page.set_viewport_size({"width": 1920, "height": 1080})
                    menu("browser.csharp", "Delete")
                    page.locator("#catalog-submit").click()
                    expect(page.locator('[data-action="browser.csharp"]')).to_have_count(0, timeout=30000)
                    self.assertTrue(csharp_source.is_file())
                    self.assertFalse((runtime.registry / "browser.csharp.json").exists())
                    page.locator('[data-add="core.sleep"]').click()
                    expect(page.locator('[data-field="seconds"]')).to_have_value("1")
                    page.locator('[data-field="seconds"]').fill("0.01")
                    page.locator('[data-field="seconds"]').blur()
                    expect(page.locator('[data-action="core.sleep"] .language')).to_have_text("Python")
                    self.assertEqual(page.locator('[data-edit="core.sleep"]').count(), 0)
                    page.locator('[data-value-type="constant"]').select_option("string")
                    literal = 'first\\n raw\nsecond\\t <img src=x onerror=alert(1)> "quoted"'
                    string_input = page.locator('[data-node="constant"][data-field="value"]')
                    self.assertEqual(string_input.evaluate("element => element.tagName"), "TEXTAREA")
                    string_input.fill(literal)
                    self.assertEqual(page.evaluate("graph.nodes.find(node => node.id === 'constant').parameters.value"), literal)
                    self.assertEqual(page.locator(".raw-string-body mark").count(), 2)
                    self.assertEqual(page.locator(".raw-string-body img").count(), 0)
                    self.assertEqual(page.locator('[data-block="constant"] [data-parameter="value"]').evaluate(
                        "element => getComputedStyle(element).borderTopWidth"), "0px")
                    page.reload()
                    expect(page.locator('[data-node="constant"][data-field="value"]')).to_have_value(literal)
                    expect(page.locator(".literal-delimiter").first).to_have_text('r"""')
                    page.locator("#save").click()
                    expect(page.locator("#status")).to_contain_text("Saved v3", timeout=30000)
                    self.assertEqual(runtime.definition("browser.handoff")["graph"]["nodes"][0]["parameters"]["value"], literal)
                    page.locator('[data-action="browser.handoff"]').click(button="right")
                    page.screenshot(path=str(acceptance / "action-workbench-authoring-desktop.png"), full_page=True)
                    self.assertFalse(errors, errors)
                    browser.close()
            finally:
                process.terminate()
                process.communicate(timeout=10)

    def test_graph_and_optional_package_workflow(self):
        acceptance = Path("/tmp/pkm-action-acceptance")
        acceptance.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="workbench-", dir=acceptance) as temporary:
            workspace = Path(temporary)
            stores = [workspace / "store-one", workspace / "store-two"]
            for store in stores:
                ModuleRuntime(store).configure_workspace(str(workspace))
            fixture = {"schema": "pkm.action.definition/v1", "action_id": "test.fixture.add", "version": 1,
                "input_schema": object_schema({"left": INTEGER, "right": INTEGER}), "output_schema": object_schema({"sum": INTEGER}),
                "effects": ["pure"], "examples": [{"inputs": {"left": 2, "right": 3}, "output": {"sum": 5}}],
                "implementations": [{"kind": "pipeline", "platforms": [platform.system()], "steps": [{
                    "id": "sum", "component": "core.math-expression", "inputs": {"expression": "{0} + {1}",
                        "input_0": {"$input": "left"}, "input_1": {"$input": "right"}}}], "output": {"sum": {"$step": "sum.value"}}}]}
            for store in stores:
                ModuleRuntime(store).register(fixture)
            active_store = [stores[0]]
            package = workspace / "selected.pkm-actions"

            class Handler(BaseHTTPRequestHandler):
                def log_message(self, *_):
                    pass

                def do_GET(self):
                    pathname = urlsplit(self.path).path
                    assets = {"/": (ROOT / "resources" / "action-workbench.html", "text/html"),
                              "/codicon.css": (ROOT / "dist" / "webview" / "codicon.css", "text/css"),
                              "/codicon.ttf": (ROOT / "dist" / "webview" / "codicon.ttf", "font/ttf")}
                    if pathname not in assets:
                        self.send_error(404)
                        return
                    source, content_type = assets[pathname]
                    content = source.read_bytes()
                    if pathname == "/":
                        content = content.replace(b"<head>", b'<head><link rel="stylesheet" href="/codicon.css">')
                    self.send_response(200)
                    self.send_header("Content-Type", content_type)
                    self.end_headers()
                    self.wfile.write(content)

                def do_POST(self):
                    request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                    if request["method"] == "export":
                        request["params"]["destination"] = str(package)
                    if request["method"] == "import":
                        request["params"]["local_path"] = str(package)
                    process = subprocess.run([sys.executable, str(ROOT / "resources" / "action_modules.py"), "--api", str(active_store[0])],
                                             input=json.dumps(request), text=True, capture_output=True, timeout=30)
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(process.stdout.encode())

            server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                with sync_playwright() as playwright:
                    browser = playwright.chromium.launch(headless=True)
                    page = browser.new_page(viewport={"width": 1440, "height": 1000})
                    errors = []
                    page.on("pageerror", lambda error: errors.append(str(error)))
                    page.goto("http://127.0.0.1:" + str(server.server_port))
                    page.wait_for_load_state("networkidle")
                    page.evaluate("document.fonts.ready")
                    self.assertTrue(page.evaluate("document.fonts.check('16px codicon')"))
                    self.assertEqual(page.locator('.tree-cat-label').filter(has_text='core').count(), 1)
                    self.assertEqual(page.locator('[data-add="core.user-action"]').count(), 1)
                    self.assertEqual(page.locator('[data-export="core.constant"]').count(), 0)
                    self.assertTrue(page.locator('[data-add="test.fixture.add"]').is_disabled())
                    page.locator('[data-qualify="test.fixture.add"]').click()
                    page.wait_for_function('!document.querySelector(\'[data-add="test.fixture.add"]\').disabled', timeout=30000)
                    page.locator('[data-add="test.fixture.add"]').click()
                    page.locator('[data-add="test.fixture.add"]').click()
                    blocks = page.locator(".block")
                    blocks.nth(0).locator('[data-field="left"]').fill("2")
                    blocks.nth(0).locator('[data-field="right"]').fill("3")
                    blocks.nth(1).locator('[data-field="right"]').fill("4")
                    blocks.nth(1).locator('[data-field="right"]').blur()
                    blocks.nth(0).locator('[data-output="sum"]').click()
                    blocks.nth(1).locator('[data-input="left"]').click()
                    self.assertEqual(page.locator(".connections path").count(), 1)
                    midpoint = page.locator('.connections path').evaluate("path => {const point=path.getPointAtLength(path.getTotalLength()/2); const screen=new DOMPoint(point.x,point.y).matrixTransform(path.getScreenCTM()); return {x:screen.x,y:screen.y}}")
                    page.mouse.click(midpoint["x"], midpoint["y"])
                    self.assertEqual(page.locator('.connections path.selected').count(), 1)
                    self.assertEqual(page.evaluate('graph.edges.length'), 1)
                    blocks.nth(1).locator('[data-field="right"]').focus()
                    page.keyboard.press("Delete")
                    self.assertEqual(page.evaluate('graph.edges.length'), 1)
                    page.locator('#delete-wire').click()
                    self.assertEqual(page.evaluate('graph.edges.length'), 0)
                    page.locator('#undo').click()
                    self.assertEqual(page.evaluate('graph.edges.length'), 1)
                    page.locator('#toggle-parameters').click()
                    self.assertEqual(page.locator('.block.collapsed').count(), 2)
                    self.assertEqual(page.locator('[data-field]').count(), 0)
                    self.assertEqual(page.locator('.connections path').count(), 1)
                    page.locator('.block').nth(1).locator('[data-compact="input"]').select_option('right')
                    page.locator('.block').nth(0).locator('[data-output="sum"]').click()
                    self.assertEqual(page.locator('.block').nth(1).locator('.pin.input.compatible').count(), 1)
                    page.locator('#cancel-wire').click()
                    page.locator('#toggle-parameters').click()
                    page.locator('.connections path').dispatch_event('click')
                    page.locator('#delete-wire').click()
                    blocks.nth(1).locator('[data-input="left"]').click()
                    blocks.nth(0).locator('[data-output="sum"]').click()
                    self.assertEqual(page.evaluate('graph.edges.length'), 1)
                    page.locator('.connections path').dispatch_event('click')
                    page.locator('#delete-wire').click()
                    output_port = blocks.nth(0).locator('[data-output="sum"]').bounding_box()
                    input_port = blocks.nth(1).locator('[data-input="left"]').bounding_box()
                    page.mouse.move(output_port['x'] + 7, output_port['y'] + 7)
                    page.mouse.down()
                    page.mouse.move(input_port['x'] + 7, input_port['y'] + 7, steps=8)
                    self.assertEqual(page.locator('.connections path.ghost').count(), 1)
                    page.mouse.up()
                    self.assertEqual(page.evaluate('graph.edges.length'), 1)
                    self.assertEqual(page.locator('.connections path.ghost').count(), 0)
                    draft = blocks.nth(1).locator('[data-field="right"]')
                    draft.fill('45')
                    page.evaluate('refresh()')
                    page.wait_for_function('!refreshing')
                    self.assertEqual(draft.input_value(), '45')
                    self.assertTrue(draft.evaluate('input => input === document.activeElement'))
                    draft.fill('4')
                    draft.blur()
                    page.locator("#name").fill("Arithmetic chain")
                    page.locator("#save").click()
                    page.wait_for_function("document.querySelector('#status').textContent.startsWith('Saved v')")
                    page.locator("#validate").click()
                    page.wait_for_function("!document.querySelector('#run').disabled", timeout=30000)
                    page.locator("#run").click()
                    page.wait_for_function("document.querySelector('#result').textContent.includes('9')", timeout=30000)
                    self.assertEqual(json.loads(page.locator("#result").inner_text()), {"sum": 9})
                    page.locator('#toggle-parameters').click()
                    self.assertFalse(page.locator('#run').is_disabled())
                    page.locator('#toggle-parameters').click()
                    page.locator('[data-edit^="local.graph."]').click()
                    self.assertEqual(page.locator(".block").count(), 2)
                    page.locator(".block").nth(1).locator('[data-field="right"]').fill("5")
                    page.locator(".block").nth(1).locator('[data-field="right"]').blur()
                    self.assertTrue(page.locator("#run").is_disabled())
                    page.locator("#save").click()
                    page.wait_for_function("document.querySelector('#status').textContent === 'Saved v2'")
                    page.screenshot(path=str(acceptance / "action-workbench-desktop.png"), full_page=True)
                    page.locator('[data-export^="local.graph."]').check()
                    page.locator("#export").click()
                    page.locator("#package-form button").last.click()
                    page.wait_for_function("!document.querySelector('#package-dialog').open")
                    self.assertTrue(package.is_file())
                    active_store[0] = stores[1]
                    page.locator("#import").click()
                    page.locator("#import-path").fill(str(package))
                    page.locator("#import-form button").last.click()
                    page.wait_for_selector("[data-set]")
                    self.assertFalse(page.locator("[data-set]").is_checked())
                    self.assertEqual(page.locator('[data-add^="local.graph."]').count(), 0)
                    page.locator("[data-set]").check()
                    page.wait_for_selector('[data-add^="local.graph."]')
                    self.assertIn("blocked", page.locator('[data-add^="local.graph."]').locator("..").inner_text())
                    page.locator("[data-set]").uncheck()
                    page.wait_for_function("document.querySelectorAll('[data-add^=\"local.graph.\"]').length === 0")
                    page.set_viewport_size({"width": 390, "height": 844})
                    page.screenshot(path=str(acceptance / "action-workbench-mobile.png"), full_page=True)
                    self.assertTrue(page.evaluate("document.documentElement.scrollWidth <= innerWidth"))
                    self.assertTrue(page.locator('.palette-row > div').evaluate_all('nodes => nodes.filter(node => node.getClientRects().length).every(node => node.getBoundingClientRect().width >= 75)'), 'Mobile palette titles must not be squeezed into a one-character column')
                    self.assertEqual(page.locator('[data-add^="core.cast."]').count(), 0)
                    page.locator('[data-add="core.cast"]').click()
                    cast_block = page.locator('.block').last
                    cast_block.locator('[data-value-type]').select_option('number')
                    self.assertEqual(cast_block.locator('[data-parameter="target_type"]').count(), 0)
                    self.assertEqual(page.evaluate('graph.nodes.at(-1).parameters.target_type'), 'number')
                    cast_id = cast_block.get_attribute('data-block')
                    self.assertNotIn('trim', page.evaluate('graph.nodes.at(-1).parameters'))
                    self.assertEqual(cast_block.locator('[data-parameter="value"].required').count(), 1)
                    self.assertEqual(cast_block.locator('[data-parameter="trim"].optional').count(), 1)
                    for parameter in ['value', 'trim']:
                        self.assertEqual(cast_block.locator('[data-parameter="' + parameter + '"]').evaluate('row => getComputedStyle(row).borderTopWidth'), '0px')
                    required_box = cast_block.locator('[data-field="value"]')
                    self.assertGreater(float(required_box.evaluate('input => getComputedStyle(input).borderTopWidth').removesuffix('px')), 0)
                    self.assertTrue(required_box.evaluate('input => { const probe=document.createElement("span");probe.style.color="var(--accent)";input.parentElement.append(probe);const matches=getComputedStyle(input).borderTopColor===getComputedStyle(probe).color;probe.remove();return matches; }'))
                    enable_trim = cast_block.locator('[data-enable-field="trim"]')
                    enable_trim.check()
                    self.assertIs(page.evaluate('graph.nodes.at(-1).parameters.trim'), False)
                    cast_block.locator('[data-field="trim"]').check()
                    self.assertIs(page.evaluate('graph.nodes.at(-1).parameters.trim'), True)
                    enable_trim.uncheck()
                    self.assertNotIn('trim', page.evaluate('graph.nodes.at(-1).parameters'))
                    cast_block.locator('[data-output="value"]').click()
                    page.locator('.block').first.locator('[data-input="left"]').click()
                    self.assertIn('Incompatible ports', page.locator('#status').inner_text())
                    self.assertEqual(page.evaluate('graph.edges.length'), 1)
                    page.locator('#cancel-wire').click()
                    cast_block.locator('[data-field="value"]').fill('"3.25"')
                    cast_block.locator('[data-field="value"]').blur()
                    page.locator('#toggle-parameters').click()
                    self.assertEqual(page.locator('.block.collapsed').count(), 3)
                    cast_block.locator('[data-compact="input"]').select_option('trim')
                    self.assertIn('optional', cast_block.locator('[data-input="trim"]').get_attribute('class'))
                    page.locator('#toggle-parameters').click()
                    self.assertEqual(cast_block.get_attribute('data-block'), cast_id)
                    self.assertEqual(cast_block.locator('[data-field="value"]').input_value(), '"3.25"')
                    page.screenshot(path=str(acceptance / "action-workbench-optional-mobile.png"), full_page=True)
                    page.evaluate("graph={action_id:'local.choice.fixture',name:'Chat choice',nodes:[],edges:[]};saved=null;renderGraph()")
                    page.locator('[data-add="core.user-action"]').click()
                    page.locator('[data-field="prompt"]').fill('Choose an outcome')
                    page.locator('[data-field="prompt"]').blur()
                    page.locator('#save').click()
                    page.wait_for_function("document.querySelector('#status').textContent.startsWith('Saved v')")
                    page.on('dialog', lambda dialog: dialog.accept())
                    page.locator('#validate').click()
                    page.wait_for_function("!document.querySelector('#run').disabled", timeout=30000)
                    self.assertEqual(page.locator('[data-choice]').count(), 0)
                    page.locator('#run').click()
                    page.wait_for_selector('[data-choice]', timeout=30000)
                    self.assertEqual(json.loads(page.locator('#result').inner_text())['state'], 'running')
                    page.locator('.chat-options input[type="radio"]').first.check()
                    page.locator('.chat-message button[type="submit"]').click()
                    page.wait_for_function("document.querySelector('#result').textContent.includes('continue')", timeout=30000)
                    self.assertEqual(json.loads(page.locator('#result').inner_text()), {'value': 'continue'})
                    self.assertEqual(page.locator('.chat-answer').inner_text(), 'Continue')
                    page.wait_for_function('currentRun === null')
                    before_cancel = page.evaluate('JSON.stringify(graph)')
                    page.locator('#run').click()
                    page.wait_for_selector('.chat-options button:not([disabled])', timeout=30000)
                    run_id = page.evaluate('currentRun')
                    page.locator('#cancel-run').click()
                    page.wait_for_function('currentRun === null', timeout=30000)
                    self.assertTrue(ModuleRuntime(active_store[0]).cancelled(ModuleRuntime(active_store[0]).get(run_id)))
                    self.assertEqual(page.evaluate('JSON.stringify(graph)'), before_cancel)
                    self.assertTrue(page.locator('#cancel-run').is_disabled())
                    page.screenshot(path=str(acceptance / 'action-workbench-chat-mobile.png'), full_page=True)
                    self.assertFalse(errors, errors)
                    browser.close()
            finally:
                server.shutdown()
                server.server_close()
                thread.join()


if __name__ == "__main__":
    unittest.main()
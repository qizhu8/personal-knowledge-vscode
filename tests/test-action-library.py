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
    def test_pending_actions_are_visible_in_tree_with_validation_guidance_and_exact_proposal(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime, _ = self.create_runtime(directory)
            catalog = runtime.catalog()
            original = next(item for item in catalog["actions"] if item["action_id"] == "test.library.echo")
            catalog["actions"] = [original]
            names = ["dlis.falcon.gen1_to_gen2", "dlis.falcon.gen2_to_acr", "dlis.falcon.acr_to_iff"]
            proposals = [{
                "action_id": name, "proposal_id": f"proposal_fixture_{index}",
                "content_hash": f"hash_{index}", "state": "pending",
                "definition": {**original, "action_id": name, "display_name": name, "version": 1, "effects": ["remote-write"]},
            } for index, name in enumerate(names)]
            catalog["proposals"] = proposals
            bootstrap = """
window.__catalog=CATALOG;window.__calls=[];window.__saved=null;
window.acquireVsCodeApi=()=>({getState:()=>({libraryOpen:true}),setState:value=>{__saved=value},postMessage:message=>{
 __calls.push(message);let result={ok:true};
 if(message.method==='catalog')result=__catalog;
 if(message.method==='runs')result={runs:[]};
 if(message.method==='validate')result={ok:true,cancelled:true};
 if(message.method==='validate_batch'){
  result={ok:true,results:message.params.items.map((item,index)=>({...item,state:index===1?'succeeded':'failed',error:index===1?null:'Fixture blocked review'}))};
  window.__finishBatch=()=>window.dispatchEvent(new MessageEvent('message',{data:{requestId:message.requestId,result}}));
  queueMicrotask(()=>window.dispatchEvent(new MessageEvent('message',{data:{requestId:message.requestId,progress:{total:message.params.items.length,completed:1,action_id:message.params.items[1].action_id,stage:'Agent code review',result:result.results[0]}}})));
  return;
 }
 queueMicrotask(()=>window.dispatchEvent(new MessageEvent('message',{data:{requestId:message.requestId,result}})));
}});
""".replace("CATALOG", json.dumps(catalog))
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(headless=True)
                try:
                    page = browser.new_page()
                    errors = []
                    page.on("pageerror", lambda failure: errors.append(str(failure)))
                    page.route("https://action.test/**", lambda route: route.fulfill(
                        content_type="text/html", body=(ROOT / "resources/action-workbench.html").read_text()))
                    page.add_init_script(bootstrap)
                    page.goto("https://action.test/")
                    for name in names:
                        row = page.locator(f'[data-action="{name}"]')
                        expect(row).to_be_visible()
                        expect(row.locator(".needs-validation-label")).to_have_text("Need Validation")
                        expect(row.locator("[data-qualify]")).to_have_class("icon validation-needed")
                        expect(row.locator("[data-add]")).to_be_disabled()
                        self.assertEqual(row.locator("[data-export]").count(), 0)
                    expect(page.locator("#action-library")).not_to_be_visible()
                    expect(page.locator("#workbench-tasks")).to_contain_text("Click a highlighted flask")
                    self.assertFalse(page.evaluate("__calls.some(item=>item.method==='validate')"))
                    page.locator("#open-library").click()
                    expect(page.locator("#library-next-step")).to_contain_text("need validation")
                    self.assertFalse(page.locator("#workbench-review-details").evaluate("node=>node.open"))
                    page.locator("#show-validation-actions").click()
                    first = page.locator(f'[data-qualify="{names[0]}"]')
                    first.click()
                    expect(page.locator("#validation-message")).to_contain_text("remote-write")
                    page.locator("#validation-dismiss").click()
                    self.assertFalse(page.evaluate("__calls.some(item=>item.method==='validate')"))
                    first.click()
                    page.locator("#validation-accept").click()
                    expect(page.locator("#validation-feedback")).to_contain_text("cancelled")
                    request = page.evaluate("__calls.find(item=>item.method==='validate').params")
                    self.assertEqual(request["proposal_id"], proposals[0]["proposal_id"])
                    self.assertEqual(request["content_hash"], proposals[0]["content_hash"])
                    self.assertEqual(request["action_id"], names[0])
                    self.assertTrue(request["allow_effects"])
                    self.assertFalse(page.evaluate("actions.some(item=>item.action_id.startsWith('dlis.falcon.'))"),
                                     "pending rows must not enter the executable action catalog")
                    page.evaluate("""() => {
                      const proposal=__catalog.proposals.shift();
                      __catalog.actions.push({...proposal.definition,content_hash:proposal.content_hash,availability:{state:'ready'}});
                    }""")
                    page.locator("#refresh").click()
                    expect(page.locator(f'[data-action="{names[0]}"] .needs-validation-label')).to_have_count(0)
                    expect(page.locator(f'[data-qualify="{names[0]}"]')).to_have_class("icon")
                    expect(page.locator(f'[data-action="{names[1]}"] .needs-validation-label')).to_have_text("Need Validation")
                    previous_hash = page.evaluate("actions.find(item=>item.action_id==='test.library.echo').content_hash")
                    page.evaluate("""() => {
                      const previous=actions.find(item=>item.action_id==='test.library.echo');
                      __catalog.proposals.push({action_id:previous.action_id,proposal_id:'proposal_update',content_hash:'new_revision',
                        definition:{...previous,version:previous.version+1}});
                    }""")
                    page.locator("#refresh").click()
                    expect(page.locator('[data-action="test.library.echo"] .needs-validation-label')).to_have_text("Need Validation")
                    self.assertEqual(page.evaluate("actions.find(item=>item.action_id==='test.library.echo').content_hash"), previous_hash,
                                     "a pending update must not replace the executable approved version")
                    self.assertEqual(page.locator('[data-action="test.library.echo"]').count(), 1)
                    page.locator("#validate-all-actions").click()
                    expect(page.locator("#validation-title")).to_contain_text("Validate all")
                    expect(page.locator("#validation-message")).to_contain_text("remote-write")
                    page.locator("#validation-dismiss").click()
                    self.assertFalse(page.evaluate("__calls.some(item=>item.method==='validate_batch')"))
                    page.locator("#validate-all-actions").click()
                    page.locator("#validation-accept").click()
                    expect(page.locator("#batch-validation-progress")).to_be_visible()
                    expect(page.locator("#batch-validation-stage")).to_contain_text("1/3")
                    expect(page.locator("#batch-validation-stage")).to_contain_text("Review")
                    expect(page.locator("#batch-validation-bar")).to_have_attribute("value", "1")
                    expect(page.locator("#batch-validation-results")).to_contain_text("Fixture blocked review")
                    expect(page.locator("#batch-validation-results")).not_to_be_visible()
                    expect(page.locator("#validation-feedback")).not_to_be_visible()
                    expect(page.locator("#validate-all-actions")).to_be_disabled()
                    page.evaluate("__finishBatch()")
                    expect(page.locator("#batch-validation-stage")).to_contain_text("1 passed · 2 failed")
                    expect(page.locator("#batch-validation-results")).not_to_be_visible()
                    page.locator("#batch-validation-details > summary").click()
                    expect(page.locator("#batch-validation-results")).to_be_visible()
                    expect(page.locator("#batch-validation-results pre").first).not_to_be_visible()
                    page.locator("#batch-validation-results summary").first.click()
                    expect(page.locator("#batch-validation-results pre").first).to_have_text("Fixture blocked review")
                    expect(page.locator("#batch-validation-results li")).to_have_count(3)
                    batch = page.evaluate("__calls.find(item=>item.method==='validate_batch').params")
                    self.assertEqual(len(batch["items"]), 3)
                    self.assertTrue(batch["allow_effects"])
                    self.assertTrue(all(item.get("proposal_id") for item in batch["items"]))
                    self.assertEqual(errors, [])
                finally:
                    browser.close()

    def test_independent_library_inspection_readiness_invocation_and_explicit_navigation(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime, _ = self.create_runtime(directory)
            catalog = runtime.catalog()
            action = next(item for item in catalog["actions"] if item["action_id"] == "test.library.echo")
            catalog["actions"] = [action]
            catalog["proposals"] = [{"action_id": "pending.hidden", "proposal_id": "proposal_hidden"}]
            bootstrap = """
window.__catalog=CATALOG;window.__action=ACTION;window.__calls=[];window.__state={};window.__fail=false;
window.acquireVsCodeApi=()=>({getState:()=>__state,setState:value=>{__state=value},postMessage:message=>{
 __calls.push(message);let result={ok:true};
 if(message.method==='catalog')result=__fail?{ok:false,error:'Library unavailable'}:__catalog;
 if(message.method==='library_get')result={ok:true,action:__action};
 if(message.method==='call')result={ok:true,run_id:'action_run_'+'a'.repeat(32),state:'running'};
 if(message.method==='run')result={ok:true,run_id:'action_run_'+'a'.repeat(32),state:'succeeded',outputs:{value:'hello'}};
 queueMicrotask(()=>window.dispatchEvent(new MessageEvent('message',{data:{requestId:message.requestId,result}})));
}});
""".replace("CATALOG", json.dumps(catalog)).replace("ACTION", json.dumps(action))
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(headless=True)
                try:
                    page = browser.new_page(viewport={"width": 420, "height": 900})
                    errors = []
                    page.on("pageerror", lambda failure: errors.append(str(failure)))
                    page.route("https://action.test/**", lambda route: route.fulfill(
                        content_type="text/html", body=(ROOT / "resources/action-library.html").read_text()))
                    page.add_init_script(bootstrap)
                    page.goto("https://action.test/")
                    page.locator('[data-action="test.library.echo"]').click()
                    expect(page.locator("#detail")).to_contain_text("unverified")
                    expect(page.locator("#run")).to_be_disabled()
                    self.assertEqual(page.get_by_text("pending.hidden").count(), 0)
                    self.assertFalse(page.evaluate("__calls.some(item=>['call','validate','open_workbench'].includes(item.method))"))
                    page.evaluate("__action.availability={state:'ready',reason:''}")
                    page.locator("#refresh").click()
                    expect(page.locator("#run")).to_be_enabled()
                    page.locator('[data-field="value"]').fill("hello")
                    page.locator("#approve").check()
                    page.locator('[data-field="value"]').fill("changed")
                    expect(page.locator("#approve")).not_to_be_checked()
                    page.locator('[data-field="value"]').fill("hello")
                    page.locator("#approve").check()
                    page.locator("#run").click()
                    expect(page.locator("#run-status")).to_contain_text("succeeded", timeout=7000)
                    expect(page.locator("#run-result")).to_contain_text("hello")
                    self.assertEqual(len(page.evaluate("__calls.filter(item=>item.method==='call')")), 1)
                    self.assertEqual(page.evaluate("__state.launch.inputs"), {"value": "hello"})
                    page.locator("#open-workbench").click()
                    self.assertEqual(page.evaluate("__calls.filter(item=>item.method==='open_workbench').length"), 1)
                    self.assertEqual(page.evaluate("document.documentElement.scrollWidth>innerWidth"), False)
                    page.evaluate("__fail=true")
                    page.locator("#refresh").click()
                    expect(page.locator("#error")).to_contain_text("Library unavailable")
                    self.assertEqual(errors, [])
                finally:
                    browser.close()

    def test_embedded_subfolders_and_nested_move_persist_and_show_errors(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime, definition = self.create_runtime(directory)
            calls = []

            def dispatch(message):
                calls.append(message)
                method, params = message["method"], message.get("params", {})
                try:
                    if method == "catalog":
                        return runtime.catalog()
                    if method == "group_create":
                        return runtime.group_create(**params)
                    if method == "action_move":
                        return runtime.action_move(**params)
                    return {"ok": True, "runs": [], "draft": None}
                except (ValueError, PermissionError) as failure:
                    return {"ok": False, "error": str(failure)}

            html = (ROOT / "resources/action-workbench.html").read_text()
            bridge = """<script>window.acquireVsCodeApi=()=>({getState:()=>null,setState:()=>{},postMessage:message=>parent.postMessage(message,'*')});</script>"""
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(headless=True)
                try:
                    page = browser.new_page()
                    page.expose_function("dispatch", dispatch)
                    panel_source = (ROOT / "src/webview/panel/53-panel-instances.js").read_text()
                    self.assertIn("actionsFrame.setAttribute('sandbox', 'allow-scripts allow-forms')", panel_source)
                    page.route("https://action.test/**", lambda route: route.fulfill(content_type="text/html", body="""<iframe title="Workbench" sandbox="allow-scripts allow-forms" style="width:100%;height:900px"></iframe><script>
window.addEventListener('message',async event=>{if(event.source!==document.querySelector('iframe').contentWindow)return;
const result=await dispatch(event.data);event.source.postMessage({requestId:event.data.requestId,result},'*')});
</script>"""))
                    page.goto("https://action.test/")
                    page.locator("iframe").evaluate("(node,html)=>node.srcdoc=html", bridge + html)
                    frame = page.frame_locator("iframe")
                    frame.locator("#toggle-tree").click()
                    frame.locator("#add-group").click()
                    frame.locator("#catalog-name").fill("Tools")
                    frame.locator("#catalog-submit").click()
                    expect(frame.locator("#catalog-dialog")).not_to_be_visible(timeout=3000)
                    for parent, child in [("Tools", "Cloud"), ("Tools/Cloud", "Pipelines")]:
                        category = json.dumps(parent.split("/"), separators=(",", ":"))
                        frame.locator(f'[data-category=\'{category}\']').click(button="right")
                        frame.get_by_role("menuitem", name="Add subgroup").click()
                        expect(frame.locator("#catalog-parent")).to_contain_text(parent)
                        frame.locator("#catalog-name").fill(child)
                        frame.locator("#catalog-submit").click()
                        expect(frame.locator("#catalog-dialog")).not_to_be_visible()
                    frame.locator('[data-category=\'["Actions"]\']').click()
                    frame.locator(f'[data-action="{definition["action_id"]}"]').click(button="right")
                    frame.get_by_role("menuitem", name="Move to", exact=True).click()
                    frame.locator("#catalog-group").select_option("Tools/Cloud/Pipelines")
                    frame.locator("#catalog-submit").click()
                    expect(frame.locator("#catalog-dialog")).not_to_be_visible()
                    expect(frame.locator('[data-category=\'["Tools","Cloud","Pipelines"]\']')).to_have_attribute("aria-expanded", "true")
                    self.assertEqual(runtime.catalog_layout()["actions"][definition["action_id"]]["category"], "Tools/Cloud/Pipelines")
                    frame.locator('[data-category=\'["Tools","Cloud"]\']').click(button="right")
                    frame.get_by_role("menuitem", name="Add subgroup").click()
                    frame.locator("#catalog-name").fill("Pipelines")
                    frame.locator("#catalog-submit").click()
                    expect(frame.locator("#catalog-error")).to_contain_text("already exists")
                    expect(frame.locator("#catalog-dialog")).to_be_visible()
                    self.assertEqual(sum(item["method"] == "action_move" for item in calls), 1)
                finally:
                    browser.close()

    def test_unverified_drag_highlights_flask_and_validation_reports_outcomes_without_browser_confirm(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime, definition = self.create_runtime(directory)
            definition = runtime.catalog()["actions"]
            action = next(item for item in definition if item["action_id"] == "test.library.echo")
            action["effects"] = ["remote-read"]
            catalog = runtime.catalog()
            catalog["actions"] = [action]
            bootstrap = """
window.__catalog=CATALOG;window.__calls=[];window.__job=null;window.__fail=false;
window.confirm=()=>{throw Error('Browser confirm must not be used in VS Code webviews')};
window.acquireVsCodeApi=()=>({getState:()=>null,setState:()=>{},postMessage:message=>{
 __calls.push(message);let result={ok:true};
 if(message.method==='catalog')result={...__catalog,queue:{jobs:__job?[__job]:[]}};
 if(message.method==='runs')result={runs:[]};
 if(message.method==='validate'){
  if(__fail)result={ok:false,error:'Fixture permission denied'};
  else{__job={job_id:'validation_fixture',action_id:message.params.action_id,state:'queued',stage:'queued'};result={ok:true,job_id:__job.job_id}}
 }
 queueMicrotask(()=>window.dispatchEvent(new MessageEvent('message',{data:{requestId:message.requestId,result}})));
}});
""".replace("CATALOG", json.dumps(catalog))
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(headless=True)
                try:
                    page = browser.new_page()
                    errors = []
                    page.on("pageerror", lambda error: errors.append(str(error)))
                    page.route("https://action.test/**", lambda route: route.fulfill(
                        content_type="text/html", body=(ROOT / "resources/action-workbench.html").read_text()))
                    page.add_init_script(bootstrap)
                    page.goto("https://action.test/")
                    page.wait_for_function("actions.length===1")
                    page.evaluate("setTreeCollapsed(false);catExpanded[JSON.stringify(['Actions'])]=true;renderPalette()")
                    row = page.locator('[data-action="test.library.echo"]')
                    expect(row).to_have_attribute("draggable", "true")
                    row.dispatch_event("dragstart", {"dataTransfer": page.evaluate_handle("new DataTransfer()")})
                    expect(page.locator("#validation-dialog")).to_be_visible()
                    expect(page.locator("#validation-message")).to_contain_text("highlighted flask")
                    expect(page.locator("[data-qualify]")).to_have_class("icon validation-needed")
                    page.locator("#validation-accept").click()
                    self.assertFalse(page.evaluate("__calls.some(item=>item.method==='validate')"))
                    page.locator("[data-qualify]").click()
                    expect(page.locator("#validation-dialog")).to_be_visible()
                    expect(page.locator("#validation-message")).to_contain_text("remote-read")
                    page.locator("#validation-dismiss").click()
                    self.assertFalse(page.evaluate("__calls.some(item=>item.method==='validate')"))
                    page.locator("[data-qualify]").click()
                    page.locator("#validation-accept").click()
                    expect(page.locator("#validation-feedback")).to_contain_text("queued")
                    self.assertTrue(page.evaluate("__calls.find(item=>item.method==='validate').params.allow_effects"))
                    page.evaluate("__job.state='blocked';__job.error='Operator approval required';refresh()")
                    expect(page.locator("#validation-feedback")).to_contain_text("Operator approval required")
                    expect(page.locator("#validation-feedback")).to_have_attribute("data-failed", "true")
                    page.evaluate("__job.state='succeeded';delete __job.error;refresh()")
                    expect(page.locator("#validation-feedback")).to_contain_text("Ready:")
                    page.evaluate("__fail=true")
                    page.locator("[data-qualify]").click()
                    page.locator("#validation-accept").click()
                    expect(page.locator("#validation-feedback")).to_contain_text("Fixture permission denied")
                    self.assertEqual(errors, [])
                finally:
                    browser.close()

    def test_host_trust_buttons_request_native_review_without_automatic_execution(self):
        calls = []
        granted = [False]
        cancel = [True]
        with tempfile.TemporaryDirectory() as directory:
            runtime, _ = self.create_runtime(directory)
            from action_authoring import authoring_contract
            action = runtime.register(authoring_contract()["examples"]["cli"])
            proposed_definition = {**authoring_contract()["examples"]["cli"], "action_id": "example.pending"}
            proposal = runtime.propose(proposed_definition)

            def route_request(route):
                if route.request.method == "GET":
                    route.fulfill(status=200, content_type="text/html",
                                  body=(ROOT / "resources/action-workbench.html").read_text())
                    return
                request = route.request.post_data_json
                calls.append(request)
                method = request["method"]
                if method == "catalog":
                    result = runtime.catalog()
                elif method == "library_get":
                    result = runtime.library_get(action["action_id"])
                    result["grant"] = {"state": "granted" if granted[0] else "blocked"}
                elif method == "review_host_trust":
                    if not cancel[0]:
                        granted[0] = request["params"]["grant"]
                    result = {"ok": True, "cancelled": cancel[0]}
                elif method == "validate":
                    if cancel[0]:
                        result = {"ok": True, "cancelled": True}
                    else:
                        params = request["params"]
                        review = runtime.qualification_review(params["action_id"], params["content_hash"], params.get("proposal_id"))
                        result = runtime.qualification_execute(params["action_id"], params["content_hash"], review["snapshot_hash"],
                            {"approved": True, "issues": [], "summary": "Fixture review passed", "model": "fixture"},
                            params.get("proposal_id"), params.get("allow_effects", False))
                        result = runtime.qualification_admit(result["attempt_id"])
                        granted[0] = True
                elif method == "inspect_admission":
                    result = runtime.proposal_review(request["params"]["proposal_id"], reject=request["params"].get("reject", False)) if request["params"].get("proposal_id") else runtime.host_trust_review(
                        request["params"]["action_id"], request["params"]["content_hash"])
                elif method == "review_proposal":
                    if cancel[0]:
                        result = {"ok": True, "cancelled": True}
                    else:
                        review = runtime.proposal_review(request["params"]["proposal_id"], reject=not request["params"]["grant"])
                        result = runtime.proposal_decide(request["params"]["proposal_id"], review["review_hash"],
                                                         request["params"]["grant"])
                elif method == "runs":
                    result = {"ok": True, "runs": []}
                elif method == "session":
                    result = {"ok": True, "draft": None}
                else:
                    raise AssertionError("Unexpected UI operation: " + method)
                route.fulfill(status=200, content_type="application/json", body=json.dumps(result))

            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(headless=True)
                try:
                    page = browser.new_page()
                    page.route("https://action.test/**", route_request)
                    page.goto("https://action.test/")
                    page.locator("#open-library").click()
                    page.locator("#workbench-review-details > summary").click()
                    page.locator("#library-search").fill(action["action_id"])
                    page.locator(f'[data-inspect-library="{action["action_id"]}"]').click()
                    authorize = page.get_by_role("button", name="Review implementation before validation", exact=True)
                    expect(authorize).to_be_visible()
                    draft = page.evaluate("JSON.stringify(graph)")
                    authorize.click()
                    expect(page.locator("#admission-review")).to_be_visible()
                    expect(page.locator(".workspace .viewport")).to_be_hidden()
                    expect(page.locator("#admission-review details")).not_to_have_attribute("open", "")
                    expect(page.locator("#admission-review")).to_contain_text("Inputs")
                    expect(page.locator("#admission-review")).to_contain_text("Outputs")
                    for width in [320, 1280]:
                        page.set_viewport_size({"width": width, "height": 900})
                        self.assertTrue(page.locator("#admission-review").evaluate("node=>node.scrollWidth<=node.clientWidth"),
                                        "readable review must fit desktop and narrow canvas widths")
                    page.locator("#admission-cancel").click()
                    expect(page.locator(".workspace .viewport")).to_be_visible()
                    self.assertEqual(page.evaluate("JSON.stringify(graph)"), draft)
                    self.assertFalse(any(item["method"] == "review_host_trust" for item in calls))
                    page.locator("#open-library").click()
                    page.locator("#workbench-review-details").evaluate("node=>node.open=true")
                    authorize.click()
                    page.locator("#admission-confirm").click()
                    expect(page.locator("#admission-confirm")).to_be_enabled()
                    self.assertFalse(granted[0], "cancelled native review must not grant")
                    cancel[0] = False
                    page.locator("#admission-confirm").click()
                    expect(page.locator("#validation-feedback")).to_contain_text("admitted and ready")
                    page.locator("#open-library").click()
                    page.locator("#workbench-review-details").evaluate("node=>node.open=true")
                    page.locator(f'[data-inspect-library="{action["action_id"]}"]').click()
                    revoke = page.get_by_role("button", name="Revoke host execution for this revision", exact=True)
                    expect(revoke).to_be_visible()
                    revoke.click()
                    expect(authorize).to_be_visible()
                    self.assertFalse(granted[0])
                    updates = [item for item in calls if item["method"] == "review_host_trust"]
                    self.assertEqual([item["params"]["grant"] for item in updates], [False])
                    self.assertTrue(all(item["params"]["content_hash"] == action["content_hash"] for item in updates))
                    self.assertFalse(any(item["method"] in {"call", "host_trust_update"} for item in calls))
                    page.locator("#library-search").fill(proposed_definition["action_id"])
                    proposal_button = page.locator(f'[data-proposal="{proposal["proposal_id"]}"][data-approve="true"]')
                    expect(proposal_button).to_be_visible()
                    self.assertFalse((runtime.registry / "example.pending.json").exists())
                    cancel[0] = True
                    proposal_button.click()
                    expect(page.locator("#admission-confirm")).to_be_visible()
                    self.assertFalse(any(item["method"] == "review_proposal" for item in calls),
                                     "opening the readable canvas must not request approval")
                    page.locator("#admission-confirm").click()
                    expect(page.locator("#admission-confirm")).to_be_enabled()
                    self.assertFalse((runtime.registry / "example.pending.json").exists())
                    cancel[0] = False
                    page.locator("#admission-confirm").click()
                    expect(page.locator("#validation-feedback")).to_contain_text("admitted and ready")
                    page.locator("#open-library").click()
                    page.locator("#workbench-review-details").evaluate("node=>node.open=true")
                    expect(page.locator('[data-inspect-library="example.pending"]')).to_be_visible()
                    page.locator('[data-inspect-library="example.pending"]').click()
                    expect(page.locator("#library-run")).to_be_enabled()
                    self.assertTrue(runtime.admitted(runtime.definition("example.pending")))
                    self.assertFalse(any(item["method"] in {"call", "proposal_decide"} for item in calls))
                    updated = {**proposed_definition, "version": 2, "description": "<img src=x onerror=alert(1)>"}
                    rejected = runtime.propose(updated)
                    page.locator("#library-close").click()
                    page.locator("#open-library").click()
                    page.locator("#workbench-review-details").evaluate("node=>node.open=true")
                    page.locator("#library-search").fill("example.pending")
                    page.locator(f'[data-proposal="{rejected["proposal_id"]}"][data-approve="false"]').click()
                    expect(page.locator("#admission-review")).to_contain_text("Approved v1")
                    expect(page.locator("#admission-review img")).to_have_count(0)
                    page.locator("#admission-confirm").click()
                    expect(page.locator("#action-library")).to_be_visible()
                    self.assertEqual(runtime.definition("example.pending")["version"], 1)
                    self.assertFalse(runtime.proposal_list()["proposals"])
                    self.assertTrue(all(item["params"].get("review_hash") for item in calls
                                        if item["method"] == "review_proposal"))
                finally:
                    browser.close()

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
                            page.locator("#workbench-review-details").evaluate("node=>node.open=true")
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
                            page.locator("#workbench-review-details").evaluate("node=>node.open=true")
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
                            expect(page.locator("#status")).to_contain_text("Proposal submitted", timeout=30000)
                            proposal = next(item for item in runtime.proposal_list()["proposals"]
                                            if item["action_id"] == page.evaluate("graph.action_id"))
                            review = runtime.proposal_review(proposal["proposal_id"])
                            runtime.proposal_decide(proposal["proposal_id"], review["review_hash"], True)
                            page.evaluate("refresh()")
                            page.wait_for_function("() => saved?.version===1")
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
                        page.locator("#workbench-review-details").evaluate("node=>node.open=true")
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
                        page.locator("#workbench-review-details").evaluate("node=>node.open=true")
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
                        page.locator("#workbench-review-details").evaluate("node=>node.open=true")
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

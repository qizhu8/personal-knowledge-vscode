"""Browser acceptance of the shipped inline Chat form and polling template creator."""

import json
import re
import unittest
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]


class ActionForms(unittest.TestCase):
    def test_inline_question_drafts_validation_error_retry_and_cancel(self):
        assets = ROOT / "dist" / "webview"
        values = {"nonce": "fixture", "cspSource": "'self'", "styles": "/api-chat.css", "script": "/api-chat.js",
            "libraryScript": "/api-chat-library.js", "retrievalScript": "/chat-retrieval-flow.js",
            "hostHealthScript": "/host-health.js", "hostHealthStyles": "/host-health.css", "icons": "/codicon.css",
            "harnessScript": "/agent-harness.js", "harnessStyles": "/agent-harness.css", "visualizationScript": "/chat-visualization.js",
            "marked": "/marked.umd.js", "purify": "/purify.min.js", "katex": "/katex.js", "katexStyles": "/katex.css",
            "mermaid": "/mermaid.js"}
        html = re.sub(r"\{\{(\w+)\}\}", lambda match: values[match[1]], (assets / "api-chat.html").read_text())
        schema = {"type": "object", "properties": {
            "alias": {"type": "string", "title": "Agent alias", "minLength": 1, "maxLength": 80},
            "mode": {"type": "string", "enum": ["read", "review"]},
            "tags": {"type": "array", "items": {"type": "string", "enum": ["research", "coding"]}},
            "minutes": {"type": "integer", "minimum": 1, "maximum": 5},
            "confirm": {"type": "boolean"},
        }, "required": ["alias", "mode", "minutes"]}
        state = {"type": "state", "busy": True, "decisions": [{"id": "form", "title": "Choose agent identity",
            "detail": "Do not enter secrets.", "choices": [{"value": "submit", "label": "Submit"}, {"value": "cancel", "label": "Cancel"}],
            "form": schema}], "approvals": [],
            "chat": {"id": "fixture", "title": "Action form", "messages": [], "context": [], "permissionMode": "protective", "permissionGrants": []},
            "chats": [{"id": "fixture", "title": "Action form", "status": "awaiting-input"}],
            "settings": {"provider": "openai-compatible", "model": "fixture", "models": [], "profiles": [],
                "selectedProfile": {"id": "fixture", "status": "active", "contextWindow": 4096, "maxOutputTokens": 1024},
                "contextWindow": 4096, "maxOutputTokens": 1024, "inputBaseTokens": 0}}
        bootstrap = "window.__posts=[];window.__fixture=" + json.dumps(state) + """;
window.acquireVsCodeApi=()=>({getState:()=>({}),setState:()=>{},postMessage:message=>{
 __posts.push(message);
 if(message.type==='ready')queueMicrotask(()=>window.dispatchEvent(new MessageEvent('message',{data:__fixture})));
 if(message.type==='hostHealth')queueMicrotask(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'hostHealth',id:message.id}})));
}});
"""
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                for width in [1280, 390]:
                    page = browser.new_page(viewport={"width": width, "height": 900})
                    errors = []
                    page.on("pageerror", lambda error: errors.append(str(error)))
                    def route(request):
                        name = request.request.url.split("http://127.0.0.1/")[-1]
                        if not name:
                            request.fulfill(content_type="text/html", body=html)
                        else:
                            asset = assets / name
                            if asset.is_file():
                                request.fulfill(path=str(asset))
                            else:
                                request.fulfill(status=404)
                    page.route("http://127.0.0.1/**", route)
                    page.add_init_script(bootstrap)
                    page.goto("http://127.0.0.1/")
                    page.evaluate("window.dispatchEvent(new MessageEvent('message',{data:{type:'showChat'}}))")
                    self.assertEqual(errors, [])
                    form = page.locator(".chat-question-form")
                    expect(form).to_be_visible()
                    expect(form.locator("select")).to_have_count(0)
                    submit = page.get_by_role("button", name="Submit", exact=True)
                    submit.click()
                    self.assertFalse(page.evaluate("__posts.some(message=>message.type==='decision')"))
                    form.get_by_label("Agent alias").fill("research-agent")
                    form.get_by_role("radio", name="review", exact=True).check()
                    form.get_by_role("checkbox", name="research", exact=True).check()
                    form.get_by_role("checkbox", name="coding", exact=True).check()
                    form.locator('[name="minutes"]').fill("3")
                    form.locator('[name="confirm"]').check()
                    page.evaluate("window.dispatchEvent(new MessageEvent('message',{data:__fixture}))")
                    expect(form.get_by_label("Agent alias")).to_have_value("research-agent")
                    expect(form.get_by_role("radio", name="review", exact=True)).to_be_checked()
                    expect(form.get_by_role("checkbox", name="research", exact=True)).to_be_checked()
                    expect(form.get_by_role("checkbox", name="coding", exact=True)).to_be_checked()
                    submit.click()
                    self.assertTrue(page.evaluate("""__posts.some(message=>message.type==='decision'&&message.id==='form'
&&message.answer.alias==='research-agent'&&message.answer.mode==='review'&&message.answer.minutes===3
&&message.answer.tags.length===2&&message.answer.confirm===true)"""))
                    expect(submit).to_be_disabled()
                    page.evaluate("""window.dispatchEvent(new MessageEvent('message',{data:{type:'error',chatId:'fixture',
confirmationId:'form',message:'The backend rejected the answer; edit and retry.'}}))""")
                    expect(submit).to_be_enabled()
                    expect(form.get_by_role("alert")).to_contain_text("backend rejected")
                    expect(form.get_by_label("Agent alias")).to_have_value("research-agent")
                    page.get_by_role("button", name="Cancel", exact=True).click()
                    self.assertTrue(page.evaluate("__posts.some(message=>message.type==='decision'&&message.value==='cancel')"))
                    self.assertEqual(errors, [])
                    page.close()
            finally:
                browser.close()

    def test_poll_template_pins_read_only_query_without_executing_it(self):
        html = (ROOT / "resources/action-workbench.html").read_text()
        bootstrap = """
window.__posts=[];window.acquireVsCodeApi=()=>({getState:()=>null,setState:()=>{},postMessage:message=>{
 __posts.push(message);let result={ok:true};
 if(message.method==='catalog')result={actions:[{action_id:'fixture.query',display_name:'Read job status',content_hash:'pinned-query',
 effects:['remote-read'],category:'Actions',availability:{state:'ready'},
 input_schema:{type:'object',properties:{job:{type:'string'}},required:['job']},
 output_schema:{type:'object',properties:{status:{type:'string'}}},examples:[{inputs:{job:'fixture-job'}}]}],
 groups:['Actions'],module_sets:[],queue:{jobs:[]}};
 if(message.method==='runs')result={runs:[]};
 queueMicrotask(()=>window.dispatchEvent(new MessageEvent('message',{data:{requestId:message.requestId,result}})));
}});
"""
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                page = browser.new_page(viewport={"width": 1280, "height": 900})
                errors = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.route("http://127.0.0.1/", lambda route: route.fulfill(content_type="text/html", body=html))
                page.add_init_script(bootstrap)
                page.goto("http://127.0.0.1/")
                self.assertEqual(errors, [])
                page.locator("#toggle-tree").click()
                page.get_by_role("button", name="Create polling Action").click()
                dialog = page.get_by_role("dialog")
                expect(dialog).to_be_visible()
                expect(dialog.get_by_label("Query inputs")).to_have_value('{\n  "job": "fixture-job"\n}')
                dialog.get_by_label("Expected value").fill("{")
                dialog.get_by_role("button", name="Create without running").click()
                expect(dialog.get_by_role("alert")).not_to_be_empty()
                self.assertFalse(page.evaluate("__posts.some(item=>item.method==='template_create')"))
                dialog.get_by_label("Expected value").fill('"succeeded"')
                dialog.get_by_role("button", name="Create without running").click()
                expect(dialog).not_to_be_visible()
                payload = page.evaluate("__posts.find(item=>item.method==='template_create').params")
                self.assertEqual(payload["parameters"]["query_revision"], "pinned-query")
                self.assertEqual(payload["parameters"]["query_inputs"], {"job": "fixture-job"})
                self.assertEqual(payload["parameters"]["expected"], "succeeded")
                self.assertFalse(page.evaluate("__posts.some(item=>['call','platform_call','validate'].includes(item.method))"))
                self.assertEqual(errors, [])
            finally:
                browser.close()


if __name__ == "__main__":
    unittest.main()

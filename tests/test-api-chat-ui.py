import json
import tempfile
import time
import unittest
from urllib.parse import urlparse
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parent.parent


class ChatUiTests(unittest.TestCase):
    def test_panel_host_connection_warning(self):
        assets = ROOT / 'dist' / 'webview'
        html = (assets / 'panel.html').read_text(encoding='utf-8')
        for token, asset in {'PANEL_JS': 'panel.js', 'PANEL_CSS': 'panel.css', 'CODICON_CSS': 'codicon.css',
                             'HOST_HEALTH_JS': 'host-health.js', 'HOST_HEALTH_CSS': 'host-health.css',
                             'MARKED_SRC': 'marked.umd.js', 'HLJS_SRC': 'hljs.js', 'HLJS_CSS': 'hljs.css',
                             'KATEX_SRC': 'katex.js', 'KATEX_CSS': 'katex.css'}.items():
            html = html.replace('%%' + token + '%%', asset)
        html = html.replace('%%CSP_SOURCE%%', "'self'")
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            try:
                for width in (1280, 390, 320):
                    page = browser.new_page(viewport={'width': width, 'height': 844})
                    page.clock.install()
                    page.add_init_script("window.__posts=[];window.acquireVsCodeApi=()=>({getState:()=>({tab:'notes'}),setState:()=>{},postMessage:value=>window.__posts.push(value)});")
                    def route(request):
                        name = Path(urlparse(request.request.url).path).name
                        if name == 'index.html':
                            request.fulfill(body=html, content_type='text/html')
                        elif (assets / name).is_file():
                            request.fulfill(path=str(assets / name))
                        else:
                            request.fulfill(status=404, body='Not found')
                    page.route('http://panel.test/**', route)
                    page.goto('http://panel.test/index.html')
                    page.clock.fast_forward(15_000)
                    warning = page.locator('#pkm-host-warning')
                    expect(warning).to_contain_text('PKM failed to load')
                    geometry = warning.bounding_box()
                    self.assertAlmostEqual(geometry['x'] + geometry['width'], width - 8, delta=1)
                    self.assertAlmostEqual(geometry['y'], 8, delta=1)
                    self.assertGreaterEqual(geometry['x'], 0)
                    self.assertTrue(warning.locator('span:not(.codicon)').evaluate('node=>node.scrollWidth<=node.clientWidth'))
                    page.evaluate("window.dispatchEvent(new MessageEvent('message',{data:{command:'loadingProgress',data:{stage:'ready'}}}))")
                    expect(warning).to_be_hidden()
                    page.clock.fast_forward(20_000)
                    expect(warning).to_contain_text('Extension Host is not responding')
                    page.evaluate("window.dispatchEvent(new MessageEvent('message',{data:window.__posts.filter(message=>message.command==='hostHealth').at(-1)}))")
                    expect(warning).to_be_hidden()
                    page.evaluate("""() => {
                        projectSnapshot = {agentSessionGroups:[
                            {groupId:'manager',hostKind:'pkm',hostSessionId:'Manager',title:'Manager',libraryGroupId:'research',libraryGroupTitle:'Research / Group',workerTreeId:'tree'},
                            {groupId:'worker',hostKind:'pkm',hostSessionId:'Worker',title:'Worker',libraryGroupId:'ungroup',libraryGroupTitle:'Ungroup',workerTreeId:'tree',workerParentChatId:'Manager'},
                            {groupId:'empty',hostKind:'pkm',hostSessionId:'Empty',title:'Empty Chat',libraryGroupId:'research',libraryGroupTitle:'Research / Group'}
                        ]};
                        const fixture=document.createElement('section');fixture.id='session-group-fixture';
                        fixture.innerHTML=agentSessionTree([
                            {sessionId:'task_manager',groupId:'manager',task:'Parent Task',status:'running'},
                            {sessionId:'task_worker',groupId:'worker',task:'Worker Task',status:'paused'}
                        ]);
                        document.body.append(fixture);
                    }""")
                    groups = page.locator('#session-group-fixture .agent-session-tree > .tree-cat')
                    expect(groups).to_have_count(1)
                    expect(groups.locator(':scope > .tree-cat-hdr .tree-cat-label')).to_contain_text('Research / Group')
                    expect(groups.locator(':scope > .tree-cat-body > .tree-cat')).to_have_count(2)
                    expect(page.locator('#session-group-fixture .agent-session-row')).to_have_count(2)
                    expect(page.locator('#session-group-fixture')).to_contain_text('No Task')
                    expect(page.locator('#session-group-fixture .tree-cat .tree-cat .tree-cat')).to_have_count(1)
                    page.locator('#session-group-fixture').evaluate('node=>node.remove()')
                    page.close()
            finally:
                browser.close()

    def test_popovers_model_acknowledgement_and_single_activity(self):
        assets = ROOT / "dist" / "webview"
        page_html = (assets / "api-chat.html").read_text()
        replacements = {
            "nonce": "isolated-chat-ui", "cspSource": "https://chat.test",
            "styles": "api-chat.css", "script": "api-chat.js", "icons": "codicon.css",
            "marked": "marked.umd.js", "purify": "purify.min.js",
            "katex": "katex.js", "katexStyles": "katex.css", "mermaid": "mermaid.js",
            "libraryScript": "api-chat-library.js", "retrievalScript": "chat-retrieval-flow.js",
            "hostHealthScript": "host-health.js", "hostHealthStyles": "host-health.css",
            "harnessScript": "agent-harness.js", "harnessStyles": "agent-harness.css",
            "visualizationScript": "chat-visualization.js",
        }
        for key, value in replacements.items():
            page_html = page_html.replace("{{" + key + "}}", value)
        started = int(time.time() * 1000) - 5000
        chat_url = "pkm://chats/0123456789abcdef/816fcfcc-05f3-4506-9b10-eeb09efbafd2"
        progress = {"attemptId": "fixture", "startedAt": started, "status": "running", "model": "fixture", "steps": [
            {"label": "Preparing context", "at": started, "status": "complete"},
            {"label": "Completed tool: read_file", "at": started + 100, "status": "complete"},
            {"label": "Waiting for tool-loop decision", "at": started + 200, "status": "waiting"},
        ]}
        fixture = {"type": "state", "busy": True, "approvals": [], "chats": [], "tools": [], "toolGroups": [],
            "library": {"groups": [], "chats": [{"id": "chat_fixture", "title": "Chat UI", "status": "running", "groupId": "ungroup"}]},
            "chat": {"id": "chat_fixture", "title": "Chat UI", "context": [], "permissionMode": "allow-all", "permissionGrants": [],
                "messages": [{"id": "reply", "role": "assistant", "content": f"Partial result\n\n[Chat link]({chat_url}) [Unsafe link](javascript:alert(1)) [File link](file:///tmp/private) [External link](https://example.com)", "status": "streaming", "progress": progress,
                    "toolCalls": [{"id": "read", "name": "read_file", "arguments": "{}", "result": "retained result", "status": "complete"}]}],
                "progress": progress, "includeHistory": True},
            "settings": {"provider": "vscode", "maxToolRounds": 30, "contextWindow": 8192, "maxOutputTokens": 1024,
                "selectedProfile": {"id": "fixture", "model": "fixture", "label": "Fixture", "status": "active", "contextWindow": 8192, "maxOutputTokens": 1024}}}

        def serve(route):
            name = urlsplit(route.request.url).path.lstrip("/")
            if not name:
                route.fulfill(content_type="text/html", body=page_html)
            elif (assets / name).is_file():
                suffix = Path(name).suffix
                content_type = {".js": "text/javascript", ".css": "text/css", ".ttf": "font/ttf"}.get(suffix, "application/octet-stream")
                route.fulfill(content_type=content_type, body=(assets / name).read_bytes())
            else:
                route.fulfill(status=404, body="missing fixture asset")

        with tempfile.TemporaryDirectory(prefix="pkm-chat-ui-") as screenshots, sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            try:
                for width in [1280, 390]:
                    with self.subTest(width=width):
                        page = browser.new_page(viewport={"width": width, "height": 800})
                        errors = []
                        page.on("pageerror", lambda error: errors.append(str(error)))
                        page.clock.install()
                        page.route("https://chat.test/**", serve)
                        page.add_init_script("window.__posts=[];window.__sendSnapshots=[];window.acquireVsCodeApi=()=>({getState:()=>({screen:'chat'}),setState:()=>{},postMessage:value=>{if(value.type==='send')window.__sendSnapshots.push(document.querySelector('.optimistic-message')?.textContent);window.__posts.push(value)}});")
                        page.goto("https://chat.test/")
                        page.wait_for_function("window.__posts.some(message=>message.type==='ready')")
                        expect(page.get_by_role('progressbar', name='Loading PKM Chat')).to_be_visible()
                        self.assertTrue(page.evaluate('window.PkmHostHealth.unavailable'))
                        page.locator('#composer').evaluate("node=>node.requestSubmit()")
                        self.assertEqual(page.evaluate("window.__posts.filter(message=>message.type==='send').length"), 0)
                        page.clock.fast_forward(15_000)
                        expect(page.locator('#pkm-host-warning')).to_contain_text('PKM failed to load')
                        expect(page.locator('#pkm-chat-loading')).to_be_hidden()
                        expect(page.locator('#copy-chat-id')).to_have_attribute('aria-label', 'Copy PKM URL')
                        banner = page.locator('#pkm-host-warning').bounding_box()
                        self.assertAlmostEqual(banner['x'] + banner['width'], width - 8, delta=1)
                        self.assertGreaterEqual(banner['x'], 0)
                        self.assertLessEqual(page.evaluate('document.documentElement.scrollWidth'), width)
                        page.get_by_role('button', name='Reconnect to Extension Host').click()
                        expect(page.locator('#pkm-chat-loading')).to_be_visible()
                        page.clock.fast_forward(10_000)
                        expect(page.locator('#pkm-host-warning')).to_contain_text('Reconnecting to Extension Host')
                        expect(page.locator('#pkm-chat-loading')).to_be_visible()
                        page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))", fixture)
                        expect(page.locator('#library-view')).to_be_visible()
                        expect(page.locator('#messages .message')).to_have_count(0)
                        expect(page.locator('#chat-list .chat-status-indicator')).to_have_attribute('aria-label', 'Running')
                        page.get_by_role('button', name='Chat actions', exact=True).click()
                        page.get_by_role('menuitem', name='Rename chat', exact=True).click()
                        self.assertTrue(page.evaluate("window.__posts.some(message=>message.type==='rename'&&message.id==='chat_fixture')"))
                        expect(page.locator('#library-view')).to_be_visible()
                        waiting = {**fixture, 'library': {'groups': [], 'chats': [{**fixture['library']['chats'][0], 'status': 'awaiting-input'}]}}
                        page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))", waiting)
                        expect(page.locator('#chat-list .chat-status-indicator')).to_have_attribute('aria-label', 'Waiting for Input')
                        expect(page.locator('#messages .message')).to_have_count(0)
                        tree_fixture = {**fixture, "library": {"groups": [{"id": "specialists", "name": "Specialists"}], "chats": [
                            {**fixture["library"]["chats"][0], "status": "idle", "workerTreeId": "tree"},
                            {"id": "idle_a", "title": "Idle A", "status": "idle", "groupId": "ungroup"},
                            {"id": "idle_b", "title": "Idle B", "status": "idle", "groupId": "ungroup"},
                            {"id": "child", "title": "Temporary worker", "status": "idle", "groupId": "ungroup", "workerParentChatId": "chat_fixture", "workerTreeId": "tree"},
                            {"id": "existing", "title": "Existing specialist", "status": "idle", "groupId": "specialists"},
                        ]}}
                        page.evaluate("""data => {
                            window.__treeFixture = data;
                            window.dispatchEvent(new MessageEvent('message', {data}));
                            const selector = '.chat-list-group[data-group-id="ungroup"] > .chat-list-node > .chat-list-row > .chat-list-open';
                            window.__stableRows = [...document.querySelectorAll(selector)];
                            window.__stableOrder = window.__stableRows.map(node => node.dataset.chatId);
                        }""", tree_fixture)
                        expect(page.locator('[data-node-chat-id="chat_fixture"] .chat-list-children [data-node-chat-id="child"]')).to_have_count(1)
                        expect(page.locator('[data-group-id="specialists"] [data-node-chat-id="existing"]')).to_have_count(1)
                        self.assertTrue(page.evaluate("""() => {
                            for (let i = 0; i < 50; i++) {
                                for (const chat of window.__treeFixture.library.chats) chat.updatedAt = i;
                                window.dispatchEvent(new MessageEvent('message', {data: window.__treeFixture}));
                            }
                            const rows = [...document.querySelectorAll('.chat-list-group[data-group-id="ungroup"] > .chat-list-node > .chat-list-row > .chat-list-open')];
                            return rows.every((node, index) => node === window.__stableRows[index]);
                        }"""), "Fifty progress refreshes preserve button identity and order")
                        self.assertTrue(page.evaluate("""() => {
                            window.__treeFixture.library.chats.find(chat => chat.id === 'idle_b').status = 'running';
                            window.dispatchEvent(new MessageEvent('message', {data: window.__treeFixture}));
                            const ids = [...document.querySelectorAll('.chat-list-group[data-group-id="ungroup"] > .chat-list-node > .chat-list-row > .chat-list-open')].map(node => node.dataset.chatId);
                            return JSON.stringify(ids) === JSON.stringify(['idle_b', ...window.__stableOrder.filter(id => id !== 'idle_b')]);
                        }"""), "Only active-state partition changes ordering")
                        page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))", waiting)
                        page.evaluate("window.dispatchEvent(new MessageEvent('message',{data:{type:'showChat'}}))")
                        expect(page.locator('#messages .message')).to_have_count(1)
                        simple_approval = {**fixture, "approvals": [{"id": "simple_fixture", "title": "Permit one action",
                            "detail": "One bounded action", "scope": "Non-destructive operations", "once": False}]}
                        page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))", simple_approval)
                        expect(page.locator('.approval').get_by_role('button', name='Approve & remember', exact=True)).to_be_visible()
                        expect(page.locator('.approval').get_by_role('button', name='Allow All', exact=True)).to_be_visible()
                        page.locator('.approval').get_by_role('button', name='Allow once', exact=True).click()
                        self.assertEqual(page.evaluate("window.__posts.at(-1)"),
                                         {"type": "approval", "id": "simple_fixture", "value": "approve-once"})
                        worker_ui = {**fixture, "workerOverview": {"rootChatId": "chat_fixture", "activeWorkers": 0, "quota": 6, "maximum": 10, "nodes": [
                            {"chatId": "chat_fixture", "title": "Manager", "status": "completed"},
                            {"chatId": "archived", "parentChatId": "chat_fixture", "title": "Archived worker", "status": "completed", "archived": True, "receiptId": "receipt_fixture", "dispatchedAt": started},
                            {"chatId": "failed-worker", "parentChatId": "chat_fixture", "title": "Budget failure", "status": "failed", "canResume": True,
                             "receiptId": "failed-receipt", "attemptId": "failed-attempt", "error": "Local output budget exhausted. Partial evidence preserved."},
                        ]}, "approvals": [{"id": "quota_fixture", "title": "Increase capacity", "detail": "3 to 6", "scope": "Worker quota", "once": True, "quota": True, "questions": []}]}
                        page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))", worker_ui)
                        expect(page.locator('#workers-summary')).to_contain_text('Capacity: 0/6')
                        if page.locator('#workers-toggle').get_attribute('aria-expanded') == 'false':
                            page.locator('#workers-toggle').click()
                        expect(page.locator('#workers-tree .worker-node')).to_have_count(3)
                        failed_worker = page.locator('#workers-tree [data-chat-id="failed-worker"]')
                        failed_worker.locator(':scope > summary').click()
                        expect(failed_worker.locator('.worker-failure')).to_be_visible()
                        expect(failed_worker.locator('.worker-failure')).to_contain_text('output budget exhausted')
                        failed_worker.locator(':scope > summary').click()
                        expect(failed_worker).to_contain_text('Resume retains execution evidence')
                        failed_worker.get_by_role('button', name='Resume worker', exact=True).click()
                        self.assertEqual(page.evaluate("window.__posts.at(-1)"), {"type": "workerResume", "id": "failed-receipt", "value": "failed-attempt", "chatId": "chat_fixture"})
                        expect(failed_worker.get_by_role('button', name='Resume worker', exact=True)).to_be_disabled()
                        expect(page.locator('[data-chat-id="archived"]').get_by_role('button', name='Resume worker', exact=True)).to_have_count(0)
                        expect(page.locator('.approval').get_by_role('button', name='Yes', exact=True)).to_be_enabled()
                        expect(page.locator('.approval').get_by_role('button', name='No', exact=True)).to_be_enabled()
                        page.locator('.approval textarea').fill('Is capacity reusable?')
                        page.locator('.approval').get_by_role('button', name='Let me ask a question', exact=True).click()
                        self.assertTrue(page.evaluate("window.__posts.some(message=>message.type==='approvalQuestion'&&message.text==='Is capacity reusable?')"))
                        self.assertFalse(page.evaluate("window.__posts.some(message=>message.type==='approval'&&message.id==='quota_fixture')"))
                        page.locator('[data-chat-id="archived"] > summary').click()
                        page.locator('[data-chat-id="archived"]').get_by_role('button', name='Archived result', exact=True).click()
                        self.assertTrue(page.evaluate("window.__posts.some(message=>message.type==='workerArchive'&&message.id==='receipt_fixture')"))
                        page.evaluate("window.dispatchEvent(new MessageEvent('message',{data:{type:'workerArchive',chatId:'chat_fixture',receiptId:'receipt_fixture',title:'Archived worker',answer:'**Durable answer**',tools:[{name:'read_file',status:'complete'}]}}))")
                        expect(page.locator('.worker-archive strong')).to_have_text('Durable answer')
                        expect(page.locator('.worker-archive')).to_contain_text('read_file: complete')
                        page.locator('.worker-archive').get_by_role('button', name='Close', exact=True).click()
                        page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))", fixture)
                        expect(page.locator('#pkm-host-warning')).to_be_hidden()
                        expect(page.locator('#pkm-chat-loading')).to_be_hidden()
                        expect(page.locator('#send')).to_be_visible()
                        expect(page.locator('#stop')).to_be_visible()
                        for mode, text in [('steer', 'Revised boundary'), ('task', 'Independent next task')]:
                            page.locator(f'#{mode}-mode').click()
                            page.locator('#prompt').fill(text)
                            page.locator('#send').click()
                            page.clock.run_for(32)
                            page.wait_for_function("() => window.__posts.some(message=>message.type==='send'&&message.text===document.getElementById('prompt').value)")
                            sent = page.evaluate("window.__posts.filter(message=>message.type==='send').at(-1)")
                            self.assertIsNotNone(sent, {'errors': errors, 'form': page.locator('#composer').evaluate("node=>({valid:node.checkValidity(),invalid:Array.from(node.querySelectorAll(':invalid')).map(item=>({id:item.id,message:item.validationMessage}))})"), 'hostUnavailable': page.evaluate('window.PkmHostHealth.unavailable')})
                            self.assertEqual(sent['text'], text)
                            self.assertEqual(sent['mode'], mode)
                            expect(page.locator('.optimistic-message').filter(has_text=text)).to_contain_text('Sending')
                            self.assertIn(text, page.evaluate("window.__sendSnapshots.at(-1)"))
                            page.locator('#prompt').press('Enter')
                            self.assertEqual(page.evaluate("window.__posts.filter(message=>message.type==='send'&&message.submissionId==='%s').length" % sent['submissionId']), 1)
                            page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))", {'type': 'sendAccepted', 'chatId': sent['chatId'], 'submissionId': sent['submissionId']})
                            expect(page.locator('#prompt')).to_have_value('')
                            expect(page.locator('.optimistic-message').filter(has_text=text)).to_contain_text('Accepted')
                            synced = {**fixture, 'chat': {**fixture['chat'], 'queuedInputs': [{'id': sent['submissionId'], 'mode': mode, 'text': text}]}}
                            page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))", synced)
                            expect(page.locator('.optimistic-message')).to_have_count(0)
                        page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))", {**fixture, 'remoteBusy': True})
                        expect(page.locator('#steer-mode')).to_be_disabled()
                        expect(page.locator('#stop')).to_be_disabled()
                        expect(page.locator('#permission-mode')).to_be_disabled()
                        page.locator('#prompt').fill('Task from this sending window')
                        expect(page.locator('#send')).to_be_enabled()
                        page.locator('#send').click()
                        page.clock.run_for(32)
                        page.wait_for_function("() => window.__posts.some(message=>message.type==='send'&&message.text==='Task from this sending window')")
                        foreign_sent = page.evaluate("window.__posts.filter(message=>message.type==='send').at(-1)")
                        self.assertEqual(foreign_sent['mode'], 'task')
                        self.assertEqual(foreign_sent['text'], 'Task from this sending window')
                        page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))", {'type': 'sendAccepted', 'chatId': foreign_sent['chatId'], 'submissionId': foreign_sent['submissionId']})
                        expect(page.locator('#prompt')).to_have_value('')
                        foreign_synced = {**fixture, 'chat': {**fixture['chat'], 'messages': [*fixture['chat']['messages'], {'id': 'foreign_user', 'role': 'user', 'content': foreign_sent['text'], 'status': 'complete', 'submissionId': foreign_sent['submissionId']}]}}
                        page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))", foreign_synced)
                        expect(page.locator('.optimistic-message')).to_have_count(0)
                        queued_fixture = {**fixture, 'chat': {**fixture['chat'], 'queuedInputs': [{'id': 'queued_fixture', 'mode': 'task', 'text': 'Queued evidence check'}]}}
                        page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))", queued_fixture)
                        expect(page.locator('#queued-inputs')).to_contain_text('Queued evidence check')
                        page.get_by_role('button', name='Remove queued input', exact=True).click()
                        self.assertTrue(page.evaluate("window.__posts.some(message=>message.type==='removeQueuedInput'&&message.id==='queued_fixture')"))
                        idle_queue = {**queued_fixture, 'busy': False}
                        page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))", idle_queue)
                        page.get_by_role('button', name='Run queued inputs', exact=True).click()
                        self.assertTrue(page.evaluate("window.__posts.some(message=>message.type==='runQueued')"))
                        delegated = {**fixture, 'chat': {**fixture['chat'], 'messages': [{**fixture['chat']['messages'][0], 'delegations': [{'id': 'receipt_fixture', 'chatUrl': chat_url, 'status': 'complete', 'answer': '<img src=x onerror=alert(1)> safely stored result'}]}]}}
                        page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))", delegated)
                        expect(page.locator('.delegation-answer')).to_contain_text('<img src=x onerror=alert(1)>')
                        expect(page.locator('.delegation-result img')).to_have_count(0)
                        expect(page.locator('.delegation-result .chat-status-indicator')).to_have_attribute('data-state', 'completed')
                        rich_text = "# Rich result\n\n**Evidence** $x^2$ and \\(y+1\\).\n\n$$\\frac{a}{b}$$\n\n```mermaid\nflowchart LR\n A[Input] --> B[Result]\n```\n\n`$not_math$`\n\n[Unsafe](javascript:alert(1))"
                        rich = {**fixture, 'chat': {**fixture['chat'], 'messages': [{**fixture['chat']['messages'][0], 'content': rich_text, 'delegations': [{'id': 'rich_receipt', 'chatUrl': chat_url, 'status': 'complete', 'answer': rich_text}]}]}}
                        page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))", rich)
                        expect(page.locator('.delegation-answer h1')).to_have_text('Rich result')
                        expect(page.locator('.delegation-answer .katex')).to_have_count(3)
                        expect(page.locator('.delegation-answer .mermaid-diagram svg')).to_have_count(1)
                        expect(page.locator('.message > .content .mermaid-diagram svg')).to_have_count(1)
                        expect(page.locator('.delegation-answer code')).to_have_text('$not_math$')
                        self.assertIsNone(page.locator('.delegation-answer a').get_attribute('href'))
                        page.evaluate("window.__diagram=document.querySelector('.delegation-answer .mermaid-diagram svg')")
                        page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))", rich)
                        self.assertTrue(page.evaluate("window.__diagram===document.querySelector('.delegation-answer .mermaid-diagram svg')"))
                        invalid = {**rich, 'chat': {**rich['chat'], 'messages': [{**rich['chat']['messages'][0], 'content': '$\\invalidcommand{x}$\n\n```mermaid\nnot a diagram\n```'}]}}
                        page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))", invalid)
                        expect(page.locator('.message > .content .rich-render-error')).to_have_count(2)
                        page.locator('#prompt').fill('Failure draft')
                        page.locator('#send').click()
                        page.clock.run_for(32)
                        page.wait_for_function("() => window.__posts.some(message=>message.type==='send'&&message.text==='Failure draft')")
                        failed_send = page.evaluate("window.__posts.filter(message=>message.type==='send').at(-1)")
                        page.locator('#prompt').fill('New draft typed while sending')
                        page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))", {'type': 'error', 'message': 'Explicit fixture rejection', 'chatId': failed_send['chatId'], 'submissionId': failed_send['submissionId']})
                        expect(page.locator('.optimistic-message')).to_have_count(0)
                        expect(page.locator('#prompt')).to_have_value('New draft typed while sending')
                        expect(page.locator('#send')).to_be_enabled()
                        page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))", fixture)
                        self.assertLessEqual(page.evaluate('document.documentElement.scrollWidth'), width)
                        expect(page.get_by_role('link', name='Chat link', exact=True)).to_have_attribute('href', chat_url)
                        page.get_by_role('link', name='Chat link', exact=True).click()
                        self.assertTrue(page.evaluate("url=>window.__posts.some(message=>message.type==='openLink'&&message.value===url)", chat_url))
                        self.assertIsNone(page.locator('.content a').filter(has_text='Unsafe link').get_attribute('href'))
                        self.assertIsNone(page.locator('.content a').filter(has_text='File link').get_attribute('href'))
                        page.get_by_role('link', name='External link', exact=True).click()
                        self.assertTrue(page.evaluate("window.__posts.some(message=>message.type==='openLink'&&message.value==='https://example.com')"))
                        expect(page.locator(".workflow > summary")).to_contain_text("Activity [2 / 3]")
                        expect(page.locator(".workflow-summary .elapsed")).to_have_attribute("data-started", str(started + 200))
                        expect(page.locator(".workflow-summary .elapsed")).to_have_attribute("title", "Elapsed current step time")
                        expect(page.locator(".workflow-rail")).to_have_count(0)
                        expect(page.locator(".workflow-summary .working-cauldron")).to_have_count(1)
                        cauldron = page.locator(".workflow-summary .working-cauldron")
                        expect(cauldron).to_be_visible()
                        self.assertEqual(cauldron.evaluate("node=>getComputedStyle(node).animationName"), "working-cauldron-rock")
                        self.assertEqual(cauldron.evaluate("node=>getComputedStyle(node).width"), "16px")
                        self.assertEqual(cauldron.evaluate("node=>getComputedStyle(node).height"), "16px")
                        self.assertEqual(cauldron.evaluate("node=>getComputedStyle(node).position"), "static")
                        self.assertTrue(cauldron.evaluate("node=>node.parentElement.matches('.workflow-summary')"))
                        page.emulate_media(reduced_motion="reduce")
                        self.assertEqual(cauldron.evaluate("node=>getComputedStyle(node).animationName"), "none")
                        page.emulate_media(reduced_motion="no-preference")
                        page.evaluate("document.body.classList.add('chat-backgrounded')")
                        self.assertEqual(cauldron.evaluate("node=>getComputedStyle(node).animationPlayState"), "paused")
                        page.evaluate("document.body.classList.remove('chat-backgrounded')")
                        role_chats = [
                            {**fixture["library"]["chats"][0], "workerManager": True, "workerTreeId": "pixel_tree"},
                            {"id": "pixel_worker", "title": "Pixel worker", "status": "running", "groupId": "ungroup",
                             "workerParentChatId": "chat_fixture", "workerTreeId": "pixel_tree"},
                            {"id": "pixel_nested", "title": "Nested manager", "status": "running", "groupId": "ungroup",
                             "workerParentChatId": "pixel_worker", "workerTreeId": "pixel_tree", "workerManager": True},
                        ]
                        role_nodes = [
                            {"chatId": "chat_fixture", "title": "Pixel manager", "status": "running", "manager": True},
                            {"chatId": "pixel_worker", "parentChatId": "chat_fixture", "title": "Pixel worker", "status": "running", "manager": False},
                            {"chatId": "pixel_nested", "parentChatId": "pixel_worker", "title": "Nested manager", "status": "running", "manager": True},
                        ]
                        pixel_fixture = {**fixture, "chats": role_chats, "library": {"groups": [], "chats": role_chats},
                                         "chat": {**fixture["chat"], "workerManager": True, "messages": [
                                             {**fixture["chat"]["messages"][0], "delegations": [
                                                 {"id": "pixel_receipt", "chatId": "pixel_nested", "chatUrl": chat_url, "status": "running"}]}]},
                                         "workerOverview": {"rootChatId": "chat_fixture", "nodes": role_nodes, "activeWorkers": 2, "quota": 3, "maximum": 10}}
                        page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))", pixel_fixture)
                        if page.locator("#workers-toggle").get_attribute("aria-expanded") == "false":
                            page.locator("#workers-toggle").click()
                        manager_icon = page.locator('#chat-list [data-chat-id="chat_fixture"] > .chat-status-indicator')
                        worker_icon = page.locator('#chat-list [data-chat-id="pixel_worker"] > .chat-status-indicator')
                        nested_icon = page.locator('#chat-list [data-chat-id="pixel_nested"] > .chat-status-indicator')
                        expect(manager_icon).to_have_attribute("data-chat-role", "manager")
                        expect(worker_icon).to_have_attribute("data-chat-role", "manager")
                        expect(nested_icon).to_have_attribute("data-chat-role", "manager")
                        expect(page.locator('#workers-tree [data-chat-id="pixel_worker"] > summary > .chat-status-indicator')).to_have_attribute("data-chat-role", "worker")
                        expect(page.locator('#workers-tree [data-chat-id="pixel_nested"] > summary > .chat-status-indicator')).to_have_attribute("data-chat-role", "manager")
                        expect(page.locator("#chat-status > .chat-status-indicator")).to_have_attribute("aria-label", "Manager \u00b7 Running")
                        expect(page.locator(".workflow-summary > .chat-role-icon")).to_have_attribute("data-chat-role", "manager")
                        expect(page.locator(".delegation-result .chat-status-indicator")).to_have_attribute("data-chat-role", "manager")
                        expect(manager_icon.locator("svg")).to_have_attribute("viewBox", "0 0 16 16")
                        self.assertEqual(manager_icon.locator("svg").evaluate("node=>[getComputedStyle(node).width,getComputedStyle(node).height,getComputedStyle(node).shapeRendering]"),
                                         ["16px", "16px", "crispedges"])
                        self.assertTrue(page.evaluate("""() => {
                            const icon=PkmChatStatusIndicator('running','worker');document.body.append(icon);
                            const frames=[...icon.querySelectorAll('.pixel-wizard-frame')];
                            const animations=icon.getAnimations({subtree:true});
                            const visible=[];
                            for(let index=0;index<4;index++){
                                for(const animation of animations){animation.pause();animation.currentTime=index*260+10;}
                                visible.push(frames.map(frame=>getComputedStyle(frame).opacity).filter(opacity=>opacity==='1').length);
                            }
                            const stillPot=icon.querySelectorAll('svg > rect[fill="#435366"]').length===2;
                            icon.remove();return visible.every(count=>count===1)&&stillPot;
                        }"""), "Four discrete pixel frames animate the stirrer, never the cauldron")
                        page.emulate_media(reduced_motion="reduce")
                        pixel_frames = page.locator(".workflow-summary .pixel-wizard-frame")
                        self.assertEqual(pixel_frames.nth(0).evaluate("node=>[getComputedStyle(node).animationName,getComputedStyle(node).opacity]"), ["none", "1"])
                        self.assertEqual(pixel_frames.nth(1).evaluate("node=>getComputedStyle(node).opacity"), "0")
                        page.emulate_media(reduced_motion="no-preference")
                        for paused_class in ["chat-backgrounded", "pkm-host-unavailable"]:
                            page.evaluate("name=>document.body.classList.add(name)", paused_class)
                            self.assertEqual(pixel_frames.nth(0).evaluate("node=>getComputedStyle(node).animationPlayState"), "paused")
                            page.evaluate("name=>document.body.classList.remove(name)", paused_class)
                        role_chats[0]["status"] = "awaiting-result"
                        role_chats[1]["status"] = "failed"
                        pixel_fixture["chat"]["workerState"] = {"sleeping": True}
                        pixel_fixture["busy"] = False
                        page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))", pixel_fixture)
                        expect(manager_icon).to_have_attribute("aria-label", "Manager \u00b7 Waiting for delegated result")
                        expect(manager_icon).to_have_class("chat-role-icon chat-status-indicator chat-role-still")
                        self.assertEqual(manager_icon.evaluate("node=>getComputedStyle(node,'::before').backgroundColor"), "rgb(227, 179, 65)")
                        self.assertEqual(worker_icon.evaluate("node=>getComputedStyle(node,'::before').backgroundColor"), "rgb(239, 108, 108)")
                        self.assertEqual(manager_icon.locator(".pixel-wizard-frame").first.evaluate("node=>getComputedStyle(node).animationName"), "none")
                        role_chats.pop()
                        pixel_fixture["workerOverview"]["nodes"] = role_nodes[:2]
                        page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))", pixel_fixture)
                        expect(worker_icon).to_have_attribute("data-chat-role", "worker")
                        role_chats[:] = role_chats[:1]
                        pixel_fixture["workerOverview"]["nodes"] = []
                        page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))", pixel_fixture)
                        expect(manager_icon).to_have_attribute("data-chat-role", "manager")
                        pixel_fixture["chat"] = {**fixture["chat"], "workerState": {"parentChatId": "chat_fixture"}}
                        pixel_fixture["busy"] = True
                        page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))", pixel_fixture)
                        expect(page.locator(".workflow-summary > .chat-role-icon")).to_have_attribute("data-chat-role", "worker")
                        page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))", fixture)
                        expect(page.locator(".debug-information")).to_have_count(1)
                        expect(page.locator("#allow-all")).to_have_count(0)
                        expect(page.locator(".model-controls > #model + #options")).to_have_count(1)
                        expect(page.locator(".model-controls + #send")).to_have_count(1)
                        expect(page.locator("#options .codicon")).to_have_class("codicon codicon-settings")
                        expect(page.locator("#options")).to_have_attribute("aria-label", "Model settings")
                        model_label = page.locator("#model-label").bounding_box()
                        arrow = page.locator("#model .codicon-chevron-down").bounding_box()
                        self.assertAlmostEqual(arrow["x"] - model_label["x"] - model_label["width"], 4, delta=1)
                        options = page.locator("#options").bounding_box()
                        self.assertAlmostEqual(options["x"] - arrow["x"] - arrow["width"], 8, delta=1)
                        self.assertAlmostEqual(options["y"], page.locator("#model").bounding_box()["y"], delta=1)
                        original_label = page.locator("#model-label").inner_text()
                        for full_name in ["Long provider / very long model name for layout verification",
                                          "provider/very-long-model-name-with-complete-version-and-deployment-identifier-2026-10-08"]:
                            page.locator("#model-label").evaluate("(node,label)=>node.textContent=label", full_name)
                            expect(page.locator("#model-label")).to_have_text(full_name)
                            self.assertTrue(page.locator("#model-label").evaluate(
                                "node=>node.scrollWidth<=node.clientWidth+1&&node.scrollHeight<=node.clientHeight+1&&getComputedStyle(node).overflow==='visible'"))
                            long_model = page.locator("#model").bounding_box()
                            long_options = page.locator("#options").bounding_box()
                            self.assertAlmostEqual(long_options["x"] - long_model["x"] - long_model["width"], 4, delta=1)
                            self.assertAlmostEqual(long_options["y"] + long_options["height"] / 2,
                                                   long_model["y"] + long_model["height"] / 2, delta=1)
                            self.assertLessEqual(long_options["x"] + long_options["width"], width)
                            self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), width)
                        page.locator("#model-label").evaluate("(node,label)=>node.textContent=label", original_label)
                        before = page.locator("#composer").bounding_box()
                        for mode, label in [("protective", "Protective"), ("ask", "Ask before changes"), ("read-only", "Read only"), ("allow-all", "Allow All (PKM)")]:
                            page.locator("#permissions").click()
                            page.locator("#permission-mode").select_option(mode)
                            self.assertTrue(page.evaluate("mode=>window.__posts.some(message=>message.type==='permissionMode'&&message.value===mode)", mode))
                            fixture["chat"]["permissionMode"] = mode
                            page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))", fixture)
                            expect(page.locator("#permissions")).to_have_attribute("data-permission-mode", mode)
                            expect(page.locator("#permissions .codicon")).to_have_class("codicon codicon-shield")
                            expect(page.locator("#permission-label")).to_have_count(0)
                            expect(page.locator("#permissions")).to_have_attribute("title", "Permissions: " + label + " \u00b7 next request")
                            expect(page.locator("#permission-mode")).to_have_value(mode)
                            expect(page.locator("#permission-boundary")).to_contain_text("VS Code tools may still require a separate native confirmation")
                            self.assertEqual(page.locator("#composer").bounding_box(), before)
                            page.keyboard.press("Escape")
                            page.locator("#permissions").hover()
                            self.assertLessEqual(page.locator("#permissions").bounding_box()["width"], 32)
                        for button, panel in [("permissions", "permissions-panel"), ("tools", "tools-panel"), ("options", "advanced-budget"), ("agent-config", "agent-config-panel"), ("memory", "memory-panel")]:
                            page.locator("#" + button).click()
                            expect(page.locator("#" + panel)).to_be_visible()
                            self.assertEqual(page.locator(".chat-settings:visible").count(), 1)
                            self.assertEqual(page.locator("#composer").bounding_box(), before)
                            rectangle = page.locator("#" + panel).bounding_box()
                            self.assertGreaterEqual(rectangle["x"], 0)
                            self.assertLessEqual(rectangle["x"] + rectangle["width"], width)
                            self.assertGreaterEqual(rectangle["y"], 0)
                            page.keyboard.press("Escape")
                            expect(page.locator("#" + panel)).to_be_hidden()
                        full_memory = "Readable memory \U0001f642 includes <tag> and exact source content. " * 8
                        memory_candidates = [
                            {"id": "memory-piece-uuid", "kind": "memory", "label": "unhelpful memory uuid", "selected": True},
                            {"id": "tool-piece-uuid", "kind": "memory", "label": "unhelpful tool uuid", "selected": False},
                            *[{"id": f"note-{index}", "kind": "note", "label": f"Reference note {index}", "selected": False} for index in range(10)],
                        ]
                        for candidate in memory_candidates:
                            candidate.update({"sourceUri": f"pkm://fixture/{candidate['id']}", "method": "lexical",
                                              "score": 1, "scoreComponents": {"lexical": 1, "semantic": 0},
                                              "reason": "Included in context" if candidate["selected"] else "Outside budget"})
                        receipt = {"chatId": "chat_fixture", "model": "fixture", "query": "source content",
                                   "selectedCount": 1, "candidates": memory_candidates}
                        memory_fixture = {**fixture, "chat": {**fixture["chat"], "messages": [
                            {**fixture["chat"]["messages"][0], "retrieval": receipt}]},
                            "memoryTree": {"chatId": "chat_fixture", "title": "Chat UI", "tasks": [
                                {"id": "conversation", "title": "Conversation", "segments": [
                                    {"id": "memory-piece-uuid", "preview": full_memory[:30], "sourceKind": "dialogue", "role": "assistant", "characters": len(full_memory)},
                                    {"id": "tool-piece-uuid", "preview": "Actual tool output, not header", "sourceKind": "tool", "role": "assistant", "characters": 40},
                                ]}]}}
                        page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))", memory_fixture)
                        page.locator("#memory").click()
                        expect(page.locator("#memory-policy-status")).to_contain_text("Last 30 days")
                        expect(page.locator("#memory-policy-status")).to_contain_text("descendant workers")
                        page.locator("#memory-policy").click()
                        self.assertEqual(page.evaluate("window.__posts.at(-1).type"), "memoryPolicy")
                        entries = page.locator("#retrieval-candidates .memory-segment")
                        expect(entries).to_have_count(10)
                        expect(entries.nth(0).locator("summary")).to_have_text(full_memory[:30])
                        expect(page.locator("#retrieval-candidates")).to_contain_text("Chat history")
                        expect(page.locator("#retrieval-candidates")).to_contain_text("Tool receipts")
                        expect(entries.nth(0).locator("pre")).to_be_hidden()
                        entries.nth(0).locator("summary").click()
                        page.clock.run_for(32)
                        page.wait_for_function("() => window.__posts.some(message=>message.type==='memorySegment'&&message.id==='memory-piece-uuid')")
                        self.assertEqual(page.evaluate("window.__posts.filter(message=>message.type==='memorySegment'&&message.id==='memory-piece-uuid').length"), 1,
                                         {"errors": errors, "open": entries.nth(0).get_attribute("open"),
                                          "content": entries.nth(0).locator("pre").text_content(),
                                          "posts": page.evaluate("window.__posts.slice(-4)")})
                        expect(entries.nth(0).locator(".memory-metadata")).to_contain_text("Selected")
                        expect(entries.nth(0).locator(".memory-metadata")).to_contain_text("memory-piece-uuid")
                        page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))",
                                      {"type": "memorySegment", "chatId": "chat_fixture", "segment": {"id": "memory-piece-uuid", "content": full_memory}})
                        expect(entries.nth(0).locator("pre")).to_have_text(full_memory)
                        memory_fixture["memoryTree"]["title"] = "Refreshed Chat UI"
                        page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))", memory_fixture)
                        expect(entries.nth(0)).to_have_attribute("open", "")
                        expect(entries.nth(0).locator("pre")).to_have_text(full_memory)
                        page.clock.run_for(32)
                        self.assertEqual(page.evaluate("window.__posts.filter(message=>message.type==='memorySegment'&&message.id==='memory-piece-uuid').length"), 1)
                        page.locator("#retrieval-flow").locator("..").locator("summary").click()
                        expect(page.locator("#retrieval-flow svg")).to_be_visible()
                        expect(page.locator("#retrieval-flow")).to_contain_text("Readable memory")
                        page.locator("#retrieval-flow").locator("..").locator("summary").click()
                        entries.nth(1).locator("summary").click()
                        page.clock.run_for(32)
                        page.wait_for_function("() => window.__posts.some(message=>message.type==='memorySegment'&&message.id==='tool-piece-uuid')")
                        page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))",
                                      {"type": "memorySegmentUnavailable", "chatId": "chat_fixture", "id": "tool-piece-uuid", "error": "This memory revision is unavailable."})
                        expect(entries.nth(1).locator("pre")).to_contain_text("unavailable")
                        page.locator("#retrieval-kind").select_option("note")
                        expect(entries).to_have_count(10)
                        expect(entries.nth(0)).to_contain_text("not the full resource")
                        page.locator("#retrieval-kind").select_option("all")
                        page.locator("#retrieval-top").select_option("20")
                        expect(entries).to_have_count(12)
                        expect(entries.nth(1).locator("pre")).to_contain_text("unavailable")
                        page.clock.run_for(32)
                        self.assertEqual(page.evaluate("window.__posts.filter(message=>message.type==='memorySegment'&&message.id==='tool-piece-uuid').length"), 1)
                        foreign_memory = {**fixture, "chat": {**fixture["chat"], "id": "different_chat", "messages": []},
                                          "memoryTree": {"chatId": "different_chat", "title": "Different Chat", "tasks": []}}
                        page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))", foreign_memory)
                        page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))",
                                      {"type": "memorySegment", "chatId": "chat_fixture", "segment": {"id": "memory-piece-uuid", "content": "Must not leak"}})
                        expect(page.locator("#memory-preview")).to_be_hidden()
                        page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))", memory_fixture)
                        self.assertIsNone(entries.nth(0).get_attribute("open"))
                        expect(entries.nth(0).locator("pre")).to_have_text("Expand to read this memory")
                        page.locator("#retrieval-top").select_option("10")
                        page.keyboard.press("Escape")
                        page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))", fixture)
                        page.locator("#model").click()
                        expect(page.locator("#model")).to_have_attribute("aria-busy", "true")
                        self.assertEqual(page.evaluate("window.__posts.filter(message=>message.type==='chooseModel').length"), 1)
                        page.evaluate("window.dispatchEvent(new MessageEvent('message',{data:{type:'modelPickerClosed'}}))")
                        self.assertIsNone(page.locator("#model").get_attribute("aria-busy"))
                        page.locator(".workflow > summary").click()
                        expect(page.locator(".workflow-events")).to_be_visible()
                        expect(page.locator(".tool-call")).to_be_visible()
                        page.screenshot(path=str(Path(screenshots) / f"chat-{width}.png"), full_page=True)
                        idle = {**fixture, "busy": False, "chat": {**fixture["chat"], "progress": {**progress, "status": "complete"}}}
                        page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))", idle)
                        expect(page.locator(".workflow-summary .working-cauldron")).to_have_count(0)
                        statuses = page.evaluate("""() => ['running','completed','new-result','failed','awaiting-input','idle','awaiting-result','paused'].map(value => {
                            const node=PkmChatStatusIndicator(value);document.body.append(node);
                            const result={state:node.dataset.state,cauldron:node.classList.contains('working-cauldron'),color:getComputedStyle(node,'::before').backgroundColor,width:getComputedStyle(node).width};
                            node.remove();return result;
                        })""")
                        self.assertTrue(statuses[0]['cauldron'])
                        self.assertEqual(statuses[1]['state'], 'completed')
                        self.assertEqual(statuses[2]['state'], 'completed')
                        self.assertEqual(statuses[1]['color'], 'rgb(82, 187, 128)')
                        self.assertEqual(statuses[3]['color'], 'rgb(239, 108, 108)')
                        self.assertEqual(statuses[4]['state'], 'waiting-input')
                        self.assertEqual(statuses[6]['state'], 'waiting-result')
                        self.assertEqual(statuses[6]['color'], 'rgb(227, 179, 65)')
                        self.assertEqual(statuses[7]['state'], 'stopped')
                        self.assertTrue(all(status['width'] == '16px' for status in statuses))
                        long_text = '\n\n'.join(f'History paragraph {index}: retained Chat result.' for index in range(150))
                        long_chat = {**idle, 'chat': {**idle['chat'], 'messages': [{'id': 'long_reply', 'role': 'assistant', 'status': 'complete', 'content': long_text}]}}
                        page.locator('#back').click()
                        page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))", long_chat)
                        page.locator('.chat-list-open').click()
                        expect(page.locator('#library-view')).to_be_hidden()
                        self.assertTrue(page.locator('#messages').evaluate('node=>node.scrollHeight-node.scrollTop-node.clientHeight<2'))
                        page.locator('#messages').evaluate('node=>node.scrollTop=80')
                        refreshed = {**long_chat, 'chat': {**long_chat['chat'], 'messages': [{**long_chat['chat']['messages'][0], 'content': long_text + '\n\nNew result.'}]}}
                        page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))", refreshed)
                        self.assertEqual(page.locator('#messages').evaluate('node=>node.scrollTop'), 80)
                        page.locator('#back').click()
                        page.locator('.chat-list-open').click()
                        self.assertTrue(page.locator('#messages').evaluate('node=>node.scrollHeight-node.scrollTop-node.clientHeight<2'))
                        page.evaluate("""() => {
                            window.__previousMessage=document.querySelector('#messages .message');
                            Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'});
                            document.dispatchEvent(new Event('visibilitychange'));
                        }""")
                        buffered = {**refreshed, 'chat': {**refreshed['chat'], 'messages': [{**refreshed['chat']['messages'][0], 'content': long_text + '\n\nBuffered while hidden.'}]}}
                        page.evaluate("""() => {
                            window.__hiddenMutations=0;
                            window.__hiddenObserver=new MutationObserver(records=>__hiddenMutations+=records.length);
                            __hiddenObserver.observe(document.getElementById('window-presets'),{childList:true,subtree:true});
                        }""")
                        for _ in range(20):
                            page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))", buffered)
                        page.evaluate("window.dispatchEvent(new MessageEvent('message',{data:{type:'delta',chatId:'chat_fixture',id:'long_reply',text:' Streamed while hidden.'}}))")
                        page.clock.run_for(32)
                        self.assertEqual(page.evaluate("__hiddenMutations"), 0,
                                         "Hidden Chat must not repeatedly rebuild controls while native Chat is open")
                        page.evaluate("__hiddenObserver.disconnect()")
                        self.assertTrue(page.evaluate("window.__previousMessage===document.querySelector('#messages .message')"))
                        expect(page.locator('#messages')).not_to_contain_text('Buffered while hidden.')
                        page.evaluate("() => {delete document.visibilityState;document.dispatchEvent(new Event('visibilitychange'));}")
                        expect(page.locator('#messages')).to_contain_text('Buffered while hidden. Streamed while hidden.')
                        page.locator('#back').click()
                        previous_message = page.locator('#messages .message').element_handle()
                        for _ in range(5):
                            page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))", buffered)
                        self.assertTrue(previous_message.evaluate("node=>node===document.querySelector('#messages .message')"))
                        page.locator('.chat-list-open').click()
                        expect(page.locator('#messages')).to_contain_text('Buffered while hidden.')
                        original_user = {"id": "retry_user", "role": "user", "content": "Keep this original user message", "status": "complete"}
                        failed_response = {"id": "retry_failed", "role": "assistant", "content": "Failed output to replace", "status": "failed", "error": "Fixture failure"}
                        retry_fixture = {**fixture, "busy": False, "chat": {**fixture["chat"], "progress": None,
                            "messages": [original_user, failed_response]}}
                        page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))", retry_fixture)
                        expect(page.locator('#messages .message')).to_have_count(2)
                        retry_button = page.get_by_role('button', name='Retry response in place (new request; earlier tools may have run)', exact=True)
                        expect(retry_button).to_be_enabled()
                        failed_node = page.locator('[data-message-id="retry_failed"]').element_handle()
                        sends_before_retry = page.evaluate("window.__posts.filter(message=>message.type==='send').length")
                        retry_button.click()
                        self.assertEqual(page.evaluate("window.__posts.at(-1)"), {"type": "retry", "id": "retry_failed"})
                        self.assertEqual(page.evaluate("window.__posts.filter(message=>message.type==='send').length"), sends_before_retry)
                        expect(page.locator('#messages .optimistic-message')).to_have_count(0)
                        retry_fixture["busy"] = True
                        retry_fixture["chat"]["messages"] = [original_user, {"id": "retry_replacement", "role": "assistant", "content": "New inference in place", "status": "streaming"}]
                        page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))", retry_fixture)
                        expect(page.locator('#messages .message')).to_have_count(2)
                        expect(page.locator('#messages .message.user')).to_have_count(1)
                        expect(page.locator('[data-message-id="retry_failed"]')).to_have_count(0)
                        self.assertFalse(failed_node.evaluate("node=>node.isConnected"))
                        self.assertEqual(page.locator('#messages .message').evaluate_all("nodes=>nodes.map(node=>node.dataset.messageId)"),
                                         ["retry_user", "retry_replacement"])
                        expect(page.locator('#messages')).not_to_contain_text('Failed output to replace')
                        expect(page.locator('#messages')).to_contain_text('New inference in place')
                        paging_fixture = {**retry_fixture, "busy": False, "history": {"start": 2, "total": 4},
                            "chat": {**retry_fixture["chat"], "id": "history_fixture", "messages": [original_user, failed_response]}}
                        page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))", paging_fixture)
                        older_button = page.get_by_role('button', name='Load older messages', exact=True)
                        expect(older_button).to_be_enabled()
                        page.evaluate("()=>{const m=document.getElementById('messages');m.scrollTop=0;m.dispatchEvent(new Event('scroll'))}")
                        self.assertEqual(page.evaluate("window.__posts.filter(message=>message.type==='historyPage').length"), 1)
                        self.assertEqual(page.evaluate("window.__posts.at(-1)"),
                                         {"type": "historyPage", "chatId": "history_fixture", "id": "retry_user"})
                        expect(page.get_by_role('button', name='Loading older messages...', exact=True)).to_be_disabled()
                        page.evaluate("()=>document.getElementById('messages').dispatchEvent(new Event('scroll'))")
                        self.assertEqual(page.evaluate("window.__posts.filter(message=>message.type==='historyPage').length"), 1)
                        older_messages = [
                            {"id": "older_user", "role": "user", "content": "Older preserved assignment", "status": "complete"},
                            {"id": "older_reply", "role": "assistant", "content": "Older preserved evidence", "status": "complete"}]
                        history_page = {"type": "historyPage", "chatId": "history_fixture", "beforeId": "retry_user",
                                        "start": 0, "total": 4, "messages": older_messages}
                        page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))", history_page)
                        expect(page.locator('#messages .message')).to_have_count(4)
                        expect(page.get_by_role('button', name='Load older messages', exact=True)).to_have_count(0)
                        page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))", paging_fixture)
                        expect(page.locator('#messages .message')).to_have_count(4)
                        paging_fixture["chat"]["messages"] = [original_user, retry_fixture["chat"]["messages"][-1]]
                        page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))", paging_fixture)
                        expect(page.locator('#messages .message')).to_have_count(4)
                        expect(page.locator('[data-message-id="retry_failed"]')).to_have_count(0)
                        expect(page.locator('#messages')).to_contain_text('Older preserved evidence')
                        page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))", retry_fixture)
                        page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))", history_page)
                        expect(page.locator('#messages .message')).to_have_count(2)
                        expect(page.locator('#messages')).not_to_contain_text('Older preserved evidence')
                        retry_fixture["decisions"] = [{"id": "loop-inline", "title": "Possible tool loop", "detail": "Existing tool results remain. Allow All does not approve this decision.",
                            "choices": [{"value": "continue", "label": "Continue"}, {"value": "summarize", "label": "Answer with current results"}, {"value": "cancel", "label": "Cancel request"}]}]
                        page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))", retry_fixture)
                        decision_card = page.get_by_role('region', name='Chat decision', exact=True)
                        expect(decision_card).to_be_visible()
                        expect(decision_card.locator('details')).to_have_attribute('open', '')
                        expect(decision_card.get_by_role('button')).to_have_count(3)
                        expect(decision_card).not_to_contain_text('Approve & remember')
                        decision_card.get_by_role('button', name='Continue', exact=True).click()
                        self.assertEqual(page.evaluate("window.__posts.at(-1)"), {"type": "decision", "id": "loop-inline", "value": "continue"})
                        expect(decision_card.get_by_role('button', name='Cancel request')).to_be_disabled()
                        retry_fixture["decisions"] = []
                        page.evaluate("data=>window.dispatchEvent(new MessageEvent('message',{data}))", retry_fixture)
                        expect(decision_card).to_have_count(0)
                        page.locator('#prompt').fill('Draft must survive host disconnection')
                        page.clock.fast_forward(20_000)
                        expect(page.locator('#pkm-host-warning')).to_contain_text('Extension Host is not responding')
                        page.screenshot(path=str(Path(screenshots) / f'host-disconnected-{width}.png'), full_page=True)
                        sends = page.evaluate("window.__posts.filter(message=>message.type==='send').length")
                        page.locator('#composer').evaluate("node=>node.requestSubmit()")
                        self.assertEqual(page.evaluate("window.__posts.filter(message=>message.type==='send').length"), sends)
                        expect(page.locator('#prompt')).to_have_value('Draft must survive host disconnection')
                        page.evaluate("window.dispatchEvent(new MessageEvent('message',{data:{type:'hostHealth',id:'stale'}}))")
                        expect(page.locator('#pkm-host-warning')).to_be_visible()
                        page.get_by_role('button', name='Reconnect to Extension Host').click()
                        self.assertEqual(page.evaluate("window.__posts.filter(message=>message.type==='ready').length"), 3)
                        page.evaluate("window.dispatchEvent(new MessageEvent('message',{data:window.__posts.filter(message=>message.type==='hostHealth').at(-1)}))")
                        expect(page.locator('#pkm-host-warning')).to_be_hidden()
                        expect(page.locator('#prompt')).to_have_value('Draft must survive host disconnection')
                        self.assertEqual(page.evaluate("window.__posts.filter(message=>message.type==='send').length"), sends)
                        page.evaluate("window.dispatchEvent(new MessageEvent('message',{data:{type:'initializationError',message:'fixture backend startup failure'}}))")
                        expect(page.locator('#pkm-host-warning')).to_contain_text('fixture backend startup failure')
                        expect(page.locator('#pkm-chat-loading')).to_be_hidden()
                        page.clock.fast_forward(20_000)
                        expect(page.locator('#pkm-host-warning')).to_contain_text('fixture backend startup failure')
                        page.evaluate("window.dispatchEvent(new ErrorEvent('error',{message:'fixture script failure'}))")
                        expect(page.locator('#pkm-host-warning')).to_contain_text('fixture script failure')
                        page.clock.fast_forward(20_000)
                        expect(page.locator('#pkm-host-warning')).to_contain_text('fixture script failure')
                        self.assertEqual(errors, [])
                        page.close()
            finally:
                browser.close()


if __name__ == "__main__":
    unittest.main()
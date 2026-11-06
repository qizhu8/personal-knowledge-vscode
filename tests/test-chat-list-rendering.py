import json
import re
import unittest
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
WEBVIEW = ROOT / "dist" / "webview"


class ChatListRenderingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def setUp(self):
        self.page = self.browser.new_page(viewport={"width": 390, "height": 900})
        self.page.set_default_timeout(10000)
        self.addCleanup(self.page.close)
        self.errors = []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        html = (WEBVIEW / "api-chat.html").read_text()
        html = re.sub(r'<meta http-equiv[^>]*>|<link[^>]*>|<script[^>]*></script>', "", html)
        self.page.set_content(html)
        self.page.wait_for_load_state("networkidle")
        self.page.add_style_tag(path=str(WEBVIEW / "api-chat.css"))
        self.page.add_script_tag(path=str(WEBVIEW / "api-chat-library.js"))
        self.page.evaluate("""() => {
            document.body.classList.add('chat-library-visible');
            document.getElementById('library-view').hidden=false;
            document.getElementById('pkm-chat-loading').hidden=true;
            window.posts = [];
            window.fixture = PkmChatLibrary({
                post:(type, value) => posts.push({type, ...value}),
                save(){}, saved:{}
            });
            window.makeChats = (count, shape='chain') => Array.from({length:count}, (_, i) => ({
                id:String(i), title:'Fixture '+i, groupId:'ungroup', status:'idle', workerTreeId:'tree',
                ...(i && shape === 'chain' ? {workerParentChatId:String(i-1)} : {}),
                ...(i && shape === 'wide' ? {workerParentChatId:'0'} : {})
            }));
            window.library = {chats:[], groups:[]};
        }""")

    def measure(self, count, shape="chain"):
        result = self.page.evaluate("""async ([count, shape]) => {
            library.chats = makeChats(count, shape);
            let ticks=0;
            const timer=setInterval(()=>ticks++, 10);
            const started=performance.now();
            fixture.render(library);
            const renderMs=performance.now()-started;
            await new Promise(resolve=>setTimeout(resolve, 50));
            clearInterval(timer);
            return {renderMs,ticks,rows:document.querySelectorAll('.chat-list-row').length,
                entries:fixture.pickerGroups.flatMap(group=>group.entries).length};
        }""", [count, shape])
        print(json.dumps({"count": count, "shape": shape, **result}), flush=True)
        self.assertEqual(self.errors, [])
        self.assertGreater(result["ticks"], 0)
        return result

    def test_PKM_FAULT_025_deep_collapsed_workers_render_under_one_second_without_omission(self):
        result = self.measure(2000)
        self.assertLess(result["renderMs"], 1000)
        self.assertEqual(result["rows"], 1)
        self.assertEqual(result["entries"], 2000)
        traces = self.page.evaluate("posts.filter(post=>post.type==='chatListRender')")
        self.assertEqual([trace["params"]["phase"] for trace in traces[:2]], ["started", "completed"])
        self.assertEqual(traces[1]["params"]["chats"], 2000)

    def test_PKM_FAULT_026_collapsed_wide_workers_expand_and_collapse_without_losing_picker_entries(self):
        self.measure(500, "wide")
        toggle = self.page.locator('[data-node-chat-id="0"] > .chat-list-row > .chat-list-workers-toggle')
        toggle.click()
        self.assertEqual(self.page.locator(".chat-list-row").count(), 500)
        self.page.locator('[data-chat-id="499"]').click()
        self.assertEqual(self.page.evaluate("posts.at(-1).id"), "499")
        toggle.click()
        self.assertEqual(self.page.locator(".chat-list-row").count(), 1)
        self.assertEqual(self.page.evaluate("fixture.pickerGroups[0].entries.length"), 500)
        self.assertEqual(self.errors, [])

    def test_PKM_FAULT_027_collapsed_group_builds_no_chat_dom_and_reopens_normally(self):
        self.measure(500, "flat")
        summary = self.page.locator('[data-group-id="ungroup"] > summary')
        summary.click()
        self.page.wait_for_function("document.querySelectorAll('.chat-list-row').length===0")
        self.assertEqual(self.page.evaluate("fixture.pickerGroups[0].entries.length"), 500)
        summary.click()
        self.page.wait_for_function("document.querySelectorAll('.chat-list-row').length===500")
        self.assertEqual(self.errors, [])

    def test_PKM_FAULT_028_cyclic_ancestry_is_flattened_without_recursion_or_hidden_chats(self):
        self.page.evaluate("""() => {
            library.chats=makeChats(4);
            library.chats[0].workerParentChatId='2';
            fixture.render(library);
        }""")
        self.assertEqual(self.page.locator(".chat-list-row").count(), 4)
        self.assertEqual(self.page.evaluate("fixture.pickerGroups[0].entries.length"), 4)
        self.assertEqual(self.errors, [])

    def test_PKM_FAULT_029_active_collapsed_descendant_promotes_its_manager(self):
        self.page.evaluate("""() => {
            library.chats=[
                {id:'first',title:'First',groupId:'ungroup',status:'idle'},
                {id:'manager',title:'Manager',groupId:'ungroup',status:'idle',workerTreeId:'tree'},
                {id:'worker',title:'Worker',groupId:'ungroup',status:'running',workerTreeId:'tree',workerParentChatId:'manager'}
            ];
            fixture.render(library);
        }""")
        self.assertEqual(self.page.locator(".chat-list-open").first.get_attribute("data-chat-id"), "manager")
        self.assertEqual(self.page.locator(".chat-list-row").count(), 2)
        self.assertEqual(self.errors, [])

    def test_PKM_FAULT_030_full_chat_state_with_deep_worker_library_keeps_browser_responsive(self):
        self.page.reload()
        html = (WEBVIEW / "api-chat.html").read_text()
        self.page.set_content(re.sub(r'<meta http-equiv[^>]*>|<link[^>]*>|<script[^>]*></script>', "", html))
        self.page.wait_for_load_state("networkidle")
        self.page.evaluate("""() => {
            window.posts=[];
            window.acquireVsCodeApi=()=>({getState:()=>({screen:'library'}),setState(){},postMessage:message=>posts.push(message)});
        }""")
        self.page.add_style_tag(path=str(WEBVIEW / "api-chat.css"))
        for script in ["host-health.js", "marked.umd.js", "purify.min.js", "api-chat-library.js",
                       "agent-harness.js", "chat-visualization.js", "chat-retrieval-flow.js", "api-chat.js"]:
            self.page.add_script_tag(path=str(WEBVIEW / script))
        result = self.page.evaluate("""async () => {
            const chats=Array.from({length:2000}, (_, i)=>({
                id:String(i),title:'Fixture '+i,groupId:'ungroup',status:'idle',workerTreeId:'tree',
                ...(i ? {workerParentChatId:String(i-1)} : {})
            }));
            const profile={id:'fixture',label:'Fixture',status:'active',contextWindow:16384,maxOutputTokens:4096};
            const state={type:'state',busy:false,
                chat:{id:'0',title:'Fixture 0',includeHistory:true,context:[],permissionMode:'ask',messages:[]},
                settings:{model:'fixture',models:[],provider:'openai-compatible',endpoint:'https://example.test/v1',
                    contextWindow:16384,maxOutputTokens:2048,maxToolRounds:30,inputBaseTokens:100,profiles:[profile],selectedProfile:profile},
                chats,library:{groups:[],chats}};
            let ticks=0;
            const timer=setInterval(()=>ticks++,10);
            const started=performance.now();
            window.dispatchEvent(new MessageEvent('message',{data:state}));
            const renderMs=performance.now()-started;
            await new Promise(resolve=>setTimeout(resolve,50)); clearInterval(timer);
            return {renderMs,ticks,options:document.querySelectorAll('#chats option').length,
                rows:document.querySelectorAll('.chat-list-row').length,ready:!PkmHostHealth.unavailable};
        }""")
        print(json.dumps({"full_state": result}), flush=True)
        self.assertLess(result["renderMs"], 1000)
        self.assertGreater(result["ticks"], 0)
        self.assertEqual(result["options"], 2000)
        self.assertEqual(result["rows"], 1)
        self.assertTrue(result["ready"])
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()

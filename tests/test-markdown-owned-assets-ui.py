import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]


class ResourceTreeTests(unittest.TestCase):
    def test_real_resource_listing_expand_preview_and_manage_at_narrow_widths(self):
        with tempfile.TemporaryDirectory(prefix="pkm-assets-browser-") as directory:
            source = (ROOT / "src/webview/panel/20-knowledge.js").read_text()
            helpers = source[source.index("function markdownAssetFolder("):source.index("function toggleNotePin(")]
            results = subprocess.run(["node", "-e", """
const {saveMarkdownAsset,listedMarkdownAssets}=require('./dist/knowledge/markdown-assets');
const root=process.argv[1];const result=[];
for(const area of ['skills','notes','papers']){
 saveMarkdownAsset(root,area,'Team/Design.md','plot.png',Buffer.from('plot'));
 result.push({area,documentPath:'Team/Design.md',assets:listedMarkdownAssets(root,area,'Team/Design.md','').map(asset=>({path:asset.path}))});
}
console.log(JSON.stringify(result));
""", directory], cwd=ROOT, text=True, capture_output=True, check=True)
            records = json.loads(results.stdout)
            bootstrap = """
const requests=[];
const uiIcon=()=>'<span aria-hidden="true">+</span>';
const esc=value=>String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
function ask(command,data){
 requests.push({command,...data});
 if(command==='markdownAssetList')showMarkdownAssetList(records.find(item=>item.area===data.area));
}
"""
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(headless=True)
                try:
                    for width in [1280, 390, 320]:
                        page = browser.new_page(viewport={"width": width, "height": 800})
                        errors = []
                        page.on("pageerror", lambda error: errors.append(str(error)))
                        page.set_content("<main></main>")
                        page.add_script_tag(content="const records=" + json.dumps(records) + ";" + bootstrap + helpers)
                        page.add_style_tag(content="""
body{background:#1e1e1e;color:#eee;font:14px sans-serif;margin:12px}
details{margin-bottom:20px;overflow-wrap:anywhere}summary{padding:8px;cursor:pointer}
button{color:inherit;background:#333;border:1px solid #666;padding:8px;margin:4px}
""")
                        page.evaluate("document.querySelector('main').innerHTML=records.map(item=>'<h2>'+item.area+'</h2>'+markdownAssetFolder(item.area,item.documentPath,0)).join('')")
                        for area in ["skills", "notes", "papers"]:
                            folder = page.locator(f'[data-asset-area="{area}"]')
                            folder.locator("summary").click()
                            expect(folder.get_by_role("button", name="Team/Design.assets/plot.png")).to_be_visible()
                            folder.get_by_role("button", name="Team/Design.assets/plot.png").click()
                            folder.get_by_role("button", name="Manage resources...").click()
                            self.assertEqual(page.evaluate("requests.slice(-2).map(item=>item.command)"),
                                             ["previewMarkdownAsset", "manageMarkdownAssets"])
                            folder.locator("summary").focus()
                            page.keyboard.press("Enter")
                            expect(folder.get_by_role("button", name="Team/Design.assets/plot.png")).not_to_be_visible()
                            page.keyboard.press("Enter")
                            expect(folder.get_by_role("button", name="Team/Design.assets/plot.png")).to_be_visible()
                        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), width)
                        self.assertFalse(page.evaluate("requests.some(item=>/migration|delete|call/.test(item.command))"))
                        self.assertEqual(errors, [])
                        if os.environ.get("PKM_ASSET_ACCEPTANCE_OUTPUT"):
                            output = Path(os.environ["PKM_ASSET_ACCEPTANCE_OUTPUT"])
                            output.mkdir(parents=True, exist_ok=True)
                            page.screenshot(path=str(output / f"resource-tree-{width}.png"))
                        page.close()
                finally:
                    browser.close()


if __name__ == "__main__":
    unittest.main()

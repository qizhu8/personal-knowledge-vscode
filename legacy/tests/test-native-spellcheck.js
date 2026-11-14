const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {chromium} = require("playwright");
const root = path.resolve(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");

async function main() {
  const browser = await chromium.launch({headless:true, executablePath:process.env.PKM_CHROMIUM_EXECUTABLE || undefined});
  try {
    const page = await browser.newPage();
    for (const [file, enabled, disabled] of [
      ["src/webview/api-chat.html", ["#prompt"], []],
      ["src/webview/panel.html", ["#note-content", "#pf-content", "#pf-conclusions"], ["#pf-url"]],
      ["resources/action-workbench.html", [], ["#poll-template-inputs"]],
    ]) {
      const html = read(file).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<meta[^>]*http-equiv="Content-Security-Policy"[^>]*>/gi, "");
      await page.setContent(html);
      for (const selector of enabled) assert.equal(await page.locator(selector).evaluate(node => node.spellcheck), true, `${file} ${selector}`);
      for (const selector of disabled) assert.equal(await page.locator(selector).evaluate(node => node.spellcheck), false, `${file} ${selector}`);
      await page.evaluate(() => {
        const field = document.createElement("textarea");
        field.id = "dynamic-prose";
        document.body.append(field);
      });
      assert.equal(await page.locator("#dynamic-prose").evaluate(node => node.spellcheck), true, "dynamic inputs inherit native spellcheck");
    }
    for (const file of ["src/ui/recipe-browser.ts", "src/chatroom/chatroom-browser.ts", "src/sync/github-sync-workbench.ts", "src/extension.ts"]) {
      assert.match(read(file), /<html[^>]*spellcheck="true"/, file);
    }
    await page.setContent('<body spellcheck="true"><div id="editor"></div></body>');
    await page.addScriptTag({content:`
      const esc=value=>String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
      const currentDetail={documentKind:'todo-board'};
      ${read("src/webview/panel/22-note-todo.js")}
    `});
    await page.evaluate(() => {
      Object.assign(noteTodo, {
        editor:{item:{id:'task',title:'Title',goal:'Goal',scope:'Scope',acceptance:['Verified'],state:'Planning',evidence:[]}},
        chats:[],projects:[],snapshot:{items:[]},
      });
      document.getElementById('editor').innerHTML=noteTodoEditorHtml();
    });
    for (const name of ["title","description","goal","scope","acceptance","owner","monitorEndCondition","blockedReason","reason"]) {
      assert.equal(await page.locator(`[name="${name}"]`).evaluate(node=>node.spellcheck), true, name);
    }
    for (const name of ["ownerId","dependsOn","links","reviewerIds","collaboratorIds","monitorUntil","evidence","evidence-unit"]) {
      assert.equal(await page.locator(`[name="${name}"]`).evaluate(node=>node.spellcheck), false, name);
    }
    console.log("PASS native spellcheck: Chat/Markdown/dynamic Todo prose enabled; URL, JSON and references excluded");
  } finally { await browser.close(); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});

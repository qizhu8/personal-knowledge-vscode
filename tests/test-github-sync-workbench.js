#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Module = require("node:module");
const { spawnSync } = require("node:child_process");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");
let compare;

function sample() {
  const fixture = {
    record: { schema: 1, id: "conflict-1", targetId: "primary", revision: 3, remoteCommit: "abc", createdAt: "", explicitResolution: true,
      files: [
        { path: 'skills/<script>"&.md', type: "skill", hasBase: true, hasLocal: true, hasRemote: true, candidateSource: "unresolved" },
        { path: "recipes/run.md", type: "recipe", hasBase: false, hasLocal: true, hasRemote: true, candidateSource: "unresolved" },
        { path: "skills/image.png", type: "skill", hasBase: true, hasLocal: true, hasRemote: true, candidateSource: "unresolved" },
      ] },
    files: [
      { path: 'skills/<script>"&.md', binary: false, base: "base", local: "local", remote: '<script>alert("x")</script>', merged: "candidate" },
      { path: "recipes/run.md", binary: false, local: "recipe local", remote: "recipe GitHub", merged: "recipe" },
      { path: "skills/image.png", binary: true, mime: "image/png", local: "BINARY MUST NOT APPEAR IN EDITOR", merged: "BINARY MUST NOT APPEAR IN EDITOR",
        previews: { local: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1kAAAAASUVORK5CYII=", remote: "https://attacker.example/pixel.png", merged: "data:image/svg+xml;base64,PHN2Zz4=" } },
    ],
  };
  if (compare) for (const file of fixture.files) {
    const meta = fixture.record.files.find(entry => entry.path === file.path);
    if (!file.binary && meta.hasLocal && meta.hasRemote) file.comparison = compare(file.local || "", file.remote || "", file.merged || "");
  }
  return fixture;
}

// A small DOM/browser event harness executes the real standalone asset, not a duplicated controller.
function browser() {
  const nodes = new Map();
  const messages = [];
  const confirms = [];
  let answer = true;
  const decode = value => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  class Element {
    constructor(id, tag = "div") { this.id = id; this.tag = tag; this.dataset = {}; this.listeners = {}; this.children = []; this.disabled = false; this.value = ""; this.textContent = ""; }
    addEventListener(type, callback) { this.listeners[type] = callback; }
    click() { if (!this.disabled) this.listeners.click?.(); }
    input(value) { this.value = value; this.listeners.input?.(); }
    querySelectorAll(tag) { return this.children.filter(child => child.tag === tag); }
    set innerHTML(html) {
      this.html = html;
      this.children = [];
      if (this.id === "detail") { nodes.delete("result"); nodes.delete("dirty"); }
      for (const match of html.matchAll(/<(button|textarea|p|div)\b([^>]*)>/g)) {
        const [, tag, attrs] = match;
        const id = /\bid="([^"]*)"/.exec(attrs)?.[1];
        const child = new Element(id, tag);
        for (const attr of attrs.matchAll(/data-([a-z]+)="([^"]*)"/g)) child.dataset[attr[1]] = decode(attr[2]);
        if (id) nodes.set(id, child);
        this.children.push(child);
      }
    }
    get innerHTML() { return this.html || ""; }
  }
  for (const id of ["count", "previous", "next", "refresh", "apply", "status", "error", "files", "detail", "layout", "toggle-files"]) nodes.set(id, new Element(id, ["previous", "next", "refresh", "apply", "toggle-files"].includes(id) ? "button" : "div"));
  const listeners = {};
  const context = vm.createContext({
    acquireVsCodeApi: () => ({ postMessage: message => messages.push(message) }),
    document: { getElementById: id => nodes.get(id), querySelectorAll: tag => [...nodes.values()].flatMap(node => [node, ...node.children]).filter(node => node.tag === tag) },
    window: { addEventListener: (event, callback) => { listeners[event] = callback; }, confirm: text => { confirms.push(text); return answer; } },
  });
  vm.runInContext(fs.readFileSync(path.join(root, "resources/github-sync-workbench.js"), "utf8"), context);
  return {
    nodes, messages, confirms,
    setAnswer: value => { answer = value; },
    state: (state, completed, validatedPaths = []) => listeners.message({ data: { type: "state", state, completed, validatedPaths } }),
    error: error => listeners.message({ data: { type: "error", error } }),
    navigate: path => listeners.message({ data: { type: "navigate", path } }),
    beforeUnload: () => { const event = { preventDefault() { this.prevented = true; } }; listeners.beforeunload(event); return event; },
    action: (command, source) => {
      const button = nodes.get("detail").children.find(node => node.dataset.command === command && (!source || node.dataset.source === source));
      assert.ok(button, `Missing button: ${command}/${source}`);
      button.click();
    },
  };
}

function differenceTests() {
  const local = "title\nlocal one\nkeep\nlocal two\nstable tail\nend\n";
  const remote = "title\nremote one\nkeep\nremote two\nstable tail\nend\n";
  const result = "custom title\nlocal one\nkeep\nremote two\nstable tail\ncustom end\n";
  const comparison = compare(local, remote, result);
  assert.equal(comparison.blocks.length, 2);
  assert.equal(result.slice(comparison.blocks[0].resultStart, comparison.blocks[0].resultEnd), "local one\n");
  assert.equal(result.slice(comparison.blocks[1].resultStart, comparison.blocks[1].resultEnd), "remote two\n");
  const b = browser(), s = sample(), first = s.files[0].path;
  Object.assign(s.files[0], { local, remote, merged: result, comparison });
  b.state(s);
  const pick = (index, source) => {
    const button = b.nodes.get("difference-blocks").children.find(entry => entry.dataset.index === String(index) && entry.dataset.source === source);
    assert.ok(button); button.click();
  };
  const requests = b.messages.length;
  pick(1, "local");
  pick(0, "remote");
  assert.equal(b.nodes.get("result").value, "custom title\nremote one\nkeep\nlocal two\nstable tail\ncustom end\n", "Out-of-order block picks preserve independent candidate edits");
  pick(0, "local"); pick(0, "remote");
  assert.equal(b.nodes.get("result").value, "custom title\nremote one\nkeep\nlocal two\nstable tail\ncustom end\n", "Repeated picks replace the same mapped range");
  assert.equal(b.messages.length, requests, "Block picking is draft-only, with no host mutation");
  assert.equal(b.nodes.get("apply").disabled, true);
  b.setAnswer(false); b.nodes.get("next").click();
  assert.equal(b.nodes.get("result").value, "custom title\nremote one\nkeep\nlocal two\nstable tail\ncustom end\n", "Dirty navigation preserves picked blocks");
  b.action("save");
  assert.equal(b.messages.at(-1).content, b.nodes.get("result").value);
  assert.equal(b.messages.at(-1).path, first);
  b.error("Validation failed");
  assert.equal(b.nodes.get("result").value, b.messages.at(-1).content);
  b.nodes.get("result").input("manual change");
  const beforeManualPick = b.nodes.get("result").value;
  pick(0, "local");
  assert.equal(b.nodes.get("result").value, beforeManualPick, "Manual editing invalidates offsets rather than overwriting arbitrary text");
  b.action("save");
  assert.equal(b.messages.at(-1).content, "manual change", "Manual modifications after block picking use the same explicit save path");
  b.error("Validation failed");
  const overlap = compare(local, remote, "title\nmanual across two blocks\nend\n");
  assert(overlap.blocks.every(block => block.resultStart === undefined), "Cross-boundary edits are never overwritten by guessing");
  for (const [left, right, candidate, expected] of [
    ["a\nb\n", "a\nnew\nb\n", "a\nb\n", "new\n"],
    ["a\nold\nb\n", "a\nb\n", "a\nold\nb\n", ""],
    ["a\r\nold\r\n", "a\r\nnew\r\n", "a\r\nold\r\n", "new\r\n"],
    ["a\nold", "a\nnew", "a\nold", "new"],
    ["", "new\n", "", "new\n"],
    ["old\n", "", "old\n", ""],
    ["a\n", "a", "a\n", "a"],
    ["a\nb\n", "a\ninsert\nb\n", "a\nother\nb\n", "insert\n"],
  ]) {
    const output = compare(left, right, candidate);
    assert.equal(output.blocks.length, 1);
    const block = output.blocks[0];
    assert.equal(block.remote, expected);
    assert.notEqual(block.resultStart, undefined);
    const picked = candidate.slice(0, block.resultStart) + block.remote + candidate.slice(block.resultEnd);
    assert.equal(picked, right, "Insertion/deletion/CRLF/EOF picks preserve exact bytes");
  }
  assert.deepEqual(compare("same", "same", "same").blocks, []);
  assert.match(compare("x".repeat(200001), "", "").warning, /too large/);
  assert.match(compare(Array(210).fill("same\nlocal\n").join(""), Array(210).fill("same\nremote\n").join(""), "").warning, /200 difference blocks/);
  const malicious = sample();
  malicious.files[0].comparison = compare("safe", '<img src=x onerror="alert(1)">', "safe");
  b.state(malicious, "save");
  assert(!b.nodes.get("difference-blocks").innerHTML.includes("<img"), "Diff content is escaped, never interpreted as markup");
  malicious.record.appliedAt = "already applied";
  b.state(malicious, "apply");
  pick(0, "remote");
  assert.equal(b.nodes.get("result").value, "candidate", "Applied state prevents block mutation");
}

function browserTests() {
  const b = browser();
  const s = sample();
  const first = s.files[0].path;
  assert.equal(b.messages[0].command, "ready");
  b.state(s);
  assert.match(b.nodes.get("count").textContent, /3 unresolved/);
  assert.match(b.nodes.get("detail").innerHTML, /Local \(this machine\).*GitHub \(remote\).*Common base.*Editable result/s);
  assert.ok(!b.nodes.get("detail").innerHTML.includes('<script>alert("x")</script>'));
  assert.ok(b.nodes.get("files").innerHTML.includes("&lt;script&gt;&quot;&amp;"));
  assert.equal(b.nodes.get("apply").disabled, true);
  b.nodes.get("result").input("edited candidate");
  b.setAnswer(false);
  const initialRequests = b.messages.length;
  b.nodes.get("next").click();
  b.navigate("recipes/run.md");
  for (const [command, source] of [["choose", "local"], ["compare", "base"], ["agent"], ["delete-local"], ["delete-remote"]]) b.action(command, source);
  b.nodes.get("refresh").click();
  b.nodes.get("apply").click();
  assert.equal(b.messages.length, initialRequests, "dirty guards block every non-save action");
  assert.equal(b.nodes.get("result").value, "edited candidate");
  assert.equal(b.beforeUnload().prevented, true);
  b.state(sample());
  assert.equal(b.nodes.get("result").value, "edited candidate", "unsolicited state does not erase edits");
  b.action("save");
  assert.equal(b.messages.at(-1).content, "edited candidate");
  assert.equal(b.messages.at(-1).revision, 3);
  assert.equal(b.messages.at(-1).path, first);
  assert.equal(b.nodes.get("result").disabled, true, "validation in flight freezes the submitted buffer");
  b.error("Validation failed: invalid metadata");
  assert.equal(b.nodes.get("result").value, "edited candidate");
  assert.equal(b.nodes.get("result").disabled, false, "validation failure re-enables editing");
  assert.match(b.nodes.get("error").textContent, /Validation failed/);
  assert.equal(b.nodes.get("apply").disabled, true);
  b.action("save");
  assert.equal(b.messages.at(-1).command, "save", "failed save can be retried");
  s.files[0].merged = "edited candidate";
  s.record.files[0].candidateSource = "manual";
  b.state(s, "save", [first]);
  assert.match(b.nodes.get("status").textContent, /knowledge has not been applied/);
  b.setAnswer(true);
  b.nodes.get("next").click();
  const missingBase = b.nodes.get("detail").children.find(node => node.dataset.command === "choose" && node.dataset.source === "base");
  assert.equal(missingBase.disabled, true, "absent side never defaults to empty content");
  b.action("agent");
  assert.equal(b.messages.at(-1).command, "agent");
  b.state(s, "agent", [first]);
  assert.match(b.nodes.get("status").textContent, /Review it, then save/);
  b.nodes.get("next").click();
  assert.equal(b.nodes.get("result"), undefined, "binary never gets a textarea");
  assert.ok(!b.nodes.get("detail").innerHTML.includes("BINARY MUST NOT APPEAR"));
  assert.ok(!b.nodes.get("detail").innerHTML.includes("attacker.example"));
  assert.ok(!b.nodes.get("detail").innerHTML.includes("image/svg+xml"));
  assert.match(b.nodes.get("detail").innerHTML, /data:image\/png/);
  assert.match(b.nodes.get("detail").innerHTML, /Download local image/);
  const count = b.messages.length;
  b.action("save");
  b.action("agent");
  assert.equal(b.messages.length, count, "unresolved binary cannot save or invoke agent");
  b.action("choose", "remote");
  assert.equal(b.messages.at(-1).source, "remote");
  s.record.files[2].candidateSource = "remote";
  b.state(s, "choose", [first]);
  b.action("save");
  assert.equal(b.messages.at(-1).command, "save");
  assert.equal(b.messages.at(-1).content, undefined, "binary save validates original bytes without decoding");
  b.state(s, "save", [first, s.files[2].path]);
  b.nodes.get("previous").click();
  b.setAnswer(false);
  const beforeDelete = b.messages.length;
  b.action("delete-local");
  assert.equal(b.messages.length, beforeDelete);
  b.setAnswer(true);
  b.action("delete-local");
  assert.equal(b.messages.at(-1).command, "delete-local");
  assert.match(b.confirms.at(-1), /GitHub variant unchanged/);
  s.record.files[1].candidateSource = "delete-local";
  const all = s.files.map(file => file.path);
  b.state(s, "delete-local", all);
  assert.equal(b.nodes.get("result"), undefined);
  assert.equal(b.nodes.get("apply").disabled, false);
  b.setAnswer(false);
  const beforeApply = b.messages.length;
  b.nodes.get("apply").click();
  assert.equal(b.messages.length, beforeApply, "final apply requires explicit confirmation");
  b.setAnswer(true);
  b.nodes.get("apply").click();
  assert.equal(b.messages.at(-1).command, "apply");
  b.nodes.get("apply").click();
  assert.equal(b.messages.length, beforeApply + 1, "double click produces one operation");
  b.state(undefined, "apply");
  assert.match(b.nodes.get("status").textContent, /No active conflict workspace.*Check GitHub Sync status/);
  assert.equal(b.nodes.get("apply").disabled, true);
  b.state(sample());
  b.nodes.get("result").input("dirty");
  b.nodes.get("refresh").click();
  assert.equal(b.messages.at(-1).command, "refresh", "confirmed discard permits refresh");
  b.state(sample(), "refresh");
  assert.equal(b.nodes.get("result").value, "candidate");
  const applied = sample();
  applied.record.appliedAt = "2026-10-12T20:00:00Z";
  applied.record.files[0].basePath = "skills/old.md";
  applied.record.files[0].localPath = "skills/local.md";
  applied.record.files[0].remotePath = "skills/remote.md";
  applied.record.files[0].resultPath = "skills/result.md";
  b.state(applied);
  assert.match(b.nodes.get("status").textContent, /Applied locally; GitHub sync pending/);
  assert.equal(b.nodes.get("result").readOnly, true);
  for (const sourcePath of ["skills/old.md", "skills/local.md", "skills/remote.md", "skills/result.md"]) {
    assert(b.nodes.get("detail").innerHTML.includes(sourcePath), "Every source and destination path remains visible");
  }
  const appliedCount = b.messages.length;
  for (const [command, source] of [["choose", "local"], ["save"], ["agent"], ["delete-local"], ["delete-remote"]]) b.action(command, source);
  assert.equal(b.messages.length, appliedCount, "applied workspace cannot mutate decisions");
  assert.match(b.nodes.get("apply").textContent, /Retry sync/);
  assert.equal(b.nodes.get("apply").disabled, false, "applied workspace can retry even after reopening without validation receipts");
  b.nodes.get("apply").click();
  assert.equal(b.messages.at(-1).command, "apply");
  b.state(applied, "apply");
  assert.match(b.nodes.get("status").textContent, /sync pending/);
}

function chromiumAcceptance(html) {
  const python = process.env.WORKBENCH_TEST_PYTHON;
  const vsix = process.env.WORKBENCH_TEST_VSIX;
  assert.ok(python && vsix, "--chromium requires WORKBENCH_TEST_PYTHON and WORKBENCH_TEST_VSIX");
  const script = String.raw`
import json, os, sys, zipfile
from playwright.sync_api import sync_playwright, expect
fixture = json.load(sys.stdin)
with zipfile.ZipFile(os.environ["WORKBENCH_TEST_VSIX"]) as package:
    asset = package.read("extension/resources/github-sync-workbench.js").decode()
assert asset == fixture["asset"], "Packaged asset differs from the tested implementation"
with sync_playwright() as driver:
    args = {"headless": True}
    if os.environ.get("WORKBENCH_TEST_CHROMIUM"):
        args["executable_path"] = os.environ["WORKBENCH_TEST_CHROMIUM"]
    browser = driver.chromium.launch(**args)
    print("Actual headless Chromium " + browser.version + "; packaged VSIX asset")
    for width, height in [(1440, 1000), (390, 844)]:
        page = browser.new_page(viewport={"width": width, "height": height})
        failures, requests, dialogs, answers = [], [], [], []
        page.on("pageerror", lambda error: failures.append(str(error)))
        def dialog(dialog):
            dialogs.append(dialog.message)
            if answers and answers.pop(0):
                dialog.accept()
            else:
                dialog.dismiss()
        page.on("dialog", dialog)
        def route(request):
            url = request.request.url
            requests.append(url)
            if url == "https://workbench.invalid/":
                request.fulfill(body=fixture["html"], content_type="text/html")
            elif url == "https://workbench.invalid/resources/github-sync-workbench.js":
                request.fulfill(body=asset, content_type="text/javascript")
            else:
                failures.append("Unexpected network request: " + url)
                request.abort()
        page.route("**/*", route)
        page.goto("https://workbench.invalid/")
        expect(page.locator("#count")).to_have_text("3 unresolved · 0/3 saved & validated")
        first = page.evaluate("acceptance.state.files[0].path")
        def last():
            return page.evaluate("acceptance.requests[acceptance.requests.length - 1]")
        def count():
            return page.evaluate("acceptance.requests.length")
        def reply(command, paths=[]):
            page.evaluate("args => acceptance.send(args.command,args.paths)", {"command":command,"paths":paths})
            expect(page.locator("#refresh")).to_be_enabled()
        for label in ["Local (this machine)", "GitHub (remote)", "Editable result"]:
            expect(page.get_by_role("heading", name=label, exact=True)).to_be_visible()
        expect(page.locator(".base-preview > summary")).to_have_text("Common base (last shared snapshot)")
        page.locator(".base-preview > summary").click()
        expect(page.get_by_title(first, exact=True)).to_be_visible()
        assert page.locator("#detail script").count() == 0
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "Horizontal overflow"
        page.get_by_role("button", name="Pick all left (local)", exact=True).click()
        assert last()["command"] == "choose" and last()["source"] == "local"
        expect(page.get_by_role("button", name="Save & validate", exact=True)).to_be_disabled()
        page.evaluate("() => { acceptance.state.record.files[0].candidateSource='local'; acceptance.state.files[0].merged='local'; acceptance.state.record.revision++; }")
        reply("choose")
        expect(page.locator("#apply")).to_be_disabled()
        for source in ["remote", "base"]:
            if source == "base":
                page.locator(".base-preview > summary").click()
            page.get_by_role("button", name="Choose base" if source == "base" else "Pick all right (GitHub)", exact=True).click()
            assert last()["command"] == "choose" and last()["source"] == source
            page.evaluate("source => { acceptance.state.record.files[0].candidateSource=source; acceptance.state.files[0].merged=acceptance.state.files[0][source]; acceptance.state.record.revision++; }", source)
            reply("choose")
            expect(page.locator("#result")).to_have_value(page.evaluate("acceptance.state.files[0].merged"))
            expect(page.locator("#apply")).to_be_disabled()
        page.locator("#result").fill("human edited candidate")
        page.locator(".base-preview > summary").click()
        before = count()
        for selector in ["#next", "#refresh"]:
            page.locator(selector).click()
            assert count() == before
            expect(page.locator("#result")).to_have_value("human edited candidate")
        for label in ["Choose base", "Native compare base / result", "Delete local only…"]:
            page.get_by_role("button", name=label, exact=True).click()
            assert count() == before
        assert all("Discard the unsaved" in text for text in dialogs)
        page.evaluate("() => acceptance.send()")
        expect(page.locator("#error")).to_contain_text("unsaved edits")
        expect(page.locator("#result")).to_have_value("human edited candidate")
        page.get_by_role("button", name="Save & validate", exact=True).click()
        assert last()["content"] == "human edited candidate"
        expect(page.locator("#status")).to_have_text("Working…")
        expect(page.locator("#next")).to_be_disabled()
        expect(page.locator("#result")).to_be_disabled()
        page.evaluate("() => acceptance.error('Validation failed: expected skill metadata')")
        expect(page.locator("#error")).to_contain_text("Validation failed: expected skill metadata")
        expect(page.locator("#result")).to_have_value("human edited candidate")
        expect(page.locator("#apply")).to_be_disabled()
        page.get_by_role("button", name="Save & validate", exact=True).click()
        page.evaluate("() => { acceptance.state.record.files[0].candidateSource='manual'; acceptance.state.files[0].merged='human edited candidate'; acceptance.state.record.revision++; }")
        reply("save", [first])
        expect(page.locator("#status")).to_contain_text("Local knowledge has not been applied")
        page.locator("#next").click()
        page.locator(".base-preview > summary").click()
        expect(page.get_by_role("button", name="Choose base", exact=True)).to_be_disabled()
        page.locator("#result").fill("dirty recipe")
        before = count()
        page.get_by_role("button", name="Ask Agent", exact=True).click()
        assert count() == before
        answers.append(True)
        page.get_by_role("button", name="Ask Agent", exact=True).click()
        assert last()["command"] == "agent"
        page.evaluate("() => acceptance.error('Agent failed: synthetic provider error')")
        expect(page.locator("#error")).to_contain_text("Agent failed: synthetic provider error")
        page.get_by_role("button", name="Ask Agent", exact=True).click()
        reply("agent", [first])
        expect(page.locator("#status")).to_contain_text("Review it, then save")
        page.locator("#next").click()
        assert page.locator("textarea").count() == 0
        expect(page.get_by_role("button", name="Save & validate", exact=True)).to_be_disabled()
        expect(page.get_by_role("button", name="Ask Agent", exact=True)).to_be_disabled()
        expect(page.locator("#detail")).not_to_contain_text("BINARY MUST NOT APPEAR")
        assert page.locator("img").count() == 1
        expect(page.locator("img")).to_be_visible()
        assert page.locator("img").evaluate("image => image.complete && image.naturalWidth > 0"), "Image preview did not decode safely"
        expect(page.get_by_role("link", name="Download local image", exact=True)).to_be_visible()
        assert all("attacker.example" not in url for url in requests)
        assert "svg+xml" not in page.locator("#detail").inner_html()
        page.get_by_role("button", name="Native compare local / result", exact=True).click()
        assert last()["command"] == "compare" and last()["source"] == "local" and "content" not in last()
        page.evaluate("() => acceptance.error('Native compare failed: synthetic binary inspection error')")
        expect(page.locator("#error")).to_contain_text("synthetic binary inspection error")
        page.get_by_role("button", name="Pick all left (local)", exact=True).click()
        page.evaluate("() => { acceptance.state.record.files[2].candidateSource='local'; acceptance.state.record.revision++; }")
        reply("choose", [first])
        page.get_by_role("button", name="Save & validate", exact=True).click()
        assert last()["command"] == "save" and "content" not in last()
        reply("save", [first, "skills/image.png"])
        page.locator("#previous").click()
        before = count()
        page.get_by_role("button", name="Delete local only…", exact=True).click()
        assert count() == before
        assert "GitHub variant unchanged" in dialogs[-1]
        answers.append(True)
        page.get_by_role("button", name="Delete local only…", exact=True).click()
        assert last()["command"] == "delete-local"
        page.evaluate("() => { acceptance.state.record.files[1].candidateSource='delete-local'; acceptance.state.record.revision++; }")
        paths = [first, "recipes/run.md", "skills/image.png"]
        reply("delete-local", paths)
        assert page.locator("#result").count() == 0
        expect(page.locator("#detail")).to_contain_text("GitHub stays unchanged")
        expect(page.locator("#apply")).to_be_enabled()
        page.locator("#previous").click()
        before = count()
        page.get_by_role("button", name="Delete from synced result…", exact=True).click()
        assert count() == before
        assert "local knowledge and GitHub" in dialogs[-1]
        answers.append(True)
        page.get_by_role("button", name="Delete from synced result…", exact=True).click()
        assert last()["command"] == "delete-remote"
        page.evaluate("() => { acceptance.state.record.files[0].candidateSource='delete'; acceptance.state.record.revision++; }")
        reply("delete-remote", paths)
        expect(page.locator("#detail")).to_contain_text("Delete local and from GitHub")
        before = count()
        page.locator("#apply").click()
        assert count() == before
        assert "not confirmation of a successful GitHub push" in dialogs[-1]
        answers.append(True)
        page.locator("#apply").click()
        assert last()["command"] == "apply"
        page.evaluate("() => { acceptance.state.record.appliedAt='2026-10-12T22:00:00Z'; acceptance.state.record.files[0].candidateSource='manual'; }")
        reply("apply")
        expect(page.locator("#status")).to_contain_text("Applied locally; GitHub sync pending")
        expect(page.locator("#result")).to_have_attribute("readonly", "")
        for label in ["Pick all left (local)", "Save & validate", "Ask Agent", "Delete local only…"]:
            expect(page.get_by_role("button", name=label, exact=True)).to_be_disabled()
        expect(page.locator("#apply")).to_have_text("Retry sync…")
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "Applied state horizontal overflow"
        answers.append(True)
        page.locator("#apply").click()
        assert last()["command"] == "apply"
        page.evaluate("() => acceptance.error('GitHub sync failed: synthetic push rejection')")
        expect(page.locator("#error")).to_contain_text("GitHub sync failed: synthetic push rejection")
        expect(page.locator("#status")).to_contain_text("Applied locally; GitHub sync pending")
        expect(page.locator("#apply")).to_be_enabled()
        page.locator("#refresh").click()
        page.evaluate("() => { acceptance.state=undefined; acceptance.send('refresh'); }")
        expect(page.locator("#status")).to_contain_text("No active conflict workspace. Check GitHub Sync status")
        expect(page.locator("#apply")).to_be_disabled()
        page.evaluate("() => {acceptance.state=structuredClone(acceptance.pickState);acceptance.send();}")
        expect(page.locator(".difference-block")).to_have_count(2)
        expect(page.locator(".difference-local")).to_contain_text(["local one", "local two"])
        expect(page.locator(".difference-remote")).to_contain_text(["remote one longer", "remote two"])
        assert page.locator(".difference-local").first.evaluate("node => getComputedStyle(node).backgroundColor") != "rgba(0, 0, 0, 0)"
        assert page.locator(".difference-remote").first.evaluate("node => getComputedStyle(node).backgroundColor") != "rgba(0, 0, 0, 0)"
        before_width = page.locator("#detail").bounding_box()["width"]
        page.locator("#toggle-files").click()
        expect(page.locator("#files")).to_be_hidden()
        assert page.locator("#detail").bounding_box()["width"] >= before_width
        expect(page.locator("#toggle-files")).to_have_attribute("aria-expanded", "false")
        page.locator("#toggle-files").click()
        expect(page.locator("#files")).to_be_visible()
        folder = page.locator("#files details").first
        folder.locator(":scope > summary").click()
        expect(folder).not_to_have_attribute("open", "")
        reply("refresh")
        expect(page.locator("#files details").first).not_to_have_attribute("open", "")
        page.locator("#files details").first.locator(":scope > summary").click()
        before = count()
        page.get_by_role("button", name="Pick right · difference 2", exact=True).click()
        expect(page.locator("#result")).to_have_value("Title\nlocal one\nkeep\nremote two\nend\n")
        page.get_by_role("button", name="Pick right · difference 1", exact=True).click()
        expect(page.locator("#result")).to_have_value("Title\nremote one longer\nkeep\nremote two\nend\n")
        page.get_by_role("button", name="Pick left · difference 2", exact=True).click()
        expect(page.locator("#result")).to_have_value("Title\nremote one longer\nkeep\nlocal two\nend\n")
        assert count() == before, "Block picking must not persist or apply behind the user's back"
        expect(page.locator("#apply")).to_be_disabled()
        expect(page.locator("#dirty")).to_contain_text("Unsaved block picks")
        page.locator("#result").fill("Title\nremote one longer\nkeep\nlocal two\nend\nhuman modification\n")
        expect(page.get_by_role("button", name="Pick left · difference 1", exact=True)).to_be_disabled()
        page.get_by_role("button", name="Save & validate", exact=True).click()
        assert last()["content"].endswith("human modification\n"), "Manual edits after picking must be included in the save"
        page.evaluate("() => acceptance.error('Validation failed: synthetic picked draft error')")
        expect(page.locator("#result")).to_have_value(last()["content"])
        page.get_by_role("button", name="Save & validate", exact=True).click()
        page.evaluate("() => {acceptance.state=structuredClone(acceptance.savedPickState);}")
        reply("save", [first])
        expect(page.get_by_role("button", name="Pick left · difference 1", exact=True)).to_be_enabled()
        expect(page.locator("#apply")).to_be_enabled()
        page.get_by_role("button", name="Pick left · difference 1", exact=True).click()
        expect(page.locator("#apply")).to_be_disabled()
        expect(page.locator("#result")).to_have_value("Title\nlocal one\nkeep\nlocal two\nend\nhuman modification\n")
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "Difference comparison must fit narrow viewports"
        assert not failures, failures
        print(str(width) + "x" + str(height) + ": selection, dirty/save/pending/error/stale-state, agent, binary, delete/apply confirmations, appliedAt/retry passed")
        page.close()
    browser.close()
`;
  const result = spawnSync(python, ["-c", script], {
    input: JSON.stringify({ html, asset: fs.readFileSync(path.join(root, "resources/github-sync-workbench.js"), "utf8") }),
    encoding: "utf8", timeout: 120000, maxBuffer: 4 * 1024 * 1024,
  });
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  assert.ifError(result.error);
  assert.equal(result.status, 0, "Real Chromium acceptance failed");
}

async function hostTests() {
  const created = [];
  const vscode = {
    Uri: { joinPath: (uri, ...parts) => ({ toString: () => `${uri.toString()}/${parts.join("/")}` }) },
    ViewColumn: { Active: 1 },
    window: { createWebviewPanel: (_id, _title, _column, options) => {
      const panel = {
        options, messages: [], revealCount: 0,
        webview: {
          cspSource: "vscode-webview://test",
          asWebviewUri: uri => uri,
          postMessage: async message => { panel.messages.push(message); return true; },
          onDidReceiveMessage: callback => { panel.receive = callback; return { dispose() { panel.receiveDisposed = true; } }; },
        },
        reveal() { this.revealCount++; },
        onDidDispose(callback) { panel.close = callback; return { dispose() { panel.closeDisposed = true; } }; },
        dispose() { panel.close(); },
      };
      created.push(panel);
      return panel;
    } },
  };
  const filename = path.join(root, "src/sync/github-sync-workbench.ts");
  const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const loadedModule = new Module(filename, module);
  loadedModule.filename = filename;
  loadedModule.paths = Module._nodeModulePaths(root);
  loadedModule.require = id => id === "vscode" ? vscode : require(id);
  loadedModule._compile(compiled, filename);
  const { openGitHubSyncConflictWorkbench: open, renderGitHubSyncWorkbenchHtml: render, githubSyncWorkbenchComparison } = loadedModule.exports;
  compare = githubSyncWorkbenchComparison;
  differenceTests();
  if (process.argv.includes("--browser-fixture") || process.argv.includes("--chromium")) {
    const nonce = "browserAcceptanceNonce";
    const html = render({ cspSource: "'self'" }, { toString: () => "resources/github-sync-workbench.js" }, nonce);
    const pickState = sample();
    pickState.record.files = [pickState.record.files[0]];
    pickState.files = [pickState.files[0]];
    const local = "Title\nlocal one\nkeep\nlocal two\nend\n", remote = "Title\nremote one longer\nkeep\nremote two\nend\n";
    const merged = local, picked = "Title\nremote one longer\nkeep\nlocal two\nend\n";
    Object.assign(pickState.files[0], { local, remote, merged, comparison: compare(local, remote, merged) });
    const savedPickState = structuredClone(pickState);
    savedPickState.record.revision++;
    savedPickState.record.files[0].candidateSource = "manual";
    savedPickState.files[0].merged = picked + "human modification\n";
    savedPickState.files[0].comparison = compare(local, remote, savedPickState.files[0].merged);
    const fixture = `<script nonce="${nonce}">
window.acceptance = {
  state: ${JSON.stringify(sample()).replace(/</g, "\\u003c")},
  pickState: ${JSON.stringify(pickState).replace(/</g, "\\u003c")},
  savedPickState: ${JSON.stringify(savedPickState).replace(/</g, "\\u003c")},
  requests: [],
  send: function(completed, validatedPaths) {
    window.postMessage({type: "state", state: this.state, completed: completed, validatedPaths: validatedPaths || []}, "*");
  },
  error: function(message) { window.postMessage({type: "error", error: message}, "*"); }
};
window.acquireVsCodeApi = function() { return {postMessage: function(message) {
  window.acceptance.requests.push(message);
  if (message.command === "ready") window.acceptance.send();
}}; };
</script>`;
    const fixtureHtml = html.replace(`<script nonce="${nonce}" src=`, `${fixture}<script nonce="${nonce}" src=`);
    if (process.argv.includes("--browser-fixture")) {
      fs.writeFileSync(path.join(root, ".github-sync-workbench-browser.html"), fixtureHtml);
      console.log("Synthetic browser fixture written to .github-sync-workbench-browser.html");
    }
    if (process.argv.includes("--chromium")) chromiumAcceptance(fixtureHtml);
  }
  const context = { extensionUri: { toString: () => "file:///extension" }, subscriptions: [] };
  let state = sample();
  let failState = false;
  const calls = [];
  let pending;
  const options = {
    getState: async () => { if (failState) throw new Error("State unavailable"); return state; },
    perform: async request => {
      calls.push(request);
      if (pending) await pending;
      if (request.command === "compare") throw new Error("Native compare unavailable");
      const meta = state.record.files.find(file => file.path === request.path);
      const file = state.files.find(file => file.path === request.path);
      if (request.command === "choose") { meta.candidateSource = request.source; file.merged = file[request.source]; }
      if (request.command === "save") { meta.candidateSource = file.binary ? meta.candidateSource : "manual"; if (!file.binary) file.merged = request.content; }
      if (request.command === "delete-local") meta.candidateSource = "delete-local";
      if (request.command === "apply") state = undefined;
      if (state) state.record.revision++;
    },
  };
  await open(context, "primary", options);
  const panel = created[0];
  assert.equal(created.length, 1);
  assert.equal(context.subscriptions.length, 1);
  assert.equal(panel.options.enableScripts, true);
  assert.equal(panel.options.localResourceRoots[0].toString(), "file:///extension/resources");
  assert.match(panel.webview.html, /file:\/\/\/extension\/resources\/github-sync-workbench.js/);
  assert.match(panel.webview.html, /connect-src 'none'/);
  assert.match(panel.webview.html, /default-src 'none'/);
  assert.match(panel.webview.html, /script-src 'nonce-[a-f0-9]{48}'/);
  assert.ok(!panel.webview.html.includes("conflict-1"), "state never interpolated into HTML");
  const malicious = render(panel.webview, { toString: () => '"><script>bad</script>' }, "safe");
  assert.ok(!malicious.includes('src=""><script>'));
  assert.match(malicious, /&quot;&gt;&lt;script&gt;/);
  await panel.receive({ command: "ready" });
  assert.equal(panel.messages.at(-1).state.record.id, "conflict-1");
  const send = async (command, extra = {}) => panel.receive({ command, conflictId: state?.record.id ?? "conflict-1", revision: state?.record.revision ?? 0, ...extra });
  const first = state.files[0].path;
  await send("apply");
  assert.equal(calls.length, 0, "host rejects apply before validation");
  assert.match(panel.messages.at(-1).error, /Save & validate/);
  await send("choose", { path: first, source: "bad" });
  await send("save", { path: "skills/image.png", content: "corrupt bytes" });
  await send("save", { path: "skills/image.png" });
  await send("choose", { path: "recipes/run.md", source: "base" });
  await send("save", { path: "missing.md", content: "x" });
  await send("choose", { path: first, source: "local", content: "injected" });
  await send("refresh", { revision: -1 });
  await send("refresh", { revision: 0 });
  await send("refresh", { conflictId: "stale" });
  assert.equal(calls.length, 0);
  await send("choose", { path: first, source: "local" });
  assert.equal(calls.at(-1).command, "choose");
  assert.deepEqual(panel.messages.at(-1).validatedPaths, []);
  await send("save", { path: first, content: "human review" });
  assert.deepEqual(panel.messages.at(-1).validatedPaths, [first]);
  await send("choose", { path: "skills/image.png", source: "local" });
  await send("save", { path: "skills/image.png" });
  assert.equal(calls.at(-1).content, undefined);
  await send("agent", { path: "skills/image.png" });
  assert.match(panel.messages.at(-1).error, /unresolved text/);
  await send("delete-local", { path: "recipes/run.md" });
  assert.equal(panel.messages.at(-1).validatedPaths.length, 3);
  state.files[0].merged = "external edit";
  await send("refresh");
  assert.ok(!panel.messages.at(-1).validatedPaths.includes(first), "external candidate changes invalidate explicit validation");
  await send("save", { path: first, content: "reviewed external edit" });
  await send("compare", { path: first, source: "remote" });
  assert.match(panel.messages.at(-1).error, /Native compare unavailable/, "action errors returned visibly");
  await open(context, "primary", { ...options, initialPath: "recipes/run.md" });
  assert.equal(created.length, 1);
  assert.equal(panel.revealCount, 1);
  assert.equal(panel.messages.at(-1).type, "navigate");
  let release;
  pending = new Promise(resolve => { release = resolve; });
  const inFlight = send("refresh");
  await send("refresh");
  assert.match(panel.messages.at(-1).error, /still running/);
  release();
  await inFlight;
  pending = undefined;
  await send("apply");
  assert.equal(calls.at(-1).command, "apply");
  assert.equal(panel.messages.at(-1).state, undefined);
  failState = true;
  await panel.receive({ command: "ready" });
  assert.match(panel.messages.at(-1).error, /State unavailable/);
  panel.dispose();
  assert.equal(context.subscriptions.length, 0);
  assert.equal(panel.receiveDisposed, true);
  assert.equal(panel.closeDisposed, true);
  failState = false;
  state = sample();
  await open(context, "primary", options);
  assert.equal(created.length, 2, "disposed targets can reopen");
  state.record.appliedAt = "2026-10-12T20:00:00Z";
  await created[1].receive({ command: "ready" });
  const appliedCalls = calls.length;
  await created[1].receive({ command: "save", conflictId: state.record.id, revision: state.record.revision, path: first, content: "bad" });
  assert.equal(calls.length, appliedCalls);
  assert.match(created[1].messages.at(-1).error, /already applied/);
  await created[1].receive({ command: "apply", conflictId: state.record.id, revision: state.record.revision });
  assert.equal(calls.at(-1).command, "apply", "host permits retry of already applied decisions without new validation receipts");
  await open({ ...context, subscriptions: [] }, "primary", options);
  assert.equal(created.length, 3, "different extension contexts own different panels");
  created[1].dispose();
  created[2].dispose();
}

(async () => {
  browserTests();
  await hostTests();
  console.log("GitHub Sync workbench: browser interactions and mocked VS Code host tests passed.");
})().catch(error => { console.error(error); process.exitCode = 1; });

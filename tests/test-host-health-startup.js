const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

function element() {
  const classes = new Set();
  return { hidden: false, dataset: {}, attributes: {}, children: [], textContent: "",
    classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
    setAttribute(name, value) { this.attributes[name] = value; }, append(...items) { this.children.push(...items); } };
}

function load() {
  let now = 1_000_000, tick;
  const listeners = {}, posted = [];
  const loading = element(), body = element();
  const context = {
    Date: { now: () => now }, console,
    setInterval: fn => { tick = fn; return 1; },
    acquireVsCodeApi: () => ({ postMessage: message => posted.push(message), getState() {}, setState() {} }),
    document: { visibilityState: "visible", body, getElementById: id => id === "pkm-chat-loading" ? loading : undefined, createElement: element,
      addEventListener() {} },
    window: { addEventListener: (type, fn) => { listeners[type] = fn; } },
  };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "src", "webview", "host-health.js"), "utf8"), context);
  const banner = body.children[0];
  const reply = () => { for (const message of posted.splice(0)) if (message.type === "hostHealth") listeners.message({ data: { type: "hostHealth", id: message.id } }); };
  const advance = (ms, alive = true) => { for (let left = ms; left > 0; left -= 5000) { now += Math.min(5000, left); if (alive) reply(); tick(); } };
  return { context, banner, loading, advance };
}

test("a slow first activation with a responsive Host is reported as starting, never as a dead extension", () => {
  const page = load();
  page.advance(60_000);
  assert.equal(page.banner.hidden, false);
  assert.equal(page.banner.dataset.kind, "starting");
  assert.equal(page.banner.attributes.role, "status");
  assert.match(page.banner.children[1].textContent, /still starting/);
  assert.doesNotMatch(page.banner.children[1].textContent, /failed|not responding/);
  assert.equal(page.loading.hidden, false);
  page.context.PkmHostHealth.ready();
  assert.equal(page.banner.hidden, true);
});

test("startup failure is declared only when the Host stops answering or the grace limit expires", () => {
  const silent = load();
  silent.advance(25_000, false);
  assert.equal(silent.banner.dataset.kind, "starting", "a short pause in health replies is not yet a failure");
  silent.advance(10_000, false);
  assert.equal(silent.banner.dataset.kind, "initial-unresponsive");
  silent.advance(5_000);
  assert.equal(silent.banner.dataset.kind, "starting", "a Host that answers again returns to starting");

  const stuck = load();
  stuck.advance(175_000);
  assert.equal(stuck.banner.dataset.kind, "starting");
  stuck.advance(10_000);
  assert.equal(stuck.banner.dataset.kind, "initial");
  assert.match(stuck.banner.children[1].textContent, /within 3 minutes/);
});

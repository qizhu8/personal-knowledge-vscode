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
  let now = 1_000_000, tick, reloads = 0;
  const listeners = {}, posted = [];
  const loading = element(), body = element();
  const context = {
    Date: { now: () => now }, console,
    setInterval: fn => { tick = fn; return 1; },
    acquireVsCodeApi: () => ({ postMessage: message => posted.push(message), getState() {}, setState() {} }),
    document: { visibilityState: "visible", body, getElementById: id => id === "pkm-chat-loading" ? loading : undefined, createElement: element,
      addEventListener() {} },
    window: { location:{reload:()=>reloads++}, addEventListener: (type, fn) => { listeners[type] = fn; } },
  };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "src", "webview", "host-health.js"), "utf8"), context);
  const banner = body.children[0];
  const reply = () => { for (const message of posted.splice(0)) if (message.type === "hostHealth") listeners.message({ data: { type: "hostHealth", id: message.id } }); };
  const advance = (ms, alive = true) => { for (let left = ms; left > 0; left -= 5000) { now += Math.min(5000, left); if (alive) reply(); tick(); } };
  return { context, banner, loading, advance, listeners, posted, reloads:()=>reloads };
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
  assert.equal(page.banner.children[2].hidden, true, "starting is informational, not a request to reconnect");
  page.context.PkmHostHealth.ready();
  assert.equal(page.banner.hidden, true);
});

test("interface failures reload only the interface; Host failures reconnect and remain failed until confirmed", () => {
  const page = load();
  page.listeners.error({message:"asset missing"});
  assert(page.posted.some(message => message.type === "interfaceError" && message.message.includes("asset missing")));
  assert.equal(page.banner.children[2].textContent, "Reload interface");
  page.banner.children[2].onclick();
  assert.equal(page.reloads(), 1);
  assert(!page.banner.hidden, "clicking recovery is not proof of recovery");
  const host = load();
  host.context.PkmHostHealth.ready();
  host.advance(25_000, false);
  assert.equal(host.banner.children[2].textContent, "Reconnect to Extension Host");
  host.banner.children[2].onclick();
  assert(host.posted.some(message=>message.command === "ready"));
  assert(!host.banner.hidden);
});

test("diagnostic/help commands work while unavailable without opening the gate to mutations", () => {
  const page = load();
  page.listeners.error({message:"script failed"});
  page.posted.length = 0;
  page.context.PkmWebviewApi.postMessage({type:"send"});
  page.context.PkmWebviewApi.postMessage({command:"envDelete"});
  page.context.PkmWebviewApi.postMessage({type:"openHelp",value:"agents"});
  page.context.PkmWebviewApi.postMessage({type:"showLogs"});
  assert.deepEqual(page.posted.map(message=>message.type), ["openHelp","showLogs"]);
  page.banner.children[3].onclick();
  assert.equal(page.posted.at(-1).command, "showLogs");
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

test("PKM-FAULT-013: a busy loaded Host warns after twenty seconds, blocks mutations, and clears the warning only after a health reply", () => {
  const page = load();
  page.context.PkmHostHealth.ready();
  page.advance(15_000, false);
  assert.equal(page.banner.hidden, true);
  page.advance(5_000, false);
  assert.equal(page.banner.dataset.kind, "host");
  assert.match(page.banner.children[1].textContent, /Extension Host is not responding/);
  page.context.PkmWebviewApi.postMessage({ type:"send", text:"Must not dispatch" });
  assert(!page.posted.some(post => post.type === "send"));
  page.advance(5_000);
  assert.equal(page.banner.hidden, true);
});

test("PKM-FAULT-014: a responsive Host with a permanently halted backend times out startup, not Host health", () => {
  const page = load();
  page.advance(185_000, true);
  assert.equal(page.banner.dataset.kind, "initial");
  assert.match(page.banner.children[1].textContent, /responding.*within 3 minutes/);
  page.context.PkmHostHealth.ready();
  assert.equal(page.banner.hidden, true);
});

test("PKM-FAULT-015 [platform boundary]: a hard-stalled renderer cannot execute its own health timers or display a new warning", () => {
  const { spawnSync } = require("node:child_process");
  const child = spawnSync(process.execPath, ["-e", `
    const fs = require("node:fs"), vm = require("node:vm");
    const node = () => ({hidden:false, dataset:{}, children:[], textContent:"",
      classList:{add(){},remove(){}}, setAttribute(){}, append(...items){this.children.push(...items)}});
    const body=node();
    const context={Date,console,setInterval:fn=>setInterval(fn,5),
      acquireVsCodeApi:()=>({postMessage(){}}),
      document:{visibilityState:"visible",body,getElementById:node,createElement:node,addEventListener(){}},
      window:{location:{reload(){}},addEventListener(){}}};
    context.globalThis=context;
    vm.runInNewContext(fs.readFileSync(process.argv[1],"utf8"),context);
    context.PkmHostHealth.ready();
    fs.writeSync(1,"renderer entered injected stall; banner hidden="+body.children[0].hidden+"\\n");
    while (true) {}
  `, path.join(__dirname, "../src/webview/host-health.js")], {
    encoding:"utf8", timeout:500,
  });
  assert.equal(child.error?.code, "ETIMEDOUT");
  assert.match(child.stdout, /entered injected stall; banner hidden=true/);
  assert.doesNotMatch(child.stdout, /not responding/);
});

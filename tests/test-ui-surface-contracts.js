#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { dimensions, surfaces } = require("./ui-surface-manifest.js");

const root = path.join(__dirname, "..");
const read = relative => fs.readFileSync(path.join(root, relative), "utf8");
const html = read("src/webview/panel.html");
const core = read("src/webview/panel/00-core.js");
const extension = read("src/extension.ts");
const packageJson = JSON.parse(read("package.json"));
function expandScript(name, seen = new Set()) {
  if (seen.has(name)) return "";
  seen.add(name);
  const command = packageJson.scripts[name] || "";
  return `${command} ${[...command.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)]
    .map(match => expandScript(match[1], seen))
    .join(" ")}`;
}
const releaseGate = `${expandScript("pretest:release")} ${expandScript("test:release")}`;
const missingReleaseEvidence = new Set();

const htmlTabs = [...html.matchAll(/data-tab="([^"]+)"/g)].map(match => match[1]);
assert.deepStrictEqual(
  [...new Set(htmlTabs)].sort(),
  Object.keys(surfaces).sort(),
  "every visible panel tab must have exactly one comprehensive surface contract",
);

const workspaceBlock = core.match(/const workspaceSurfaces = Object\.freeze\(\{([\s\S]*?)\}\);/)?.[1] || "";
for (const [tab, contract] of Object.entries(surfaces)) {
  assert.match(workspaceBlock, new RegExp(`${contract.workspace}:\\[[^\\]]*['"]${tab}['"]`), `${tab} must stay in its declared workspace`);
  const source = read(contract.source);
  assert(source.includes(`function ${contract.renderer}(`), `${tab} renderer is missing: ${contract.renderer}`);
  assert(contract.viewKinds.length > 0, `${tab} must declare its rendered view kinds`);
  for (const dimension of dimensions) {
    const evidence = contract.evidence[dimension];
    assert(Array.isArray(evidence) && evidence.length > 0, `${tab} is missing ${dimension} evidence`);
    for (const file of evidence) {
      assert(fs.existsSync(path.join(__dirname, file)), `${tab} ${dimension} evidence does not exist: ${file}`);
      if (!releaseGate.includes(`tests/${file}`)) missingReleaseEvidence.add(file);
    }
  }
}
assert.deepStrictEqual(
  [...missingReleaseEvidence].sort(),
  [],
  `UI evidence is not enforced by the release gate: ${[...missingReleaseEvidence].sort().join(", ")}`,
);

const panelSources = fs.readdirSync(path.join(root, "src", "webview", "panel"))
  .filter(file => file.endsWith(".js"))
  .map(file => read(path.join("src", "webview", "panel", file)))
  .join("\n");
const panelMarkup = `${html}\n${panelSources}`;

for (const match of panelMarkup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
  const attributes = match[1];
  const visible = match[2]
    .replace(/<[^>]+>/g, "")
    .replace(/\$\{uiIcon\([^,]+,\s*['"]([^'"]+)['"]\)\}/g, "$1")
    .replace(/\$\{uiIcon\([^,]+,[^)]*\)\}/g, "dynamic label")
    .replace(/\$\{uiIcon\([^)]*\)\}/g, "")
    .replace(/\$\{(?:esc|attr)\([^)]+\)\}/g, "dynamic label")
    .replace(/\$\{[A-Za-z_$][A-Za-z0-9_$.]*\}/g, "dynamic label")
    .replace(/\$\{[^}]+\}/g, "dynamic label")
    .trim();
  assert(
    visible || /\b(?:title|aria-label)=/.test(attributes),
    `icon-only button needs a title or aria-label: ${match[0].slice(0, 160)}`,
  );
}

for (const match of panelMarkup.matchAll(/<(?:article|div)\b([^>]*\brole=["']button["'][^>]*)>/g)) {
  assert(/\btabindex=/.test(match[1]), `custom button needs tabindex: ${match[0]}`);
  assert(/\bonkeydown=/.test(match[1]), `custom button needs keyboard activation: ${match[0]}`);
}

const inlineHandlerBuiltins = new Set(["ask", "decodeURIComponent", "encodeURIComponent", "if", "Number", "parseInt", "String"]);
for (const attribute of panelMarkup.matchAll(/\bon(?:click|change|input|keydown|contextmenu)=["']([^"']*)["']/g)) {
  for (const call of attribute[1].matchAll(/(?<![.\w])([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)) {
    const name = call[1];
    if (inlineHandlerBuiltins.has(name)) continue;
    assert(
      new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(|(?:const|let|var)\\s+${name}\\s*=`).test(panelSources),
      `inline UI handler is not defined: ${name} in ${attribute[0]}`,
    );
  }
}

for (const [tab, contract] of Object.entries(surfaces)) {
  const source = read(contract.source);
  const siblingContracts = Object.values(surfaces).filter(candidate => candidate.source === contract.source);
  if (source.includes("<table")) assert(siblingContracts.some(candidate => candidate.viewKinds.includes("table")), `${contract.source} renders a table without table coverage`);
  if (/(?:class=["'][^"']*card|<article)/.test(source)) assert(siblingContracts.some(candidate => candidate.viewKinds.includes("card")), `${contract.source} renders cards without card coverage`);
  for (const table of source.matchAll(/<table\b[\s\S]*?<\/table>/g)) {
    assert(table[0].includes("<thead"), `${tab} data table is missing an accessible header row: ${table[0].slice(0, 120)}`);
  }
}

const sortableSource = read("src/webview/components/sortable-data-table.js");
const interactionSource = read("src/webview/components/accessible-interactions.js");
assert.match(interactionSource, /nativeInteractiveTags\.has\(element\.tagName\)/);
assert.match(interactionSource, /if \(!element\.hasAttribute\("role"\)\) element\.setAttribute\("role", "button"\)/);
assert.match(interactionSource, /if \(!element\.hasAttribute\("tabindex"\)\) element\.tabIndex = 0/);
assert.match(interactionSource, /event\.target !== element \|\| \(event\.key !== "Enter" && event\.key !== " "\)/);
assert.match(interactionSource, /element\.click\(\)/);
assert.match(read("scripts/build-panel.js"), /accessible-interactions\.js/);
const interactionEnd = interactionSource.indexOf("\nfunction enhanceClickableElements");
const interactionContext = {};
vm.createContext(interactionContext);
vm.runInContext(`${interactionSource.slice(0, interactionEnd)};this.enhance=enhanceClickableElement`, interactionContext);
function fakeClickable(tagName = "DIV", onclick = "openItem()") {
  const attributes = new Map([["onclick", onclick]]);
  return {
    tagName,
    dataset: {},
    tabIndex: -1,
    clicked: 0,
    getAttribute: name => attributes.get(name) || null,
    hasAttribute: name => attributes.has(name),
    setAttribute: (name, value) => attributes.set(name, String(value)),
    addEventListener: (_type, listener) => { this.listener = listener; },
    click() { this.clicked += 1; },
    attributes,
  };
}
const clickable = fakeClickable();
clickable.addEventListener = (_type, listener) => { clickable.listener = listener; };
interactionContext.enhance(clickable);
assert.strictEqual(clickable.attributes.get("role"), "button");
assert.strictEqual(clickable.tabIndex, 0);
let prevented = false;
clickable.listener({ target: clickable, key: "Enter", preventDefault: () => { prevented = true; } });
assert.strictEqual(clickable.clicked, 1);
assert.strictEqual(prevented, true);
clickable.listener({ target: {}, key: " ", preventDefault: () => {} });
assert.strictEqual(clickable.clicked, 1, "nested controls must not activate their clickable ancestor");
const nativeButton = fakeClickable("BUTTON");
nativeButton.addEventListener = () => { throw new Error("native button must not be enhanced"); };
interactionContext.enhance(nativeButton);
assert.strictEqual(nativeButton.attributes.has("role"), false);
const propagationOnly = fakeClickable("DIV", "event.stopPropagation()");
propagationOnly.addEventListener = () => { throw new Error("event-only containers must not be enhanced"); };
interactionContext.enhance(propagationOnly);
assert.strictEqual(propagationOnly.attributes.has("role"), false);
assert.match(sortableSource, /direction === "ascending" \? "descending"[\s\S]*direction === "descending" \? "none" : "ascending"/);
assert.match(sortableSource, /header\.tabIndex = 0/);
assert.match(sortableSource, /header\.setAttribute\("aria-sort", "none"\)/);
assert.match(sortableSource, /event\.key !== "Enter" && event\.key !== " "/);
assert.match(sortableSource, /Number\(left\.dataset\.canonicalOrder\) - Number\(right\.dataset\.canonicalOrder\)/);
assert.match(read("scripts/build-panel.js"), /sortable-data-table\.js/);
const sortContext = {};
vm.createContext(sortContext);
const pureSortStart = sortableSource.indexOf("function nextTableSortDirection");
const pureSortEnd = sortableSource.indexOf("\nfunction tableSortKey", pureSortStart);
vm.runInContext(`${sortableSource.slice(pureSortStart, pureSortEnd)};this.next=nextTableSortDirection;this.compare=compareTableValues`, sortContext);
assert.strictEqual(sortContext.next("none"), "ascending");
assert.strictEqual(sortContext.next("ascending"), "descending");
assert.strictEqual(sortContext.next("descending"), "none");
assert(sortContext.compare({ rank: 0, value: 2 }, { rank: 0, value: 10 }) < 0, "numeric table values must sort numerically");
assert(sortContext.compare({ rank: 2, value: "a" }, { rank: 2, value: "b" }) < 0, "text table values must sort lexically");
const applySortStart = sortableSource.indexOf("function applyTableSort");
const applySortEnd = sortableSource.indexOf("\nfunction enhanceSortableTable", applySortStart);
vm.runInContext(`${sortableSource.slice(applySortStart, applySortEnd)};this.apply=applyTableSort`, sortContext);
const rows = ["10", "2", "2"].map(text => ({ cells: [{ textContent: text, dataset: {} }], dataset: {} }));
const body = {
  rows,
  appendChild(row) {
    const index = this.rows.indexOf(row);
    if (index >= 0) this.rows.splice(index, 1);
    this.rows.push(row);
  },
};
const table = { tBodies: [body] };
sortContext.apply(table, 0, "ascending");
assert.deepStrictEqual(rows.map(row => row.cells[0].textContent), ["2", "2", "10"]);
assert.deepStrictEqual(rows.slice(0, 2).map(row => row.dataset.canonicalOrder), ["1", "2"], "equal values must keep canonical order");
sortContext.apply(table, 0, "descending");
assert.deepStrictEqual(rows.map(row => row.cells[0].textContent), ["10", "2", "2"]);
sortContext.apply(table, 0, "none");
assert.deepStrictEqual(rows.map(row => row.cells[0].textContent), ["10", "2", "2"], "clearing sort must restore canonical source order");

const literalAskCommands = new Set([...panelSources.matchAll(/\bask\(\s*['"]([^'"]+)['"]/g)].map(match => match[1]));
const extensionCases = new Set([...extension.matchAll(/case\s+["']([^"']+)["']\s*:/g)].map(match => match[1]));
const commandAliases = new Set(["toast", "openExternal"]);
for (const command of literalAskCommands) {
  assert(
    extensionCases.has(command) || commandAliases.has(command),
    `UI command has no extension handler: ${command}`,
  );
}

const actionTimeoutBlock = core.match(/const actionTimeouts = \{([\s\S]*?)\n\};/)?.[1] || "";
const timedActions = new Set([...actionTimeoutBlock.matchAll(/\b([A-Za-z][A-Za-z0-9]+)\s*:/g)].map(match => match[1]));
const finishActionBlock = core.slice(core.indexOf("function finishAction"), core.indexOf("function refreshActionTimeout"));
assert.doesNotMatch(finishActionBlock, /function refreshActionTimeout/, "progress timeout refresh must not be scoped inside finishAction");
assert.match(core, /function refreshActionTimeout\(command\)[\s\S]*clearTimeout\(entry\.timer\)[\s\S]*setTimeout\(\(\) => timeoutAction/);
assert.match(core, /command === 'subscriptionGitHubProgress'[\s\S]{0,180}refreshActionTimeout/,
  "GitHub subscription progress must extend the pending action timeout");
const refreshTimeoutStart = core.indexOf("function refreshActionTimeout");
const refreshTimeoutEnd = core.indexOf("\nfunction hasPendingActionPrefix", refreshTimeoutStart);
const timeoutEntry = { timer: 7 };
const timeoutCalls = [];
const timeoutContext = {
  actionTimeouts: { subscriptionMountGitHub: 150000 },
  pendingActionButtons: new Map([["subscriptionMountGitHub", [timeoutEntry]]]),
  clearTimeout: timer => timeoutCalls.push(["clear", timer]),
  setTimeout: (_callback, delay) => { timeoutCalls.push(["set", delay]); return 8; },
  timeoutAction: () => {},
};
vm.createContext(timeoutContext);
vm.runInContext(`${core.slice(refreshTimeoutStart, refreshTimeoutEnd)};this.refresh=refreshActionTimeout`, timeoutContext);
timeoutContext.refresh("subscriptionMountGitHub");
assert.deepStrictEqual(timeoutCalls, [["clear", 7], ["set", 150000]]);
assert.strictEqual(timeoutEntry.timer, 8);
for (const command of timedActions) {
  assert(extensionCases.has(command), `timed action has no extension handler: ${command}`);
  assert(panelSources.includes(command), `timed action is not reachable from the UI: ${command}`);
  assert(
    panelSources.split(command).length > 2,
    `timed action has no success/error completion contract: ${command}`,
  );
}

assert.match(core, /function showActionError\([\s\S]*role','alert'/, "button failures must use an accessible alert");
assert.match(core, /function showViewActionError\([\s\S]*role','alert'/, "view failures must use an accessible alert");
assert.match(core, /timed out\.[\s\S]*check PKM logs before retrying/, "long-running buttons need a truthful timeout fallback");
assert.match(panelSources, /function invalidateSubscriptionKnowledgeViews\(\)[\s\S]*cachedKnowledgeTabs\.forEach\(invalidateKnowledgeTabView\)/, "subscription refresh must invalidate every cached CatTree");

console.log(`UI surface contracts passed: ${Object.keys(surfaces).length} tabs, ${literalAskCommands.size} UI commands, ${timedActions.size} timed actions`);

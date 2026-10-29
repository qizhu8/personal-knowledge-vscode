#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { chromium } = require(process.env.PKM_PLAYWRIGHT_PATH || "playwright");
const extensionRoot = process.env.PKM_BACKGROUND_TEST_EXTENSION_ROOT || path.resolve(__dirname, "..");
const { parseProcessTable, describeBackgroundProcesses, assessBackgroundProcess, BackgroundProcessInventory } = require(path.join(extensionRoot, "dist/runtime/background-processes"));
const bundledPanel = fs.readFileSync(path.join(extensionRoot, "dist/webview/panel.js"), "utf8");
const fragmentStart = bundledPanel.indexOf("let backgroundTaskSnapshot = null;");
const fragmentEnd = bundledPanel.indexOf("// UI snapshots contain data only;", fragmentStart);
assert(fragmentStart >= 0 && fragmentEnd > fragmentStart, "packaged panel must contain the Background Tasks renderer");
const renderer = bundledPanel.slice(fragmentStart, fragmentEnd);

const rows = parseProcessTable(`
 123 1 6-08:01:02 102400 /usr/bin/python /tmp/pkm-startup-old/extension/resources/retrieval_worker.py --secret do-not-expose
 124 2 04:05 2048 /usr/bin/node /extensions/uone.personal-knowledge-3.2.85/dist/runtime/pkm-service-entry.js
 125 2 01:04:05 4096 /usr/bin/python "/home/user/knowledge root/mcp-server/server.py"
 126 1 00:10 1024 /usr/bin/python /other/server.py
 127 1 00:10 1024 /usr/bin/python -c 'print("/tmp/pkm-startup-old/extension/resources/retrieval_worker.py")'
 128 1 00:10 1024 /bin/bash /tmp/pkm-startup-old/extension/resources/retrieval_worker.py
`);
assert.equal(rows.length, 6);
assert.equal(rows[0].elapsedSeconds, 6 * 86400 + 8 * 3600 + 62);
assert.equal(rows[1].elapsedSeconds, 245);
assert.equal(rows[2].elapsedSeconds, 3845);
const processes = describeBackgroundProcesses(rows, file => {
  if (file.includes("pkm-startup")) throw Object.assign(new Error("missing"), { code: "ENOENT" });
  return {};
});
assert.equal(processes.length, 3);
assert.equal(processes[0].pid, 123);
assert.equal(processes[0].entryExists, false);
assert.equal(processes[0].fixture, true);
assert.equal(processes[0].rssBytes, 104857600);
assert.equal(processes.find(p => p.pid === 124).pathVersion, "3.2.85");
assert.equal(processes.find(p => p.pid === 125).kind, "mcp");
assert.doesNotMatch(JSON.stringify(processes), /do-not-expose|command/);
assert.throws(() => describeBackgroundProcesses(rows, () => {
  throw Object.assign(new Error("denied"), { code: "EACCES" });
}), /Cannot inspect PKM process 123 entry \(EACCES\)/);
const windows = describeBackgroundProcesses([{
  pid: 200, parentPid: 1, elapsedSeconds: 15, rssBytes: 3000,
  command: '"C:\\Program Files\\Python\\python.exe" "C:\\Knowledge Root\\mcp-server\\server.py"',
}], () => ({}));
assert.equal(windows.length, 1);
assert.equal(windows[0].entryPath, "C:\\Knowledge Root\\mcp-server\\server.py");
assert.equal(windows[0].kind, "mcp");

const observedAt = Date.parse("2026-10-22T18:40:00Z");
const installedExtension = { version: "3.2.89", buildId: "a".repeat(64), builtAt: new Date(observedAt).toISOString() };
const record = {
  pid: 125, heartbeatFresh: true, heartbeatAt: (observedAt - 500) / 1000,
  extensionVersion: "3.2.87", version: "2.18.0", generation: "generation-a",
  phase: "accepting", inFlight: 2, uncertainCalls: 1, runtimeBuild: "b".repeat(64),
  credentials: "must-not-expose",
};
const report = instances => ({ configuredGeneration: "generation-a", instances });
const enriched = describeBackgroundProcesses([...rows, {
  pid: 2, parentPid: 1, elapsedSeconds: 7200, rssBytes: 999, command: "/bin/copilot-runtime --token must-not-expose",
}], () => ({}), { installedVersion: installedExtension.version, now: observedAt, mcpStatus: () => report([record]) });
const olderMcp = enriched.find(p => p.pid === 125);
assert.equal(olderMcp.parentName, "copilot-runtime");
assert.equal(olderMcp.parentObserved, true);
assert.equal(olderMcp.startedAt, new Date(observedAt - 3845000).toISOString());
assert.deepEqual(olderMcp.assessment, { state: "older", basis: "runtime-report" });
assert.equal(olderMcp.runtime.inFlight, 2);
assert.equal(olderMcp.runtime.uncertainCalls, 1);
assert.equal(olderMcp.runtime.serverVersion, "2.18.0");
assert.doesNotMatch(JSON.stringify(enriched), /must-not-expose|credentials|command/);
const stale = describeBackgroundProcesses(rows, () => ({}), {
  installedVersion: installedExtension.version, now: observedAt,
  mcpStatus: () => report([{ ...record, heartbeatFresh: false }]),
}).find(p => p.pid === 125);
assert.deepEqual(stale.assessment, { state: "unverified", basis: "unknown" }, "stale reports are not evidence of a current loaded version");
const ambiguous = describeBackgroundProcesses(rows, () => ({}), {
  installedVersion: installedExtension.version, now: observedAt, mcpStatus: () => report([record, record]),
}).find(p => p.pid === 125);
assert.match(ambiguous.runtimeError, /ownership is ambiguous/);
assert.equal(ambiguous.runtime, undefined);
const currentMcp = { ...olderMcp, pid: 128, runtime: { ...olderMcp.runtime, extensionVersion: installedExtension.version } };
currentMcp.assessment = assessBackgroundProcess(currentMcp, installedExtension.version);
assert.equal(currentMcp.assessment.state, "current");
const superseded = { ...currentMcp, pid: 129, runtime: { ...currentMcp.runtime, generation: "generation-old" } };
superseded.assessment = assessBackgroundProcess(superseded, installedExtension.version);
assert.equal(superseded.assessment.state, "superseded", "matching extension version must not hide an old generation");
assert.deepEqual(assessBackgroundProcess({ ...currentMcp, runtime: { ...currentMcp.runtime, fresh: false }, pathVersion: "3.2.85" }, installedExtension.version),
  { state: "older", basis: "entry-path" });
assert.deepEqual(assessBackgroundProcess({ ...currentMcp, runtime: undefined, pathVersion: installedExtension.version }, installedExtension.version),
  { state: "unverified", basis: "entry-path" }, "a matching entry path is not a loaded-runtime handshake");
assert.equal(assessBackgroundProcess({ ...currentMcp, elapsedSeconds: 86400000 }, installedExtension.version).state, "current", "age alone is not staleness");
assert.equal(assessBackgroundProcess(currentMcp).state, "unverified", "missing installed baseline cannot establish currentness");

(async () => {
  const inventory = new BackgroundProcessInventory();
  const [first, concurrent] = await Promise.all([inventory.snapshot(), inventory.snapshot()]);
  assert.strictEqual(first, concurrent, "parallel panels must share one scan");
  assert.strictEqual(first, await inventory.snapshot(), "repeated requests must use the bounded cache");
  assert(Array.isArray(first.processes));
  assert(!first.error);
  const withBaseline = await inventory.snapshot(installedExtension);
  assert.equal(withBaseline.installedExtension.version, installedExtension.version);
  assert.notStrictEqual(first, withBaseline, "a new installed baseline invalidates the bounded cache");
  console.log(`background process parser and real ${first.platform} inventory passed (${first.processes.length} recognized processes)`);
  const browser = await chromium.launch({ headless: true,
    ...(process.env.PKM_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PKM_CHROMIUM_EXECUTABLE } : {}) });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setContent('<main id="detail"></main>');
    await page.addStyleTag({ path: path.join(extensionRoot, "dist/webview/panel.css") });
    await page.evaluate(() => {
      window.state = { tab: "backgroundTasks" };
      window.esc = value => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
      window.__asks = [];
      window.ask = (...args) => window.__asks.push(args);
    });
    await page.addScriptTag({ content: renderer });
    await page.evaluate(snapshot => {
      backgroundTasksOnSnapshot({ tasks: [] });
      backgroundProcessesOnSnapshot(snapshot);
    }, { ...first, installedExtension, loadedExtension: { ...installedExtension, version: "3.2.87" }, processes: [{
      ...processes[0], entryPath: `/tmp/pkm-startup-old/${"long-path-".repeat(40)}/<img src=x onerror=alert(1)>.py`,
    }, olderMcp, currentMcp, superseded, { ...stale, pid: 130 }, { ...ambiguous, pid: 131 }, {
      ...enriched.find(p => p.pid === 124),
    }] });
    assert.equal(await page.locator('details.background-process-group').count(), 3);
    assert.equal(await page.locator('details.background-process-group[open]').count(), 0, "categories start collapsed");
    assert.equal(await page.locator('.background-process-info[open]').count(), 0, "snapshot explanations start collapsed");
    assert.equal(await page.getByText("Scope", { exact: true }).isVisible(), false);
    assert.match(await page.locator('.background-process-overview').textContent(), /7 processes/);
    const mcpGroup = page.locator('[data-process-group="mcp"]');
    const retrievalGroup = page.locator('[data-process-group="retrieval"]');
    const serviceGroup = page.locator('[data-process-group="service"]');
    for (const [group, total, latest, old, leftovers, unknown] of [[mcpGroup, 5, 1, 2, 0, 2], [retrievalGroup, 1, 0, 0, 1, 0], [serviceGroup, 1, 0, 1, 0, 0]]) {
      const header = await group.locator(':scope > summary').textContent();
      for (const expected of [`${total} PIDs`, `${latest} latest (reported)`, `${old} old`, `${leftovers} suspected leftovers`, `${unknown} other / unverified`]) assert(header.includes(expected), header);
      assert(!header.includes("cleanup review"), "internal review terminology must not appear in category counts");
      assert.equal(await group.locator('article').count(), total);
    }
    await mcpGroup.locator(':scope > summary').focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.getElementById('background-process-group-mcp').open);
    await retrievalGroup.locator(':scope > summary').click();
    await serviceGroup.locator(':scope > summary').click();
    assert.equal(await mcpGroup.getByText("Details", { exact: true }).count(), 5);
    assert.equal(await page.getByRole("alert").isVisible(), true, "runtime evidence errors must not be hidden in collapsed per-PID details");
    for (const summary of await mcpGroup.locator('.background-process-entry > summary').all()) await summary.click();
    assert.match(await page.getByRole("alert").textContent(), /runtime ownership is ambiguous/);
    assert.equal(await page.getByText("Stale report · not used as current runtime evidence", { exact: true }).count(), 1);
    assert.equal(await page.getByText("Old · Older entry path · runtime unknown", { exact: true }).count(), 1);
    const warning = serviceGroup.locator('.older .background-task-status');
    assert.equal(await warning.evaluate(element => getComputedStyle(element).color), 'rgb(204, 167, 0)', "old PID has a yellow warning label");
    const olderText = await mcpGroup.textContent();
    for (const expected of ["copilot-runtime", "In flight: 2", "Uncertain calls: 1"]) assert(olderText.includes(expected), expected);
    await retrievalGroup.locator('.background-process-entry summary').click();
    for (const width of [320, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.getByText("Test leftover · entry deleted", { exact: true }).count(), 1);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        `process entry must not overflow at ${width}px`);
      assert.equal(await page.locator("img").count(), 0);
    }
    const refresh = page.getByRole("button", { name: "Refresh", exact: true });
    await refresh.click();
    assert(await page.getByRole("button", { name: "Refreshing…" }).isDisabled());
    assert.equal(await page.evaluate(() => window.__asks[0][0]), "backgroundProcesses");
    await page.evaluate(() => backgroundTasksOnSnapshot({ tasks: [] }));
    assert.equal(await page.locator('details.background-process-group[open]').count(), 3, "task refresh preserves category expansion");
    await mcpGroup.locator(':scope > summary').click();
    await page.waitForFunction(() => !document.getElementById('background-process-group-mcp').open);
    await page.evaluate(() => backgroundProcessesOnSnapshot(backgroundProcessSnapshot));
    assert.equal(await mcpGroup.getAttribute('open'), null, "process refresh preserves a collapsed category");
    assert.equal(await page.locator('details.background-process-group[open]').count(), 2);
    await page.evaluate(() => backgroundProcessesOnSnapshot({ processes: [] }));
    assert.equal(await page.locator('details.background-process-group').count(), 3, "zero-count categories remain visible");
    for (const summary of await page.locator('details.background-process-group > summary').allTextContents()) assert(summary.includes('0 PIDs'));
    await page.evaluate(() => backgroundProcessesOnSnapshot({ error: "Inventory unavailable", processes: [] }));
    assert.equal(await page.getByRole("alert").textContent(), "Inventory unavailable");
    assert(await refresh.isEnabled());
    assert.equal(await page.getByText("No recognized PKM background processes found.", { exact: true }).count(), 0);
    assert.deepEqual(errors, []);
    console.log("Background Processes Chromium widths, refresh, safe paths and explicit errors passed");
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

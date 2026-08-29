#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const { initServers, serverList, serverCreate, serverUpdate, serverGroupList, serverCreateGroup, serverMoveGroup, serverListenerProcesses, forceStopExternalServer, startServer, disposeServers, rewriteProxyHtml, serverNetworkAddresses } = require("../dist/servers.js");

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function main() {
  const addresses = serverNetworkAddresses({
    lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    docker0: [{ address: "172.17.0.1", family: "IPv4", internal: false }],
    ethernet: [{ address: "10.0.0.8", family: "IPv4", internal: false }],
    duplicate: [{ address: "10.0.0.8", family: "IPv4", internal: false }],
  });
  assert.deepStrictEqual(addresses, [
    { interface: "ethernet", address: "10.0.0.8" },
    { interface: "docker0", address: "172.17.0.1" },
  ]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-server-proxy-"));
  const serversDir = path.join(root, "servers");
  const stateDir = path.join(root, "state");
  const slug = "demo-server";
  fs.mkdirSync(path.join(serversDir, slug), { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  const upstream = http.createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end('<!doctype html><head><title>Demo</title></head><body><script src="/app.js"></script></body>');
  });
  const upstreamPort = await listen(upstream);
  fs.writeFileSync(path.join(serversDir, slug, "server.json"), JSON.stringify({
    name: "Demo Server", command: "demo", port: upstreamPort, python: "", autostart: false,
    category: "Research/Vision", pinned: true, tags: ["visualization", " gpu ", "visualization"],
  }));
  const duplicateSlug = "duplicate-port";
  fs.mkdirSync(path.join(serversDir, duplicateSlug), { recursive: true });
  fs.writeFileSync(path.join(serversDir, duplicateSlug, "server.json"), JSON.stringify({
    name: "Duplicate Port", command: "demo", port: upstreamPort,
  }));
  fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify({
    [slug]: { pid: process.pid, port: upstreamPort, startedAt: new Date().toISOString(), logFile: path.join(stateDir, "demo.log"), command: "demo" },
  }));

  const proxyProbe = http.createServer();
  const proxyPort = await listen(proxyProbe);
  await new Promise(resolve => proxyProbe.close(resolve));
  initServers(serversDir, stateDir, proxyPort);
  await new Promise(resolve => setTimeout(resolve, 100));

  const response = await fetch(`http://127.0.0.1:${proxyPort}/s/${slug}/`);
  const html = await response.text();
  assert.strictEqual(response.status, 200);
  assert.match(html, new RegExp(`<base href="/s/${slug}/">`));
  assert.match(html, new RegExp(`src="/s/${slug}/app.js"`));

  const twice = rewriteProxyHtml(rewriteProxyHtml('<head><base href="/s/demo-server/"></head><a href="/s/demo-server/row">row</a>', slug), slug);
  assert.strictEqual((twice.match(/<base\b/g) || []).length, 1, "proxy rewrite must keep exactly one base tag");
  assert.doesNotMatch(twice, /\/s\/demo-server\/s\/demo-server\//, "proxy rewrite must not duplicate an existing stable prefix");

  const rows = await serverList();
  assert.strictEqual(rows[0].proxyRunning, true);
  assert.strictEqual(rows[0].stableUrl, `http://localhost:${proxyPort}/s/${slug}/`);
  assert.ok(Array.isArray(rows[0].networkLinks));
  assert.ok(rows[0].networkLinks.every(link => link.url.endsWith(`:${upstreamPort}/`)));
  assert.strictEqual(rows[0].category, "Research/Vision");
  assert.strictEqual(rows[0].pinned, true);
  assert.deepStrictEqual(rows[0].tags, ["visualization", "gpu"]);
  assert.notStrictEqual(rows.find(server => server.slug === duplicateSlug).port, upstreamPort, "startup must repair duplicate configured ports");
  fs.rmSync(path.join(serversDir, duplicateSlug), { recursive: true, force: true });
  assert.strictEqual(serverUpdate(slug, { category: " Research / Models / ", pinned: false, tags: ["model", " a100 "] }), true);
  const updatedRows = await serverList();
  assert.strictEqual(updatedRows[0].category, "Research/Models");
  assert.strictEqual(updatedRows[0].pinned, false);
  assert.deepStrictEqual(updatedRows[0].tags, ["model", "a100"]);
  const nestedSlug = "nested-server";
  fs.mkdirSync(path.join(serversDir, nestedSlug), { recursive: true });
  fs.writeFileSync(path.join(serversDir, nestedSlug, "server.json"), JSON.stringify({
    name: "Nested Server", command: "demo", port: upstreamPort + 1, category: "Research/Models/Deep",
  }));
  assert.deepStrictEqual(serverMoveGroup("Research", "ML"), { ok: true, count: 2 });
  assert.deepStrictEqual(Object.fromEntries((await serverList()).map(server => [server.slug, server.category])), {
    [slug]: "ML/Models", [nestedSlug]: "ML/Models/Deep",
  });
  assert.deepStrictEqual(serverMoveGroup("ML", "ML/Models"), { ok: false, count: 0, error: "group cannot be moved into itself" });
  assert.deepStrictEqual(serverMoveGroup("ML", ""), { ok: true, count: 2 });
  assert.deepStrictEqual(Object.fromEntries((await serverList()).map(server => [server.slug, server.category])), {
    [slug]: "Models", [nestedSlug]: "Models/Deep",
  });
  assert.strictEqual(serverUpdate(slug, { category: " hidden / archived " }), true);
  assert.strictEqual((await serverList()).find(server => server.slug === slug).category, "Hidden/archived");
  assert.deepStrictEqual(serverCreateGroup("Research/Empty"), { ok: true, group: "Research/Empty" });
  assert.ok(serverGroupList().includes("Research/Empty"), "empty groups must be persisted");
  assert.deepStrictEqual(serverMoveGroup("Research/Empty", "Research/Renamed"), { ok: true, count: 0 });
  assert.ok(serverGroupList().includes("Research/Renamed"), "empty groups must be renameable");

  const firstCreated = serverCreate("Port Alpha");
  const secondCreated = serverCreate("Port Beta");
  assert.ok(firstCreated.ok && secondCreated.ok);
  assert.notStrictEqual(firstCreated.port, secondCreated.port, "new Servers must reserve unique ports");
  assert.strictEqual(serverUpdate(secondCreated.slug, { port: firstCreated.port }), false, "duplicate configured ports must be rejected");

  const external = http.createServer((_request, response) => response.end("external"));
  const externalPort = await listen(external);
  const externalSlug = "external-listener";
  fs.mkdirSync(path.join(serversDir, externalSlug), { recursive: true });
  fs.writeFileSync(path.join(serversDir, externalSlug, "server.json"), JSON.stringify({
    name: "External Listener", command: "demo", port: externalPort,
  }));
  const externalRow = (await serverList()).find(server => server.slug === externalSlug);
  assert.strictEqual(externalRow.status, "external");
  assert.match(startServer(externalSlug).error, /external listener/);
  await new Promise(resolve => external.close(resolve));

  const forceProbe = http.createServer();
  const forcePort = await listen(forceProbe);
  await new Promise(resolve => forceProbe.close(resolve));
  const forceSlug = "force-stop-listener";
  fs.mkdirSync(path.join(serversDir, forceSlug), { recursive: true });
  fs.writeFileSync(path.join(serversDir, forceSlug, "server.json"), JSON.stringify({ name: "Force Stop Listener", command: "demo", port: forcePort }));
  const child = spawn(process.execPath, ["-e", `require('http').createServer((q,s)=>s.end('child')).listen(${forcePort},'127.0.0.1',()=>console.log('ready'))`], { stdio: ["ignore", "pipe", "ignore"] });
  try {
    await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("child listener timeout")), 3000); child.stdout.once("data", () => { clearTimeout(timer); resolve(); }); });
    const listeners = serverListenerProcesses(forcePort);
    assert.ok(listeners.some(listener => listener.pid === child.pid), "listener PID must be identified");
    assert.match((await forceStopExternalServer(forceSlug, [child.pid + 1])).error, /listener process changed/, "stale PID confirmation must not terminate anything");
    assert.strictEqual(child.exitCode, null, "listener must survive a stale PID request");
    assert.deepStrictEqual(await forceStopExternalServer(forceSlug, [child.pid]), { ok: true, pids: [child.pid] });
    if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => child.once("exit", resolve));
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }

  const guide = fs.readFileSync(path.join(serversDir, slug, "PKM_SERVER_PROXY.md"), "utf8");
  assert.match(guide, /Stable Link/);
  assert.match(guide, /one shared selected address/);
  assert.match(guide, /Server Link/);
  assert.match(guide, /WebSockets, and SSE/);

  const panel = fs.readFileSync(path.join(__dirname, "..", "dist", "webview", "panel.js"), "utf8");
  const panelCss = fs.readFileSync(path.join(__dirname, "..", "dist", "webview", "panel.css"), "utf8");
  assert.match(panel, /class="srv-actions"/);
  assert.match(panel, /class="srv-lifecycle-actions"/);
  assert.match(panel, /class="srv-management-actions"/);
  assert.match(panel, />📂 Folder<\/button>/);
  assert.match(panel, />⚙ Settings<\/button>/);
  assert.match(panel, /class="tbtn srv-danger"/);
  assert.match(panel, />🗑 Delete<\/button>/);
  assert.doesNotMatch(panel, />🌐<\/button>/);
  assert.match(panel, /title="Edit server settings: command, port, and Python"/);
  assert.match(panel, /id="srv-out-\$\{esc\(s\.slug\)\}"/);
  assert.match(panel, /function closeServerOutput/);
  assert.match(panel, /title="Close log panel"/);
  assert.match(panel, /<strong>Stable Link<\/strong>/);
  assert.match(panel, /class="srv-url-link"[^>]*onclick="openServerLink/);
  assert.match(panel, /class="srv-summary-link" role="link" tabindex="0"/);
  assert.match(panel, /<details class="srv-link-block srv-local-link">/);
  assert.match(panel, /<summary[^>]*>Server Local Link/);
  assert.doesNotMatch(panel, /<details class="srv-link-block srv-local-link" open/);
  assert.match(panel, />Open<\/button><button[^>]*>Copy<\/button>/);
  assert.match(panel, /class="srv-global-controls"/);
  assert.match(panel, /title="Select the network interface\/IP for every Stable Link"/);
  assert.strictEqual((panel.match(/onchange="serverNetworkChanged\(this\.value\)"/g) || []).length, 1);
  assert.doesNotMatch(panel, /pkm-server-network-/);
  assert.match(panel, /class="tbtn srv-forward-toggle \$\{autoForward \? 'active' : ''\}" aria-pressed="\$\{autoForward\}"/);
  assert.match(panel, /Port Forward/);
  assert.match(panel, /function serverForwardChanged\(enabled\)/);
  assert.doesNotMatch(panel, /serverForwardChanged\(slug/);
  assert.match(panel, /requiresForward: kind === 'local'/);
  assert.match(panel, /id="srv-out-\$\{esc\(s\.slug\)\}"/);
  assert.match(panel, /function serverOutput/);
  assert.match(panel, /function closeServerOutput/);
  assert.match(panel, /title="Close log panel"/);
  assert.match(panel, /title="Refresh this log output"/);
  assert.match(panel, /Display name <input id="se-name-/);
  assert.match(panel, /class="srv-port-registry"/);
  assert.match(panel, /Next free:/);
  assert.match(panel, /function useSuggestedServerPort\(slug, port\)/);
  assert.match(panel, /External listener detected ·/);
  assert.match(panel, /■ Force Stop/);
  assert.match(panel, /serverForceStopExternal/);
  assert.match(panel, /name: document\.getElementById\('se-name-' \+ slug\)\.value/);
  assert.doesNotMatch(panel, /id="srv-out"/);
  assert.match(panelCss, /justify-content:space-between/);
  assert.match(panelCss, /\.srv-link-actions\{display:flex;flex-direction:column/);
  assert.match(panelCss, /\.srv-danger\{color:#f87171/);

  disposeServers();
  await new Promise(resolve => upstream.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
  console.log("server proxy test: startup listener, prefix rewrite, health, and Agent guide OK");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
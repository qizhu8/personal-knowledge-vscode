#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const { initServers, serverList, disposeServers, rewriteProxyHtml, serverNetworkAddresses } = require("../dist/servers.js");

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

  const guide = fs.readFileSync(path.join(serversDir, slug, "PKM_SERVER_PROXY.md"), "utf8");
  assert.match(guide, /Stable Link/);
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
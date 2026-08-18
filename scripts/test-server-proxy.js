#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const { initServers, serverList, disposeServers, rewriteProxyHtml } = require("../dist/servers.js");

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function main() {
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

  const guide = fs.readFileSync(path.join(serversDir, slug, "PKM_SERVER_PROXY.md"), "utf8");
  assert.match(guide, /Stable URL/);
  assert.match(guide, /WebSocket\/SSE/);
  assert.match(guide, new RegExp(`/s/${slug}/`));

  disposeServers();
  await new Promise(resolve => upstream.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
  console.log("server proxy test: startup listener, prefix rewrite, health, and Agent guide OK");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
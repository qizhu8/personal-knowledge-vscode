#!/usr/bin/env node
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");

const root = path.join(__dirname, "..");
const port = 4179;
const origin = `http://127.0.0.1:${port}`;
const startedAt = Date.now();
let serverReadyAt = 0;
let phase = "starting preview server";
const heartbeat = setInterval(() => {
  const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
  console.log(`[recipe-browser-ui] running · ${phase} · ${elapsedSeconds}s elapsed`);
}, 15_000);
heartbeat.unref();
console.log(`[recipe-browser-ui] phase=${phase}`);
const server = spawn(process.execPath, [path.join(__dirname, "release-preview-server.js")], {
  cwd: root,
  env: { ...process.env, PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"]
});

let serverOutput = "";
server.stdout.on("data", chunk => { serverOutput += chunk; });
server.stderr.on("data", chunk => { serverOutput += chunk; });

function waitForServer(attempt = 0) {
  return new Promise((resolve, reject) => {
    const request = http.get(`${origin}/projects`, response => {
      response.resume();
      if (response.statusCode === 200) resolve();
      else if (attempt < 100) setTimeout(() => waitForServer(attempt + 1).then(resolve, reject), 50);
      else reject(new Error(`Preview returned ${response.statusCode}.\n${serverOutput}`));
    });
    request.on("error", error => {
      if (attempt < 100) setTimeout(() => waitForServer(attempt + 1).then(resolve, reject), 50);
      else reject(new Error(`Preview did not start: ${error.message}\n${serverOutput}`));
    });
  });
}

function runTest() {
  phase = "running Chromium scenarios";
  console.log(`[recipe-browser-ui] phase=${phase}`);
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.PYTHON || "python", ["tests/test-recipe-browser-ui.py"], {
      cwd: root,
      env: { ...process.env, PKM_PREVIEW_URL: origin },
      stdio: "inherit"
    });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve() : reject(new Error(`Recipe browser UI test exited with ${code}.`)));
  });
}

(async () => {
  try {
    await waitForServer();
    serverReadyAt = Date.now();
    console.log("[recipe-browser-ui] preview server ready");
    await runTest();
    const summary = {
      schema: "pkm.browser-suite-timing/v1",
      suite: "recipe-panel",
      previewStartupMs: serverReadyAt - startedAt,
      chromiumScenariosMs: Date.now() - serverReadyAt,
      durationMs: Date.now() - startedAt,
    };
    console.log(`[recipe-browser-ui] completed · ${Math.round(summary.durationMs / 1000)}s elapsed`);
    console.log(`[recipe-browser-ui] summary-json=${JSON.stringify(summary)}`);
  } finally {
    clearInterval(heartbeat);
    if (server.exitCode === null) server.kill("SIGTERM");
  }
})().catch(error => {
  clearInterval(heartbeat);
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const root = path.resolve(__dirname, "..");
const taskCatalog = {
  plan: {
    command: process.execPath,
    args: ["tests/test-browser-test-plan.js"],
    budgetMs: 10_000,
  },
  contract: {
    command: process.execPath,
    args: ["tests/test-recipe-browser-editor.js"],
    budgetMs: 20_000,
  },
  standalone: {
    command: process.env.PYTHON || "python",
    args: ["tests/test-recipe-standalone-browser-ui.py"],
    budgetMs: 30_000,
  },
  panel: {
    command: process.execPath,
    args: ["scripts/run-recipe-browser-ui-test.js"],
    budgetMs: 30_000,
  },
  startup: {
    command: process.execPath,
    args: ["scripts/run-extension-startup-test.js"],
    budgetMs: 90_000,
  },
};

const plans = {
  smoke: ["panel", "startup"],
  full: ["plan", "contract", "standalone", "panel", "startup"],
};

function parsePositiveInteger(value, fallback, label) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function selectTasks(mode, env = process.env) {
  let names;
  if (mode === "targeted") {
    names = String(env.PKM_BROWSER_SUITES || "")
      .split(",")
      .map(value => value.trim())
      .filter(Boolean);
    if (!names.length) {
      throw new Error(`PKM_BROWSER_SUITES is required for the targeted plan. Available suites: ${Object.keys(taskCatalog).join(", ")}`);
    }
  } else {
    names = plans[mode];
    if (!names) throw new Error(`Unknown browser test plan "${mode}". Use smoke, targeted, or full.`);
  }

  const unknown = names.filter(name => !taskCatalog[name]);
  if (unknown.length) throw new Error(`Unknown browser suites: ${unknown.join(", ")}`);

  const shardCount = parsePositiveInteger(env.PKM_BROWSER_SHARD_COUNT, 1, "PKM_BROWSER_SHARD_COUNT");
  const shardIndex = parsePositiveInteger(env.PKM_BROWSER_SHARD_INDEX, 1, "PKM_BROWSER_SHARD_INDEX");
  if (shardIndex > shardCount) throw new Error("PKM_BROWSER_SHARD_INDEX cannot exceed PKM_BROWSER_SHARD_COUNT");

  return [...new Set(names)]
    .filter((_name, index) => index % shardCount === shardIndex - 1)
    .map(name => ({
      name,
      ...taskCatalog[name],
      env: name === "startup" && mode === "smoke"
        ? { PKM_STARTUP_ONLY: "clean-install" }
        : {},
    }));
}

function writePrefixed(stream, name, chunk) {
  const text = chunk.toString();
  for (const line of text.split(/\r?\n/)) {
    if (line) stream.write(`[browser:${name}] ${line}\n`);
  }
}

function runTask(task, env = process.env) {
  const startedAt = Date.now();
  console.log(`[browser-plan] suite=${task.name} started budget=${task.budgetMs}ms`);
  return new Promise(resolve => {
    const child = spawn(task.command, task.args, {
      cwd: root,
      env: { ...env, ...task.env },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", chunk => writePrefixed(process.stdout, task.name, chunk));
    child.stderr.on("data", chunk => writePrefixed(process.stderr, task.name, chunk));
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      console.error(`[browser-plan] suite=${task.name} exceeded budget=${task.budgetMs}ms; terminating pid=${child.pid}`);
      terminateChild(child, "SIGTERM");
      const force = setTimeout(() => {
        if (child.exitCode === null) terminateChild(child, "SIGKILL");
      }, 5_000);
      force.unref();
    }, task.budgetMs);
    timeout.unref();
    child.on("error", error => {
      clearTimeout(timeout);
      resolve({ name: task.name, durationMs: Date.now() - startedAt, status: "failed", error: error.message });
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timeout);
      const durationMs = Date.now() - startedAt;
      const status = code === 0 && !timedOut ? "passed" : timedOut ? "timed-out" : "failed";
      console.log(`[browser-plan] suite=${task.name} ${status} duration=${durationMs}ms`);
      resolve({ name: task.name, durationMs, status, code, signal });
    });
  });
}

function terminateChild(child, signal) {
  if (!child.pid || child.exitCode !== null) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function runWithConcurrency(tasks, concurrency, env = process.env) {
  const pending = [...tasks];
  const results = [];
  async function worker() {
    while (pending.length) {
      const task = pending.shift();
      if (task) results.push(await runTask(task, env));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
  return results;
}

async function main() {
  const mode = process.argv[2] || "smoke";
  const selected = selectTasks(mode);
  if (!selected.length) throw new Error("The selected browser-test shard contains no suites");
  if (process.env.PKM_BROWSER_DRY_RUN === "1") {
    console.log(JSON.stringify({ mode, suites: selected.map(task => task.name) }));
    return;
  }

  const startedAt = Date.now();
  const concurrency = parsePositiveInteger(process.env.PKM_BROWSER_CONCURRENCY, 2, "PKM_BROWSER_CONCURRENCY");
  let activeSummary = selected.map(task => task.name).join(", ");
  const heartbeat = setInterval(() => {
    console.log(`[browser-plan] running mode=${mode} suites=${activeSummary} elapsed=${Date.now() - startedAt}ms`);
  }, 15_000);
  heartbeat.unref();

  let results;
  try {
    results = await runWithConcurrency(selected, concurrency);
  } finally {
    clearInterval(heartbeat);
  }
  const sorted = [...results].sort((left, right) => right.durationMs - left.durationMs);
  activeSummary = "complete";
  const summary = {
    schema: "pkm.browser-test-summary/v1",
    mode,
    concurrency,
    durationMs: Date.now() - startedAt,
    results: sorted,
  };
  console.log(`[browser-plan] slowest ${sorted.map(result => `${result.name}=${result.durationMs}ms`).join(" · ")}`);
  console.log(`[browser-plan] summary-json=${JSON.stringify(summary)}`);
  if (process.env.PKM_BROWSER_SUMMARY) {
    const summaryPath = path.resolve(root, process.env.PKM_BROWSER_SUMMARY);
    fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
    fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  }
  if (results.some(result => result.status !== "passed")) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[browser-plan] failed: ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { plans, runWithConcurrency, selectTasks, taskCatalog };

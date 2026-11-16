"use strict";

const fs = require("node:fs");
const { runPlan } = require("./engine.cjs");
const { restoreWorkspace } = require("./workspace.cjs");

function notify(message) {
  fs.writeSync(Number(process.env.PKM_TEST_SUPERVISOR_FD), JSON.stringify(message) + "\n");
}

async function main() {
  const { plan, options, workspace } = JSON.parse(fs.readFileSync(0, "utf8"));
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    const result = await runPlan(plan, {
      ...options, runWorkspace: restoreWorkspace(workspace), signal: controller.signal,
      onEvent(event) {
        notify({ type: "event", event });
        console.log(JSON.stringify({ type: "event", event }));
      },
    });
    notify({ type: "complete", retain: Boolean(result.summary.retainedWorkspace) });
    console.log(JSON.stringify({ type: "result", summary: result.summary, report: result.report || null }));
    process.exitCode = result.summary.successful ? 0 : 1;
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
}

main().catch(error => { console.error(`Test worker failed: ${error.message}`); process.exitCode = 1; });

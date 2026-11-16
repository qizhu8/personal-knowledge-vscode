"use strict";

const { spawnSync } = require("node:child_process");

const steps = JSON.parse(process.env.PKM_TEST_STEPS || "null");
if (!Array.isArray(steps) || !steps.length || steps.some(step =>
  !Array.isArray(step) || !step.length || step.some(argument => typeof argument !== "string" || !argument.length))) {
  console.error("Invalid or empty test pipeline.");
  process.exitCode = 1;
} else {
  for (const [index, command] of steps.entries()) {
    console.log(`STEP ${index + 1}/${steps.length}: ${command[0]}`);
    const result = spawnSync(command[0], command.slice(1), { stdio: "inherit", env: process.env });
    if (result.error || result.status !== 0) {
      console.error(result.error?.message || `Pipeline step ${index + 1} exited ${result.status ?? result.signal}; remaining steps were not run.`);
      process.exitCode = result.status || 1;
      break;
    }
  }
}

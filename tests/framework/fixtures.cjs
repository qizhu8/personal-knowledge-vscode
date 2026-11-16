"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");

function fixtureRequirements(evidence) {
  return {
    qualificationInputs: [],
    compatBuild: Boolean(evidence.compatBuild || evidence.hostBuild),
    clientBuild: Boolean(evidence.clientBuild),
    hostBuild: Boolean(evidence.hostBuild),
    subscriptionRam: (evidence.environments || []).includes("PKM_SUBSCRIPTION_TEST_RAM_ROOT"),
  };
}

function preparationCommand(entries) {
  return [process.execPath, __filename, "--prepare",
    ...(entries.some(entry => entry.fixtures?.compatBuild) ? ["--compat"] : []),
    ...(entries.some(entry => entry.fixtures?.clientBuild) ? ["--client"] : []),
    ...(entries.some(entry => entry.fixtures?.hostBuild) ? ["--host"] : [])];
}

if (require.main === module) {
  if (!process.argv.includes("--prepare")) throw new Error("Use --prepare to build v5 source fixtures.");
  const root = path.resolve(__dirname, "../..");
  const host = process.argv.includes("--host");
  const commands = [["run", "build"],
    ...(process.argv.includes("--client") ? [["run", "typecheck:client"]] : []),
    ...(process.argv.includes("--compat") || host ? [["run", "build:compat"]] : []),
    ...(host ? [["--prefix", "clients/vscode-host", "run", "build"]] : [])];
  for (const args of commands) {
    const result = spawnSync("npm", args, { cwd: root, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`v5 source preparation failed: npm ${args.join(" ")} (${result.signal || result.status})`);
  }
}

module.exports = { fixtureRequirements, preparationCommand };

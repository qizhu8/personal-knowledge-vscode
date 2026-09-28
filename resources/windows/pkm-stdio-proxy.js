#!/usr/bin/env node
const { spawn } = require("child_process");

const [command, ...args] = process.argv.slice(2);
if (!command) {
  process.stderr.write("Usage: pkm-stdio-proxy.js <command> [args...]\n");
  process.exitCode = 2;
} else {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(command, args, {
    env,
    stdio: "inherit",
    windowsHide: true,
  });
  let failed = false;
  child.once("error", error => {
    failed = true;
    process.stderr.write(`PKM stdio proxy could not start the target process: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.once("exit", code => {
    if (!failed) process.exitCode = Number.isInteger(code) ? code : 1;
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      if (!child.killed) child.kill(signal);
    });
  }
}

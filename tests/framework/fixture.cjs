"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const [mode, observer] = process.argv.slice(2);
const scratch = path.join(process.cwd(), ".migration-test-work", "framework-fixture");
fs.mkdirSync(scratch, { recursive: true });
fs.writeFileSync(path.join(scratch, "created.txt"), "isolated");
fs.writeFileSync(path.join(process.cwd(), "tests", ".framework-fixture"), "isolated");
fs.writeFileSync(path.join(process.cwd(), "package.json"), "{}");
const locked = path.join(scratch, "permission-denied");
fs.mkdirSync(locked);
fs.writeFileSync(path.join(locked, "owned.txt"), "permission fixture");
fs.chmodSync(locked, 0);

if (mode === "failure") {
  process.stderr.write("\0".repeat(100000));
  process.exitCode = 7;
} else if (mode === "orphan" || mode === "timeout") {
  const worker = spawn(process.execPath, ["-e",
    `const fs=require('fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(observer)},'tick\\n'),20);`],
  { detached: true, stdio: "ignore" });
  worker.unref();
  setTimeout(() => { if (mode === "orphan") process.exit(0); }, 300);
  if (mode === "timeout") setInterval(() => {}, 1000);
} else if (mode !== "success") throw new Error(`Unknown fixture mode: ${mode}`);

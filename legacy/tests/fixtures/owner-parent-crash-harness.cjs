"use strict";
const { fork, spawn } = require("node:child_process");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const child = fork(path.join(__dirname, "owner-parent-session-child.mjs"), [], {
  env: { ...process.env, PKM_TEST_PARENT: String(process.pid) },
  stdio: ["ignore", "ignore", "ignore", "ipc"],
});
child.once("message", message => {
  const stat = readFileSync(`/proc/${child.pid}/stat`, "utf8");
  const start = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19];
  let holder;
  if (process.env.PKM_TEST_HOLD_IPC === "1") {
    holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"],
      { stdio: ["ignore", "ignore", "ignore", child.channel.fd] });
  }
  const holderStat = holder && readFileSync(`/proc/${holder.pid}/stat`, "utf8");
  const holderStart = holderStat && holderStat.slice(holderStat.lastIndexOf(")") + 2).trim().split(/\s+/)[19];
  process.send({ ...message, ownerPid: child.pid, ownerStart: start,
    ...(holder ? { holderPid: holder.pid, holderStart } : {}) });
});
child.once("exit", (code, signal) => {
  if (process.connected) process.send({ type: "owner-exit", code, signal });
});

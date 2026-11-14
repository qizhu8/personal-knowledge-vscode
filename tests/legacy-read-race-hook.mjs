import { createRequire, syncBuiltinESMExports } from "node:module";
import { isMainThread } from "node:worker_threads";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const fs = require("node:fs");
const originalReadFileSync = fs.readFileSync;
const originalWriteFileSync = fs.writeFileSync;
let paused = false;

fs.readFileSync = function (file, ...args) {
  const value = Reflect.apply(originalReadFileSync, this, [file, ...args]);
  const root = process.env.PKM_LEGACY_READ_RACE_ROOT;
  const target = process.env.PKM_LEGACY_READ_RACE_TARGET;
  const barrier = process.env.PKM_LEGACY_READ_RACE_BARRIER;
  if (!isMainThread && !paused && root && target && barrier &&
    fs.existsSync(resolve(barrier, "armed")) &&
    resolve(String(file)) === resolve(root, target)) {
    paused = true;
    originalWriteFileSync(resolve(barrier, "paused"), "paused", { flag: "wx" });
    const release = resolve(barrier, "release");
    const wait = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + 15_000;
    while (!fs.existsSync(release)) {
      if (Date.now() >= deadline) throw new Error("Legacy read race barrier was not released.");
      Atomics.wait(wait, 0, 0, 10);
    }
  }
  return value;
};

syncBuiltinESMExports();

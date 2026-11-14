"use strict";
const fs = require("node:fs"), path = require("node:path"), { execFileSync } = require("node:child_process");
module.exports = (root, home) => {
  const mapping = fs.readFileSync("/proc/self/uid_map", "utf8").trim().split(/\s+/);
  if (process.getuid() !== 0 || mapping.length !== 3 || mapping[0] !== "0" || mapping[2] !== "1")
    throw new Error("A private single-user mapped namespace is required before account fixture mounts.");
  // Conda treats namespace UID 0 as admin; its old env-list must not enumerate real account homes.
  const file = path.join(root, "fixture-passwd");
  fs.writeFileSync(file, `pkm-fixture:x:0:0:Private PKM qualification:${home}:/bin/sh\n`, { flag: "wx", mode: 0o600 });
  execFileSync("mount", ["--bind", file, "/etc/passwd"], { cwd: root, env: { PATH: "/usr/bin:/bin" } });
};

"use strict";
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");
module.exports = async function createOldConda({ root, vsix, executable, channel, old }) {
  fs.mkdirSync(root, { mode: 0o700 });
  for (const name of ["home", "bin", "envs", "cache", "registry", "uv-parent"])
    fs.mkdirSync(path.join(root, name), { mode: 0o700 });
  fs.symlinkSync(executable, path.join(root, "bin/conda"));
  if (!old) {
    const file = path.join(root, "exact-old-pyenvs.cjs");
    fs.writeFileSync(file, execFileSync("unzip", ["-p", vsix, "extension/dist/servers/pyenvs.js"]));
    old = require(file); old.initPyenvs(path.join(root, "registry"));
  }
  const config = path.join(root, "condarc");
  fs.writeFileSync(config, JSON.stringify({ offline: true, channels: [pathToFileURL(channel).href],
    default_channels: [], add_pip_as_python_dependency: false, auto_update_conda: false, always_copy: true }));
  const selected = { HOME: path.join(root, "home"), PATH: `${path.join(root, "bin")}:/usr/bin:/bin`, CONDARC: config,
    CONDA_PKGS_DIRS: path.join(root, "cache"), CONDA_ENVS_PATH: path.join(root, "envs"), CONDA_OFFLINE: "true",
    CONDA_NO_PLUGINS: "true", CONDA_SOLVER: "classic", CONDA_AUTO_UPDATE_CONDA: "false",
    PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1" };
  const saved = Object.fromEntries(Object.keys(selected).map(key => [key, process.env[key]]));
  Object.assign(process.env, selected);
  try {
    const created = await old.pyenvCreate({ manager: "conda", name: "legacy-conda", pythonVersion: "3.11",
      description: "Actual old offline conda create against private copied local channel" });
    assert(created.ok, JSON.stringify(created));
    assert.equal(created.env.path, path.join(root, "envs/legacy-conda"));
    assert.equal(execFileSync(created.env.python, ["-I", "-B", "-c", "import sys; print(sys.prefix)"],
      { env: selected, encoding: "utf8" }).trim(), created.env.path);
    const absentUv = await old.pyenvCreate({ manager: "uv", name: "unavailable-uv", parentDir: path.join(root, "uv-parent") });
    assert.equal(absentUv.ok, false); assert.match(absentUv.error, /ENOENT/);
    assert(!fs.existsSync(path.join(root, "uv-parent/unavailable-uv")));
    const evidence = { exactOldCreateFunction: true, actualOfflineCondaCreate: true,
      environment: created.env, unavailableUvExplicitlyFailed: true, sourceCachePassedToOldProcess: false,
      oldNameBasedCreatePreservedInsideSyntheticEnvsDirectory: true };
    fs.writeFileSync(path.join(root, "old-manager-create-evidence.json"), JSON.stringify(evidence, null, 2));
    return evidence;
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
};

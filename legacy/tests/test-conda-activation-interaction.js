const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), Module = require("node:module");
const { execFileSync } = require("node:child_process"), { randomUUID } = require("node:crypto");
const build = process.env.PKM_ENV_AUTHORITY_BUILD;
if (!build || !path.isAbsolute(build)) throw Error("Set absolute PKM_ENV_AUTHORITY_BUILD; fixture-only tests.");
const { LocalEnvironmentCatalog } = require(path.join(build, "runtime/local-environment-catalog.js"));
const lifecycle = require(path.join(build, "runtime/local-conda-lifecycle.js"));
const quote = value => `'${value.replace(/'/g, "'\\''")}'`;

function fixture(t) {
  const root = path.resolve("tests", `.conda-activation-${randomUUID()}`), storage = path.join(root, "profile");
  const base = path.join(root, "old-install"), prefix = path.join(base, "envs", "original");
  fs.mkdirSync(storage, { recursive: true, mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync("/usr/bin/python3", ["-I", "-B", "-c",
    "import os,sys,venv;os.umask(0o077);venv.EnvBuilder(with_pip=False).create(sys.argv[1])", prefix],
    { env: { HOME: root, TMPDIR: root } });
  const meta = path.join(prefix, "conda-meta"); fs.mkdirSync(meta, { mode: 0o700 });
  fs.writeFileSync(path.join(meta, "history"), "# controlled prefix fixture\n");
  fs.writeFileSync(path.join(meta, "python-fixture.json"), JSON.stringify({
    name: "python", fn: "python-3.11-fixture.tar.bz2", sha256: "a".repeat(64),
  }));
  const hook = path.join(base, "etc", "profile.d", "conda.sh");
  fs.mkdirSync(path.dirname(hook), { recursive: true, mode: 0o700 });
  fs.writeFileSync(hook, `_fixture_old_path="$PATH"
conda() {
  case "$1" in
    activate) export CONDA_PREFIX="$2" CONDA_SHLVL=1 PATH="$2/bin:$_fixture_old_path" ;;
    deactivate) export PATH="$_fixture_old_path" CONDA_SHLVL=0; unset CONDA_PREFIX ;;
    *) return 41 ;;
  esac
}
`);
  const calls = path.join(root, "hook-queries.log"), tool = path.join(root, "controlled-conda");
  fs.writeFileSync(tool, `#!/bin/bash
set -eu
[ "$#" = 2 ] && [ "$1" = shell.bash ] && [ "$2" = hook ]
[ "$CONDA_OFFLINE" = true ] && [ "$PYTHONDONTWRITEBYTECODE" = 1 ]
printf '%s\\n' "$HOME" >> ${quote(calls)}
/bin/cat -- ${quote(hook)}
`, { mode: 0o700 });
  const entry = { id: "original-conda", name: "Original conda", language: "python", kind: "environment",
    manager: "conda", root: prefix, executors: [{ id: "python", executable: path.join(prefix, "bin/python") }] };
  const store = new LocalEnvironmentCatalog(path.join(storage, "next-local-environments"));
  store.register(entry, store.read().digest);
  return { root, storage, base, prefix, tool, calls, entry, store,
    queryCount: () => fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n").length : 0 };
}

function native(f) {
  const state = { query: false, activation: false, trusted: true, mutate: undefined, dialogs: [], warnings: [], terminals: [] };
  const stub = { window: {
    showQuickPick: async items => items.find(item => item.entry?.id === f.entry.id),
    showOpenDialog: async options => {
      state.dialogs.push(options);
      return options.canSelectFiles ? [{ fsPath: f.tool }] : undefined;
    },
    showWarningMessage: async (message, options, button) => {
      assert(options.modal); state.warnings.push({ message, detail: options.detail });
      state.mutate?.(message);
      return message.startsWith("Generate") ? state.query ? button : undefined : state.activation ? button : undefined;
    },
    createTerminal: options => {
      const terminal = { options, sent: [], show() {}, sendText(text) { this.sent.push(text); } };
      state.terminals.push(terminal); return terminal;
    },
  } };
  const file = path.join(build, "ui/next-conda-lifecycle.js"), load = Module._load, compiled = new Module(file, module);
  compiled.filename = file; compiled.paths = Module._nodeModulePaths(path.dirname(file));
  try {
    Module._load = function (id, ...args) { return id === "vscode" ? stub : load.call(this, id, ...args); };
    compiled._compile(fs.readFileSync(file, "utf8"), file);
  } finally { Module._load = load; }
  state.run = (action = "Activate registered conda in private Bash terminal") => compiled.exports.manageCondaLifecycle(
    action, f.store, f.store.read(), f.storage, () => { if (!state.trusted) throw Error("trust revoked"); });
  return state;
}

test("real old 4.0.22 commands and Next's reviewed terminal work without selecting package archives", async t => {
  const f = fixture(t), oracleFile = path.join(f.root, "old-pyenvs.cjs");
  fs.writeFileSync(oracleFile, execFileSync("unzip", ["-p", path.resolve("personal-knowledge-4.0.22.vsix"),
    "extension/dist/servers/pyenvs.js"]));
  const old = require(oracleFile); old.initPyenvs(path.join(f.root, "old-registry"));
  const registered = old.pyenvAdd({ name: f.entry.name, manager: "conda", path: f.prefix, python: f.entry.executors[0].executable });
  const oldCommands = old.pyenvActivateCommands(registered.id);
  assert.equal(oldCommands.shell, "posix");
  const suffix = "\npython -I -B -c 'import sys; print(sys.prefix)'\nconda deactivate\nprintf '%s\\n' \"$CONDA_SHLVL\"\n";
  assert.equal(execFileSync("/bin/bash", ["--noprofile", "--norc"], { cwd: f.root, env: { PATH: "/usr/bin:/bin" },
    input: oldCommands.lines.join("\n") + suffix, encoding: "utf8" }).trim(), `${f.prefix}\n0`);
  const source = lifecycle.inspectCondaPrefix(f.entry), digest = f.store.read().digest, ui = native(f);
  await ui.run();
  assert.equal(ui.dialogs.length, 1); assert.equal(f.queryCount(), 0); assert.equal(ui.terminals.length, 0);
  assert(!fs.existsSync(path.join(f.storage, "next-environment-maintenance")));
  ui.query = true; await ui.run();
  assert.equal(f.queryCount(), 1); assert.equal(ui.terminals.length, 0);
  ui.activation = true; await ui.run();
  assert.equal(f.queryCount(), 2); assert.equal(ui.dialogs.length, 3); assert.equal(ui.terminals.length, 1);
  const terminal = ui.terminals[0];
  assert.equal(terminal.options.shellPath, "/bin/bash"); assert.equal(terminal.sent.length, 1);
  assert.equal(execFileSync("/bin/bash", terminal.options.shellArgs, { cwd: f.root, env: terminal.options.env,
    input: terminal.sent[0] + suffix, encoding: "utf8" }).trim(), `${f.prefix}\n0`);
  assert.equal(f.store.read().digest, digest); lifecycle.validateCondaPrefix(source, f.entry);
  assert(ui.warnings.some(warning => warning.detail.includes("SEPARATE activation review")));
  assert(ui.dialogs.every(options => options.canSelectFiles && !options.canSelectFolders));
});

test("trust loss before hook query and catalog drift before terminal delivery refuse effects at the correct boundary", async t => {
  const f = fixture(t), ui = native(f); ui.query = ui.activation = true;
  ui.mutate = () => { ui.trusted = false; };
  await assert.rejects(ui.run(), /trust revoked/);
  assert.equal(f.queryCount(), 0); assert.equal(ui.terminals.length, 0);
  ui.trusted = true; ui.mutate = message => {
    if (message.startsWith("Activate")) f.store.editPython(f.entry.id, "Concurrent rename", "", f.store.read().digest);
  };
  await assert.rejects(ui.run(), /Catalog changed/);
  assert.equal(f.queryCount(), 1); assert.equal(ui.terminals.length, 0);
  assert.equal(f.store.read().catalog.entries[0].name, "Concurrent rename");
});

test("clone and recovery still require an explicitly selected archive cache", async t => {
  const f = fixture(t), ui = native(f); ui.query = ui.activation = true;
  await ui.run("Clone conda to managed prefix (keep original)");
  assert.equal(ui.dialogs.length, 2); assert(ui.dialogs[1].canSelectFolders);
  await ui.run("Restore conda recovery clone");
  assert.equal(ui.dialogs.length, 4); assert(ui.dialogs[3].canSelectFolders);
  assert.equal(ui.warnings.length, 0); assert.equal(f.queryCount(), 0); assert.equal(ui.terminals.length, 0);
  assert(fs.existsSync(f.prefix)); assert(!fs.existsSync(path.join(f.storage, "next-synthetic-python")));
});

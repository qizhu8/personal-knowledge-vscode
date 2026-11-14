const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");

const out = process.env.PKM_ENV_AUTHORITY_BUILD;
if (!out || !path.isAbsolute(out)) throw new Error("PKM_ENV_AUTHORITY_BUILD must name the isolated root build.");
const { PythonEnvironmentAuthority } = require(path.join(out, "runtime/python-environment-authority.js"));
const registry = require(path.join(out, "servers/pyenvs.js"));

test("uninitialized registry cannot supply environment authority from the working directory", () => {
  assert.throws(() => new PythonEnvironmentAuthority(() => true).select("workspace", "actor", "fixture"), /not initialized/);
});

test("host selection binds a real venv to the registry, workspace, actor and session", t => {
  const systemPython = fs.realpathSync("/usr/bin/python3");
  const binary = fs.statSync(systemPython);
  assert(binary.isFile() && binary.uid === 0 && (binary.mode & 0o022) === 0);
  const fixture = path.join(fs.realpathSync(process.cwd()), "tests", `.python-authority-${randomUUID()}`);
  fs.mkdirSync(fixture, { mode: 0o700 });
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const root = path.join(fixture, "venv");
  execFileSync(systemPython, ["-m", "venv", "--without-pip", root], { cwd: fixture, env: {} });
  registry.initPyenvs(path.join(fixture, "registry"));
  const env = registry.pyenvAdd({ name: "fixture", manager: "venv", path: root, python: path.join(root, "bin", "python") });
  let trusted = true;
  const authority = new PythonEnvironmentAuthority(() => trusted);
  const handle = authority.select("workspace-a", "actor-a", env.id);
  authority.validate(handle, "workspace-a", "actor-a");
  assert.equal(handle.target, systemPython);
  assert.equal(execFileSync(handle.executable, ["-c", "import sys; print(sys.prefix)"], { cwd: fixture, env: {} }).toString().trim(), root);
  assert.throws(() => authority.validate(handle, "workspace-b", "actor-a"), /workspace or actor/);
  assert.throws(() => authority.validate(handle, "workspace-a", "actor-b"), /workspace or actor/);
  assert.throws(() => authority.validate(structuredClone(handle), "workspace-a", "actor-a"), /workspace or actor/);
  assert.throws(() => new PythonEnvironmentAuthority(() => true).validate(handle, "workspace-a", "actor-a"), /workspace or actor/);
  trusted = false;
  assert.throws(() => authority.validate(handle, "workspace-a", "actor-a"), /workspace or actor/);
  trusted = true;
  assert.throws(() => authority.validate(handle, "workspace-a", "actor-a"), /workspace or actor/);
  const second = authority.select("workspace-a", "actor-a", env.id);
  registry.pyenvUpdate(env.id, { python: path.join(root, "bin", "python3") });
  assert.throws(() => authority.validate(second, "workspace-a", "actor-a"), /registry binding changed/);
  registry.pyenvUpdate(env.id, { python: second.executable });
  assert.throws(() => authority.validate(second, "workspace-a", "actor-a"), /workspace or actor/);
  const third = authority.select("workspace-a", "actor-a", env.id);
  fs.unlinkSync(third.executable);
  fs.symlinkSync(systemPython, third.executable);
  assert.throws(() => authority.validate(third, "workspace-a", "actor-a"), /changed/);
  const replacement = authority.select("workspace-a", "actor-a", env.id);
  fs.renameSync(root, `${root}-old`);
  fs.mkdirSync(root, { mode: 0o700 });
  assert.throws(() => authority.validate(replacement, "workspace-a", "actor-a"), /changed/);
  fs.rmSync(root, { recursive: true });
  fs.renameSync(`${root}-old`, root);
  const current = authority.select("workspace-a", "actor-a", env.id);
  authority.revoke();
  assert.throws(() => authority.validate(current, "workspace-a", "actor-a"), /workspace or actor/);
});

test("untrusted, missing, ambiguous and noncanonical selections fail closed", t => {
  const fixture = path.join(fs.realpathSync(process.cwd()), "tests", `.python-authority-${randomUUID()}`);
  fs.mkdirSync(fixture, { mode: 0o700 });
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const env = { id: "fixture", name: "fixture", manager: "venv", path: fixture, python: "/usr/bin/python3" };
  assert.throws(() => new PythonEnvironmentAuthority(() => false, () => [env]).select("w", "a", env.id), /Trusted workspace/);
  assert.throws(() => new PythonEnvironmentAuthority(() => true, () => []).select("w", "a", env.id), /missing or ambiguous/);
  assert.throws(() => new PythonEnvironmentAuthority(() => true, () => [env, env]).select("w", "a", env.id), /missing or ambiguous/);
  assert.throws(() => new PythonEnvironmentAuthority(() => true, () => [env]).select("w", "a", env.id), /canonical registered/);
});

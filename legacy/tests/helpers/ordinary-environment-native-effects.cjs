"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");

const launcher = executable => "#!/bin/sh\nexec /usr/bin/unshare --mount --pid --fork --kill-child=KILL --mount-proc "
  + "'" + executable.replace(/'/g, "'\\''") + "' \"$@\"\n";
const decode = value => value.replace(/\\(040|011|012|134)/g,
  (_match, code) => ({ "040": " ", "011": "\t", "012": "\n", "134": "\\" })[code]);
function mount(directory) {
  const rows = fs.readFileSync("/proc/self/mountinfo", "utf8").trim().split("\n").map(line => {
    const [left, right] = line.split(" - "), fields = left.split(" "), tail = right.split(" ");
    return { id: fields[0], device: fields[2], directory: decode(fields[4]),
      options: fields[5].split(","), type: tail[0] };
  }).filter(row => row.directory === directory);
  if (rows.length !== 1) throw Error("Private fixture mount identity is unavailable or ambiguous.");
  return rows[0];
}
function identity(directory) {
  const info = fs.lstatSync(directory, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink() || fs.realpathSync(directory) !== directory)
    throw Error("Fixture capability requires canonical directories.");
  return `${info.dev}:${info.ino}`;
}
function synchronous(callback) {
  const result = callback();
  if (result !== undefined) {
    if (result && typeof result.then === "function") void Promise.resolve(result).catch(() => {});
    throw Error("Fixture effect fence must be synchronous.");
  }
}

/** Kernel-isolated fixture only. No profile lock, PID or marker grants production ownership. */
function acquireNativeFixtureEffects(options, intent, lifetime) {
  const base = path.resolve(options.fixture);
  if (!base.startsWith(path.resolve(options.projectRoot || process.cwd(), ".migration-test-work") + path.sep)
    || base !== fs.realpathSync(base) || !intent || !lifetime?.signal
    || !Number.isSafeInteger(lifetime.expiresAtMs) || lifetime.expiresAtMs <= Date.now()
    || lifetime.expiresAtMs > Date.now() + 120_000 || typeof options.assertOwnerCurrent !== "function"
    || !Array.isArray(options.programs) || !options.programs.length
    || !options.originalOwnedProcessesDrained || typeof options.originalOwnedProcessesDrained !== "function")
    throw Error("Native fixture effects require isolated kernel resources and actual prior-host drain proof.");
  const profileMountpoint = path.resolve(options.profileMountpoint), programsMountpoint = path.resolve(options.programsMountpoint);
  for (const directory of [profileMountpoint, programsMountpoint, intent.globalStorageDirectory, intent.knowledgeRoot])
    if (!directory.startsWith(base + path.sep) || fs.realpathSync(directory) !== directory)
      throw Error("Fixture authority must stay inside its private project fixture.");
  if (!intent.globalStorageDirectory.startsWith(profileMountpoint + path.sep))
    throw Error("Original profile is not inside the private fixture volume.");
  const profileMount = mount(profileMountpoint), programMount = mount(programsMountpoint);
  if (profileMount.type !== "tmpfs" || !profileMount.options.includes("rw")
    || programMount.type !== "tmpfs" || !programMount.options.includes("ro"))
    throw Error("Profile requires private tmpfs; launchers require immutable private tmpfs.");
  const namespace = fs.readlinkSync("/proc/self/ns/mnt"), pidNamespace = fs.readlinkSync("/proc/self/ns/pid");
  if (namespace !== options.expectedMountNamespace || pidNamespace !== options.expectedPidNamespace)
    throw Error("Fixture mount/PID namespace identity does not match its trusted controller.");
  const rootPin = identity(intent.knowledgeRoot), profilePin = identity(intent.globalStorageDirectory);
  const environment = Object.freeze({ ...options.environment, PIP_NO_INDEX: "1",
    PIP_DISABLE_PIP_VERSION_CHECK: "1", PYTHONDONTWRITEBYTECODE: "1" });
  const programs = options.programs.map(program => {
    const filename = path.resolve(program.filename);
    if (!filename.startsWith(programsMountpoint + path.sep) || fs.realpathSync(filename) !== filename)
      throw Error("Query launcher is not inside the immutable private volume.");
    const info = fs.lstatSync(filename, { bigint: true }), content = fs.readFileSync(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o022n
      || content.toString("utf8") !== launcher(program.executable))
      throw Error("Query launcher is not the exact kernel-supervised fixture program.");
    return { ...program, filename, pin: `${info.dev}:${info.ino}`, digest: crypto.createHash("sha256").update(content).digest("hex") };
  });
  let claimed = false, writeActive = false;
  const children = new Map(), counts = new Map();
  const controller = new AbortController(), revoke = () => controller.abort();
  lifetime.signal.addEventListener("abort", revoke, { once: true });
  const check = () => {
    if (controller.signal.aborted || lifetime.signal.aborted || Date.now() >= lifetime.expiresAtMs)
      throw Error("Native fixture request authority was revoked.");
    synchronous(() => options.assertOwnerCurrent(intent));
    synchronous(options.originalOwnedProcessesDrained);
    if (fs.readlinkSync("/proc/self/ns/mnt") !== namespace || fs.readlinkSync("/proc/self/ns/pid") !== pidNamespace
      || !isDeepStrictEqual(mount(profileMountpoint), profileMount) || !isDeepStrictEqual(mount(programsMountpoint), programMount)
      || identity(intent.knowledgeRoot) !== rootPin || identity(intent.globalStorageDirectory) !== profilePin)
      throw Error("Native fixture Root/profile/mount identity changed.");
    if (controller.signal.aborted || lifetime.signal.aborted || Date.now() >= lifetime.expiresAtMs)
      throw Error("Native fixture request authority was revoked.");
  };
  const target = (id, kind) => {
    check();
    if (!claimed || !intent.environments.some(entry => entry.id === id)
      || intent.operation === "packages" && kind !== "packages"
      || intent.operation === "metadata" && kind === "packages")
      throw Error("Native fixture effect does not match the exact consumed intent.");
    return intent.environments.find(entry => entry.id === id);
  };
  try { check(); } catch (error) { lifetime.signal.removeEventListener("abort", revoke); throw error; }
  return {
    signal: controller.signal, environment,
    claim(actual) {
      check();
      if (claimed || !isDeepStrictEqual(actual, intent)) throw Error("Fixture intent was changed or replayed.");
      claimed = true;
    },
    assertCurrent(_effect, id, kind) { target(id, kind); },
    assertProfileWriter: check,
    assertExecution(trace) {
      const entry = target(trace.environmentId, trace.kind);
      if (!isDeepStrictEqual(trace.intent, intent) || !isDeepStrictEqual(trace.environment, environment))
        throw Error("Fixture execution intent/environment mismatch.");
      const filename = trace.program === "du" ? path.join(options.environment.PATH, "du") : trace.program;
      const program = programs.find(item => item.filename === filename);
      const allowedArgs = trace.kind === "size" ? ["-sk", entry.path]
        : trace.kind === "version" ? ["--version"]
        : entry.manager === "conda" ? ["list", "--json", "-p", entry.path]
        : ["-m", "pip", "list", "--format=json"];
      if (!program || !isDeepStrictEqual(trace.args, allowedArgs)
        || trace.kind !== "size" && program.filename !== (entry.manager === "conda" && trace.kind === "packages"
          ? options.condaExecutable : entry.python))
        throw Error("Fixture execution program/argv is not approved.");
      const info = fs.lstatSync(program.filename, { bigint: true });
      if (`${info.dev}:${info.ino}` !== program.pin
        || crypto.createHash("sha256").update(fs.readFileSync(program.filename)).digest("hex") !== program.digest)
        throw Error("Kernel-supervised query launcher changed.");
      const key = `${trace.environmentId}:${trace.kind}`, count = counts.get(key) || 0;
      if (count) throw Error("Fixture request cannot replay a query.");
      counts.set(key, count + 1);
      check();
    },
    recordExecution(child, trace) {
      if (!child || children.has(child)) throw Error("Actual fixture child registration is invalid.");
      children.set(child, trace);
    },
    async verifyDrained(child, trace) {
      if (children.get(child) !== trace) throw Error("Fixture drain child/trace mismatch.");
      // Only normal outer unshare completion establishes its PID1 exited. Signal loss remains UNKNOWN.
      if (!Number.isInteger(child.exitCode) || child.exitCode < 0)
        throw Error("UNKNOWN: outer namespace supervisor completion was not established.");
      children.delete(child);
      if (!children.size && lifetime.signal.aborted) lifetime.signal.removeEventListener("abort", revoke);
    },
    async withProfileWrite(id, kind, write) {
      target(id, kind);
      if (writeActive) throw Error("Fixture profile writer callback overlapped.");
      writeActive = true;
      try { check(); synchronous(write); check(); }
      finally { writeActive = false; }
    },
  };
}
module.exports = { acquireNativeFixtureEffects, launcher, mount };

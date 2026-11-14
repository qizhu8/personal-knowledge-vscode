#!/usr/bin/env node
// Experimental payload only: no production service registration or cutover.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const server = path.join(root, "next-server");
const target = path.join(root, "next-runtime");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(result.stderr || String(result.error) || `Failed: ${command}`);
  return result.stdout;
}

function copyTree(source, destination, accept, nestedModules = false) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error(`Runtime source is a link: ${source}`);
  if (stat.isDirectory()) {
    if (nestedModules && path.basename(source) === "node_modules") return;
    for (const name of fs.readdirSync(source).sort()) {
      if (["__pycache__", ".git", ".bin"].includes(name)) continue;
      copyTree(path.join(source, name), path.join(destination, name), accept, nestedModules);
    }
  } else if (stat.isFile() && accept(source)) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  } else if (!stat.isFile()) throw new Error(`Unsupported runtime source: ${source}`);
}

function inventory(directory, base = directory) {
  const files = {};
  for (const name of fs.readdirSync(directory).sort()) {
    const file = path.join(directory, name), stat = fs.lstatSync(file);
    if (stat.isDirectory()) Object.assign(files, inventory(file, base));
    else if (stat.isFile()) files[path.relative(base, file).split(path.sep).join("/")] = hash(fs.readFileSync(file));
    else throw new Error(`Unexpected runtime entry: ${file}`);
  }
  return files;
}

// npm's tree inspection does not recognize a dependency resolved from the
// containing extension's node_modules as part of the server's own tree.
function prepareServerDependencyTree(output, serverDirectory, extensionRoot, declared, lock) {
  const missing = [];
  for (const name of Object.keys(declared.dependencies || {})) {
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)
      || name.split("/").some(part => part === "." || part === "..")) throw new Error(`Invalid dependency name: ${name}`);
    const installed = path.join(serverDirectory, "node_modules", name);
    if (fs.existsSync(installed)) continue;
    const source = path.join(extensionRoot, "node_modules", name);
    const expected = lock.packages?.[`node_modules/${name}`];
    if (!expected?.version || !fs.existsSync(path.join(source, "package.json")))
      throw new Error(`Missing locked next-server dependency: ${name}`);
    const actual = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8"));
    if (actual.name !== name || actual.version !== expected.version)
      throw new Error(`Hoisted dependency does not match next-server lockfile: ${name}`);
    missing.push({ name, source });
  }
  if (!missing.length) return { server: serverDirectory, modules: path.join(serverDirectory, "node_modules") };
  const temporary = path.join(output, ".server-dependency-input");
  fs.mkdirSync(temporary);
  for (const name of ["package.json", "package-lock.json"])
    fs.copyFileSync(path.join(serverDirectory, name), path.join(temporary, name));
  const localModules = path.join(serverDirectory, "node_modules");
  if (fs.existsSync(localModules)) {
    fs.cpSync(fs.realpathSync(localModules), path.join(temporary, "node_modules"), {
      recursive: true, verbatimSymlinks: true, filter: file => path.basename(file) !== ".bin",
    });
  } else {
    fs.mkdirSync(path.join(temporary, "node_modules"));
  }
  for (const { name, source } of missing) {
    const destination = path.join(temporary, "node_modules", name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(source, destination, { recursive: true, verbatimSymlinks: true });
  }
  return { server: temporary, modules: path.join(temporary, "node_modules"), temporary };
}

function stage(output = target, { production = false } = {}) {
  if (!path.resolve(output).startsWith(root + path.sep)) throw new Error("Runtime output must be inside the project.");
  fs.mkdirSync(output); // Refuse to overwrite any existing directory.
  try {
    const runtime = path.join(output, "server");
    fs.mkdirSync(runtime);
    fs.copyFileSync(path.join(root, "scripts", "next-rehearsal-check.cjs"), path.join(output, "check.cjs"));
    run(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", path.join(server, "tsconfig.json"), "--outDir", path.join(runtime, "dist")]);
    require("esbuild").buildSync({ stdin: { contents: `
      export { ChatHub } from "./src/chatroom/chatroom-hub";
      export { ChatJoinApprovalManager } from "./src/chatroom/chat-join-approval";
      export { MeetingStateStore } from "./src/chatroom/meeting-state";
      export { WebSocketServer } from "ws";`, resolveDir: root },
      bundle: true, platform: "node", format: "cjs",
      outfile: path.join(runtime, "dist", "legacy-chatroom-retained.cjs"), logLevel: "silent" });
    fs.copyFileSync(path.join(server, "package.json"), path.join(runtime, "package.json"));
    const lock = JSON.parse(fs.readFileSync(path.join(server, "package-lock.json"), "utf8"));
    const declared = require("../next-server/package.json");
    const lockDependencies = lock.packages?.[""]?.dependencies;
    if (production && (lock.packages?.[""]?.version !== declared.version || !lockDependencies
      || Object.keys(declared.dependencies).length !== Object.keys(lockDependencies).length
      || Object.entries(declared.dependencies).some(([name, version]) => lockDependencies[name] !== version)))
      throw new Error("next-server package.json and package-lock.json disagree; restore the locked dependencies first.");
    if (production) fs.copyFileSync(path.join(server, "package-lock.json"), path.join(runtime, "package-lock.json"));
    for (const [name, extensions] of [
      ["compat", [".py", ".cjs", ".json"]],
      ["compute", [".py"]],
      ["domain", [".py"]],
      ["browser", [".mjs", ".html", ".css"]],
    ]) copyTree(path.join(server, name), path.join(runtime, name), file => extensions.includes(path.extname(file)));
    if (production) {
      copyTree(path.join(root, "resources"), path.join(output, "resources"), file =>
        path.dirname(file) === path.join(root, "resources") && ([ ".py", ".txt"].includes(path.extname(file))
          || path.basename(file) === "action_components.js")
        || path.dirname(file) === path.join(root, "resources", "vendor") && path.extname(file) === ".whl");
    } else for (const name of ["note_inventory.py", "action_components.js"])
      copyTree(path.join(root, "resources", name), path.join(output, "resources", name), () => true);
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const dependencies = production ? prepareServerDependencyTree(output, server, root, declared, lock)
      : { server, modules: path.join(server, "node_modules") };
    const packages = run(npm, ["--prefix", dependencies.server, "ls", "--omit=dev", "--all", "--parseable"])
      .split(/\r?\n/).filter(Boolean).slice(1);
    const modules = dependencies.modules;
    for (const source of [...new Set(packages)].sort()) {
      const relative = path.relative(modules, source);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Dependency outside server node_modules: ${source}`);
      if (production) {
        const key = `node_modules/${relative.split(path.sep).join("/")}`;
        const actual = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8"));
        if (!lock.packages?.[key] || lock.packages[key].version !== actual.version)
          throw new Error(`Production dependency does not match package-lock.json: ${key}`);
      }
      copyTree(source, path.join(runtime, "node_modules", relative), () => true, true);
    }
    if (dependencies.temporary) fs.rmSync(dependencies.temporary, { recursive: true });
    const files = inventory(output);
    for (const required of ["check.cjs", "server/dist/cli.js", "server/dist/legacy-import-cli.js", "server/dist/storage-worker.js",
      "server/compat/legacy-knowledge-mcp.py", "server/compat/legacy-note-inventory.py",
      "server/compute/worker.py", "server/browser/integration.mjs",
      "resources/note_inventory.py", "resources/action_components.js",
      "server/node_modules/zod/package.json", "server/node_modules/@modelcontextprotocol/sdk/package.json"]) {
      if (!files[required]) throw new Error(`Missing runtime payload: ${required}`);
    }
    if (production && !files["server/dist/managed-client-child.js"])
      throw new Error("Missing required next-server private host entry: server/dist/managed-client-child.js");
    if (production) for (const required of ["legacy-import.js", "migration-preflight.js", "rename-no-replace.js", "file-mtime.js"]) {
      if (!files[`server/dist/${required}`]) throw new Error(`Missing legacy import dependency: ${required}`);
    }
    const manifest = production ? {
      schema: "pkm.next-payload/v1",
      extensionVersion: require("../package.json").version,
      serverVersion: require("../next-server/package.json").version,
      node: ">=22.18.0", entry: "server/dist/managed-client-child.js",
      buildId: hash(JSON.stringify(files)), files,
    } : { schema: "pkm.next-rehearsal-runtime/v1", experimental: true, node: ">=22.18.0", files };
    fs.writeFileSync(path.join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
    console.log(`Staged ${Object.keys(files).length} pinned ${production ? "next-server" : "experimental"} runtime files.`);
  } catch (error) {
    fs.rmSync(output, { recursive: true, force: true });
    throw error;
  }
}

if (require.main === module) {
  if (process.argv[2] !== "stage") throw new Error("Usage: node scripts/next-rehearsal-runtime.js stage");
  stage();
}
module.exports = { stage, target, prepareServerDependencyTree };

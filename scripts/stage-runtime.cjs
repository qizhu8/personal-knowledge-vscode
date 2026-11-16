const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { createRequire, isBuiltin } = require("node:module");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const legacy = path.join(root, "legacy");
const target = path.join(root, "next-runtime");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function copyTree(source, destination, accept = () => true, nestedModules = false) {
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

function retainedRuntimeFiles() {
  const ts = require("typescript");
  const base = path.join(legacy, "dist");
  const found = new Set();
  function visit(file) {
    const local = path.relative(base, file);
    if (!local || local === ".." || local.startsWith(`..${path.sep}`) || path.isAbsolute(local)
      || fs.realpathSync(file) !== file || !fs.lstatSync(file).isFile())
      throw new Error(`Retained runtime dependency must be a real compiled file: ${file}`);
    if (found.has(file)) return;
    found.add(file);
    if (path.extname(file) === ".json") return;
    if (path.extname(file) !== ".js") throw new Error(`Unsupported retained runtime dependency: ${file}`);
    const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    if (source.parseDiagnostics.length) throw new Error(`Invalid retained runtime JavaScript: ${file}`);
    const resolve = createRequire(file).resolve;
    function inspect(node) {
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || ts.isIdentifier(node.expression) && node.expression.text === "require")) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.arguments.length !== 1
          || !ts.isStringLiteralLike(node.arguments[0]))
          throw new Error(`Retained runtime dependency must use a literal CommonJS require: ${file}`);
        const name = node.arguments[0].text;
        if (name.startsWith(".")) visit(resolve(name));
        else if (!isBuiltin(name) && name !== "vscode")
          throw new Error(`Undeclared retained runtime external: ${name} in ${file}`);
      }
      ts.forEachChild(node, inspect);
    }
    inspect(source);
  }
  for (const entry of [
    "runtime/next-payload-verifier.js", "runtime/host-writer-admission.js",
    "runtime/managed-host-child-registry.js", "runtime/legacy-snapshot-vscode-authority.js",
    "knowledge/markdown-assets.js", "runtime/cross-process-lock.js",
  ]) visit(path.join(base, entry));
  return [...found].map(file => path.relative(base, file).split(path.sep).join("/")).sort();
}

function stage(output = target, { production = false, extensionVersion } = {}) {
  output = path.resolve(output);
  const relative = path.relative(root, output), parent = path.dirname(output);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
    || fs.realpathSync(parent) !== parent)
    throw new Error("Runtime output must have a real parent inside this project.");
  if (typeof production !== "boolean") throw new Error("Explicit boolean payload profile required.");
  extensionVersion ??= JSON.parse(fs.readFileSync(path.join(legacy, "package.json"), "utf8")).version;
  if (typeof extensionVersion !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(extensionVersion))
    throw new Error("An exact extension package version is required.");
  const declared = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  const locked = lock.packages?.[""];
  if (locked?.version !== declared.version || !locked.dependencies
    || Object.keys(declared.dependencies).length !== Object.keys(locked.dependencies).length
    || Object.entries(declared.dependencies).some(([name, version]) => locked.dependencies[name] !== version))
    throw new Error("Core package.json and package-lock.json disagree; restore the locked dependencies first.");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const packages = spawnSync(npm, ["--prefix", root, "ls", "--omit=dev", "--all", "--parseable"],
    { encoding: "utf8", timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
  if (packages.error || packages.status !== 0)
    throw new Error(packages.stderr || packages.error?.message || "Unable to inventory Core dependencies.");
  fs.mkdirSync(output);
  try {
    const runtime = path.join(output, "server");
    copyTree(path.join(root, "dist"), path.join(runtime, "dist"));
    require("esbuild").buildSync({ stdin: { contents: `
      export { ChatHub } from "./src/chatroom/chatroom-hub";
      export { ChatJoinApprovalManager } from "./src/chatroom/chat-join-approval";
      export { MeetingStateStore } from "./src/chatroom/meeting-state";
      export { WebSocketServer } from "ws";`, resolveDir: legacy },
    bundle: true, platform: "node", format: "cjs", absWorkingDir: root,
    outfile: path.join(runtime, "dist", "legacy-chatroom-retained.cjs"), logLevel: "silent" });
    // Keep classes, AsyncLocalStorage and WeakMap brands in one physical CJS cache.
    for (const name of retainedRuntimeFiles())
      copyTree(path.join(legacy, "dist", name), path.join(runtime, "legacy", "dist", name));
    fs.writeFileSync(path.join(runtime, "legacy", "package.json"),
      JSON.stringify({ private: true, type: "commonjs" }) + "\n", { flag: "wx" });
    fs.copyFileSync(path.join(legacy, "scripts", "next-rehearsal-check.cjs"), path.join(output, "check.cjs"));
    for (const name of ["package.json", "package-lock.json"])
      fs.copyFileSync(path.join(root, name), path.join(runtime, name));
    for (const [name, extensions] of [
      ["compat", [".py", ".cjs", ".json"]], ["compute", [".py"]],
      ["domain", [".py"]], ["browser", [".mjs", ".html", ".css"]],
    ]) copyTree(path.join(root, name), path.join(runtime, name), file => extensions.includes(path.extname(file)));
    const resources = path.join(legacy, "resources");
    copyTree(resources, path.join(runtime, "legacy", "resources"), file =>
      path.dirname(file) === resources && ([".py", ".txt"].includes(path.extname(file))
        || path.basename(file) === "action_components.js")
      || path.dirname(file) === path.join(resources, "vendor") && path.extname(file) === ".whl");
    // The retained client prerequisite checker still names these two public resources.
    for (const name of ["note_inventory.py", "action_components.js"])
      copyTree(path.join(resources, name), path.join(output, "resources", name));
    const modules = path.join(root, "node_modules");
    for (const source of [...new Set(packages.stdout.trim().split(/\r?\n/).slice(1))].sort()) {
      const local = path.relative(modules, source);
      if (!local || local === ".." || local.startsWith(`..${path.sep}`) || path.isAbsolute(local))
        throw new Error(`Dependency outside Core node_modules: ${source}`);
      const actual = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8"));
      if (lock.packages?.[`node_modules/${local.split(path.sep).join("/")}`]?.version !== actual.version)
        throw new Error(`Dependency does not match Core lockfile: ${local}`);
      copyTree(source, path.join(runtime, "node_modules", local), () => true, true);
    }
    const files = inventory(output);
    for (const required of ["check.cjs", "server/dist/cli.js", "server/dist/managed-client-child.js",
      "server/dist/active-vscode-migration-host.js",
      "server/dist/legacy-import-cli.js", "server/dist/storage-worker.js",
      "server/compat/legacy-compact-mcp.py", "server/legacy/resources/note_inventory.py",
      "server/legacy/package.json", "server/legacy/resources/action_components.js",
      "server/legacy/dist/knowledge/markdown-assets.js", "server/legacy/dist/runtime/cross-process-lock.js",
      "server/legacy/dist/runtime/next-payload-verifier.js", "server/legacy/dist/runtime/host-writer-admission.js",
      "server/legacy/dist/runtime/managed-host-child-registry.js", "server/legacy/dist/runtime/legacy-snapshot-vscode-authority.js",
      "server/legacy/dist/knowledge/filestore.js",
      "server/node_modules/zod/package.json", "server/node_modules/@modelcontextprotocol/sdk/package.json"])
      if (!files[required]) throw new Error(`Missing runtime payload: ${required}`);
    const manifest = production ? {
      schema: "pkm.next-payload/v1",
      extensionVersion,
      serverVersion: declared.version, node: ">=22.18.0", entry: "server/dist/managed-client-child.js",
      buildId: hash(JSON.stringify(files)), files,
    } : { schema: "pkm.next-rehearsal-runtime/v1", experimental: true, node: ">=22.18.0", files };
    fs.writeFileSync(path.join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
  } catch (error) {
    fs.rmSync(output, { recursive: true, force: true });
    throw error;
  }
}

if (require.main === module) {
  if (process.argv[2] !== "stage" || process.argv.length > 4
    || process.argv[3] !== undefined && process.argv[3] !== "--payload")
    throw new Error("Usage: node scripts/stage-runtime.cjs stage [--payload]");
  stage(target, { production: process.argv[3] === "--payload" });
}
module.exports = { stage, target, retainedRuntimeFiles };

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const ts = require("typescript");
const { fixtureRequirements } = require("./fixtures.cjs");

const EXECUTABLE = /^(?:test[-_].*|.*\.test)\.(?:js|cjs|mjs|py)$/;
const CONTROL_SCRIPTS = new Set(["test", "test:list", "test:framework", "test:inventory", "test:check",
  "test:quick", "test:ci", "test:all", "test:browser"]);
const OWNERS = ["agent-sessions", "chatroom", "chat", "knowledge", "retrieval", "skills", "mcp", "sync",
  "subscriptions", "runtime", "workflows", "ui", "servers"];
const BUILTINS = new Set(require("node:module").builtinModules.flatMap(name => [name, name.replace(/^node:/, "")]));

function pythonExecutable() {
  return process.env.PKM_TEST_PYTHON || process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
}

function sourceFiles(root) {
  const files = [];
  function visit(directory, client = false) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") || entry.name === "__pycache__") continue;
      if (client && ["node_modules", "dist", "out", "artifacts", "next-runtime"].includes(entry.name)) continue;
      const filename = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Test source symlinks require explicit review: ${filename}`);
      if (entry.isDirectory()) visit(filename, client);
      else if (entry.isFile()) files.push(path.relative(root, filename).split(path.sep).join("/"));
      else throw new Error(`Unexpected test source entry: ${filename}`);
    }
  }
  visit(path.join(root, "tests"));
  const moduleTests = path.join(root, "modules", "pkm-memory-engine", "tests");
  if (fs.existsSync(moduleTests)) visit(moduleTests);
  for (const client of ["clients/vscode", "clients/vscode-host"]) {
    const directory = path.join(root, client);
    if (fs.existsSync(directory)) visit(directory, true);
  }
  return files;
}

function nodeFacts(filename, text) {
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true);
  if (source.parseDiagnostics.length) throw new Error(`Test syntax error in ${filename}: ${
    ts.flattenDiagnosticMessageText(source.parseDiagnostics[0].messageText, "\n")}`);
  const imports = new Set(), environments = new Set();
  const literals = new Set();
  const mockBindings = new Set();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || statement.moduleSpecifier.text !== "node:test") continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings))
      for (const binding of bindings.elements)
        if ((binding.propertyName || binding.name).text === "mock") mockBindings.add(binding.name.text);
  }
  let assertions = 0, dynamicRequire = false, moduleMocks = false;
  function visit(node) {
    if (ts.isStringLiteral(node)) literals.add(node.text);
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.add(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node)) {
      const name = node.expression.getText(source);
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "module"
          && ts.isIdentifier(node.expression.expression) && mockBindings.has(node.expression.expression.text))
        moduleMocks = true;
      if (/^assert(?:\.|$)/.test(name)) assertions++;
      if ((name === "require" || name === "require.resolve" || node.expression.kind === ts.SyntaxKind.ImportKeyword)
          && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) imports.add(node.arguments[0].text);
      if (name === "require" && node.arguments[0] && !ts.isStringLiteral(node.arguments[0])) dynamicRequire = true;
    }
    if (ts.isPropertyAccessExpression(node) && node.expression.getText(source) === "process.env")
      environments.add(node.name.text);
    if (ts.isElementAccessExpression(node) && node.expression.getText(source) === "process.env"
        && node.argumentExpression && ts.isStringLiteral(node.argumentExpression))
      environments.add(node.argumentExpression.text);
    ts.forEachChild(node, visit);
  }
  visit(source);
  // Dynamic browser loaders deliberately resolve externally managed Playwright installations.
  if (dynamicRequire && literals.has("playwright")) imports.add("playwright");
  const processIO = [...imports].some(name => /child_process/.test(name));
  return { imports: [...imports].sort(), environments: [...environments].sort(), assertions, moduleMocks,
    compatBuild: [...literals].some(value => /^(?:\.\.?\/)*legacy\/dist(?:\/|$)/.test(value)),
    clientBuild: [...imports].some(value => /(?:^|\/)clients\/vscode\//.test(value)),
    hostBuild: filename.startsWith("clients/vscode-host/")
      || [...imports].some(value => /(?:^|\/)clients\/vscode-host\//.test(value)),
    runtimeFiles: processIO ? [...literals].filter(value => /\.(?:py|mjs|cjs)$/.test(value)
      && !value.includes("\n") && !path.isAbsolute(value)) : [],
    native: processIO && [...literals].some(value => /^--(?:user-data-dir|extensions-dir|extensionTestsPath|extensionDevelopmentPath|install-extension|installed-vsix)(?:=|$)/.test(value)),
    external: false,
    controllerFiles: [...literals].filter(value => /^scripts\/[A-Za-z0-9_./-]+\.(?:js|cjs|mjs|py)$/.test(value)),
    testFiles: [...literals].filter(value => EXECUTABLE.test(path.basename(value))),
  };
}

function domain(file, imports) {
  if (file.startsWith("tests/framework/")) return "testing";
  if (file.startsWith("modules/pkm-memory-engine/")) return "memory";
  const sourceOwner = imports.map(name => name.match(/(?:dist|src)\/([^/]+)\//)?.[1]).find(name => OWNERS.includes(name));
  if (sourceOwner) return sourceOwner;
  const stem = path.basename(file).replace(/^test[-_]/, "");
  const aliases = {
    "github-sync": "sync", "agent-": "agent-sessions", "action-": "workflows", "recipe-": "workflows",
    "workflow-": "workflows", "project-": "workflows", "note-": "knowledge", "todo-": "knowledge",
    "markdown-": "knowledge", "environment-": "runtime", "local-": "runtime", "managed-": "runtime",
    "host-": "runtime", "diagnostic-": "runtime", "retained-": "runtime", "json-file-": "runtime",
    "version-": "runtime", "background-": "runtime", "bounded-": "runtime", "cross-process-": "runtime",
  };
  return Object.keys(aliases).find(prefix => stem.startsWith(prefix))
    ? aliases[Object.keys(aliases).find(prefix => stem.startsWith(prefix))]
    : OWNERS.find(owner => stem.startsWith(`${owner}-`) || stem.startsWith(`${owner}_`)) || "platform";
}

function capabilities(facts) {
  const modules = facts.imports.join(" "), environments = facts.environments.join(" ");
  const result = [];
  if (/playwright|puppeteer/.test(modules)) result.push("browser");
  if (/(?:^|\s)(?:torch|transformers|sentence_transformers)(?:\.|\s|$)/.test(modules)) result.push("model-runtime");
  if (facts.native || /(?:^|\s)vscode(?:\s|$)|@vscode\/test-electron/.test(modules)
      || /PKM_(?:VSCODE_EXECUTABLE|TRIAL_XVFB|NATIVE_|LIVE_)/.test(environments)) result.push("native");
  if (facts.external || /@github\/copilot-sdk|@microsoft\/copilot-sdk/.test(modules)
      || /PKM_.*(?:LIVE|REAL_PROVIDER|RETRIEVAL_TEST_MODEL)/.test(environments)) result.push("external");
  if (/child_process|subprocess|node:http|node:net|(?:^|\s)http(?:\s|$)|(?:^|\s)net(?:\s|$)/.test(modules))
    result.push("process-io");
  return result;
}

function createCatalog(repositoryRoot) {
  const manifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
  const files = sourceFiles(repositoryRoot), facts = new Map();
  const declaredNodeModules = new Set(Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }));
  const controllers = [...new Set(Object.entries(manifest.scripts || {})
    .filter(([name]) => name.startsWith("test:") && !CONTROL_SCRIPTS.has(name))
    .flatMap(([, command]) => [...command.matchAll(/\b(scripts\/[A-Za-z0-9_./-]+\.(?:js|cjs|mjs|py))/g)].map(match => match[1])))];
  for (let index = 0; index < controllers.length; index++) {
    const file = controllers[index], absolute = path.join(repositoryRoot, file);
    if (!fs.existsSync(absolute)) throw new Error(`Missing test pipeline controller: ${file}`);
    if (!files.includes(file)) files.push(file);
    if (/\.(?:js|cjs|mjs)$/.test(file)) {
      const metadata = nodeFacts(file, fs.readFileSync(absolute, "utf8"));
      for (const child of metadata.controllerFiles)
        if (fs.existsSync(path.join(repositoryRoot, child)) && !controllers.includes(child)) controllers.push(child);
    }
  }
  files.sort();
  const python = files.filter(file => file.endsWith(".py"));
  if (python.length) {
    const result = spawnSync(pythonExecutable(), ["-B", path.join(__dirname, "python-inventory.py"),
      ...python.map(file => path.join(repositoryRoot, file))], { encoding: "utf8", timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
    if (result.error || result.status !== 0) throw result.error || new Error(`Python catalog inspection failed: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    for (const file of python) facts.set(file, parsed[path.join(repositoryRoot, file)]);
  }
  for (const file of files.filter(file => /\.(?:js|cjs|mjs|ts|cts|mts)$/.test(file)))
    facts.set(file, nodeFacts(file, fs.readFileSync(path.join(repositoryRoot, file), "utf8")));

  function expanded(file, visited = new Set()) {
    if (visited.has(file)) return { imports: [], environments: [], assertions: 0, native: false, external: false };
    visited.add(file);
    const own = facts.get(file);
    if (!own) return { imports: [], environments: [], assertions: 0, native: false, external: false };
    const result = { ...own, imports: [...own.imports], environments: [...own.environments], testFiles: [...(own.testFiles || [])] };
    for (const name of own.imports.filter(name => file.endsWith(".py") || name.startsWith("."))) {
      const relative = path.posix.normalize(path.posix.join(path.posix.dirname(file),
        file.endsWith(".py") ? name.replace(/\./g, "/") : name));
      const target = [relative, `${relative}.js`, `${relative}.cjs`, `${relative}.mjs`, `${relative}.py`, `${relative}/index.js`]
        .find(candidate => facts.has(candidate));
      if (!target) continue;
      const child = expanded(target, visited);
      result.imports.push(...child.imports);
      result.environments.push(...child.environments);
      result.native ||= child.native;
      result.external ||= child.external;
      result.compatBuild ||= child.compatBuild;
      result.clientBuild ||= child.clientBuild;
      result.hostBuild ||= child.hostBuild;
      result.moduleMocks ||= child.moduleMocks;
      result.testFiles.push(...(child.testFiles || []));
    }
    for (const controller of own.controllerFiles || []) {
      const child = expanded(controller, visited);
      result.imports.push(...child.imports); result.environments.push(...child.environments);
      result.native ||= child.native; result.external ||= child.external;
      result.compatBuild ||= child.compatBuild; result.clientBuild ||= child.clientBuild;
      result.hostBuild ||= child.hostBuild;
      result.moduleMocks ||= child.moduleMocks;
      result.testFiles.push(...(child.testFiles || []));
    }
    for (const runtime of own.runtimeFiles || []) {
      const target = [path.posix.normalize(path.posix.join(path.posix.dirname(file), runtime)), runtime]
        .find(candidate => facts.has(candidate));
      if (!target) continue;
      const child = expanded(target, visited);
      result.imports.push(...child.imports); result.environments.push(...child.environments);
      result.native ||= child.native; result.external ||= child.external;
      result.compatBuild ||= child.compatBuild; result.clientBuild ||= child.clientBuild;
      result.hostBuild ||= child.hostBuild;
      result.moduleMocks ||= child.moduleMocks;
    }
    return { ...result, imports: [...new Set(result.imports)].sort(), environments: [...new Set(result.environments)].sort() };
  }

  const entries = files.map(file => {
    const language = file.endsWith(".py") ? "python" : /\.(?:js|cjs|mjs)$/.test(file) ? "node"
      : /\.(?:ts|cts|mts)$/.test(file) ? "typescript" : null;
    const test = language && EXECUTABLE.test(path.basename(file)) && !file.includes("/fixtures/");
    const evidence = expanded(file), caps = capabilities(evidence), fixtures = fixtureRequirements(evidence);
    if (fixtures.qualificationInputs.length) caps.push("qualification");
    const role = test ? "test" : file.startsWith("scripts/") ? "controller"
      : path.basename(file).startsWith("benchmark_") ? "benchmark" : file.startsWith("tests/cases/") ? "manual"
      : facts.get(file)?.imports.includes("vscode") ? "host-actor" : language ? "fixture" : "data";
    const layer = !test ? null : file.startsWith("tests/framework/") ? "framework"
      : caps.includes("qualification") ? "qualification" : caps.includes("native") || caps.includes("external") ? "native"
        : caps.includes("browser") ? "browser" : caps.includes("process-io") ? "integration" : "component";
    const nodeModules = language === "node" ? evidence.imports.filter(name =>
      !name.startsWith(".") && !path.isAbsolute(name) && !BUILTINS.has(name) && name !== "vscode"
      && declaredNodeModules.has(name.startsWith("@") ? name.split("/").slice(0, 2).join("/") : name.split("/")[0])) : [];
    return {
      id: file, file, role, language, domain: domain(file, evidence.imports), layer,
      sha256: createHash("sha256").update(fs.readFileSync(path.join(repositoryRoot, file))).digest("hex"),
      capabilities: caps, evidence, nodeModules, fixtures,
      timeoutMs: file === "tests/legacy-read-race.test.mjs" ? 5 * 60 * 1000
        : ["native", "qualification"].includes(layer) ? 30 * 60 * 1000
        : layer === "browser" || caps.includes("model-runtime") ? 10 * 60 * 1000 : 120000,
    };
  });
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const aliases = [];
  function members(name, seen = new Set()) {
    if (seen.has(name)) throw new Error(`Cyclic npm test dependency: ${name}`);
    const command = manifest.scripts[name];
    if (!command) throw new Error(`Missing npm script referenced by test suite: ${name}`);
    const next = new Set([...seen, name]);
    const ids = [...command.matchAll(/\b(tests\/[A-Za-z0-9_./-]+\.(?:js|cjs|mjs|py))/g)].map(match => match[1]);
    for (const match of command.matchAll(/\b(scripts\/[A-Za-z0-9_./-]+\.(?:js|cjs|mjs|py))/g)) {
      const evidence = expanded(match[1]);
      for (const filename of evidence.testFiles || []) {
        const candidates = entries.filter(entry => entry.role === "test" && (entry.id === filename || path.basename(entry.id) === filename));
        if (candidates.length === 1) ids.push(candidates[0].id);
      }
    }
    for (const match of command.matchAll(/\bnpm run ([A-Za-z0-9:_-]+)/g)) {
      if (match[1].startsWith("test:") && !CONTROL_SCRIPTS.has(match[1])) ids.push(...members(match[1], next));
    }
    if (manifest.scripts[`pre${name}`]) ids.push(...members(`pre${name}`, next));
    return [...new Set(ids)];
  }
  for (const name of Object.keys(manifest.scripts || {}).sort()) {
    if (!name.startsWith("test:") || CONTROL_SCRIPTS.has(name)) continue;
    const ids = members(name);
    for (const id of ids) if (!byId.has(id)) throw new Error(`Stale test path in ${name}: ${id}`);
    const caps = [...new Set(ids.flatMap(id => byId.get(id).capabilities))];
    const aliasEnvironments = ids.flatMap(id => byId.get(id).evidence.environments);
    const memberEvidence = ids.map(id => byId.get(id).evidence);
    for (const match of manifest.scripts[name].matchAll(/\b(scripts\/[A-Za-z0-9_./-]+\.(?:js|cjs|mjs|py))/g)) {
      const evidence = expanded(match[1]);
      caps.push(...capabilities(evidence));
      aliasEnvironments.push(...evidence.environments);
      memberEvidence.push(evidence);
    }
    const aliasEvidence = { environments: [...new Set(aliasEnvironments)],
      compatBuild: memberEvidence.some(evidence => evidence.compatBuild),
      clientBuild: memberEvidence.some(evidence => evidence.clientBuild),
      hostBuild: memberEvidence.some(evidence => evidence.hostBuild) };
    const fixtures = fixtureRequirements(aliasEvidence);
    if (name === "test:qualification") caps.push("qualification");
    aliases.push({
      id: name, name, role: manifest.scripts[name].includes("--prepare-only") ? "preparation" : "suite",
      layer: caps.includes("qualification") ? "qualification" : caps.includes("native") || caps.includes("external") ? "native" : caps.includes("browser") ? "browser" : "integration",
      domain: "pipeline", capabilities: [...new Set(caps)], members: ids, fixtures,
      nodeModules: [...new Set(ids.flatMap(id => byId.get(id).nodeModules))],
      ownsBuild: name === "test:qualification" || /(?:npm run build|tsc -p tsconfig\.json)/.test(manifest.scripts[name])
        || /(?:npm run build|tsc -p tsconfig\.json)/.test(manifest.scripts[`pre${name}`] || ""),
      command: ["npm", "run", name], timeoutMs: 30 * 60 * 1000,
    });
  }
  const fingerprint = createHash("sha256").update(JSON.stringify(entries.map(entry =>
    [entry.id, entry.role, entry.layer, entry.domain, entry.sha256, entry.evidence])))
    .update(JSON.stringify(manifest.scripts)).digest("hex");
  return { schema: "pkm.test-catalog/v1", entries, aliases, fingerprint, files: files.length,
    tests: entries.filter(entry => entry.role === "test").length };
}

function commandFor(entry, testName) {
  if (entry.role !== "test") throw new Error(`Not an executable test (fixture/controller/manual data): ${entry.id}`);
  if (entry.language === "python")
    return [pythonExecutable(), "-B", entry.file, ...(testName ? [testName] : [])];
  return [process.execPath, ...(entry.file.endsWith(".mjs") ? ["--experimental-transform-types"] : []),
    ...(entry.evidence?.moduleMocks ? ["--experimental-test-module-mocks"] : []),
    "--test", "--test-concurrency=1", ...(testName ? [`--test-name-pattern=${testName}`] : []), entry.file];
}

module.exports = { createCatalog, commandFor, sourceFiles, pythonExecutable };

#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const ts = require("typescript");

const domains = {
  chat: "api-chat-acceptance api-chat-client api-chat-mcp api-chat-models api-chat-store api-chat-tools api-chat-view api-chat-vscode",
  "agent-sessions": "agent-session-lifecycle agent-snapshots",
  chatroom: "chat-commands chat-hub-health chat-join-approval chat-magic-link chat-managed-agent-routing chat-meeting-lifecycle chat-persistence-worker chat-persistence chat-room-credentials chat-room-identity chat-room-lifecycle chat-room-lock chatroom-browser chatroom-client chatroom-hub chatroom-protocol chatroom collaboration-model meeting-state",
  knowledge: "content-privacy filestore knowledge-contracts knowledge-groups knowledge-inventory-worker knowledge-inventory knowledge-locator knowledge-migration link-graph live-note-server markdown-assets migrate storage store-path",
  retrieval: "retrieval-contracts retrieval-index-events retrieval-snapshot retrieval-worker",
  skills: "pkm-skill-projection skill-router-config",
  mcp: "mcp-native-location mcp-stdio-command mcp-usage mcp-version-policy mcp",
  sync: "github-sync-catalog-worker github-sync-conflicts github-sync-coordinator github-sync-fingerprint-worker github-sync-scheduler github-sync sync-magic-code sync-server",
  subscriptions: "broker-share-markers subscription-acl subscription-fork subscription-gateway-entry subscription-ip-policy subscription-materialize-worker subscription-mqtt-client subscriptions",
  runtime: "background-task-registry cross-process-lock diagnostic-log environment-paths extension-host-runtime json-file-cache performance-telemetry root-storage-policy user-service-ports version-order",
  ui: "browser-branding localization navigation-path navigation-status navigation-subscriptions onboarding-experience prompt-manager recipe-browser webview-restoration",
  servers: "pyenvs servers",
  workflows: "module-contracts workflow-contracts",
  ai: "ai",
};
const layout = Object.fromEntries(Object.entries(domains).flatMap(([domain, names]) =>
  names.split(" ").map(name => [`${name}.ts`, `${domain}/${name}.ts`])));
const normalized = value => value.split(path.sep).join("/");

function filesUnder(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(filename) : [filename];
  });
}

function runtimeRelative(filename) {
  return (layout[filename.replace(/\.js$/, ".ts")] || filename).replace(/\.ts$/, ".js");
}

function writeCompatibilityBridges(root) {
  for (const [original, relocated] of Object.entries(layout)) {
    const target = path.join(root, "dist", relocated.replace(/\.ts$/, ".js"));
    if (!fs.existsSync(path.join(root, "src", relocated)) || !fs.existsSync(target)) continue;
    const destination = path.join(root, "dist", original.replace(/\.ts$/, ".js"));
    if (["api-chat-client.ts", "api-chat-tools.ts", "api-chat-mcp.ts"].includes(original)) fs.copyFileSync(target, destination);
    else fs.writeFileSync(destination, `module.exports = require(${JSON.stringify("./" + normalized(path.relative(path.dirname(destination), target)))});\n`);
  }
}

function verifyLayout(root, complete = false) {
  for (const [original, relocated] of Object.entries(layout)) {
    const oldFile = path.join(root, "src", original);
    const newFile = path.join(root, "src", relocated);
    if (fs.existsSync(oldFile) && fs.existsSync(newFile)) throw new Error(`Duplicate module ownership: ${original}`);
    if (complete && !fs.existsSync(newFile)) throw new Error(`Unmigrated module: ${original}`);
    if (fs.existsSync(newFile)) {
      const compiled = path.join(root, "dist", relocated.replace(/\.ts$/, ".js"));
      if (fs.existsSync(compiled) && !fs.existsSync(path.join(root, "dist", original.replace(/\.ts$/, ".js")))) {
        throw new Error(`Missing compatibility entry: ${original}`);
      }
    }
  }
  if (complete) for (const filename of fs.readdirSync(path.join(root, "src"))) {
    if (filename.endsWith(".ts") && filename !== "extension.ts") throw new Error(`Unowned root module: ${filename}`);
  }
}

function migrate(root, domain) {
  const sourceRoot = path.join(root, "src");
  const moved = new Map(Object.entries(layout).filter(([, target]) => !domain || target.startsWith(domain + "/"))
    .filter(([original]) => fs.existsSync(path.join(sourceRoot, original)))
    .map(([original, target]) => [path.join(sourceRoot, original), path.join(sourceRoot, target)]));
  for (const [original, target] of moved) if (fs.existsSync(target)) throw new Error(`Refusing to overwrite ${target}`);
  const sourceFiles = filesUnder(sourceRoot).filter(filename => filename.endsWith(".ts"));
  const sourceSet = new Set(sourceFiles);
  const byName = new Map(sourceFiles.map(filename => [path.basename(filename).replace(/\.ts$/, ".js"), filename]));
  const references = [...filesUnder(sourceRoot), ...filesUnder(path.join(root, "tests")), ...filesUnder(path.join(root, "scripts"))]
    .filter(filename => /\.(?:ts|js|cjs|json)$/.test(filename) && filename !== __filename);
  references.push(path.join(root, "package.json"), path.join(root, "tsconfig.json"));
  const resolveImport = (value, caller) => {
    if (!value.startsWith(".")) return value;
    const candidate = path.resolve(path.dirname(caller), value);
    const target = [candidate, candidate + ".ts", candidate.replace(/\.js$/, ".ts"), path.join(candidate, "index.ts")]
      .find(filename => sourceSet.has(filename)
        || filename.startsWith(root + path.sep) && filename.endsWith(".json") && fs.existsSync(filename));
    if (!target) return value;
    const updated = normalized(path.relative(path.dirname(moved.get(caller) || caller), moved.get(target) || target));
    const extension = value.endsWith(".js") ? ".js" : value.endsWith(".ts") ? ".ts" : "";
    const specifier = updated.replace(/\.ts$/, extension);
    return specifier.startsWith(".") ? specifier : "./" + specifier;
  };
  const rewritePaths = value => {
    value = value.replace(/dist\/(subscriptions|mcp|servers|ai|chatroom)\/\1\//g, "dist/$1/");
    const paths = new Map([...moved].flatMap(([original, target]) => {
      const before = normalized(path.relative(sourceRoot, original));
      const after = normalized(path.relative(sourceRoot, target));
      return [["src/" + before, "src/" + after], ["dist/" + before.replace(/\.ts$/, ""), "dist/" + after.replace(/\.ts$/, "")]];
    }));
    if (paths.size) {
      const choices = [...paths.keys()].sort((left, right) => right.length - left.length)
        .map(candidate => candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      value = value.replace(new RegExp(`(?:${choices.join("|")})(?=$|[^\\w/-])`, "g"), match => paths.get(match));
    }
    if (domain === "chat" || !domain) value = value.replace("--outdir=dist --allow-overwrite", "--outdir=dist/chat --allow-overwrite");
    return value;
  };
  let edited = 0;
  for (const filename of new Set(references)) {
    const content = fs.readFileSync(filename, "utf8");
    const parsed = ts.createSourceFile(filename, content, ts.ScriptTarget.Latest, true,
      filename.endsWith(".json") ? ts.ScriptKind.JSON : filename.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS);
    const edits = [];
    const visit = node => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        let value = node.text;
        const parent = node.parent;
        const isImport = (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) && parent.moduleSpecifier === node
          || ts.isLiteralTypeNode(parent) && ts.isImportTypeNode(parent.parent)
          || ts.isCallExpression(parent) && (parent.expression.kind === ts.SyntaxKind.ImportKeyword
            || ts.isIdentifier(parent.expression) && parent.expression.text === "require");
        if (isImport && filename.startsWith(sourceRoot + path.sep)) value = resolveImport(value, filename);
        if (ts.isBinaryExpression(parent) && parent.right === node && ts.isIdentifier(parent.left) && parent.left.text === "name") {
          let guard = parent.parent;
          while (guard && (ts.isBinaryExpression(guard) || ts.isParenthesizedExpression(guard))) {
            if (ts.isBinaryExpression(guard) && guard.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
              let caller;
              const findCaller = child => {
                if (ts.isCallExpression(child) && ts.isPropertyAccessExpression(child.expression)
                    && child.expression.name.text === "endsWith" && ts.isStringLiteral(child.arguments[0])) {
                  caller = byName.get(child.arguments[0].text);
                }
                ts.forEachChild(child, findCaller);
              };
              findCaller(guard.left);
              if (caller) { value = resolveImport(value, caller); break; }
            }
            guard = guard.parent;
          }
        }
        if (ts.isCallExpression(parent) && ts.isPropertyAccessExpression(parent.expression)
            && ["join", "resolve"].includes(parent.expression.name.text)) {
          const directory = parent.arguments.find(argument => ts.isStringLiteral(argument) && ["src", "dist"].includes(argument.text));
          const oldSource = path.join(sourceRoot, node.text.replace(/\.js$/, ".ts"));
          if (directory && moved.has(oldSource)) {
            value = normalized(path.relative(sourceRoot, moved.get(oldSource)));
            if (directory.text === "dist") value = value.replace(/\.ts$/, node.text.endsWith(".js") ? ".js" : "");
          }
        }
        value = rewritePaths(value);
        if (value !== node.text) edits.push({ start: node.getStart(parsed), end: node.end, text: JSON.stringify(value) });
      } else if (moved.has(filename) && ts.isIdentifier(node) && node.text === "__dirname") {
        edits.push({ start: node.getStart(parsed), end: node.end, text: 'require("path").resolve(__dirname, "..")' });
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);
    if (!edits.length) continue;
    let updated = content;
    for (const edit of edits.sort((left, right) => right.start - left.start)) updated = updated.slice(0, edit.start) + edit.text + updated.slice(edit.end);
    fs.writeFileSync(filename, updated); edited++;
  }
  for (const [original, target] of moved) {
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.renameSync(original, target);
  }
  console.log(`Source layout: moved ${moved.size} modules; updated ${edited} dependency/contract files.`);
}

module.exports = { layout, runtimeRelative, writeCompatibilityBridges, verifyLayout, migrate };
if (require.main === module) {
  const root = path.join(__dirname, "..");
  if (process.argv.includes("--verify")) { verifyLayout(root, true); console.log("Source ownership layout verified."); }
  else {
    const index = process.argv.indexOf("--domain");
    const domain = index < 0 ? undefined : process.argv[index + 1];
    if (index >= 0 && !Object.hasOwn(domains, domain)) throw new Error("Choose an explicit known source domain.");
    migrate(root, domain);
  }
}
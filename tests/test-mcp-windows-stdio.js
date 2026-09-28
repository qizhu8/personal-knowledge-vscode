#!/usr/bin/env node
const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ts = require('typescript');

const root = path.join(__dirname, '..');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pkm-windows-stdio-'));
const compiled = path.join(fixture, 'mcp-stdio-command.js');
childProcess.execFileSync('npx', [
  'esbuild',
  path.join(root, 'src/mcp-stdio-command.ts'),
  '--bundle',
  '--platform=node',
  '--format=cjs',
  `--outfile=${compiled}`,
], { cwd: root, stdio: 'ignore' });

const { mcpStdioCommand } = require(compiled);
const windowsPython = String.raw`C:\Users\person\pkm-envs\pkm-mcp\Scripts\python.exe`;
const server = String.raw`C:\Users\person\OneDrive\PersonalKnowledge\mcp-server\server.py`;
const extensionRoot = String.raw`C:\Users\person\.vscode\extensions\uone.personal-knowledge-3.1.1`;
const signedCodeExecutable = String.raw`C:\Program Files\Microsoft VS Code\Code.exe`;
const proxy = path.join(extensionRoot, 'resources', 'windows', 'pkm-stdio-proxy.js');

assert.deepStrictEqual(
  mcpStdioCommand(windowsPython, [server], 'win32', extensionRoot, signedCodeExecutable, () => true),
  {
    command: signedCodeExecutable,
    args: [proxy, windowsPython, server],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  },
  'Windows stdio MCP launch must use the signed VS Code executable and packaged JavaScript proxy',
);
assert.deepStrictEqual(
  mcpStdioCommand('/home/person/pkm-envs/pkm-mcp/bin/python', ['/home/person/pkm/mcp-server/server.py'], 'linux'),
  { command: '/home/person/pkm-envs/pkm-mcp/bin/python', args: ['/home/person/pkm/mcp-server/server.py'] },
  'non-Windows stdio MCP launch must remain unchanged',
);
assert.throws(
  () => mcpStdioCommand(windowsPython, [server], 'win32', extensionRoot, signedCodeExecutable, () => false),
  /PKM Windows stdio proxy is missing/,
  'Windows must fail explicitly instead of falling back to a console-subsystem executable',
);

const proxyPath = path.join(root, 'resources', 'windows', 'pkm-stdio-proxy.js');
const proxySource = fs.readFileSync(proxyPath, 'utf8');
assert.match(proxySource, /spawn\(command, args,/);
assert.match(proxySource, /stdio:\s*"inherit"/);
assert.match(proxySource, /windowsHide:\s*true/);
assert.match(proxySource, /delete env\.ELECTRON_RUN_AS_NODE/);
assert.deepStrictEqual(
  fs.readdirSync(path.join(root, 'resources', 'windows')).filter(name => name.toLowerCase().endsWith('.exe')),
  [],
  'the extension must not ship custom unsigned Windows executables',
);

const echoChild = path.join(fixture, 'echo-child.js');
fs.writeFileSync(echoChild, `
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => process.stdout.write(process.argv[2] + ":" + input));
`);
const roundTrip = childProcess.spawnSync(process.execPath, [proxyPath, process.execPath, echoChild, 'argument'], {
  encoding: 'utf8',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  input: 'payload',
});
assert.strictEqual(roundTrip.status, 0, roundTrip.stderr);
assert.strictEqual(roundTrip.stdout, 'argument:payload', 'the proxy must preserve target arguments and stdio');
const exitCode = childProcess.spawnSync(process.execPath, [proxyPath, process.execPath, '-e', 'process.exit(7)']);
assert.strictEqual(exitCode.status, 7, 'the proxy must preserve the target exit code');

const mcpSource = fs.readFileSync(path.join(root, 'src/mcp.ts'), 'utf8');
assert.strictEqual((mcpSource.match(/mcpStdioCommand\(/g) || []).length, 5, 'every MCP registration and instruction surface must use the Windows-safe launcher');
assert.match(mcpSource, /env:\s*launch\.env/,
  'native MCP definition data must carry the signed-host environment');
assert.strictEqual((mcpSource.match(/\.\.\.\(launch\.env \? \{ env: launch\.env \} : \{\}\)/g) || []).length, 4,
  'every JSON registry and instruction surface must carry ELECTRON_RUN_AS_NODE');
const extensionSource = fs.readFileSync(path.join(root, 'src/extension.ts'), 'utf8');
assert.match(extensionSource, /new api\.McpStdioServerDefinition\(data\.label, data\.command, data\.args, data\.env \|\| \{\}, data\.version\)/,
  'the native VS Code MCP provider must pass the signed-host environment');
assert.doesNotMatch(mcpSource, /Get-CimInstance Win32_Process/,
  'passive MCP status must not launch a visible PowerShell process on Windows');
assert.match(mcpSource, /Passive MCP process inspection is disabled on Windows/,
  'Windows MCP status must explain why passive process inspection is unavailable');
const serversSource = fs.readFileSync(path.join(root, 'src/servers.ts'), 'utf8');
assert.match(serversSource, /status === "external" && slug === inspectExternalSlug \? serverListenerProcesses\(m\.port\) : \[\]/,
  'passive Server status must defer Windows listener inspection until the user explicitly requests it');
const retrievalSource = fs.readFileSync(path.join(root, 'src/retrieval-worker.ts'), 'utf8');
assert.match(retrievalSource, /const launch = mcpStdioCommand\(this\.python, \[this\.workerScript, this\.stateDir, this\.configurationHash\]\)/,
  'the long-lived Windows retrieval worker must use the signed-host JavaScript no-console proxy');
assert.match(retrievalSource, /spawn\(launch\.command, launch\.args,/,
  'retrieval must execute the platform-safe launch command rather than python.exe directly');
assert.match(retrievalSource, /env:\s*\{\s*\.\.\.process\.env,\s*\.\.\.launch\.env\s*\}/,
  'retrieval must pass ELECTRON_RUN_AS_NODE to the signed VS Code executable');
assert.doesNotMatch(retrievalSource, /spawn\(this\.python,/,
  'the Windows retrieval worker must never directly start the console-subsystem Python executable');

const runtimeProcessFiles = fs.readdirSync(path.join(root, 'src'), { recursive: true })
  .filter(entry => String(entry).endsWith('.ts'))
  .map(entry => path.join('src', String(entry)))
  .filter(relative => /from ["']child_process["']/.test(fs.readFileSync(path.join(root, relative), 'utf8')))
  .sort();
assert(runtimeProcessFiles.length >= 8, 'the Windows process audit must discover every extension-runtime child_process import');
const childOptionIndex = new Map([
  ['execFile', 2],
  ['execFileAsync', 2],
  ['execFileSync', 2],
  ['execSync', 1],
  ['fork', 2],
  ['spawn', 2],
  ['spawnSync', 2],
]);
for (const relative of runtimeProcessFiles) {
  const sourceText = fs.readFileSync(path.join(root, relative), 'utf8');
  const sourceFile = ts.createSourceFile(relative, sourceText, ts.ScriptTarget.Latest, true);
  const visit = node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && childOptionIndex.has(node.expression.text)) {
      let options = node.arguments[childOptionIndex.get(node.expression.text)];
      while (options && (ts.isAsExpression(options) || ts.isParenthesizedExpression(options))) options = options.expression;
      const hidden = options && ts.isObjectLiteralExpression(options)
        && options.properties.some(property => property.name && property.name.getText(sourceFile) === 'windowsHide');
      const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      assert(hidden, `${relative}:${location.line + 1} ${node.expression.text} must explicitly set windowsHide`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  assert.doesNotMatch(sourceText, /windowsHide\s*:\s*false/, `${relative} must never opt into visible Windows console windows`);
}

const recipeRuntimeSource = fs.readFileSync(path.join(root, 'resources', 'recipe_runtime.py'), 'utf8');
assert.match(recipeRuntimeSource, /CREATE_NO_WINDOW/);
assert.strictEqual((recipeRuntimeSource.match(/subprocess\.Popen\(/g) || []).length, 2);
assert.strictEqual((recipeRuntimeSource.match(/\*\*_background_process_options\(\)/g) || []).length, 2,
  'Recipe worker and Recipe commands must both suppress Windows console windows');
assert.match(recipeRuntimeSource, /subprocess\.run\(\["taskkill"[\s\S]{0,300}\*\*_hidden_process_options\(\)/,
  'Recipe timeout cleanup must suppress the taskkill console window');

fs.rmSync(fixture, { recursive: true, force: true });
console.log('Windows process launch test: MCP, Recipe, and every extension-runtime child process suppress console windows');

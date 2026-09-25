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

assert.deepStrictEqual(
  mcpStdioCommand(windowsPython, [server], 'win32', 'x64', extensionRoot, () => true),
  {
    command: path.join(extensionRoot, 'resources', 'windows', 'pkm-stdio-launcher-x64.exe'),
    args: [windowsPython, server],
  },
  'Windows stdio MCP launch must use the packaged no-console launcher and preserve Python arguments',
);
assert.deepStrictEqual(
  mcpStdioCommand('/home/person/pkm-envs/pkm-mcp/bin/python', ['/home/person/pkm/mcp-server/server.py'], 'linux'),
  { command: '/home/person/pkm-envs/pkm-mcp/bin/python', args: ['/home/person/pkm/mcp-server/server.py'] },
  'non-Windows stdio MCP launch must remain unchanged',
);
assert.throws(
  () => mcpStdioCommand(windowsPython, [server], 'win32', 'arm64', extensionRoot, () => false),
  /PKM Windows stdio launcher is missing/,
  'Windows must fail explicitly instead of falling back to a console-subsystem executable',
);

const peMachines = { x64: 0x8664, arm64: 0xaa64, ia32: 0x014c };
for (const arch of ['x64', 'arm64', 'ia32']) {
  const executable = path.join(root, 'resources', 'windows', `pkm-stdio-launcher-${arch}.exe`);
  const bytes = fs.readFileSync(executable);
  assert.strictEqual(bytes.subarray(0, 2).toString('ascii'), 'MZ', `${arch} launcher must be a Windows PE executable`);
  const peOffset = bytes.readUInt32LE(0x3c);
  assert.strictEqual(bytes.subarray(peOffset, peOffset + 4).toString('binary'), 'PE\u0000\u0000');
  assert.strictEqual(bytes.readUInt16LE(peOffset + 4), peMachines[arch], `${arch} launcher must target the matching Windows architecture`);
  assert.strictEqual(bytes.readUInt16LE(peOffset + 24 + 68), 2, `${arch} launcher must use the Windows GUI subsystem`);
}

const launcherSource = fs.readFileSync(path.join(root, 'scripts/windows-stdio-launcher.go'), 'utf8');
assert.match(launcherSource, /CreationFlags: createNoWindow/);
assert.match(launcherSource, /command\.Stdin = os\.Stdin[\s\S]*command\.Stdout = os\.Stdout[\s\S]*command\.Stderr = os\.Stderr/);

const mcpSource = fs.readFileSync(path.join(root, 'src/mcp.ts'), 'utf8');
assert.strictEqual((mcpSource.match(/mcpStdioCommand\(/g) || []).length, 5, 'every MCP registration and instruction surface must use the Windows-safe launcher');

const runtimeProcessFiles = [
  'src/extension.ts',
  'src/github-sync.ts',
  'src/mcp.ts',
  'src/prompt-manager.ts',
  'src/pyenvs.ts',
  'src/retrieval-worker.ts',
  'src/servers.ts',
  'src/subscriptions.ts',
];
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
}

fs.rmSync(fixture, { recursive: true, force: true });
console.log('Windows process launch test: MCP launchers and every extension-runtime child process suppress console windows');

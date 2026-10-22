// The Python MCP host retains previews; callers supply IDs, never replacement proposal bodies.
const fs = require('node:fs');
const path = require('node:path');
try {
  const [extensionRoot, root] = process.argv.slice(2);
  const request = JSON.parse(fs.readFileSync(0, 'utf8'));
  const engine = require(path.join(extensionRoot, 'dist/knowledge/asset-classification.js'));
  const value = request.operation === 'preview' ? engine.previewAssetClassification(root)
    : request.operation === 'apply' ? engine.applyAssetClassification(root, request.preview, request.proposalIds)
    : request.operation === 'rollback' ? engine.rollbackAssetClassification(root, request.journalId)
    : (() => { throw new Error('Unsupported operation'); })();
  process.stdout.write(JSON.stringify(value));
} catch {
  process.stderr.write('Asset classification failed; no asset content is logged.');
  process.exitCode = 1;
}

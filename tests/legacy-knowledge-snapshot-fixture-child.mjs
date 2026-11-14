import { legacyKnowledgeSnapshotFixtureBridge } from "../dist/legacy-knowledge-snapshot-fixture-bridge.js";

const [root, nonce, operation, crash] = process.argv.slice(2);
try {
  const result = await legacyKnowledgeSnapshotFixtureBridge(root, { nonce, operation,
    checkpoint(phase) { if (phase === crash) process.exit(77); } });
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error.code || "ERROR");
  process.exitCode = 1;
}

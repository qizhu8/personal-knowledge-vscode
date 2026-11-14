const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const vscode = require("vscode");

async function run() {
  const fixture = process.env.PKM_RETRIEVAL_WINDOW_FIXTURE;
  const index = process.env.PKM_RETRIEVAL_WINDOW_INDEX;
  const phase = process.env.PKM_RETRIEVAL_WINDOW_PHASE;
  const wait = async (probe, label) => {
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      if (fs.existsSync(path.join(fixture, "abort"))) throw new Error("Fixture aborted");
      const value = await probe();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out: ${label}`);
  };
  const extension = vscode.extensions.getExtension("uone.personal-knowledge");
  assert(extension, "The installed candidate extension must be present");
  await extension.activate();
  const store = require(path.join(extension.extensionPath, "dist/knowledge/filestore")).getStorePath();
  assert.equal(path.resolve(store), path.join(fixture, "root"));
  const identity = createHash("sha256").update(path.resolve(store)).digest("hex").slice(0, 16);
  const state = path.join(fixture, "storage", "retrieval", identity);
  const owner = await wait(() => {
    const dir = path.join(state, "owners");
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir).filter(name => name.endsWith(".open"))) {
      const record = JSON.parse(fs.readFileSync(path.join(dir, name)));
      if (record.pid === process.pid && !fs.existsSync(path.join(dir, name.replace(".open", ".close"))))
        return record;
    }
  }, "this VS Code host retrieval admission");
  const endpoint = JSON.parse(fs.readFileSync(path.join(state, "worker.json")));
  const status = await fetch(`http://127.0.0.1:${endpoint.port}/status`, {
    headers: { "X-PKM-Retrieval-Token": endpoint.token }, signal: AbortSignal.timeout(10000),
  });
  assert.equal(status.status, 200);
  fs.writeFileSync(path.join(fixture, `ready-${phase}-${index}.json`),
    JSON.stringify({ hostPid: process.pid, workerPid: endpoint.pid, ownerId: owner.id }));
  let probed = false;
  await wait(async () => {
    if (!probed && fs.existsSync(path.join(fixture, `probe-${phase}-${index}`))) {
      const response = await fetch(`http://127.0.0.1:${endpoint.port}/status`, {
        headers: { "X-PKM-Retrieval-Token": endpoint.token }, signal: AbortSignal.timeout(10000),
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).pid, endpoint.pid);
      fs.writeFileSync(path.join(fixture, `probed-${phase}-${index}`), JSON.stringify({ hostPid: process.pid, workerPid: endpoint.pid }));
      probed = true;
    }
    return fs.existsSync(path.join(fixture, `finish-${phase}-${index}`));
  }, "window close request");
}

module.exports = { run };

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

function contained(root, directory) {
  const relative = path.relative(root, fs.realpathSync(directory));
  assert(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    "Service cleanup must stay within the fixture root.");
}

async function stopFixturePkmService({ fixtureRoot, extensionRoot, storage, knowledge, home }) {
  if (!fs.existsSync(storage)) return;
  const root = fs.realpathSync(fixtureRoot);
  for (const directory of [storage, knowledge, home]) contained(root, directory);
  const api = require(path.join(extensionRoot, "dist/runtime/pkm-service"));
  const options = {
    globalStoragePath: storage, knowledgeRoot: knowledge,
    extensionVersion: require(path.join(extensionRoot, "package.json")).version,
    serviceEntryPath: path.join(extensionRoot, "dist/runtime/pkm-service-entry.js"),
    execute: async () => { throw new Error("Sync execution is not authorized during fixture cleanup."); },
  };
  const previousHome = process.env.HOME, previousProfile = process.env.USERPROFILE;
  try {
    process.env.HOME = process.env.USERPROFILE = home;
    const identity = api.pkmServiceIdentity(options);
    const endpoint = path.join(identity.serviceDirectory, "endpoint.json");
    if (!fs.existsSync(endpoint)) return;
    const metadata = JSON.parse(fs.readFileSync(endpoint, "utf8"));
    assert.equal(metadata.identity, identity.identity, "Only drain this fixture's service identity.");
    assert.equal(metadata.extensionVersion, options.extensionVersion, "Do not upgrade a service during cleanup.");
    const client = await api.PkmServiceClient.connect(options);
    try { await client.drain(); } finally { client.dispose(); }
    const deadline = Date.now() + 10_000;
    while (fs.existsSync(endpoint)) {
      if (Date.now() >= deadline) throw new Error("Fixture service shutdown did not remove its endpoint.");
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    console.log("Fixture PKM service drained.");
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousProfile;
  }
}

async function stopFixtureServices(options) {
  if (!fs.existsSync(options.storage)) return;
  const root = fs.realpathSync(options.fixtureRoot);
  for (const directory of [options.storage, options.knowledge, options.home]) contained(root, directory);
  const retrieval = path.join(options.storage, "retrieval");
  if (fs.existsSync(retrieval)) {
    contained(root, retrieval);
    for (const entry of fs.readdirSync(retrieval)) {
      const directory = path.join(retrieval, entry);
      if (!fs.statSync(directory).isDirectory()) continue;
      contained(root, directory);
      const endpointPath = path.join(directory, "worker.json");
      if (!fs.existsSync(endpointPath)) continue;
      contained(root, endpointPath);
      const endpoint = JSON.parse(fs.readFileSync(endpointPath, "utf8"));
      assert(Number.isInteger(endpoint.port) && endpoint.port > 0 && endpoint.port <= 65535);
      assert(Number.isInteger(endpoint.pid) && endpoint.pid > 0);
      assert(typeof endpoint.token === "string" && endpoint.token.length > 0);
      const url = `http://127.0.0.1:${endpoint.port}`;
      const headers = { "X-PKM-Retrieval-Token": endpoint.token, "Content-Type": "application/json" };
      const response = await fetch(`${url}/status`, { headers, redirect: "error", signal: AbortSignal.timeout(5000) });
      assert(response.ok, "Fixture retrieval status failed.");
      assert.equal((await response.json()).pid, endpoint.pid, "Only stop this fixture's authenticated worker.");
      const stopped = await fetch(`${url}/shutdown`, {
        method: "POST", headers, body: "{}", redirect: "error", signal: AbortSignal.timeout(5000),
      });
      assert(stopped.ok, "Fixture retrieval shutdown failed.");
      const deadline = Date.now() + 10_000;
      while (fs.existsSync(endpointPath)) {
        if (Date.now() >= deadline) throw new Error("Fixture retrieval shutdown did not remove its endpoint.");
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      console.log("Fixture retrieval worker stopped.");
    }
  }
  await stopFixturePkmService(options);
}

module.exports = { stopFixturePkmService, stopFixtureServices };
